// organic 描画の WGSL (splat / shape / downsample / blur / composite / paper)。各パスの役割は docs/organic-rendering-spec.md

import { MAX_PALETTE, RENDER_COMMON, FULLSCREEN_VS } from './render.wgsl.js';
import { assertStructLayout } from './common.wgsl.js';
import { ORGANIC_STYLES, SHAPE_INDEX } from '../../organicStyles.js';
import { SCOPE_BG, MAX_STAIN_TYPES } from '../../stainColor.js';

// OrganicParams の並び (WGSL の struct との一致は assertOrganicLayout が確認)。style / shape だけ u32
export const ORGANIC_FIELDS = [
    'weightNorm', 'splatRadius', 'fieldGain', 'style', 'shape', 'threshold', 'nucleusThreshold', 'speciesTint',
    'dpr', 'rimStrength', 'coreThreshold', 'scopeStain', 'scopeVignette', 'scopeSpeck',
    'fieldW', 'fieldH', 'margin', 'numTypes',
];
export const ORGANIC_UNIFORM_FLOATS = ORGANIC_FIELDS.length;

// BlurParams = texel (vec2f) + count (u32) + 16 バイト境界の taps (中心 + 左右対称のペア) = 288 バイト
export const BLUR_MAX_PAIRS = 16;
export const BLUR_UNIFORM_FLOATS = 4 + 4 * (BLUR_MAX_PAIRS + 1);

const STYLE_CONSTS = [
    ...Object.entries(ORGANIC_STYLES).map(([name, s]) => `const STYLE_${name.toUpperCase()} = ${s.index}u;`),
    ...Object.entries(SHAPE_INDEX).map(([name, i]) => `const SHAPE_${name.toUpperCase()} = ${i}u;`),
].join('\n');

const ORGANIC_SHARED = /* wgsl */`
struct OrganicParams {
  weightNorm: f32,        // 平均密度で field = 1 になる粒子 1 個の重み
  splatRadius: f32,       // ワールド単位
  fieldGain: f32,
  style: u32,
  shape: u32,
  threshold: f32,
  nucleusThreshold: f32,
  speciesTint: f32,
  dpr: f32,
  rimStrength: f32,
  coreThreshold: f32,
  scopeStain: f32,
  scopeVignette: f32,
  scopeSpeck: f32,
  fieldW: f32,            // 余白を除いた field の px
  fieldH: f32,
  margin: f32,            // field の余白 (px)
  numTypes: f32,          // パレットの種類数 (1..16)。scope の種類の角度
};

${STYLE_CONSTS}

const EPS = 1e-4;
const PI = 3.14159265;
const TAU = 6.2831853;

fn meanColor(v: vec4f) -> vec3f {
  return v.rgb / max(v.a, EPS);
}
`;

const ORGANIC_COMMON = RENDER_COMMON + ORGANIC_SHARED;

/** WGSL の OrganicParams と ORGANIC_FIELDS が食い違っていないか確認する (GpuRenderer.create から)。 */
export function assertOrganicLayout() {
    assertStructLayout(ORGANIC_SHARED, 'OrganicParams', ORGANIC_FIELDS);
}

