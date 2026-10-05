// Spatial Hashing (FLIP FLUID の separate() と同じ手順) の GPU 版。
//
//   1. countCells : 各パーティクルのセルを求め、atomicAdd でセル内の個数を数える。
//                   atomicAdd の戻り値 (= セル内での通し番号) を particleSlot[i] に保存。
//   2. prefixSum  : numCellParticles[] の累積和 -> firstCellParticle[c] (セル c の先頭 index)。
//                   firstCellParticle[nCells] = 総数。読み終えた numCellParticles[] は 0 に戻す
//                   (次ステップの count のため。専用の clear パスは不要)。
//   3. scatter    : パーティクルを firstCellParticle[cell] + 通し番号 の位置へ並べ替えて書き出す。
//                   force が読みやすい形 (位置 + type + 圧力 / 速度 + id) に詰め替える。
//                   type / id は f32 に変換して入れる (id < 2^24 なので正確。bitcast だと小さな整数が
//                   非正規化数になり、GPU によっては 0 に丸められるため使わない)。
//
// CPU 版の cellParticleIds[k] (= セル順に並べたパーティクル ID) は、ここでは「データそのものを
// セル順に並べ替える」ので恒等写像 (cellParticleIds[k] == k) になり、配列は持たない。
// セル c のパーティクル = ソート済みバッファの [firstCellParticle[c], firstCellParticle[c + 1])。
// 元の index は meta.y (id) に持ち回る (テスト・デバッグ用)。
//
// meta = vec2<u32>(type, id)。type と id を 1 つのバインディングにまとめている
// (デフォルトの maxStorageBuffersPerShaderStage = 8 に収めるため)。

import { COMMON_WGSL } from './common.wgsl.js';

export const SCAN_WORKGROUP = 256;
export const PARTICLE_WORKGROUP = 256;

export const countCellsWGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(1) var<storage, read> posVel: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> numCellParticles: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> particleSlot: array<vec2u>;   // (cell, セル内通し番号)

@compute @workgroup_size(${PARTICLE_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.numParticles) { return; }
  let p = posVel[i];
  let c = cellIndex(p.x, p.y);
  let local = atomicAdd(&numCellParticles[c], 1u);
  particleSlot[i] = vec2u(c, local);
}
`;

// 単一ワークグループ (256 スレッド) のチャンク式スキャン。
// 各スレッドが連続した chunk 個のセルを直列に足し、256 個の部分和をワークグループ内でスキャンし、
// 書き戻す。nCells が何個でも正しい (nCells < 256 でも、数十万でも)。
export const prefixSumWGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> numCellParticles: array<u32>;
@group(0) @binding(2) var<storage, read_write> firstCellParticle: array<u32>;   // nCells + 1 個

var<workgroup> partial: array<u32, ${SCAN_WORKGROUP}>;

@compute @workgroup_size(${SCAN_WORKGROUP})
fn main(@builtin(local_invocation_index) lid: u32) {
  let n = P.nCells;
  let chunk = (n + ${SCAN_WORKGROUP - 1}u) / ${SCAN_WORKGROUP}u;
  let begin = min(lid * chunk, n);
  let end = min(begin + chunk, n);

  var sum = 0u;
  for (var c = begin; c < end; c++) {
    sum += numCellParticles[c];
  }
  partial[lid] = sum;
  workgroupBarrier();

  // Hillis-Steele 包括スキャン (256 要素)
  for (var offset = 1u; offset < ${SCAN_WORKGROUP}u; offset = offset << 1u) {
    var v = partial[lid];
    if (lid >= offset) { v += partial[lid - offset]; }
    workgroupBarrier();
    partial[lid] = v;
    workgroupBarrier();
  }

  // partial[lid] は包括和。このチャンクの先頭までの合計 = 包括和 - 自分の和
  var running = partial[lid] - sum;
  for (var c = begin; c < end; c++) {
    let count = numCellParticles[c];
    numCellParticles[c] = 0u;        // 次ステップの countCells 用にクリア (このスレッドしか触らない)
    firstCellParticle[c] = running;
    running += count;
  }
  if (lid == ${SCAN_WORKGROUP - 1}u) {
    firstCellParticle[n] = partial[${SCAN_WORKGROUP - 1}];   // 総数
  }
}
`;

export const scatterWGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(1) var<storage, read> srcPosVel: array<vec4f>;
@group(0) @binding(2) var<storage, read> srcMeta: array<vec2u>;
@group(0) @binding(3) var<storage, read> srcDensity: array<f32>;
@group(0) @binding(4) var<storage, read> particleSlot: array<vec2u>;
@group(0) @binding(5) var<storage, read> firstCellParticle: array<u32>;
@group(0) @binding(6) var<storage, read_write> sortedPosType: array<vec4f>;   // (x, y, f32(type), pressure)
@group(0) @binding(7) var<storage, read_write> sortedVelId: array<vec4f>;     // (vx, vy, f32(id), 0)

@compute @workgroup_size(${PARTICLE_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.numParticles) { return; }
  let s = particleSlot[i];
  let dst = firstCellParticle[s.x] + s.y;
  let pv = srcPosVel[i];
  let m = srcMeta[i];
  let pressure = max(0.0, srcDensity[i] - P.restDensity);
  sortedPosType[dst] = vec4f(pv.xy, f32(m.x), pressure);
  sortedVelId[dst] = vec4f(pv.zw, f32(m.y), 0.0);
}
`;

// リサイズ後などに全パーティクルを [0, worldW) x [0, worldH) へ巻き戻す。
export const wrapAllWGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> posVel: array<vec4f>;

@compute @workgroup_size(${PARTICLE_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.numParticles) { return; }
  var p = posVel[i];
  p.x = wrapPos(p.x, P.worldW);
  p.y = wrapPos(p.y, P.worldH);
  posVel[i] = p;
}
`;
