// 力 + 積分 (1 スレッド = 1 粒子、自分の結果だけ書く)。力のモデルは CPU 版と同じ Tom Mohr 方式 + SPH 風の圧力と人工粘性
// 近傍探索はセル幅 >= rMax / K で ±K 列、列ごとに半径 rMax の円の弦の行だけ走査する (K = 2 で走査面積が約 6 割)

import { COMMON_WGSL } from './common.wgsl.js';

// NVIDIA (Ampere) で 64 / 256 より数 % 速く、Intel (Xe) では同等
export const FORCE_WORKGROUP = 128;

// force / density 共通の近傍走査 (呼び出し側が xi, yi, xc, cx, cy, K, nxi, nyi, cellW などを定義しておく)
const neighbourLoop = (fn, accInit) => /* wgsl */`
  // nx, ny >= 2K + 1 なので回り込んでも同じセルを 2 回見ない
  var acc = ${accInit};
  for (var o = -K; o <= K; o++) {
    let c = cx + o;
    let gap = max(0.0, max(f32(c) - xc, xc - f32(c + 1))) * cellW;
    if (gap >= P.rMax) { continue; }
    let h = sqrt(P.rMax2 - gap * gap);
    let lo = max(cy - K, i32(floor((yi - h) * P.invCellH)));
    let hi = min(cy + K, i32(floor((yi + h) * P.invCellH)));

    // 回り込みは範囲ごとのずらし量で扱う (ペアごとの最小イメージ判定と同じ結果。rMax 以内の像は走査範囲に 1 つだけ)
    var col = c;
    var sx = 0.0;
    if (col < 0) { col += nxi; sx = -P.worldW; } else if (col >= nxi) { col -= nxi; sx = P.worldW; }
    let base = u32(col) * P.ny;

    // x-major なので同じ列の行 lo..hi はソート済みバッファで連続 (y の端だけ 2 範囲)
    if (lo < 0) {
      acc += ${fn}(firstCellParticle[base + u32(lo + nyi)], firstCellParticle[base + P.ny], xi, yi, row, myP, myV, vec2f(sx, -P.worldH));
      acc += ${fn}(firstCellParticle[base], firstCellParticle[base + u32(hi + 1)], xi, yi, row, myP, myV, vec2f(sx, 0.0));
    } else if (hi >= nyi) {
      acc += ${fn}(firstCellParticle[base + u32(lo)], firstCellParticle[base + P.ny], xi, yi, row, myP, myV, vec2f(sx, 0.0));
      acc += ${fn}(firstCellParticle[base], firstCellParticle[base + u32(hi - nyi + 1)], xi, yi, row, myP, myV, vec2f(sx, P.worldH));
    } else {
      acc += ${fn}(firstCellParticle[base + u32(lo)], firstCellParticle[base + u32(hi + 1)], xi, yi, row, myP, myV, vec2f(sx, 0.0));
    }
  }
`;

export const forceWGSL = (pressure, visc) => COMMON_WGSL + /* wgsl */`
@group(0) @binding(1) var<storage, read> srcPosType: array<vec4f>;     // (x, y, type, pressure)
@group(0) @binding(2) var<storage, read> srcVelId: array<vec4f>;       // (vx, vy, id, -)
@group(0) @binding(3) var<storage, read> firstCellParticle: array<u32>;
@group(0) @binding(4) var<storage, read> rules: array<f32>;
@group(0) @binding(5) var<storage, read_write> dstPosVel: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> dstMeta: array<vec2u>;

// [start, end) の粒子から受ける力 (未スケール)
fn accumulate(start: u32, end: u32, xi: f32, yi: f32, row: u32, myP: f32, myV: vec2f, shift: vec2f) -> vec2f {
  var acc = vec2f(0.0);
  for (var k = start; k < end; k++) {
    let pj = srcPosType[k];

    let dx = (pj.x - xi) + shift.x;
    let dy = (pj.y - yi) + shift.y;

    let d2 = dx * dx + dy * dy;
    if (d2 >= P.rMax2 || d2 == 0.0) { continue; }   // 範囲外 / 自分自身

    let invD = inverseSqrt(d2);
    let r = d2 * invD * P.invRMax;
    var f: f32;
    if (r < P.beta) {
      f = r * P.invBeta - 1.0;
    } else {
      f = rules[row + u32(pj.z)] * (1.0 - abs(2.0 * r - 1.0 - P.beta) * P.invOneMinusBeta);
    }
${pressure ? `
    let q = 1.0 - r;
    let pSum = myP + pj.w;
    f -= P.pressureScale * pSum * q;
