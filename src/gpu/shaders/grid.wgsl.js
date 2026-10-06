// Spatial Hashing (FLIP FLUID の separate()) の GPU 版: countCells -> prefixSum -> scatter でデータそのものをセル順に並べ替える
// meta = (type, id) を 1 つにまとめているのは maxStorageBuffersPerShaderStage = 8 に収めるため

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

// 単一ワークグループのチャンク式スキャン (各スレッドが連続した chunk 個を直列に足す)。読み終えた個数は 0 に戻す
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

  // Hillis-Steele 包括スキャン
  for (var offset = 1u; offset < ${SCAN_WORKGROUP}u; offset = offset << 1u) {
    var v = partial[lid];
    if (lid >= offset) { v += partial[lid - offset]; }
    workgroupBarrier();
    partial[lid] = v;
    workgroupBarrier();
  }

  var running = partial[lid] - sum;
  for (var c = begin; c < end; c++) {
    let count = numCellParticles[c];
    numCellParticles[c] = 0u;        // 次ステップの countCells 用
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
@group(0) @binding(3) var<storage, read> particleSlot: array<vec2u>;
@group(0) @binding(4) var<storage, read> firstCellParticle: array<u32>;
// type / id は f32 で入れる (bitcast だと小さな整数が非正規化数になり、GPU によっては 0 に丸められる)
@group(0) @binding(5) var<storage, read_write> sortedPosType: array<vec4f>;   // (x, y, type, 0)
@group(0) @binding(6) var<storage, read_write> sortedVelId: array<vec4f>;     // (vx, vy, id, 0)

@compute @workgroup_size(${PARTICLE_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.numParticles) { return; }
  let s = particleSlot[i];
  let dst = firstCellParticle[s.x] + s.y;
  let pv = srcPosVel[i];
  let m = srcMeta[i];
  sortedPosType[dst] = vec4f(pv.xy, f32(m.x), 0.0);
  sortedVelId[dst] = vec4f(pv.zw, f32(m.y), 0.0);
}
`;

// リサイズ後に全パーティクルを巻き戻す
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