export const splatWGSL = ORGANIC_COMMON + /* wgsl */`
@group(0) @binding(1) var<uniform> palette: array<vec4f, ${MAX_PALETTE}>;
@group(0) @binding(2) var<storage, read> posVel: array<vec4f>;
@group(0) @binding(3) var<storage, read> particleMeta: array<vec2u>;
@group(0) @binding(4) var<uniform> O: OrganicParams;

// cell の顆粒: 一部の粒子が向きのランダムな小さな楕円を出す
const GRANULE_FRACTION = 0.03;
const GRANULE_LONG = 0.42;       // 長軸 / スプラット半径
const GRANULE_ASPECT = 1.7;      // 長軸 / 短軸

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) d: vec2f,                                // 四角形内の [-1, 1]^2
  @location(1) color: vec3f,
  @location(2) @interpolate(flat) dir: vec2f,           // 顆粒の長軸の向き
  @location(3) @interpolate(flat) org: f32,             // 顆粒なら 1
};

struct GranuleOut {
  @location(0) field: vec4f,
  @location(1) granule: f32,
};

fn hashU(x: u32) -> u32 {                               // PCG
  let s = x * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn hashF(x: u32) -> f32 {
  return f32(hashU(x)) / 4294967295.0;
}

// 周期境界のコピーは描かない: 端をまたぐ分は余白に落ち、shape パスが反対側へ折り返す
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) pi: u32) -> VSOut {
  let p = posVel[pi];
  let pm = particleMeta[pi];
  let t = min(pm.x, ${MAX_PALETTE - 1}u);
  let c = quadCorner(vi);
  let fieldPx = vec2f(O.fieldW, O.fieldH);
  let padded = fieldPx + 2.0 * O.margin;
  let posPx = (p.xy + c * O.splatRadius) / R.worldSize * fieldPx + O.margin;

  var out: VSOut;
  out.pos = vec4f(posPx.x / padded.x * 2.0 - 1.0, 1.0 - posPx.y / padded.y * 2.0, 0.0, 1.0);
  out.d = c;
  if (O.style == STYLE_SCOPE) {    // scope: 種類を円周上の角度で表す (ぼかし後に composite が種類を復元する)
    let a = TAU * (f32(t) + 0.5) / O.numTypes;
    out.color = vec3f(cos(a), sin(a), 0.0);
  } else {
    out.color = palette[t].rgb;
  }
  if (O.style == STYLE_CELL && hashF(pm.y * 2u) < GRANULE_FRACTION) {
    let a = TAU * hashF(pm.y * 2u + 1u);
    out.dir = vec2f(cos(a), sin(a));
    out.org = 1.0;
  }
  return out;
}

fn kernelWeight(d: vec2f) -> f32 {
  let d2 = dot(d, d);
  if (d2 >= 1.0) { discard; }
  let q = 1.0 - d2;
  return q * q * q * O.weightNorm;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let w = kernelWeight(in.d);
  return vec4f(in.color * w, w);
}

@fragment
fn fsGranule(in: VSOut) -> GranuleOut {
  let w = kernelWeight(in.d);
  var out: GranuleOut;
  out.field = vec4f(in.color * w, w);
  if (in.org > 0.5) {
    let e = vec2f(dot(in.d, in.dir), dot(in.d, vec2f(-in.dir.y, in.dir.x))) / vec2f(GRANULE_LONG, GRANULE_LONG / GRANULE_ASPECT);
    let g = max(1.0 - dot(e, e), 0.0);
    out.granule = g * g;
  }
  return out;
}
`;

