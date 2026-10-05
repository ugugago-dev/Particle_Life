// 力の計算 + 積分。1 スレッド = 1 パーティクル、周囲のセルを (周期境界で回り込みながら) 走査して
// 自分の結果だけを書く (相手側には書かない = 競合なし)。
//
// 力のモデル (CPU 版 simulation.js と同一。Tom Mohr 方式):
//   r = dist / rMax
//   r < beta : f = r / beta - 1                              (共通の斥力)
//   r < 1    : f = a * (1 - |2r - 1 - beta| / (1 - beta))    (a = rules[typeI][typeJ])
//   それ以外  : f = 0
// 圧縮の制限 (SPH 風の圧力。pressureStrength = 0 なら無効):
//   density_i = sum_j (1 - r)^2                              (重み付きの近傍数)
//   pressure  = max(0, density - restDensity)                (前ステップの密度から scatter が計算)
//   f -= 0.5 * pressureStrength * (pressure_i + pressure_j) * (1 - r)     (i, j で対称な斥力)
//   accel_i  = rMax * forceFactor * sum_j f * (d_ij / |d_ij|)
// その後  v = v * friction + accel * dt;  |v| <= maxSpeed にクランプ;  x = wrap(x + v * dt)
//
// 近傍探索: セル幅 >= rMax / K (K = P.reach)、自分の列から ±K 列を見る。列ごとに
// 「その列までの x 方向の距離」から必要な y 範囲 (半径 rMax の円の弦) を求め、その行だけを走査する。
// K = 1 で従来の 3x3 と同じ範囲、K = 2 なら走査面積がおよそ 6 割になる。
//
// 入力は scatter 済みのセル順バッファ (srcPosType / srcVelId)、出力は元のバッファ (dst*)。
// 出力もこのスレッド番号 (= ソート済み順) に書くので、次ステップの count は空間的にほぼ
// ソートされた並びを読むことになる。

import { COMMON_WGSL } from './common.wgsl.js';

// 64 / 128 / 256 を NVIDIA(Ampere) と Intel(Xe) で計測: 128 が NVIDIA で数 % 速く Intel では同等。32 は大幅に遅い。
export const FORCE_WORKGROUP = 128;

export const forceWGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(1) var<storage, read> srcPosType: array<vec4f>;     // セル順 (x, y, f32(type), pressure)
@group(0) @binding(2) var<storage, read> srcVelId: array<vec4f>;       // セル順 (vx, vy, f32(id), -)
@group(0) @binding(3) var<storage, read> firstCellParticle: array<u32>;
@group(0) @binding(4) var<storage, read> rules: array<f32>;            // numTypes * numTypes
@group(0) @binding(5) var<storage, read_write> dstPosVel: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> dstMeta: array<vec2u>;
@group(0) @binding(7) var<storage, read_write> dstDensity: array<f32>;

// ソート済み index の範囲 [start, end) にいる全パーティクルから受ける力 (未スケール) と密度を合計する。
// 戻り値 = (fx, fy, density)
fn accumulate(start: u32, end: u32, xi: f32, yi: f32, row: u32, myP: f32, halfW: f32, halfH: f32) -> vec3f {
  var acc = vec3f(0.0);
  for (var k = start; k < end; k++) {
    let pj = srcPosType[k];

    // 最小イメージ変位 i -> j (位置は [0, size) に収まっている)
    var dx = pj.x - xi;
    var dy = pj.y - yi;
    if (dx > halfW) { dx -= P.worldW; } else if (dx < -halfW) { dx += P.worldW; }
    if (dy > halfH) { dy -= P.worldH; } else if (dy < -halfH) { dy += P.worldH; }

    let d2 = dx * dx + dy * dy;
    if (d2 >= P.rMax2 || d2 == 0.0) { continue; }   // 範囲外、または自分自身 / 同位置

    let invD = inverseSqrt(d2);
    let r = d2 * invD * P.invRMax;
    var f: f32;
    if (r < P.beta) {
      f = r * P.invBeta - 1.0;
    } else {
      f = rules[row + u32(pj.z)] * (1.0 - abs(2.0 * r - 1.0 - P.beta) * P.invOneMinusBeta);
    }
    let q = 1.0 - r;
    f -= P.pressureScale * (myP + pj.w) * q;
    acc += vec3f(vec2f(dx, dy) * (f * invD), q * q);
  }
  return acc;
}