${visc ? `
    // 圧力のかかるペアの法線方向の相対速度を減衰
    let vj = srcVelId[k].xy;
    f += P.viscosity * q * min(pSum, 1.0) * ((vj.x - myV.x) * dx + (vj.y - myV.y) * dy) * invD;
` : ''}
` : ''}
    acc += vec2f(dx, dy) * (f * invD);
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
  let myP = ${pressure ? 'me.w' : '0.0'};
  let myV = mv.xy;
  let row = myType * P.numTypes;
  let halfW = P.worldW * 0.5;
  let halfH = P.worldH * 0.5;

  let xc = xi * P.invCellW;
  let cx = i32(min(P.nx - 1u, u32(xc)));
  let cy = i32(min(P.ny - 1u, u32(yi * P.invCellH)));
  let K = i32(P.reach);
  let nxi = i32(P.nx);
  let nyi = i32(P.ny);
  let cellW = 1.0 / P.invCellW;

${neighbourLoop('accumulate', 'vec2f(0.0)')}

  var ax = acc.x * P.accelScale;
  var ay = acc.y * P.accelScale;

  if (P.pointerActive != 0u) {
    var dx = P.pointerX - xi;
    var dy = P.pointerY - yi;
    if (dx > halfW) { dx -= P.worldW; } else if (dx < -halfW) { dx += P.worldW; }
    if (dy > halfH) { dy -= P.worldH; } else if (dy < -halfH) { dy += P.worldH; }
    let d2 = dx * dx + dy * dy;
    if (d2 < P.pointerR2 && d2 > 1e-12) {
      let dist = sqrt(d2);
      let w = 1.0 - dist * P.invPointerR;
      let g = (P.pointerStrength * w * w * (3.0 - 2.0 * w)) / dist;
      ax += dx * g;
      ay += dy * g;
    }
  }

  var v = mv.xy * P.friction + vec2f(ax, ay) * P.dt;
  if (P.maxSpeed > 0.0) {
    let s2 = dot(v, v);
    if (s2 > P.maxSpeed * P.maxSpeed) { v *= P.maxSpeed * inverseSqrt(s2); }
  }
  let nxp = wrapPos(xi + v.x * P.dt, P.worldW);
  let nyp = wrapPos(yi + v.y * P.dt, P.worldH);

  dstPosVel[i] = vec4f(nxp, nyp, v);
  dstMeta[i] = vec2u(myType, u32(mv.z));
}
`;

// 同じステップの位置から圧力を作る (1 ステップ前の密度だと過剰に効いては抜けて振動する)。in-place にしないのは近傍を read で読むため
export const densityWGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(1) var<storage, read> posType: array<vec4f>;
@group(0) @binding(2) var<storage, read> firstCellParticle: array<u32>;
@group(0) @binding(3) var<storage, read_write> posTypeP: array<vec4f>;

fn accumulate(start: u32, end: u32, xi: f32, yi: f32, row: u32, myP: f32, myV: vec2f, shift: vec2f) -> f32 {
  var sum = 0.0;
  for (var k = start; k < end; k++) {
    let pj = posType[k].xy;
    let dx = (pj.x - xi) + shift.x;
    let dy = (pj.y - yi) + shift.y;
    let d2 = dx * dx + dy * dy;
    if (d2 >= P.rMax2 || d2 == 0.0) { continue; }
    let q = 1.0 - sqrt(d2) * P.invRMax;
    sum += q * q;
  }
  return sum;
}

@compute @workgroup_size(${FORCE_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.numParticles) { return; }

  let meFull = posType[i];
  let me = meFull.xy;
  let xi = me.x;
  let yi = me.y;
  let xc = xi * P.invCellW;
  let cx = i32(min(P.nx - 1u, u32(xc)));
  let cy = i32(min(P.ny - 1u, u32(yi * P.invCellH)));
  let K = i32(P.reach);
  let nxi = i32(P.nx);
  let nyi = i32(P.ny);
  let cellW = 1.0 / P.invCellW;
  let row = 0u;                 // 以下 3 つは共通シグネチャのための未使用値
  let myP = 0.0;
  let myV = vec2f(0.0);

${neighbourLoop('accumulate', '0.0')}

  posTypeP[i] = vec4f(meFull.xyz, max(0.0, acc - P.restDensity));
}
`;
