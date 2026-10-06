// 有機的な描画 (スクリーン空間のフィールド) 用 WGSL。パス構成 (docs/organic-rendering-spec.md):
//   splat      : 粒子ごとの四角形を field テクスチャへ加算 (rgb = 色 x w, a = w)。
//                cell だけは同じパスで「顆粒」テクスチャ (細胞内小器官) にも書く (MRT)
//   shape      : field をスタイルの shape (src/organicStyles.js) に合わせて 0..1 の指標に整形する
//   downsample : 1/2 ずつ縮小。ブラーの σ が大きいとき、低解像度でぼかして安くする
//   blur       : 分離ガウスぼかし (水平 / 垂直)。バイリニアで 2 テクセルを 1 フェッチにまとめたタップ表を使う
//   composite  : small (= disk) と large (= ring) のぼかしからスタイルごとに着色して canvas へ (不透明)
// 共通の RenderParams (binding 0) は render.wgsl.js のものをそのまま使う (splat / composite)。

import { MAX_PALETTE, RENDER_COMMON, FULLSCREEN_VS } from './render.wgsl.js';
import { assertStructLayout } from './common.wgsl.js';
import { ORGANIC_STYLES, SHAPE_INDEX } from '../../organicStyles.js';

// OrganicParams のフィールド (uniform を書く順。WGSL の struct と一致させる = assertOrganicLayout が起動時に確認)。
// スタイル用の項目は config.js の項目名と同じ (renderer.js がそのままコピーする)。style だけ u32、ほかは f32。
export const ORGANIC_FIELDS = [
    'weightNorm', 'splatRadius', 'fieldGain', 'style', 'shape', 'glowIntensity', 'bandFreq', 'threshold',
    'nucleusThreshold', 'speciesTint', 'dpr', 'bandBase', 'rimStrength', 'coreThreshold',
];
export const ORGANIC_UNIFORM_FLOATS = ORGANIC_FIELDS.length;

// BlurParams = 16 + 17 * 16 = 288 バイト = 72 個の 4 バイト値 (count だけ u32。texel の次の u32 = count、taps は 16 バイト境界)
//   taps[0] = 中心 (offset 0, weight)、taps[1..count] = 左右対称のペア (offset テクセル, weight)
export const BLUR_MAX_PAIRS = 16;
export const BLUR_UNIFORM_FLOATS = 4 + 4 * (BLUR_MAX_PAIRS + 1);

// スタイル表 (organicStyles.js) から作る WGSL 定数: STYLE_<NAME> (style) と SHAPE_<NAME> (shape)
const STYLE_CONSTS = [
    ...Object.entries(ORGANIC_STYLES).map(([name, s]) => `const STYLE_${name.toUpperCase()} = ${s.index}u;`),
    ...Object.entries(SHAPE_INDEX).map(([name, i]) => `const SHAPE_${name.toUpperCase()} = ${i}u;`),
].join('\n');