// field (平均密度 = 1) をぼかす前に 0..1 の指標 c に整形する: occupancy = 構造の占有度、nucleus = 核の指標
export const shapeWGSL = ORGANIC_SHARED + FULLSCREEN_VS + /* wgsl */`
@group(0) @binding(0) var<uniform> O: OrganicParams;
@group(0) @binding(1) var src: texture_2d<f32>;          // 余白付き
@group(0) @binding(2) var granuleSrc: texture_2d<f32>;   // 余白付き

// 本体 + 余白に落ちた反対側の端のはみ出し分 (余白 <= field なので各軸 3 通りまで)
fn folded(t: texture_2d<f32>, x: vec2i) -> vec4f {
  let m = i32(O.margin);
  let size = vec2i(i32(O.fieldW), i32(O.fieldH));
  let limit = size + 2 * m;
  var sum = vec4f(0.0);
  for (var i = -1; i <= 1; i++) {
    let px = x.x + m + i * size.x;
    if (px < 0 || px >= limit.x) { continue; }
    for (var j = -1; j <= 1; j++) {
      let py = x.y + m + j * size.y;
      if (py < 0 || py >= limit.y) { continue; }
      sum += textureLoad(t, vec2i(px, py), 0);
    }
  }
  return sum;
}

const OCC_SHARP = 2.0;
// 1 - exp(-(v / s)^p)。s, p は実測した密度で、ガスの塊 (v ≦ ~3.5) が c ≦ 0.2 に収まる値
const NUCLEUS_S = 3.5;
const NUCLEUS_P = 1.8;

fn compress(v: f32, s: f32, p: f32) -> f32 {
  return 1.0 - exp(-pow(v / s, p));
}

// 出力 = (平均色 x c, c)。scope は (種類の角度の平均ベクトル e x c, 0, c)
fn shaped(f: vec4f, c: f32) -> vec4f {
  if (O.style == STYLE_SCOPE) { return vec4f(f.rg / max(f.a, EPS) * c, 0.0, c); }
  return vec4f(meanColor(f) * c, c);
}

fn shapeField(f: vec4f) -> vec4f {
  let v = f.a * O.fieldGain;
  var c: f32;
  switch (O.shape) {
    case SHAPE_NUCLEUS: { c = smoothstep(O.coreThreshold - 0.1, O.coreThreshold + 0.1, compress(v, NUCLEUS_S, NUCLEUS_P)); }
    case SHAPE_OCCUPANCY, default: { c = 1.0 - exp(-OCC_SHARP * max(v - O.threshold, 0.0)); }
  }
  return shaped(f, c);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  return shapeField(folded(src, vec2i(frag.xy)));
}

// softLarge の large ぼかし用: threshold に依存しない。疎なガスは 0 付近、密な所は 1 に飽和 (s = 5 は旧しきい値 3 相当の体より少し大きい)
const SOFT_S = 5.0;
const SOFT_P = 2.0;

fn softField(f: vec4f) -> vec4f {
  let c = 1.0 - exp(-pow(f.a * O.fieldGain / SOFT_S, SOFT_P));
  return shaped(f, c);
}

struct ShapeSoftOut {
  @location(0) shaped: vec4f,
  @location(1) soft: vec4f,
};

@fragment
fn fsSoft(@builtin(position) frag: vec4f) -> ShapeSoftOut {
  let f = folded(src, vec2i(frag.xy));
  var out: ShapeSoftOut;
  out.shaped = shapeField(f);
  out.soft = softField(f);
  return out;
}

struct ShapeGranuleOut {
  @location(0) shaped: vec4f,
  @location(1) granule: f32,
};

@fragment
fn fsGranule(@builtin(position) frag: vec4f) -> ShapeGranuleOut {
  let x = vec2i(frag.xy);
  var out: ShapeGranuleOut;
  out.shaped = shapeField(folded(src, x));
  out.granule = folded(granuleSrc, x).r;
  return out;
}
`;

// 2x2 の箱平均で 1/2 に縮小
export const downsampleWGSL = FULLSCREEN_VS + /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy) * 2;
  let hi = vec2i(textureDimensions(src)) - vec2i(1);
  return 0.25 * (textureLoad(src, min(p, hi), 0)
               + textureLoad(src, min(p + vec2i(1, 0), hi), 0)
               + textureLoad(src, min(p + vec2i(0, 1), hi), 0)
               + textureLoad(src, min(p + vec2i(1, 1), hi), 0));
}
`;

// 分離ガウスぼかしの 1 方向
export const blurWGSL = FULLSCREEN_VS + /* wgsl */`
struct BlurParams {
  texel: vec2f,                                  // ぼかす向きの 1 テクセル分の UV
  count: u32,                                    // ペアの数
  taps: array<vec4f, ${BLUR_MAX_PAIRS + 1}>,     // (offset テクセル, weight, -, -)
};

@group(0) @binding(0) var<uniform> B: BlurParams;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let uv = frag.xy / vec2f(textureDimensions(src));
  var acc = textureSampleLevel(src, samp, uv, 0.0) * B.taps[0].y;
  for (var i = 1u; i <= B.count; i++) {
    let tap = B.taps[i];
    let o = B.texel * tap.x;
    acc += (textureSampleLevel(src, samp, uv + o, 0.0) + textureSampleLevel(src, samp, uv - o, 0.0)) * tap.y;
  }
  return acc;
}
`;

// cell / scope の画面固定のノイズ: r = 紙の目、g = 体の縁の揺らぎ、b = 核の縁の揺らぎ
export const paperWGSL = ORGANIC_SHARED + FULLSCREEN_VS + /* wgsl */`
@group(0) @binding(0) var<uniform> O: OrganicParams;

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x), u.y);
}

