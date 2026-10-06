// dots / トレイル / ポインタ円の WGSL。色は Canvas2D 版と同じくガンマ空間の値をそのまま書く (canvas は非 sRGB)

export const MAX_PALETTE = 16;

// RenderParams = 12 個の f32 (vec2f は 8 バイト境界に置いてある)
export const RENDER_UNIFORM_FLOATS = 12;

export const RENDER_COMMON = /* wgsl */`
struct RenderParams {
  worldSize: vec2f,
  canvasSize: vec2f,    // 以下 px はすべてデバイス px
  radiusPx: f32,
  pointerRadiusPx: f32,
  lineWidthPx: f32,
  fade: f32,
  pointerPos: vec2f,
  pointerMode: f32,     // +1 引力 / -1 斥力
  particleAlpha: f32,
};

@group(0) @binding(0) var<uniform> R: RenderParams;

const BG = vec3f(1.0 / 255.0, 14.0 / 255.0, 29.0 / 255.0);   // style.css の --bg

// triangle-strip の 4 頂点の四角形 ([-1, 1]^2)
fn quadCorner(vi: u32) -> vec2f {
  return vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2.0 - 1.0;
}

fn pxToNdc(px: vec2f) -> vec2f {
  return vec2f(px.x / R.canvasSize.x * 2.0 - 1.0, 1.0 - px.y / R.canvasSize.y * 2.0);
}
`;

// 全画面三角形
export const FULLSCREEN_VS = /* wgsl */`
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const particleWGSL = RENDER_COMMON + /* wgsl */`
@group(0) @binding(1) var<uniform> palette: array<vec4f, ${MAX_PALETTE}>;
@group(0) @binding(2) var<storage, read> posVel: array<vec4f>;
@group(0) @binding(3) var<storage, read> particleMeta: array<vec2u>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) offsetPx: vec2f,
  @location(1) color: vec3f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let p = posVel[ii];
  let t = min(particleMeta[ii].x, ${MAX_PALETTE - 1}u);
  let corner = quadCorner(vi);
  let half = R.radiusPx + 1.0;                           // AA 用の 1px
  let centerPx = p.xy / R.worldSize * R.canvasSize;
  var out: VSOut;
  out.offsetPx = corner * half;
  out.pos = vec4f(pxToNdc(centerPx + out.offsetPx), 0.0, 1.0);
  out.color = palette[t].rgb;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let d = length(in.offsetPx);
  let a = clamp(R.radiusPx + 0.5 - d, 0.0, 1.0);
  return vec4f(in.color, a * R.particleAlpha);
}
`;

export const fadeWGSL = RENDER_COMMON + FULLSCREEN_VS + /* wgsl */`
@fragment
fn fs() -> @location(0) vec4f {
  return vec4f(BG, R.fade);
}
`;

export const blitWGSL = FULLSCREEN_VS + /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return vec4f(textureLoad(src, vec2i(pos.xy), 0).rgb, 1.0);
}
`;

// ポインタ円: 周期境界なので 3x3 のコピーを instance で描く
export const pointerWGSL = RENDER_COMMON + /* wgsl */`
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) offsetPx: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let ox = f32(i32(ii % 3u) - 1);
  let oy = f32(i32(ii / 3u) - 1);
  let corner = quadCorner(vi);
  let half = R.pointerRadiusPx + R.lineWidthPx + 1.0;
  let centerPx = (R.pointerPos + vec2f(ox * R.worldSize.x, oy * R.worldSize.y)) / R.worldSize * R.canvasSize;
  var out: VSOut;
  out.offsetPx = corner * half;
  out.pos = vec4f(pxToNdc(centerPx + out.offsetPx), 0.0, 1.0);
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let d = length(in.offsetPx);
  let fill = clamp(R.pointerRadiusPx - d + 0.5, 0.0, 1.0) * 0.08;
  let ring = clamp(R.lineWidthPx * 0.5 + 0.5 - abs(d - R.pointerRadiusPx), 0.0, 1.0) * 0.9;
  let a = ring + fill * (1.0 - ring);
  // Canvas2D 版: attract rgb(80,255,140) / repel rgb(255,90,80)
  let color = select(vec3f(255.0, 90.0, 80.0), vec3f(80.0, 255.0, 140.0), R.pointerMode >= 0.0) / 255.0;
  return vec4f(color, a);
}
`;
