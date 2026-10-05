// 有機的な描画 (スクリーン空間メタボール) 用 WGSL。2 パス構成:
//   splat     : 粒子ごとの四角形を field テクスチャへ加算 (rgb = 色 x w, a = w)
//   composite : field をバイリニアでサンプルし、しきい値で塗り + 核の暗さ + 法線ライティング + リム
// 共通の RenderParams (binding 0) は render.wgsl.js のものをそのまま使う。

import { MAX_PALETTE, RENDER_COMMON } from './render.wgsl.js';

// OrganicParams = 48 バイト = 12 個の f32 (vec2f は offset 0 のみ)
export const ORGANIC_UNIFORM_FLOATS = 12;

const ORGANIC_COMMON = RENDER_COMMON + /* wgsl */`
struct OrganicParams {
  fieldSize: vec2f,     // field テクスチャの px
  splatRadius: f32,     // ワールド単位
  stretch: f32,         // 速度方向の伸び
  maxSpeed: f32,        // 伸びの正規化用 (ワールド単位 / 秒)
  restDensity: f32,     // 密度の基準 (重みの切り替え用)
  coreBoost: f32,       // 密度が高い粒子のフィールド重み
  threshold: f32,       // 輪郭のしきい値 (field.a)
  edge: f32,            // 輪郭のなだらかさ
  rimStrength: f32,
  normalScale: f32,     // 法線の傾き (勾配の倍率)
  weightNorm: f32,      // 粒子 1 個あたりの基準重み (restDensity の構造内部で field ~ 1)
};
`;

export const splatWGSL = ORGANIC_COMMON + /* wgsl */`
@group(0) @binding(1) var<uniform> palette: array<vec4f, ${MAX_PALETTE}>;
@group(0) @binding(2) var<storage, read> posVel: array<vec4f>;
@group(0) @binding(3) var<storage, read> particleMeta: array<vec2u>;
@group(0) @binding(4) var<storage, read> density: array<f32>;
@group(0) @binding(5) var<uniform> O: OrganicParams;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) d: vec2f,                       // 楕円内の正規化座標 ([-1, 1]^2)
  @location(1) color: vec3f,
  @location(2) weight: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let p = posVel[ii];
  let t = min(particleMeta[ii].x, ${MAX_PALETTE - 1}u);
  let c = quadCorner(vi);

  // 速度方向に伸ばした楕円 (面積はほぼ保つ: 長軸 x k, 短軸 / sqrt(k))
  let speed = length(p.zw);
  let k = 1.0 + O.stretch * min(speed / max(O.maxSpeed, 1e-4), 1.5);
  let dir = select(vec2f(1.0, 0.0), p.zw / max(speed, 1e-6), speed > 1e-6);
  let perp = vec2f(-dir.y, dir.x);
  let offsetWorld = (dir * (c.x * k) + perp * (c.y / sqrt(k))) * O.splatRadius;
  let posPx = (p.xy + offsetWorld) / R.worldSize * R.canvasSize;

  // 重みは近傍数の推定に比例させる: weightNorm は restDensity の構造内部で field ~ 1 になる正規化係数。
  // 背景 (密度 5〜10) はしきい値未満、構造の内部は超え、芯 (密度が restDensity 超) は coreBoost 倍。
  // 孤立した粒子は norm だけだと見えないので、密度が低いほど小さな粒が残る重みを足す。
  let dens = density[ii];
  let core = smoothstep(O.restDensity * 0.5, O.restDensity * 1.5, dens);
  let speck = 0.62 * (1.0 - smoothstep(0.0, 3.0, dens));
  let w = O.weightNorm * mix(1.0, O.coreBoost, core) + speck;

  var out: VSOut;
  out.pos = vec4f(pxToNdc(posPx), 0.0, 1.0);
  out.d = c;
  out.color = palette[t].rgb;
  out.weight = w;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let d2 = dot(in.d, in.d);
  if (d2 >= 1.0) { discard; }
  let q = 1.0 - d2;
  let w = q * q * q * in.weight;
  return vec4f(in.color * w, w);
}
`;

export const compositeWGSL = ORGANIC_COMMON + /* wgsl */`
@group(0) @binding(1) var<uniform> O: OrganicParams;
@group(0) @binding(2) var field: texture_2d<f32>;
@group(0) @binding(3) var fieldSampler: sampler;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn sampleField(uv: vec2f) -> vec4f {
  return textureSampleLevel(field, fieldSampler, uv, 0.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let uv = frag.xy / R.canvasSize;
  let s = sampleField(uv);
  let F = s.a;
  let th = O.threshold;
  if (F < th * 0.3) { discard; }                   // 何もない所は触らない (トレイルを保つ)

  let C = s.rgb / max(F, 1e-4);                    // 加重平均色
  let fill = smoothstep(th - O.edge, th + O.edge, F);

  // 勾配 (field の 1 テクセルの中心差分) -> 法線
  let texel = 1.0 / O.fieldSize;
  let gx = sampleField(uv + vec2f(texel.x, 0.0)).a - sampleField(uv - vec2f(texel.x, 0.0)).a;
  let gy = sampleField(uv + vec2f(0.0, texel.y)).a - sampleField(uv - vec2f(0.0, texel.y)).a;
  let grad = vec2f(gx, gy) * 0.5;
  let n = normalize(vec3f(-grad * O.normalScale, 1.0));
  let L = normalize(vec3f(-0.5, -0.6, 0.65));      // 左上手前から (画面 y は下向き)
  let diffuse = 0.62 + 0.45 * dot(n, L);

  // 核: フィールドが高いほど暗く・彩度を上げる
  let core = smoothstep(th * 1.3, th * 3.6, F);
  let luma = dot(C, vec3f(0.299, 0.587, 0.114));
  var col = mix(vec3f(luma), C, 1.0 + 0.25 * core);
  col = col * (1.0 - 0.6 * core);
  // 等高線の薄い模様 (細胞質)
  col = col * (1.0 + 0.04 * sin(F * 18.0));
  col = clamp(col * diffuse, vec3f(0.0), vec3f(1.0));

  // リム: 輪郭付近の細い明るい帯 (縁の傾きが強いほど強調)
  let band = smoothstep(th - O.edge * 2.0, th, F) * (1.0 - smoothstep(th, th + O.edge * 4.0, F));
  let rim = band * O.rimStrength;
  let rimColor = mix(C, vec3f(1.0), 0.6);

  // 半透明の縁 (膜) と不透明に近い内部
  let bodyAlpha = fill * mix(0.86, 0.98, core);
  let a = clamp(bodyAlpha + rim * 0.9, 0.0, 1.0);
  let premult = col * bodyAlpha * (1.0 - rim * 0.5) + rimColor * rim * 0.9;
  return vec4f(clamp(premult / max(a, 1e-4), vec3f(0.0), vec3f(1.0)), a);
}
`;