@compute @workgroup_size(${FORCE_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.numParticles) { return; }

  let me = srcPosType[i];
  let mv = srcVelId[i];
  let myType = u32(me.z);
  let xi = me.x;
  let yi = me.y;
  let myP = me.w;
  let row = myType * P.numTypes;       // rules[row + typeJ]: i が j にどれだけ引かれるか
  let halfW = P.worldW * 0.5;
  let halfH = P.worldH * 0.5;

  // 自分のセル (cellIndex と同じ式)
  let xc = xi * P.invCellW;            // セル単位の x
  let cx = i32(min(P.nx - 1u, u32(xc)));
  let cy = i32(min(P.ny - 1u, u32(yi * P.invCellH)));
  let K = i32(P.reach);
  let nxi = i32(P.nx);
  let nyi = i32(P.ny);
  let cellW = 1.0 / P.invCellW;

  // nx, ny >= 2K + 1 なので、±K 列 / ±K 行は周期境界で回り込んでも重複しない
  var acc = vec3f(0.0);
  for (var o = -K; o <= K; o++) {
    let c = cx + o;
    // この列までの x 方向の最短距離 (自分の列なら 0)
    let gap = max(0.0, max(f32(c) - xc, xc - f32(c + 1))) * cellW;
    if (gap >= P.rMax) { continue; }
    let h = sqrt(P.rMax2 - gap * gap);  // この列で必要な y の半幅
    let lo = max(cy - K, i32(floor((yi - h) * P.invCellH)));
    let hi = min(cy + K, i32(floor((yi + h) * P.invCellH)));

    var col = c;
    if (col < 0) { col += nxi; } else if (col >= nxi) { col -= nxi; }
    let base = u32(col) * P.ny;

    // セル番号は x-major (cx * ny + cy) なので、同じ列の行 lo..hi は番号が連続し、
    // ソート済みバッファ上でも 1 つの連続範囲になる。y の端では回り込みで 2 範囲に分かれる。
    if (lo < 0) {
      acc += accumulate(firstCellParticle[base + u32(lo + nyi)], firstCellParticle[base + P.ny], xi, yi, row, myP, halfW, halfH);
      acc += accumulate(firstCellParticle[base], firstCellParticle[base + u32(hi + 1)], xi, yi, row, myP, halfW, halfH);
    } else if (hi >= nyi) {
      acc += accumulate(firstCellParticle[base + u32(lo)], firstCellParticle[base + P.ny], xi, yi, row, myP, halfW, halfH);
      acc += accumulate(firstCellParticle[base], firstCellParticle[base + u32(hi - nyi + 1)], xi, yi, row, myP, halfW, halfH);
    } else {
      acc += accumulate(firstCellParticle[base + u32(lo)], firstCellParticle[base + u32(hi + 1)], xi, yi, row, myP, halfW, halfH);
    }
  }

  var ax = acc.x * P.accelScale;
  var ay = acc.y * P.accelScale;

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

  // 速度更新 -> 速度制限 -> 位置更新 (トーラスに巻き戻す)
  var v = mv.xy * P.friction + vec2f(ax, ay) * P.dt;
  if (P.maxSpeed > 0.0) {
    let s2 = dot(v, v);
    if (s2 > P.maxSpeed * P.maxSpeed) { v *= P.maxSpeed * inverseSqrt(s2); }
  }
  let nxp = wrapPos(xi + v.x * P.dt, P.worldW);
  let nyp = wrapPos(yi + v.y * P.dt, P.worldH);

  dstPosVel[i] = vec4f(nxp, nyp, v);
  dstMeta[i] = vec2u(myType, u32(mv.z));
  dstDensity[i] = acc.z;
}
`;
