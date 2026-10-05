// 力の計算 + 積分。1 スレッド = 1 パーティクル、周囲の (周期境界で回り込む) 3x3 セルを走査して
// 自分の結果だけを書く (相手側には書かない = 競合なし)。
//
// 力のモデル (CPU 版 simulation.js と同一。Tom Mohr 方式):
//   r = dist / rMax
//   r < beta : f = r / beta - 1                              (共通の斥力)
//   r < 1    : f = a * (1 - |2r - 1 - beta| / (1 - beta))    (a = rules[typeI][typeJ])
//   それ以外  : f = 0
//   accel_i  = rMax * forceFactor * sum_j f * (d_ij / |d_ij|)
// その後  v = v * friction + accel * dt;  x = wrap(x + v * dt)
//
// 入力は scatter 済みのセル順バッファ (srcPosVel / srcMeta)、出力は元のバッファ (dst*)。
// 出力もこのスレッド番号 (= ソート済み順) に書くので、次ステップの count は空間的にほぼ
// ソートされた並びを読むことになる。

import { COMMON_WGSL } from './common.wgsl.js';

// 64 / 128 / 256 を NVIDIA(Ampere) と Intel(Xe) で計測: 128 が NVIDIA で数 % 速く Intel では同等。32 は大幅に遅い。
export const FORCE_WORKGROUP = 128;

export const forceWGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(1) var<storage, read> srcPosVel: array<vec4f>;      // セル順 (x, y, vx, vy)
@group(0) @binding(2) var<storage, read> srcMeta: array<vec2u>;        // (type, id)
@group(0) @binding(3) var<storage, read> firstCellParticle: array<u32>;
@group(0) @binding(4) var<storage, read> rules: array<f32>;            // numTypes * numTypes
@group(0) @binding(5) var<storage, read_write> dstPosVel: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> dstMeta: array<vec2u>;

// ソート済み index の範囲 [start, end) にいる全パーティクルから受ける力 (未スケール) を合計する。
fn accumulate(start: u32, end: u32, xi: f32, yi: f32, row: u32, halfW: f32, halfH: f32) -> vec2f {
  var acc = vec2f(0.0, 0.0);
  for (var k = start; k < end; k++) {
    let pj = srcPosVel[k];

    // 最小イメージ変位 i -> j (位置は [0, size) に収まっている)
    var dx = pj.x - xi;
    var dy = pj.y - yi;
    if (dx > halfW) { dx -= P.worldW; } else if (dx < -halfW) { dx += P.worldW; }
    if (dy > halfH) { dy -= P.worldH; } else if (dy < -halfH) { dy += P.worldH; }

    let d2 = dx * dx + dy * dy;
    if (d2 >= P.rMax2 || d2 == 0.0) { continue; }   // 範囲外、または自分自身 / 同位置

    let dist = sqrt(d2);
    let r = dist * P.invRMax;
    var f: f32;
    if (r < P.beta) {
      f = r * P.invBeta - 1.0;
    } else {
      f = rules[row + srcMeta[k].x] * (1.0 - abs(2.0 * r - 1.0 - P.beta) * P.invOneMinusBeta);
    }
    let g = f / dist;
    acc += vec2f(dx, dy) * g;
  }
  return acc;
}

@compute @workgroup_size(${FORCE_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.numParticles) { return; }

  let me = srcPosVel[i];
  let myMeta = srcMeta[i];
  let xi = me.x;
  let yi = me.y;
  let row = myMeta.x * P.numTypes;     // rules[row + typeJ]: i が j にどれだけ引かれるか
  let halfW = P.worldW * 0.5;
  let halfH = P.worldH * 0.5;

  // 自分のセル (cellIndex と同じ式) と周囲 3x3 セル。
  let cx = min(P.nx - 1u, u32(xi * P.invCellW));
  let cy = min(P.ny - 1u, u32(yi * P.invCellH));

  // 周期境界: 反対側のセルへ回り込む (nx, ny >= 3 なので 3 列 / 3 行は必ず別々のセル)
  let cxm = select(cx - 1u, P.nx - 1u, cx == 0u);
  let cxp = select(cx + 1u, 0u, cx + 1u == P.nx);

  var f = vec2f(0.0, 0.0);
  for (var a = 0u; a < 3u; a++) {
    var col = cx;
    if (a == 0u) { col = cxm; } else if (a == 2u) { col = cxp; }
    let base = col * P.ny;

    // セル番号は x-major (cx * ny + cy) なので、同じ列の縦 3 セル (cy-1, cy, cy+1) は番号が連続し、
    // ソート済みバッファ上でも 1 つの連続範囲になる: [first[c0], first[c1 + 1])。
    // y 方向の端 (cy == 0 / ny-1) では回り込みで 2 範囲に分かれる。
    if (cy > 0u && cy + 1u < P.ny) {
      f += accumulate(firstCellParticle[base + cy - 1u], firstCellParticle[base + cy + 2u], xi, yi, row, halfW, halfH);
    } else if (cy == 0u) {
      f += accumulate(firstCellParticle[base + P.ny - 1u], firstCellParticle[base + P.ny], xi, yi, row, halfW, halfH);
      f += accumulate(firstCellParticle[base], firstCellParticle[base + 2u], xi, yi, row, halfW, halfH);
    } else {
      f += accumulate(firstCellParticle[base + P.ny - 2u], firstCellParticle[base + P.ny], xi, yi, row, halfW, halfH);
      f += accumulate(firstCellParticle[base], firstCellParticle[base + 1u], xi, yi, row, halfW, halfH);
    }
  }

  var ax = f.x * P.accelScale;
  var ay = f.y * P.accelScale;

  // ポインタ (引力 / 斥力)。smoothstep で減衰。
  if (P.pointerActive != 0u) {
    var dx = P.pointerX - xi;
    var dy = P.pointerY - yi;
    if (dx > halfW) { dx -= P.worldW; } else if (dx < -halfW) { dx += P.worldW; }
    if (dy > halfH) { dy -= P.worldH; } else if (dy < -halfH) { dy += P.worldH; }
    let d2 = dx * dx + dy * dy;
    if (d2 < P.pointerR2 && d2 > 1e-12) {
      let dist = sqrt(d2);
      let w = 1.0 - dist * P.invPointerR;                       // 中心で 1、縁で 0
      let g = (P.pointerStrength * w * w * (3.0 - 2.0 * w)) / dist;
      ax += dx * g;                                             // mode +1: 近づく / -1: 遠ざかる
      ay += dy * g;
    }
  }

  // 速度更新 -> 位置更新 (トーラスに巻き戻す)
  let vx = me.z * P.friction + ax * P.dt;
  let vy = me.w * P.friction + ay * P.dt;
  let nxp = wrapPos(xi + vx * P.dt, P.worldW);
  let nyp = wrapPos(yi + vy * P.dt, P.worldH);

  dstPosVel[i] = vec4f(nxp, nyp, vx, vy);
  dstMeta[i] = myMeta;
}
`;