fn fbm(p: vec2f) -> f32 {
  return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 17.1) + 0.2 * vnoise(p * 4.1 + 41.7);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let px = frag.xy / O.dpr;
  let grain = 0.6 * vnoise(px * 0.8) + 0.4 * vnoise(px * 2.3 + 9.1);
  return vec4f(grain, fbm(px * 0.045), fbm(px * 0.11 + 5.3), 1.0);
}
`;

export const compositeWGSL = ORGANIC_COMMON + FULLSCREEN_VS + /* wgsl */`
@group(0) @binding(1) var<uniform> O: OrganicParams;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var smallBlur: texture_2d<f32>;     // disk (rgb = 色 x c、scope は rg = 種類の角度の平均ベクトル x c、a = c)
@group(0) @binding(4) var largeBlur: texture_2d<f32>;     // ring
@group(0) @binding(5) var granuleTex: texture_2d<f32>;    // cell だけ
@group(0) @binding(6) var paperTex: texture_2d<f32>;      // cell / scope だけ
@group(0) @binding(7) var<uniform> stains: StainTables;  // scope だけ

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.299, 0.587, 0.114));
}

// 明るさを保って色相だけ c へ寄せる
fn tinted(base: vec3f, c: vec3f, amount: f32) -> vec3f {
  let k = luma(base) / max(luma(c), 0.05);
  return mix(base, clamp(c * k, vec3f(0.0), vec3f(1.0)), amount);
}

// 以下 s / l = shape の指標の small / large ぼかし (a = 指標、rgb / a = 平均色)。各スタイルの見た目は仕様書

// cell: 体の縁 = 占有度 0.5 の等高線、核 = large がほぼ満杯の所
fn cellStyle(s: vec4f, l: vec4f, g: f32, noise: vec3f) -> vec3f {
  let C = meanColor(s);
  let m = s.a;
  let n = l.a;

  // 紙の目の濃淡 gk は顔料のムラにも使う
  let grain = noise.r;
  let gk = 0.2 * (grain - 0.5);
  let paper = vec3f(0.96, 0.945, 0.90) * (0.95 + 0.07 * grain);

  let wob = (noise.g - 0.5) * 0.3;
  let mb = mix(m, n, 0.4) + wob;
  let body = smoothstep(0.3, 0.62, mb);
  let bleed = smoothstep(0.05, 0.3, mb) * (1.0 - body);    // 縁の外のにじみ

  // 深さ: 縁 0 -> 内部 1
  let dm = mix(m, n, 0.6);
  let depth = smoothstep(0.45, 0.98, dm);

  var col = mix(vec3f(0.36, 0.56, 0.86), vec3f(0.72, 0.91, 0.82), smoothstep(0.0, 0.55, depth));
  col = mix(col, vec3f(0.99, 0.96, 0.72), smoothstep(0.45, 1.0, depth));
  col = tinted(col, C, O.speciesTint);

  // 縁の顔料だまり
  let rimBand = body * (1.0 - smoothstep(0.5, 0.85, dm));
  col = mix(col, col * vec3f(0.80, 0.86, 1.0), rimBand * 0.55);
  col *= 1.0 - gk * body;

  let inner = smoothstep(0.35, 0.7, depth);
  let gr = smoothstep(0.25, 0.75, g) * inner;
  col = mix(col, col * vec3f(0.66, 0.66, 0.76), gr * 0.55);

  // 核: 揺らぎ ±0.06 + smoothstep の幅 0.03 なので、しきい値より 0.09 以上低い所は 0
  var nuc = 0.0;
  var nCol = vec3f(0.0);
  if (n > O.nucleusThreshold - 0.09) {
    let vn = n + (noise.b - 0.5) * 0.12;
    nuc = smoothstep(O.nucleusThreshold - 0.03, O.nucleusThreshold + 0.03, vn) * body;
    let nd = saturate((vn - O.nucleusThreshold) / max(1.0 - O.nucleusThreshold, 0.05));
    nCol = mix(vec3f(0.38, 0.19, 0.50), vec3f(0.54, 0.34, 0.65), smoothstep(0.0, 1.0, nd));
    nCol = tinted(nCol, C, O.speciesTint * 0.6);
    nCol *= 1.0 - gk;
  }

  let halo = mix(paper, paper * vec3f(0.86, 0.93, 1.0), bleed * 0.6);
  return mix(mix(halo, col, body), nCol, nuc);
}