const ORGANIC_SHARED = /* wgsl */`
struct OrganicParams {
  weightNorm: f32,        // 粒子 1 個の重み (平均密度の一様な場で field = 1 になる正規化)
  splatRadius: f32,       // スプラット半径 (ワールド単位)
  fieldGain: f32,         // field に掛ける倍率 (全スタイル共通)
  style: u32,             // STYLE_*
  shape: u32,             // SHAPE_*
  glowIntensity: f32,     // glow: 輪郭の明るさ
  bandFreq: f32,          // bands: 縞の周波数
  threshold: f32,         // 密度のしきい値 (平均密度の倍率): これ未満は「空き」(ガス) として切り捨てる (shape = occupancy)
  nucleusThreshold: f32,  // cell: 核が始まる大きなぼかしの占有度 (0..1)
  speciesTint: f32,       // 種類の色をどれだけ混ぜるか
  dpr: f32,               // 紙の目・線の太さを CSS px で決めるため
  bandBase: f32,          // bands: 密度 0 (空き) の r。freq * base^3 が空きの位相
  rimStrength: f32,       // glass: 膜の線の太さ・濃さ
  coreThreshold: f32,     // glass: 核の指標のしきい値 (圧縮した密度、0..1)
};

${STYLE_CONSTS}

const EPS = 1e-4;

// 加重平均色 (rgb = 色 x w, a = w のぼかし結果から)
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

// 顆粒 (cell): 一部の粒子だけが、向きがランダムな小さな楕円を出す。粒子といっしょに動く
const GRANULE_FRACTION = 0.03;   // 粒子のうち顆粒になる割合
const GRANULE_LONG = 0.42;       // 長軸 (スプラット半径に対する比)
const GRANULE_ASPECT = 1.7;      // 長軸 / 短軸
const TAU = 6.2831853;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) d: vec2f,                                // 四角形内の正規化座標 ([-1, 1]^2)
  @location(1) color: vec3f,
  @location(2) @interpolate(flat) dir: vec2f,           // 顆粒の長軸の向き (cell の顆粒の粒子だけ)
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

// instance = 粒子 x 4。周期境界なので、端をまたぐ分は反対側にもう 1 つ描く
// (コピー 0 = 本体、1 = x ずらし、2 = y ずらし、3 = 両方)。ずらした四角形が世界に掛からない粒子 (端から
// splatRadius 以内でない) は、色やハッシュを読む前に縮退した位置を返して捨てる
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let pi = ii >> 2u;
  let copy = ii & 3u;
  let p = posVel[pi];
  let world = R.worldSize;
  let s = O.splatRadius;

  var out: VSOut;
  let nearX = p.x < s || p.x > world.x - s;
  let nearY = p.y < s || p.y > world.y - s;
  if (((copy & 1u) != 0u && !nearX) || ((copy & 2u) != 0u && !nearY)) {
    out.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    return out;
  }

  var shift = vec2f(0.0);
  if ((copy & 1u) != 0u) { shift.x = select(world.x, -world.x, p.x > 0.5 * world.x); }
  if ((copy & 2u) != 0u) { shift.y = select(world.y, -world.y, p.y > 0.5 * world.y); }
  let pm = particleMeta[pi];
  let t = min(pm.x, ${MAX_PALETTE - 1}u);
  let c = quadCorner(vi);
  let posPx = (p.xy + shift + c * s) / world * R.canvasSize;

  out.pos = vec4f(pxToNdc(posPx), 0.0, 1.0);
  out.d = c;
  out.color = palette[t].rgb;
  if (O.style == STYLE_CELL && hashF(pm.y * 2u) < GRANULE_FRACTION) {
    let a = TAU * hashF(pm.y * 2u + 1u);
    out.dir = vec2f(cos(a), sin(a));
    out.org = 1.0;
  }
  return out;
}

// カーネル (1 - d^2)^3 x 重み。四角形の外 (円の外) は捨てる
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

// cell: field と顆粒 (向きを回した楕円: 長軸 GRANULE_LONG、短軸 / GRANULE_ASPECT) の MRT
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

// field (密度、平均 = 1。既定の設定での実測: ガス (数個〜十数個の粒の小さな塊) は ~0.5〜3.5、構造の芯は 5〜30 倍。
// 値はスプラット半径が小さいほど尖る) を、ぼかす前にスタイルの shape へ整形する。
// 出力は splat と同じ形式 (rgb = 平均色 x c, a = c) なので、あとのぼかし・縮小はそのまま使える。
//   SHAPE_OCCUPANCY (glow / mono / cell) : c = 占有度 = 1 - exp(-SHARP * max(密度 - しきい値, 0))。ガスは 0、構造の内部は ~1。
//                        SmoothLife の「場の値 (0 か 1 に近い)」に当たる。これを小 / 大のぼかしにかけて disk / ring の平均にする
//   SHAPE_COMPRESS (bands) : c = 密度を滑らかに圧縮したもの (ガスの塊はほぼ 0 のまま、構造の縁で立ち上がって芯で飽和)
//   SHAPE_NUCLEUS (glass)  : c = 圧縮した密度が coreThreshold を超えた所 = 核の指標 (0 か 1 に近い)。体・核・膜はすべてこのぼかしから作る
export const shapeWGSL = ORGANIC_SHARED + FULLSCREEN_VS + /* wgsl */`
@group(0) @binding(0) var<uniform> O: OrganicParams;
@group(0) @binding(1) var src: texture_2d<f32>;