// glass: 核 = m の 0.5 の等高線の内側、体 = n の GLASS_EDGE の等高線の内側。輪郭は fwidth で約 1px の AA
const GLASS_EDGE = 0.2;

fn aaStep(x: f32, edge: f32) -> f32 {
  return saturate((x - edge) / max(fwidth(x) * 1.3, 1e-4) + 0.5);
}

fn glassStyle(s: vec4f, l: vec4f, uv: vec2f) -> vec3f {
  let Cs = meanColor(s);
  let m = s.a;
  let n = l.a;

  var col = mix(vec3f(0.27, 0.57, 0.88), vec3f(0.20, 0.47, 0.82), uv.y);

  col = mix(col, vec3f(0.62, 0.82, 0.98), 0.8 * aaStep(n, GLASS_EDGE));

  // 膜: 勾配が弱い所 (平らな頂上・くびれ) では出さない
  let gradN = fwidth(n);
  let distPx = abs(n - GLASS_EDGE) / max(gradN, 1e-4);
  let halfW = 0.9 * O.rimStrength * O.dpr;
  let rim = saturate(halfW + 0.75 - distPx) * smoothstep(0.002, 0.005, gradN) * min(0.6 + 0.3 * O.rimStrength, 1.0);
  col = mix(col, vec3f(0.96, 1.0, 1.0), rim);

  // 核: 自分の色を暗くした約 1px の縁取りで淡い体から分離する
  let d = (m - 0.5) / max(fwidth(m), 1e-4);             // 核の縁からの px 距離
  let coreA = saturate(d + 0.5) * smoothstep(GLASS_EDGE, GLASS_EDGE + 0.06, n);   // 体の外の小さな粒は出さない
  let ringW = 1.2 * O.dpr;
  let ring = coreA * (1.0 - saturate(d - ringW + 0.5));
  let outline = clamp(mix(vec3f(luma(Cs)), Cs, 1.25) * 0.62, vec3f(0.0), vec3f(1.0));
  col = mix(col, Cs, coreA);
  col = mix(col, outline, ring);
  return col;
}

// scope: 明視野の顕微鏡像 (体 = large の等高線の壁、小器官 = small の占有度を Beer-Lambert で染める)
const SCOPE_BG = vec3f(${SCOPE_BG.join(', ')});    // stainColor.js と共有
const SCOPE_EDGE = 0.2;                    // 体の輪郭 (n)
const SCOPE_GATE = 0.2;                    // scopeSpeck = 1 で小器官に要る n
const SCOPE_BODY = 0.35;                   // 小器官の輪郭 (m)
const SCOPE_CYTO = 0.1;                    // 細胞質の吸光度 / scopeStain
const SCOPE_STAIN_REF = 1.5;               // この scopeStain で密度 1 の染色が stain[] になる
const SCOPE_LIGHT = vec2f(-0.6, -0.8);     // 光源の向き (左上、画面座標)
const SCOPE_SLOPE = 3.0;
const SCOPE_RELIEF = 0.18;
const SCOPE_SPEC = 0.15;
// 純度 R = |e| で彩度を残す範囲。R の値ではなく、2 つ離れた種類の等量混合 cos(2π/N) を 0、隣の種類の等量混合 cos(π/N) を 1 とした割合
const SCOPE_PURITY_LO = 0.3;
const SCOPE_PURITY_HI = 0.55;
const SCOPE_PURITY_CAP_LO = 0.55;         // 種類が多いとき (隣同士の色が近い) は R がこれ以上なら必ず色を残す
const SCOPE_PURITY_CAP_HI = 0.75;
const SCOPE_MIX_LIGHT = 0.5;               // 混合域の灰色を明るくする割合 (0 = 同じ輝度)
const SCOPE_SEP_W = 0.4;                   // 種類の区切り線の半幅 (dpr px)
const SCOPE_SEP_ALPHA = 0.5;

// stainColor.js の buildStainTables (パレットが変わったときだけ書く)
struct StainTables {
  stain: array<vec4f, ${MAX_STAIN_TYPES}>,       // 密度 1 の染色の色 (sRGB)。composite では未使用
  transmit: array<vec4f, ${MAX_STAIN_TYPES}>,    // min(stain / SCOPE_BG, 1)
};

// 種類の角度の平均ベクトル e (|e| = 純度) から種類を復元する。i0 / i1 = e を挟む 2 つの種類の中心 (角度順)、
// side = 2 つの境界 (中点の角度の半直線) までの e 空間の符号付き距離 (i1 側が正)、keep = 彩度を残す割合
struct Species {
  i0: i32,
  i1: i32,
  side: f32,
  keep: f32,
};

fn decodeSpecies(e: vec2f) -> Species {
  let N = max(O.numTypes, 1.0);
  let ni = i32(N);
  let ang = TAU / N;
  let pur = length(e);
  let ee = select(e, vec2f(1.0, 0.0), pur < 1e-6);          // atan2(0, 0) を避ける
  let fl = floor(atan2(ee.y, ee.x) / ang - 0.5);           // 連続な種類座標 u の整数部
  var sp: Species;
  sp.i0 = ((i32(fl) % ni) + ni) % ni;
  sp.i1 = (sp.i0 + 1) % ni;
  let phi = (fl + 1.0) * ang;
  sp.side = dot(e, vec2f(-sin(phi), cos(phi)));
  let h = PI / max(N, 2.0);                                 // N = 1 は 2 として扱う (常に keep = 1)
  let a = cos(2.0 * h);
  let b = cos(h);
  sp.keep = smoothstep(min(mix(a, b, SCOPE_PURITY_LO), SCOPE_PURITY_CAP_LO), min(mix(a, b, SCOPE_PURITY_HI), SCOPE_PURITY_CAP_HI), pur);
  return sp;
}

// 灰色へ (1 - keep) だけ寄せる (透過率なので明るくする = 淡い染色)
fn desaturate(c: vec3f, keep: f32) -> vec3f {
  return mix(vec3f(mix(luma(c), 1.0, SCOPE_MIX_LIGHT)), c, keep);
}