const OCC_SHARP = 2.0;
// 圧縮: 密度 v (平均 = 1) を 0..1 に: 1 - exp(-(v / s)^p)。ぼかす前に飽和させるので、芯の粒子ノイズが縞に乗らない。
//   glass (nucleus) : s = 3.5, p = 1.8。coreThreshold (既定 0.8 = v ~4.6) で切るための目盛り
//   bands (compress): s = 6, p = 2.5。スプラットが 0.3 rMax のときの実測で、ガスの塊 (v ≦ ~3.5) は c ≦ 0.2 (空きの青のレリーフ)、
//                     構造 (v 中央値 ~9) で ~0.9 に飽和する。s = 3.5 だとガスの塊がすべて黄〜赤の点になっていた
const NUCLEUS_S = 3.5;
const NUCLEUS_P = 1.8;
const BANDS_S = 6.0;
const BANDS_P = 2.5;

fn compress(v: f32, s: f32, p: f32) -> f32 {
  return 1.0 - exp(-pow(v / s, p));
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let f = textureLoad(src, vec2i(frag.xy), 0);
  let v = f.a * O.fieldGain;
  var c: f32;
  switch (O.shape) {
    case SHAPE_COMPRESS: { c = compress(v, BANDS_S, BANDS_P); }
    case SHAPE_NUCLEUS: { c = smoothstep(O.coreThreshold - 0.1, O.coreThreshold + 0.1, compress(v, NUCLEUS_S, NUCLEUS_P)); }
    case SHAPE_OCCUPANCY, default: { c = 1.0 - exp(-OCC_SHARP * max(v - O.threshold, 0.0)); }
  }
  return vec4f(meanColor(f) * c, c);
}
`;

// 1/2 に縮小 (2x2 の箱平均)。出力のテクセル (x, y) は入力の (2x..2x+1, 2y..2y+1) を平均する
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

// 分離ガウスぼかしの 1 方向。入力と出力は同じ大きさ。サンプラは repeat (ワールドが周期境界のため)
export const blurWGSL = FULLSCREEN_VS + /* wgsl */`
struct BlurParams {
  texel: vec2f,                                  // 1 テクセル分の UV (水平 (1/w, 0) / 垂直 (0, 1/h))
  count: u32,                                    // ペアタップの数 (offset 8。taps は array<vec4f> の 16 バイト境界 = offset 16)
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

export const compositeWGSL = ORGANIC_COMMON + FULLSCREEN_VS + /* wgsl */`
@group(0) @binding(1) var<uniform> O: OrganicParams;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var smallBlur: texture_2d<f32>;     // disk: 小さなぼかし (rgb = 色 x c, a = c)
@group(0) @binding(4) var largeBlur: texture_2d<f32>;     // ring: 大きなぼかし (large を使わないスタイルでは small が入っていて読まない)
@group(0) @binding(5) var granuleTex: texture_2d<f32>;    // 顆粒 (r。cell 以外では small が入っていて読まない)

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.299, 0.587, 0.114));
}

// 種類の色を明るさを保って混ぜる (色相だけ寄せる)
fn tinted(base: vec3f, c: vec3f, amount: f32) -> vec3f {
  let k = luma(base) / max(luma(c), 0.05);
  return mix(base, clamp(c * k, vec3f(0.0), vec3f(1.0)), amount);
}

// 半分の強さの混ぜ (bands / mono)
fn tintedHalf(base: vec3f, c: vec3f) -> vec3f {
  return tinted(base, c, O.speciesTint * 0.5);
}

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

// 以下 s = 小さなぼかし (disk)、l = 大きなぼかし (ring)。どちらも整形済みの場 (shape) のぼかしで、
// a = shape の指標 (occupancy: 占有度 / compress: 圧縮した密度 / nucleus: 核の指標)、rgb / a = 平均色。

// ---- cell: 水彩の細胞イラスト (青 -> ミント -> 淡黄の体、紫の核、薄い顆粒、紙の目)
//      体の縁 = 占有度 0.5 の等高線、深さ = 大きなぼかしの占有度 (縁 0.5 -> 内部 1)、核 = 大きなぼかしがほぼ満杯の所
fn cellStyle(s: vec4f, l: vec4f, g: f32, px: vec2f) -> vec3f {
  let C = meanColor(s);                                 // 種類の平均色
  let m = s.a;
  let n = l.a;

  // 紙: オフホワイト + 目 (紙は動かないので画面固定のノイズ)。目の濃淡 gk は顔料のムラにも使う
  let grain = 0.6 * vnoise(px * 0.8) + 0.4 * vnoise(px * 2.3 + 9.1);
  let gk = 0.2 * (grain - 0.5);
  let paper = vec3f(0.96, 0.945, 0.90) * (0.95 + 0.07 * grain);

  // 体: 縁を低周波ノイズで少し揺らす (やや不規則な縁)
  let wob = (fbm(px * 0.045) - 0.5) * 0.3;
  let mb = mix(m, n, 0.4) + wob;
  let body = smoothstep(0.3, 0.62, mb);
  let bleed = smoothstep(0.05, 0.3, mb) * (1.0 - body);    // 縁の外側ににじむ薄い青

  // 深さ: 縁 0 -> 内部 1 (大きなぼかしを混ぜて丸い勾配にする)
  let dm = mix(m, n, 0.6);
  let depth = smoothstep(0.45, 0.98, dm);

  // 青 (外) -> ミント -> 淡黄 (内)
  var col = mix(vec3f(0.36, 0.56, 0.86), vec3f(0.72, 0.91, 0.82), smoothstep(0.0, 0.55, depth));
  col = mix(col, vec3f(0.99, 0.96, 0.72), smoothstep(0.45, 1.0, depth));
  col = tinted(col, C, O.speciesTint);

  // 縁に顔料が溜まった少し濃い帯 + 紙の目による顔料のムラ
  let rimBand = body * (1.0 - smoothstep(0.5, 0.85, dm));
  col = mix(col, col * vec3f(0.80, 0.86, 1.0), rimBand * 0.55);
  col *= 1.0 - gk * body;

  // 顆粒: 体の内側だけ、薄く暗い楕円
  let inner = smoothstep(0.35, 0.7, depth);
  let gr = smoothstep(0.25, 0.75, g) * inner;
  col = mix(col, col * vec3f(0.66, 0.66, 0.76), gr * 0.55);

  // 核: 少し粗い (ノイズで揺らした) くっきりした縁、縁が濃く中心がやや明るい紫。
  // ノイズの揺らぎは ±0.06、smoothstep の幅は 0.03: n がしきい値より 0.09 以上低い所は核が 0 なので fbm を省く
  var nuc = 0.0;
  var nCol = vec3f(0.0);
  if (n > O.nucleusThreshold - 0.09) {
    let vn = n + (fbm(px * 0.11 + 5.3) - 0.5) * 0.12;
    nuc = smoothstep(O.nucleusThreshold - 0.03, O.nucleusThreshold + 0.03, vn) * body;
    let nd = saturate((vn - O.nucleusThreshold) / max(1.0 - O.nucleusThreshold, 0.05));
    nCol = mix(vec3f(0.38, 0.19, 0.50), vec3f(0.54, 0.34, 0.65), smoothstep(0.0, 1.0, nd));
    nCol = tinted(nCol, C, O.speciesTint * 0.6);
    nCol *= 1.0 - gk;
  }

  let halo = mix(paper, paper * vec3f(0.86, 0.93, 1.0), bleed * 0.6);
  return mix(mix(halo, col, body), nCol, nuc);
}

// ---- glow: SmoothLife (st3) の輪郭発光。m = disk, n = ring の平均として
//      glow = max((1-n)^2 - (1-m)^2, 0) * 4。密な構造の内側の縁と穴の縁が光り、一様な内部では打ち消し合う
fn glowStyle(s: vec4f, l: vec4f) -> vec3f {
  let m = s.a;
  let n = l.a;
  var col = vec3f(0.2) * m + vec3f(0.0, 0.2, 0.2) * n;  // 薄いベース (st3 の CellColor / RingColor)
  let a = 1.0 - n;
  let b = 1.0 - m;
  col += tinted(vec3f(0.6, 0.85, 1.0), meanColor(s), O.speciesTint) * (max(a * a - b * b, 0.0) * 4.0 * O.glowIntensity);
  return col;
}

// ---- bands: sin(vec3(1,2,3) * freq * r^3) (st1)。r = bandBase + BAND_SPAN * 圧縮した密度 (shape)。
//      空き (密度 0) は st1 と同じ位相 25 * 0.24^3 ~ 0.35 = 明るい青、密度が上がるほど位相が進んで虹の縞を何周もする
const BAND_SPAN = 0.8;        // 密度が飽和したときの r の増分
const BAND_EMBOSS = 0.35;
const BAND_EMBOSS_SLOPE = 6.0;
fn bandsStyle(s: vec4f, uv: vec2f) -> vec3f {
  let r = O.bandBase + BAND_SPAN * s.a;
  var col = max(sin(vec3f(1.0, 2.0, 3.0) * O.bandFreq * r * r * r), vec3f(0.0));
  col = tintedHalf(col, meanColor(s));

  // 控えめなエンボス: 密度を高さとみなして、勾配から固定光源の陰影を掛ける (レリーフ風)
  let e = 1.0 / vec2f(textureDimensions(smallBlur));
  let hx = textureSampleLevel(smallBlur, samp, uv + vec2f(e.x, 0.0), 0.0).a - textureSampleLevel(smallBlur, samp, uv - vec2f(e.x, 0.0), 0.0).a;
  let hy = textureSampleLevel(smallBlur, samp, uv + vec2f(0.0, e.y), 0.0).a - textureSampleLevel(smallBlur, samp, uv - vec2f(0.0, e.y), 0.0).a;
  let nrm = normalize(vec3f(-vec2f(hx, hy) * BAND_EMBOSS_SLOPE, 1.0));
  let light = normalize(vec3f(-0.5, -0.6, 0.65));
  let shade = 1.0 + BAND_EMBOSS * (dot(nrm, light) - light.z);
  return col * shade;
}

// ---- glass: 平らな 2D イラスト風の細胞。ライティング・屈折・陰影は無し。
//      青い背景、一定の淡い水色の半透明の体 (色は付けない)、白い膜の線、種類の色の平らな核 (自分の色の濃い縁取り付き)。
//      色の意味は核だけに持たせる。s / l = 核の指標 (shape) の small / large ぼかし (m, n)。
//      核 = m の 0.5 の等高線の内側、体 = n の等高線の内側 (核を囲む円盤)。核を持たないガスのかたまりは指標が 0 なので何も出ない。
//      輪郭は fwidth で約 1px のアンチエイリアスにして、ぼかしの強さによらず「くっきりだが少し柔らかい」平面の形にする。
const GLASS_EDGE = 0.2;       // 体の輪郭 (large ぼかしの等高線)

// 1px 幅のアンチエイリアス付きのステップ: x > edge で 1
fn aaStep(x: f32, edge: f32) -> f32 {
  return saturate((x - edge) / max(fwidth(x) * 1.3, 1e-4) + 0.5);
}

fn glassStyle(s: vec4f, l: vec4f, uv: vec2f) -> vec3f {
  let Cs = meanColor(s);                                // 細かい場の種類の色 (核の中の模様)
  let m = s.a;
  let n = l.a;

  // 背景: 平らな青 (ごくゆるい上下のグラデーションだけ)
  var col = mix(vec3f(0.27, 0.57, 0.88), vec3f(0.20, 0.47, 0.82), uv.y);

  // 体: 一定の淡い水色の半透明の円盤 (背景に 80%)
  col = mix(col, vec3f(0.62, 0.82, 0.98), 0.8 * aaStep(n, GLASS_EDGE));

  // 膜: 体の輪郭の等高線に沿った一定幅 (canvas px) の白い線。勾配が弱い所 (平らな頂上・くびれ) では出さない
  let gradN = fwidth(n);
  let distPx = abs(n - GLASS_EDGE) / max(gradN, 1e-4);
  let halfW = 0.9 * O.rimStrength * O.dpr;
  let rim = saturate(halfW + 0.75 - distPx) * smoothstep(0.002, 0.005, gradN) * min(0.6 + 0.3 * O.rimStrength, 1.0);
  col = mix(col, vec3f(0.96, 1.0, 1.0), rim);

  // 核: 種類の色の平らな塊 (細かい場の色なので、粒が作る縞や色の混ざりがそのまま残る)。
  // 縁には自分の色を暗く・少し濃くした約 1px の線を入れて、淡い体から分離する
  let d = (m - 0.5) / max(fwidth(m), 1e-4);             // 核の内側へ向かう px 距離 (縁 = 0)
  let coreA = saturate(d + 0.5) * smoothstep(GLASS_EDGE, GLASS_EDGE + 0.06, n);   // 体にならない小さな粒は核としても出さない (体の輪郭の内側だけ)
  let ringW = 1.2 * O.dpr;
  let ring = coreA * (1.0 - saturate(d - ringW + 0.5));
  let outline = clamp(mix(vec3f(luma(Cs)), Cs, 1.25) * 0.62, vec3f(0.0), vec3f(1.0));
  col = mix(col, Cs, coreA);
  col = mix(col, outline, ring);
  return col;
}

// ---- mono: SmoothLife (st2) の生の場のグレースケール。黒地に白い柔らかい構造、穴は黒
fn monoStyle(s: vec4f, l: vec4f) -> vec3f {
  return tintedHalf(vec3f(1.0), meanColor(s)) * smoothstep(0.0, 1.0, mix(s.a, l.a, 0.35));
}

fn sampleLarge(uv: vec2f) -> vec4f {
  return textureSampleLevel(largeBlur, samp, uv, 0.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let uv = frag.xy / R.canvasSize;
  let s = textureSampleLevel(smallBlur, samp, uv, 0.0);

  // 使うテクスチャだけ読む (large は bands が、顆粒は cell 以外が読まない)
  var col: vec3f;
  switch (O.style) {
    case STYLE_CELL: {
      let g = textureSampleLevel(granuleTex, samp, uv, 0.0).r;
      col = cellStyle(s, sampleLarge(uv), g, frag.xy / O.dpr);    // px = CSS px
    }
    case STYLE_GLOW: { col = glowStyle(s, sampleLarge(uv)); }
    case STYLE_BANDS: { col = bandsStyle(s, uv); }
    case STYLE_GLASS: { col = glassStyle(s, sampleLarge(uv), uv); }
    case STYLE_MONO, default: { col = monoStyle(s, sampleLarge(uv)); }
  }
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