fn scopeStyle(s: vec4f, l: vec4f, uv: vec2f, noise: vec3f) -> vec3f {
  let m = s.a;
  let n = l.a + (noise.g - 0.5) * 0.08;
  let k = O.scopeStain / SCOPE_STAIN_REF;
  let w = O.dpr;
  let line = vec3f(1.0, 1.0, 0.96);

  // 種類: 微分は分岐の外で先に取る
  let es = s.rg / max(s.a, EPS);
  let gradE = length(dpdx(es)) + length(dpdy(es));            // 1 px あたりの e の変化
  let sp = decodeSpecies(es);
  let spl = decodeSpecies(l.rg / max(l.a, EPS));

  var col = SCOPE_BG * (1.0 + 0.05 * (noise.g - 0.5));

  // 細胞質: 隣の種類との線形補間 (u の幅 0.5 の柔らかい切り替え)
  let hl = sin(min(PI / max(O.numTypes, 1.0), 0.5 * PI));
  let Tl = desaturate(mix(stains.transmit[spl.i0].rgb, stains.transmit[spl.i1].rgb, saturate(spl.side / max(hl, 0.1) + 0.5)), spl.keep);
  let dist = (n - SCOPE_EDGE) / max(fwidth(n), 1e-4);          // 体の輪郭からの px (内側が正)
  col *= mix(vec3f(1.0), pow(Tl, vec3f(SCOPE_CYTO * O.scopeStain)), saturate(dist + 0.5));
  let fade = smoothstep(0.002, 0.005, fwidth(n));              // 勾配が弱い所 (平らな頂上・くびれ) では壁を出さない
  col = mix(col, line, 0.7 * saturate(0.6 * w + 0.5 - abs(dist + 1.6 * w)) * fade);
  col = mix(col, vec3f(0.32, 0.33, 0.33), 0.65 * saturate(0.7 * w + 0.5 - abs(dist)) * fade);

  // 小器官: 隣の種類との切り替え (約 1 px の AA)
  let dsw = sp.side / max(gradE, 1e-5);                        // 切り替えからの px (i1 側が正)
  let T0 = desaturate(stains.transmit[sp.i0].rgb, sp.keep);
  let T1 = desaturate(stains.transmit[sp.i1].rgb, sp.keep);
  let T = mix(T0, T1, saturate(dsw + 0.5));
  let d = (m - SCOPE_BODY) / max(fwidth(m), 1e-4);             // 小器官の輪郭からの px
  let gate = select(aaStep(n, SCOPE_GATE * O.scopeSpeck), 1.0, O.scopeSpeck <= 0.0);    // 体の外の小さな塊は描かない
  let cover = saturate(d + 0.5) * gate;
  col = mix(col, line, 0.4 * saturate(0.5 * w + 0.5 - abs(d + 1.5 * w)) * gate);

  let e = 1.0 / vec2f(textureDimensions(smallBlur));
  let g = vec2f(
    textureSampleLevel(smallBlur, samp, uv + vec2f(e.x, 0.0), 0.0).a - textureSampleLevel(smallBlur, samp, uv - vec2f(e.x, 0.0), 0.0).a,
    textureSampleLevel(smallBlur, samp, uv + vec2f(0.0, e.y), 0.0).a - textureSampleLevel(smallBlur, samp, uv - vec2f(0.0, e.y), 0.0).a);
  let tilt = -dot(g, SCOPE_LIGHT) * SCOPE_SLOPE;               // 光に面した縁が正
  let nrm = normalize(vec3f(-g * SCOPE_SLOPE, 1.0));
  let spec = pow(saturate(dot(nrm, normalize(vec3f(SCOPE_LIGHT * 0.5, 1.0)))), 48.0);

  let thick = mix(0.7, 1.0, smoothstep(0.15, 0.85, l.a));      // 大きな塊ほど厚い
  var body = col * pow(T, vec3f(k * m * thick * (1.0 + 1.2 * (noise.r - 0.5) + 1.0 * (noise.b - 0.5))));
  body *= 1.0 + SCOPE_RELIEF * clamp(tilt, -1.0, 1.0);
  body *= 1.0 - 0.2 * smoothstep(0.85, 1.0, l.a);              // 核小体
  body += SCOPE_SPEC * spec;
  let ring = cover * (1.0 - saturate(d - 1.3 * w + 0.5));
  let outline = col * pow(T, vec3f(k * 2.2)) * 0.6;
  // 種類の区切り線: 接する別種の小器官を別の物に見せる (色 = 両側の輪郭の色の平均を暗く)
  let sepCol = col * 0.5 * (pow(T0, vec3f(k * 2.2)) + pow(T1, vec3f(k * 2.2))) * 0.5;
  let sep = SCOPE_SEP_ALPHA * cover * sp.keep * select(0.0, 1.0, sp.i0 != sp.i1) * saturate(SCOPE_SEP_W * w + 0.5 - abs(dsw));
  col = mix(col, body, cover);
  col = mix(col, sepCol, sep);
  col = mix(col, outline, ring);

  col *= 1.0 + 0.16 * (noise.r - 0.5);

  let r = length((uv - 0.5) * R.canvasSize) / length(0.5 * R.canvasSize);    // 角で 1 の円 (アスペクトを保つ)
  col *= 1.0 - 0.55 * O.scopeVignette * smoothstep(0.4, 1.0, r);
  return col;
}

fn sampleLarge(uv: vec2f) -> vec4f {
  return textureSampleLevel(largeBlur, samp, uv, 0.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let uv = frag.xy / R.canvasSize;
  let s = textureSampleLevel(smallBlur, samp, uv, 0.0);

  var col: vec3f;
  switch (O.style) {
    case STYLE_CELL: {
      let g = textureSampleLevel(granuleTex, samp, uv, 0.0).r;
      col = cellStyle(s, sampleLarge(uv), g, textureLoad(paperTex, vec2i(frag.xy), 0).rgb);
    }
    case STYLE_SCOPE: { col = scopeStyle(s, sampleLarge(uv), uv, textureLoad(paperTex, vec2i(frag.xy), 0).rgb); }
    case STYLE_GLASS, default: { col = glassStyle(s, sampleLarge(uv), uv); }
  }
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
