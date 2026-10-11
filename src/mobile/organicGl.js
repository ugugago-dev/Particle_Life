// organic 描画 (スマホ版、scope / glass)。PC 版 src/gpu/renderer.js と organic.wgsl.js を WebGL2 へ移植 (docs/mobile-spec.md の phase 2)

import { ORGANIC_STYLES } from '../organicStyles.js';
import { SCOPE_BG, MAX_STAIN_TYPES, buildStainTables } from '../stainColor.js';

const MAX_PALETTE = 16;
const SIGMA_MAX_TEXELS = 4;               // これを超える σ は 1/2 ずつ縮小してからぼかす
const MAX_BLUR_LEVEL = 6;
const MAX_PAIRS = 6;                      // 中心 + 6 ペア = 最大 13 フェッチ
const DEFAULT_FIELD_SCALE = 0.25;
const PC_RMAX_PX = 0.03 * 1080;           // PC 版の既定 (rMax 0.03、1080 px) での rMax の px。膜の勾配しきい値はこれで調整されている
const PC_RMAX_SMALL_TEXELS = 0.03 * 540;  // PC 版の既定 (fieldScale 0.5、ks 0) での rMax の small テクセル数。scope の斜光はこれで調整されている
const MAX_SOFT_LEVEL = 2;                 // soft 整形はこの段まで field から直接縮小して書く (最大 4x4 フェッチ)

const QUAD = `vec2 quadCorner() { return vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0; }`;

// 粒子 -> field (rgb = 色 x w, a = w) の加算。scope は rgb = (cosθ, sinθ, 0) x w (θ = 種類の角度。docs/scope-species-spec.md)。y はワールド上端が画面上端 (glRenderer の pxToClip と同じ向き)
const SPLAT_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aInst;   // x, y, type
uniform vec2 uWorld;
uniform float uRadius;                // ワールド単位
uniform vec4 uPalette[${MAX_PALETTE}];
uniform float uNumTypes;              // scope: パレットの種類数 (1..16)。0 なら glass (色をそのまま)
out vec2 vD;
out vec3 vColor;
${QUAD}
void main() {
  vec2 c = quadCorner();
  vD = c;
  int t = min(int(aInst.z + 0.5), ${MAX_PALETTE - 1});
  if (uNumTypes > 0.0) {
    float a = 6.2831853 * (float(t) + 0.5) / uNumTypes;
    vColor = vec3(cos(a), sin(a), 0.0);
  } else {
    vColor = uPalette[t].rgb;
  }
  vec2 p = (aInst.xy + c * uRadius) / uWorld;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
}
`;
const SPLAT_FS = `#version 300 es
precision highp float;
uniform float uWeight;
in vec2 vD;
in vec3 vColor;
out vec4 outColor;
void main() {
  float d2 = dot(vD, vD);
  if (d2 >= 1.0) discard;
  float q = 1.0 - d2;
  float w = q * q * q * uWeight;
  outColor = vec4(vColor * w, w);
}
`;

const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// nucleus 整形: 圧縮 1 - exp(-(v / 3.5)^1.8) を coreThreshold ± 0.1 で 0..1 に
const SHAPE_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform float uGain;
uniform float uCore;
out vec4 outColor;
void main() {
  vec4 f = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
  float v = max(f.a * uGain, 0.0);
  float c0 = 1.0 - exp(-pow(v / 3.5, 1.8));
  float c = smoothstep(uCore - 0.1, uCore + 0.1, c0);
  outColor = vec4(f.rgb / max(f.a, 1e-4) * c, c);
}
`;

// occupancy 整形 (scope の small): 1 - exp(-2 max(v - threshold, 0))。threshold は thresholdScale 倍済み。
// 出力 = (e x c, 0, c)、e = f.rg / f.a (種類の角度の平均ベクトル。b は将来の密度用に 0)
const SHAPE_OCC_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform float uGain;
uniform float uThreshold;
out vec4 outColor;
void main() {
  vec4 f = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
  float v = max(f.a * uGain, 0.0);
  float c = 1.0 - exp(-2.0 * max(v - uThreshold, 0.0));
  outColor = vec4(f.rg / max(f.a, 1e-4) * c, 0.0, c);
}
`;

// soft 整形 (scope の large) 1 - exp(-(v / 5)^2) を (e x c, 0, c) へテクセルごとに掛けてから uFactor^2 の箱平均で縮小 (shape + 縮小を 1 パスに)
const SOFT_DOWN_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform float uGain;
uniform int uFactor;
out vec4 outColor;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * uFactor;
  ivec2 hi = textureSize(uSrc, 0) - 1;
  vec4 acc = vec4(0.0);
  for (int j = 0; j < ${1 << MAX_SOFT_LEVEL}; j++) {
    if (j >= uFactor) break;
    for (int i = 0; i < ${1 << MAX_SOFT_LEVEL}; i++) {
      if (i >= uFactor) break;
      vec4 f = texelFetch(uSrc, min(base + ivec2(i, j), hi), 0);
      float v = max(f.a * uGain, 0.0) / 5.0;
      float c = 1.0 - exp(-v * v);
      acc += vec4(f.rg / max(f.a, 1e-4) * c, 0.0, c);    // e x c の箱平均 (負値あり)
    }
  }
  outColor = acc / float(uFactor * uFactor);
}
`;

// scope の画面固定のノイズ (organic.wgsl.js の paperWGSL): r = 粒状、g = 縁の揺らぎ・照明むら、b = 染色のむら
const PAPER_FS = `#version 300 es
precision highp float;
uniform float uDpr;
uniform float uLowScale;              // 低周波 (g, b) の周波数の倍率 (rMax の px が PC の基準と違う分)
out vec4 outColor;
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 17.1) + 0.2 * vnoise(p * 4.1 + 41.7); }
void main() {
  vec2 px = gl_FragCoord.xy / uDpr;
  vec2 lo = px * uLowScale;
  float grain = 0.6 * vnoise(px * 0.8) + 0.4 * vnoise(px * 2.3 + 9.1);
  outColor = vec4(grain, fbm(lo * 0.045), fbm(lo * 0.11 + 5.3), 1.0);
}
`;

// 2x2 の箱平均で 1/2 に縮小 (端はクランプ)
const DOWN_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  ivec2 hi = textureSize(uSrc, 0) - 1;
  outColor = 0.25 * (texelFetch(uSrc, min(p, hi), 0) + texelFetch(uSrc, min(p + ivec2(1, 0), hi), 0)
                   + texelFetch(uSrc, min(p + ivec2(0, 1), hi), 0) + texelFetch(uSrc, min(p + ivec2(1, 1), hi), 0));
}
`;

// 分離ガウスの 1 方向。タップは 2 テクセルを 1 回のバイリニアにまとめた表、repeat で周期境界
const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uDir;                    // 1 テクセル分の UV
uniform int uCount;
uniform vec2 uTaps[${MAX_PAIRS + 1}]; // (offset テクセル, weight)
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(uSrc, 0));
  vec4 acc = texture(uSrc, uv) * uTaps[0].y;
  for (int i = 1; i <= ${MAX_PAIRS}; i++) {
    if (i > uCount) break;
    vec2 o = uDir * uTaps[i].x;
    acc += (texture(uSrc, uv + o) + texture(uSrc, uv - o)) * uTaps[i].y;
  }
  outColor = acc;
}
`;

// 3 次 B スプラインを 4 回のバイリニアで (large は ~16 倍に引き伸ばすので、バイリニアだと fwidth がテクセルごとに段になり膜が折れ線になる)
const BSPLINE_GLSL = `
vec4 bspline(sampler2D t, vec2 uv) {
  vec2 size = vec2(textureSize(t, 0));
  vec2 p = uv * size - 0.5;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = 1.0 - g0;
  vec2 h0 = (i - 0.5 + w1 / g0) / size;
  vec2 h1 = (i + 1.5 + w3 / g1) / size;
  return g0.y * (g0.x * texture(t, h0) + g1.x * texture(t, vec2(h1.x, h0.y)))
       + g1.y * (g0.x * texture(t, vec2(h0.x, h1.y)) + g1.x * texture(t, h1));
}
`;

// glass の着色 (organic.wgsl.js の glassStyle の移植。WGSL は uv.y = 0 が上なので 1 - uv.y)
const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uSmall;
uniform sampler2D uLarge;
uniform vec2 uCanvas;
uniform float uDpr;
uniform float uRim;
uniform float uGradScale;             // 膜を消す勾配のしきい値の倍率 (rMax の px が PC の基準と違う分)
out vec4 outColor;
const float GLASS_EDGE = 0.2;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float aaStep(float x, float edge) { return clamp((x - edge) / max(fwidth(x) * 1.3, 1e-4) + 0.5, 0.0, 1.0); }
${BSPLINE_GLSL}
void main() {
  vec2 uv = gl_FragCoord.xy / uCanvas;
  vec4 s = texture(uSmall, uv);
  float n = bspline(uLarge, uv).a;
  vec3 Cs = s.rgb / max(s.a, 1e-4);
  float m = s.a;

  vec3 col = mix(vec3(0.27, 0.57, 0.88), vec3(0.20, 0.47, 0.82), 1.0 - uv.y);
  col = mix(col, vec3(0.62, 0.82, 0.98), 0.8 * aaStep(n, GLASS_EDGE));

  float gradN = fwidth(n);
  float distPx = abs(n - GLASS_EDGE) / max(gradN, 1e-4);
  float halfW = 0.9 * uRim * uDpr;
  float rim = clamp(halfW + 0.75 - distPx, 0.0, 1.0) * smoothstep(0.002 * uGradScale, 0.005 * uGradScale, gradN) * min(0.6 + 0.3 * uRim, 1.0);
  col = mix(col, vec3(0.96, 1.0, 1.0), rim);

  float d = (m - 0.5) / max(fwidth(m), 1e-4);
  float coreA = clamp(d + 0.5, 0.0, 1.0) * smoothstep(GLASS_EDGE, GLASS_EDGE + 0.06, n);
  float ring = coreA * (1.0 - clamp(d - 1.2 * uDpr + 0.5, 0.0, 1.0));
  vec3 outline = clamp(mix(vec3(luma(Cs)), Cs, 1.25) * 0.62, 0.0, 1.0);
  col = mix(col, Cs, coreA);
  col = mix(col, outline, ring);
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

// scope の着色 (organic.wgsl.js の scopeStyle の移植)。y は GL の上向きなので斜光の勾配だけ画面の下向きに直す
const SCOPE_FS = `#version 300 es
precision highp float;
uniform sampler2D uSmall;
uniform sampler2D uLarge;
uniform sampler2D uPaper;
uniform vec2 uCanvas;
uniform float uDpr;
uniform float uGradScale;             // 壁を消す勾配のしきい値の倍率 (rMax の px が PC の基準と違う分)
uniform float uReliefScale;           // 斜光の勾配の倍率 (rMax の small テクセル数が PC の基準と違う分)
uniform float uStain;
uniform float uVignette;
uniform float uSpeck;
uniform float uNumTypes;              // パレットの種類数 (1..16)
uniform vec4 uTransmit[${MAX_STAIN_TYPES}];            // 種類ごとの染色の透過率 (stainColor.js の buildStainTables)
out vec4 outColor;
const vec3 SCOPE_BG = vec3(${SCOPE_BG.join(', ')});    // stainColor.js と共有
const float SCOPE_EDGE = 0.2;
const float SCOPE_GATE = 0.2;
const float SCOPE_BODY = 0.35;
const float SCOPE_CYTO = 0.1;
const float SCOPE_STAIN_REF = 1.5;
const vec2 SCOPE_LIGHT = vec2(-0.6, -0.8);
const float SCOPE_SLOPE = 3.0;
const float SCOPE_RELIEF = 0.18;
const float SCOPE_SPEC = 0.15;
const float PI = 3.14159265;
const float TAU = 6.2831853;
const float SCOPE_PURITY_LO = 0.3;
const float SCOPE_PURITY_HI = 0.55;
const float SCOPE_PURITY_CAP_LO = 0.55;
const float SCOPE_PURITY_CAP_HI = 0.75;
const float SCOPE_MIX_LIGHT = 0.5;
const float SCOPE_MIX_COVER = 0.0;
const float SCOPE_SEP_W = 0.4;
const float SCOPE_SEP_ALPHA = 0.5;
${BSPLINE_GLSL}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
// 種類の角度の平均ベクトル e (|e| = 純度) から種類を復元する (organic.wgsl.js の decodeSpecies)。
// i0 / i1 = e を挟む 2 つの種類 (角度順)、side = 切り替えの半直線までの e 空間の符号付き距離 (i1 側が正)、keep = 彩度を残す割合
struct Species {
  int i0;
  int i1;
  float side;
  float keep;
};
Species decodeSpecies(vec2 e) {
  float N = max(uNumTypes, 1.0);
  float ang = TAU / N;
  float pur = length(e);
  vec2 ee = pur < 1e-6 ? vec2(1.0, 0.0) : e;                // atan2(0, 0) を避ける
  float fl = floor(atan(ee.y, ee.x) / ang - 0.5);          // 連続な種類座標 u の整数部
  Species sp;
  sp.i0 = int(mod(fl, N));                                  // % は負で未定義なので float の mod (>= 0)
  sp.i0 = min(sp.i0, int(N) - 1);
  sp.i1 = sp.i0 + 1 >= int(N) ? 0 : sp.i0 + 1;
  float phi = (fl + 1.0) * ang;
  sp.side = dot(e, vec2(-sin(phi), cos(phi)));
  float h = PI / max(N, 2.0);                               // N = 1 は 2 として扱う (常に keep = 1)
  float a = cos(2.0 * h);
  float b = cos(h);
  sp.keep = smoothstep(min(mix(a, b, SCOPE_PURITY_LO), SCOPE_PURITY_CAP_LO), min(mix(a, b, SCOPE_PURITY_HI), SCOPE_PURITY_CAP_HI), pur);
  return sp;
}
// 灰色へ (1 - keep) だけ寄せる (透過率なので明るくする = 淡い染色)
vec3 desaturate(vec3 c, float keep) { return mix(vec3(mix(luma(c), 1.0, SCOPE_MIX_LIGHT)), c, keep); }
void main() {
  vec2 uv = gl_FragCoord.xy / uCanvas;
  vec3 noise = texelFetch(uPaper, ivec2(gl_FragCoord.xy), 0).rgb;
  vec4 s = bspline(uSmall, uv);       // small も ~4 倍に引き伸ばすので、バイリニアだと小器官の輪郭が多角形になる
  vec4 l = bspline(uLarge, uv);
  float m = s.a;
  float n = l.a + (noise.g - 0.5) * 0.08;
  float fwN = fwidth(n);
  // m の勾配は small の ±1 テクセルの中央差分 (fwidth は 4 倍に引き伸ばした平らな所で 2x2 ごとに乱れ、輪郭線が櫛状になる)。gd.y は画面の下向き
  vec2 e = 1.0 / vec2(textureSize(uSmall, 0));
  vec2 gd = vec2(0.0);
  if (m > 0.05) {
    gd = vec2(
      textureLod(uSmall, uv + vec2(e.x, 0.0), 0.0).a - textureLod(uSmall, uv - vec2(e.x, 0.0), 0.0).a,
      textureLod(uSmall, uv - vec2(0.0, e.y), 0.0).a - textureLod(uSmall, uv + vec2(0.0, e.y), 0.0).a);
  }
  vec2 gm = gd * 0.5 / (e * uCanvas);
  float fwM = abs(gm.x) + abs(gm.y);
  float k = uStain / SCOPE_STAIN_REF;
  float w = uDpr;
  vec3 line = vec3(1.0, 1.0, 0.96);

  // 種類: 微分は分岐の外で先に取る (atan2 の折り返しを避けるため u ではなく e の変化を使う)
  vec2 es = s.rg / max(s.a, 1e-4);
  float gradE = length(dFdx(es)) + length(dFdy(es));         // 1 px あたりの e の変化
  Species sp = decodeSpecies(es);
  Species spl = decodeSpecies(l.rg / max(l.a, 1e-4));

  vec3 col = SCOPE_BG * (1.0 + 0.05 * (noise.g - 0.5));
  float dist = (n - SCOPE_EDGE) / max(fwN, 1e-4);
  float inside = clamp(dist + 0.5, 0.0, 1.0);
  if (inside > 0.0) {
    // 細胞質: 隣の種類との線形補間 (u の幅 0.5 の柔らかい切り替え)
    float hl = sin(min(PI / max(uNumTypes, 1.0), 0.5 * PI));
    vec3 Tl = desaturate(mix(uTransmit[spl.i0].rgb, uTransmit[spl.i1].rgb, clamp(spl.side / max(hl, 0.1) + 0.5, 0.0, 1.0)), spl.keep);
    col *= mix(vec3(1.0), pow(Tl, vec3(SCOPE_CYTO * uStain)), inside);
  }
  float fade = smoothstep(0.002 * uGradScale, 0.005 * uGradScale, fwN);
  col = mix(col, line, 0.7 * clamp(0.6 * w + 0.5 - abs(dist + 1.6 * w), 0.0, 1.0) * fade);
  col = mix(col, vec3(0.32, 0.33, 0.33), 0.65 * clamp(0.7 * w + 0.5 - abs(dist), 0.0, 1.0) * fade);

  float d = (m - SCOPE_BODY) / max(fwM, 1e-4);
  float gate = uSpeck <= 0.0 ? 1.0 : clamp((n - SCOPE_GATE * uSpeck) / max(fwN * 1.3, 1e-4) + 0.5, 0.0, 1.0);
  float dsw = sp.side / max(gradE, 1e-5);                    // 種類の切り替えからの px (i1 側が正)
  float pure = gate * mix(SCOPE_MIX_COVER, 1.0, sp.keep);    // 混合域 (離れた種類の隙間をぼかしが埋めた所) は薄く: 下の細胞質・背景が見える
  float cover = clamp(d + 0.5, 0.0, 1.0) * pure;
  float edgeFade = smoothstep(0.015 * uGradScale, 0.045 * uGradScale, fwM);    // 鞍点 (勾配 ~0) では輪郭線を出さない (スマホ版だけ)
  col = mix(col, line, 0.4 * clamp(0.5 * w + 0.5 - abs(d + 1.5 * w), 0.0, 1.0) * pure * edgeFade);
  if (cover > 0.0) {
    vec3 T0 = uTransmit[sp.i0].rgb;
    vec3 T1 = uTransmit[sp.i1].rgb;
    vec3 T = mix(T0, T1, clamp(dsw + 0.5, 0.0, 1.0));
    vec2 g = gd * uReliefScale;
    float tilt = -dot(g, SCOPE_LIGHT) * SCOPE_SLOPE;
    vec3 nrm = normalize(vec3(-g * SCOPE_SLOPE, 1.0));
    float spec = pow(clamp(dot(nrm, normalize(vec3(SCOPE_LIGHT * 0.5, 1.0))), 0.0, 1.0), 48.0);
    float thick = mix(0.7, 1.0, smoothstep(0.15, 0.85, l.a));
    vec3 body = col * pow(T, vec3(k * m * thick * (1.0 + 1.2 * (noise.r - 0.5) + (noise.b - 0.5))));
    body *= 1.0 + SCOPE_RELIEF * clamp(tilt, -1.0, 1.0);
    body *= 1.0 - 0.2 * smoothstep(0.85, 1.0, l.a);
    body += SCOPE_SPEC * spec;
    float ring = cover * (1.0 - clamp(d - 1.3 * w + 0.5, 0.0, 1.0)) * edgeFade;
    vec3 outline = col * pow(T, vec3(k * 2.2)) * 0.6;
    // 種類の区切り線: 接する別種の小器官を別の物に見せる (色 = 両側の輪郭の色の平均を暗く)
    vec3 sepCol = col * 0.5 * (pow(T0, vec3(k * 2.2)) + pow(T1, vec3(k * 2.2))) * 0.5;
    float sep = SCOPE_SEP_ALPHA * cover * sp.keep * (sp.i0 != sp.i1 ? 1.0 : 0.0) * clamp(SCOPE_SEP_W * w + 0.5 - abs(dsw), 0.0, 1.0);
    col = mix(col, body, cover);
    col = mix(col, sepCol, sep);
    col = mix(col, outline, ring);
  }

  col *= 1.0 + 0.16 * (noise.r - 0.5);
  float r = length((uv - 0.5) * uCanvas) / length(0.5 * uCanvas);
  col *= 1.0 - 0.55 * uVignette * smoothstep(0.4, 1.0, r);
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

// showParticles の重ね描き (PC 版と同じく半径半分・alpha 0.3)
const DOTS_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aInst;
uniform vec2 uWorld;
uniform vec2 uCanvas;
uniform vec4 uPalette[${MAX_PALETTE}];
uniform float uRadiusPx;
out vec2 vOffset;
out vec3 vColor;
${QUAD}
void main() {
  vOffset = quadCorner() * (uRadiusPx + 1.0);
  vColor = uPalette[min(int(aInst.z + 0.5), ${MAX_PALETTE - 1})].rgb;
  vec2 px = aInst.xy / uWorld * uCanvas + vOffset;
  gl_Position = vec4(px.x / uCanvas.x * 2.0 - 1.0, 1.0 - px.y / uCanvas.y * 2.0, 0.0, 1.0);
}
`;
const DOTS_FS = `#version 300 es
precision highp float;
uniform float uRadiusPx;
in vec2 vOffset;
in vec3 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor, clamp(uRadiusPx + 0.5 - length(vOffset), 0.0, 1.0) * 0.3); }
`;

/** σ (テクセル) を SIGMA_MAX_TEXELS 以下に収める縮小の段数 */
function blurLevel(sigma) {
    const k = Math.ceil(Math.log2(Math.max(sigma, 1e-3) / SIGMA_MAX_TEXELS));
    return Math.min(MAX_BLUR_LEVEL, Math.max(0, k));
}

/** 半径 3σ (上限 2 * MAX_PAIRS) のガウシアンを、2 テクセルずつバイリニアにまとめたタップ表 (offset, weight) にする */
function gaussianTaps(sigma) {
    const s = Math.max(sigma, 0.3);
    const radius = Math.min(Math.ceil(3 * s), 2 * MAX_PAIRS);
    const w = [];
    let total = 0;
    for (let i = 0; i <= radius; i++) {
        w[i] = Math.exp(-0.5 * (i / s) * (i / s));
        total += i === 0 ? w[i] : 2 * w[i];
    }
    const taps = new Float32Array(2 * (MAX_PAIRS + 1));
    taps[1] = w[0] / total;
    let pairs = 0;
    for (let i = 1; i <= radius; i += 2) {
        const wa = w[i];
        const wb = i + 1 <= radius ? w[i + 1] : 0;
        pairs++;
        taps[2 * pairs] = (i * wa + (i + 1) * wb) / (wa + wb);
        taps[2 * pairs + 1] = (wa + wb) / total;
    }
    return { taps, pairs };
}

function compileProgram(gl, label, vsSrc, fsSrc) {
    const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(s);
            gl.deleteShader(s);
            throw new Error(`GLSL compile error (organic ${label}): ${log}`);
        }
        return s;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        throw new Error(`GLSL link error (organic ${label}): ${log}`);
    }
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
        const name = gl.getActiveUniform(p, i).name;
        u[name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, name);
    }
    return { program: p, u };
}

/** テクスチャ + FBO (既定 rgba16f。paper は rgba8 + nearest)。完全でなければ throw */
function makeTarget(gl, w, h, format = gl.RGBA16F) {
    const filter = format === gl.RGBA16F ? gl.LINEAR : gl.NEAREST;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const target = { tex, fbo, w, h };
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        deleteTarget(gl, target);
        throw new Error(`organic: framebuffer incomplete (0x${status.toString(16)})`);
    }
    return target;
}

function deleteTarget(gl, t) {
    gl.deleteFramebuffer(t.fbo);
    gl.deleteTexture(t.tex);
}

export class OrganicGl {
    /** 能力 (rgba16f に描けて FBO が完全) が無ければ null */
    static create(gl) {
        if (!(gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float'))) return null;
        gl.getExtension('EXT_float_blend');
        try {
            deleteTarget(gl, makeTarget(gl, 4, 4));
            return new OrganicGl(gl);
        } catch (e) {
            console.warn('[organic] disabled:', e?.message ?? e);
            while (gl.getError() !== gl.NO_ERROR) { /* 失敗した確認のエラーを捨てる */ }
            return null;
        }
    }

    constructor(gl) {
        this.gl = gl;
        this.programs = {
            splat: compileProgram(gl, 'splat', SPLAT_VS, SPLAT_FS),
            shape: compileProgram(gl, 'shape', FULLSCREEN_VS, SHAPE_FS),
            shapeOcc: compileProgram(gl, 'shape occupancy', FULLSCREEN_VS, SHAPE_OCC_FS),
            softDown: compileProgram(gl, 'soft downsample', FULLSCREEN_VS, SOFT_DOWN_FS),
            paper: compileProgram(gl, 'paper', FULLSCREEN_VS, PAPER_FS),
            down: compileProgram(gl, 'downsample', FULLSCREEN_VS, DOWN_FS),
            blur: compileProgram(gl, 'blur', FULLSCREEN_VS, BLUR_FS),
            composite: compileProgram(gl, 'composite', FULLSCREEN_VS, COMPOSITE_FS),
            scope: compileProgram(gl, 'scope', FULLSCREEN_VS, SCOPE_FS),
            dots: compileProgram(gl, 'dots', DOTS_VS, DOTS_FS),
        };
        this.emptyVao = gl.createVertexArray();
        // 周期境界のコピー (端からスプラット半径以内の粒子を ±world でもう一度)
        this.copyVao = gl.createVertexArray();
        this.copyVbo = gl.createBuffer();
        this.copyCapacity = 0;
        this.copies = new Float32Array(0);
        this.palette = new Float32Array(MAX_PALETTE * 4);
        this.transmit = new Float32Array(MAX_STAIN_TYPES * 4);    // scope の染色の透過率 (パレットが変わったときだけ作り直す)
        this.transmitKey = '';
        this.plan = null;
        this.tapCache = new Map();
    }

    /** field / 縮小列 / ぼかし (+ scope の soft 列・paper) の FBO を、解像度・段数・スタイル・paper の条件が変わったときだけ作り直す */
    ensurePlan(fw, fh, ks, kl, soft, paper) {
        const key = `${fw}x${fh}/${ks}/${kl}/${soft}/${paper ? `${paper.w}x${paper.h}@${paper.dpr}~${paper.lowScale}` : '-'}`;
        if (this.plan?.key === key) return this.plan;
        this.releasePlan();
        const gl = this.gl;
        const targets = [];
        const make = (w, h, format) => {
            const t = makeTarget(gl, w, h, format);
            targets.push(t);
            return t;
        };
        const half = (t) => [Math.max(1, Math.ceil(t.w / 2)), Math.max(1, Math.ceil(t.h / 2))];
        try {
            const field = make(fw, fh);
            const levels = [make(fw, fh)];
            for (let k = 1; k <= (soft ? ks : Math.max(ks, kl)); k++) levels.push(make(...half(levels[k - 1])));
            // soft 列: field から 2^j0 倍で直接縮小して書き、それより先は箱平均でつなぐ
            let softLevels = null;
            let softBase = 0;
            if (soft) {
                softBase = Math.min(kl, MAX_SOFT_LEVEL);
                let size = { w: fw, h: fh };
                for (let k = 0; k < softBase; k++) [size.w, size.h] = half(size);
                softLevels = [];
                softLevels[softBase] = make(size.w, size.h);
                for (let k = softBase + 1; k <= kl; k++) softLevels[k] = make(...half(softLevels[k - 1]));
            }
            const pair = (lv) => ({ src: lv, tmp: make(lv.w, lv.h), out: make(lv.w, lv.h) });
            const paperTarget = paper ? make(paper.w, paper.h, gl.RGBA8) : null;
            this.plan = {
                key, fw, fh, ks, kl, targets, field, levels, softLevels, softBase,
                small: pair(levels[ks]), large: pair(soft ? softLevels[kl] : levels[kl]),
                paper: paperTarget, paperParams: paper, paperDirty: !!paper,
            };
        } catch (e) {
            for (const t of targets) deleteTarget(gl, t);
            throw e;
        }
        return this.plan;
    }

    releasePlan() {
        if (!this.plan) return;
        for (const t of this.plan.targets) deleteTarget(this.gl, t);
        this.plan = null;
    }

    taps(sigma) {
        const key = Math.round(sigma * 1000);
        let t = this.tapCache.get(key);
        if (!t) {
            if (this.tapCache.size > 64) this.tapCache.clear();
            t = gaussianTaps(key / 1000);
            this.tapCache.set(key, t);
        }
        return t;
    }

    /** 端の粒子の周期コピーを詰めて VBO へ。コピー数を返す */
    uploadCopies(sim, r) {
        const gl = this.gl;
        const { width: W, height: H } = sim.world;
        const { x, y, type } = sim;
        const n = sim.count;
        let c = this.copies;
        let k = 0;
        const push = (px, py, t) => {
            if (k + 3 > c.length) {
                const grown = new Float32Array(Math.max(256, c.length * 2));
                grown.set(c);
                c = this.copies = grown;
            }
            c[k++] = px; c[k++] = py; c[k++] = t;
        };
        for (let i = 0; i < n; i++) {
            const px = x[i];
            const py = y[i];
            const dx = px < r ? W : px > W - r ? -W : 0;
            const dy = py < r ? H : py > H - r ? -H : 0;
            if (dx === 0 && dy === 0) continue;
            const t = type[i];
            if (dx !== 0) push(px + dx, py, t);
            if (dy !== 0) push(px, py + dy, t);
            if (dx !== 0 && dy !== 0) push(px + dx, py + dy, t);
        }
        const count = k / 3;
        if (count === 0) return 0;
        gl.bindVertexArray(this.copyVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.copyVbo);
        if (count > this.copyCapacity) {
            this.copyCapacity = Math.max(count, 2 * this.copyCapacity);
            gl.bufferData(gl.ARRAY_BUFFER, this.copyCapacity * 12, gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
            gl.vertexAttribDivisor(0, 1);
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, c, 0, k);
        return count;
    }

    fullscreen(target, prog) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, target.w, target.h);
        gl.useProgram(prog.program);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    blur(pair, sigmaPx, fw, fh) {
        const gl = this.gl;
        const { program, u } = this.programs.blur;
        gl.useProgram(program);
        gl.uniform1i(u.uSrc, 0);
        const { w, h } = pair.src;
        for (const [axis, src, dst] of [[0, pair.src, pair.tmp], [1, pair.tmp, pair.out]]) {
            const { taps, pairs } = this.taps(sigmaPx * (axis === 0 ? w / fw : h / fh));
            gl.uniform2f(u.uDir, axis === 0 ? 1 / w : 0, axis === 0 ? 0 : 1 / h);
            gl.uniform1i(u.uCount, pairs);
            gl.uniform2fv(u.uTaps, taps);
            gl.bindTexture(gl.TEXTURE_2D, src.tex);
            gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
            gl.viewport(0, 0, w, h);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
    }

    /**
     * splat -> shape (+ scope は soft 列) -> 縮小 -> ぼかし small / large -> composite (+ showParticles) を canvas へ。FBO が作れなければ throw
     * organicStyle が 'glass' なら glass、それ以外は scope (スマホ版は glass / scope だけ)
     * @param {object} ctx { vao: 粒子の instance VAO (glRenderer が詰めたもの), dpr }
     */
    draw(sim, view, ctx) {
        const gl = this.gl;
        const org = view.organic;
        const scope = org.organicStyle !== 'glass';
        const style = scope ? ORGANIC_STYLES.scope : ORGANIC_STYLES.glass;
        const fine = style.fine;
        const rMax = view.rMax ?? org.rMax;
        const { width: W, height: H } = sim.world;
        const cw = gl.canvas.width;
        const ch = gl.canvas.height;
        const fieldScale = org.fieldScale > 0 ? org.fieldScale : DEFAULT_FIELD_SCALE;
        const fw = Math.max(1, Math.round(cw * fieldScale));
        const fh = Math.max(1, Math.round(ch * fieldScale));
        const pxPerWorld = fh / H;
        const rMaxPx = Math.max(rMax * ch / H, 1);
        const gradScale = Math.min(1, PC_RMAX_PX / rMaxPx);
        const sigmaSmall = Math.max(org.blurSmall * fine.small * rMax * pxPerWorld, 0.3);
        const sigmaLarge = Math.max(org.blurLarge * fine.large * rMax * pxPerWorld, 0.3);
        const ks = blurLevel(sigmaSmall);
        // paper の低周波は壁の勾配しきい値 (gradScale) と同じ比で伸ばす (ノイズの勾配だけで壁が出ないように)
        const paper = scope ? { w: cw, h: ch, dpr: ctx.dpr, lowScale: Math.round(gradScale * 1000) / 1000 } : null;
        const plan = this.ensurePlan(fw, fh, ks, blurLevel(sigmaLarge), scope && !!style.softLarge, paper);

        if (plan.paperDirty) {
            const pp = this.programs.paper;
            gl.disable(gl.BLEND);
            gl.bindVertexArray(this.emptyVao);
            gl.useProgram(pp.program);
            gl.uniform1f(pp.u.uDpr, plan.paperParams.dpr);
            gl.uniform1f(pp.u.uLowScale, plan.paperParams.lowScale);
            this.fullscreen(plan.paper, pp);
            plan.paperDirty = false;
        }

        // 平均密度で field = 1 になる重み (仕様書の「正規化」)
        const n = sim.count;
        const meanDensity = Math.max(n / (W * H) * Math.PI * rMax * rMax / 6, 0.5);
        const splat = org.splatRadius * fine.splat;
        const radius = splat * rMax;

        const pal = view.palette.rgb;
        const pd = this.palette;
        for (let t = 0; t < Math.min(view.palette.numTypes, MAX_PALETTE); t++) {
            pd[4 * t] = pal[3 * t]; pd[4 * t + 1] = pal[3 * t + 1]; pd[4 * t + 2] = pal[3 * t + 2]; pd[4 * t + 3] = 1;
        }
        const numTypes = Math.min(Math.max(view.palette.numTypes, 1), MAX_PALETTE);
        if (scope) {
            const key = `${numTypes}:${Array.from(pal.subarray(0, 3 * numTypes)).join(',')}`;
            if (key !== this.transmitKey) {
                this.transmit = buildStainTables(pal, numTypes).transmit;
                this.transmitKey = key;
            }
        }
        const copies = this.uploadCopies(sim, radius);

        // splat (加算)
        gl.bindFramebuffer(gl.FRAMEBUFFER, plan.field.fbo);
        gl.viewport(0, 0, fw, fh);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        const sp = this.programs.splat;
        gl.useProgram(sp.program);
        gl.uniform2f(sp.u.uWorld, W, H);
        gl.uniform1f(sp.u.uRadius, radius);
        gl.uniform1f(sp.u.uWeight, 1 / Math.max(1.5 * meanDensity * splat * splat, 1e-3));
        gl.uniform4fv(sp.u.uPalette, pd);
        gl.uniform1f(sp.u.uNumTypes, scope ? numTypes : 0);
        gl.bindVertexArray(ctx.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
        if (copies > 0) {
            gl.bindVertexArray(this.copyVao);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, copies);
        }
        gl.disable(gl.BLEND);

        // shape -> 縮小 -> ぼかし
        gl.bindVertexArray(this.emptyVao);
        gl.activeTexture(gl.TEXTURE0);
        const sh = scope ? this.programs.shapeOcc : this.programs.shape;
        gl.useProgram(sh.program);
        gl.uniform1i(sh.u.uSrc, 0);
        gl.uniform1f(sh.u.uGain, org.fieldGain);
        if (scope) gl.uniform1f(sh.u.uThreshold, org.threshold * (style.thresholdScale ?? 1));
        else gl.uniform1f(sh.u.uCore, org.coreThreshold);
        gl.bindTexture(gl.TEXTURE_2D, plan.field.tex);
        this.fullscreen(plan.levels[0], sh);
        if (plan.softLevels) {
            const sd = this.programs.softDown;
            gl.useProgram(sd.program);
            gl.uniform1i(sd.u.uSrc, 0);
            gl.uniform1f(sd.u.uGain, org.fieldGain);
            gl.uniform1i(sd.u.uFactor, 1 << plan.softBase);
            this.fullscreen(plan.softLevels[plan.softBase], sd);
        }
        const dn = this.programs.down;
        gl.useProgram(dn.program);
        gl.uniform1i(dn.u.uSrc, 0);
        const chains = plan.softLevels ? [plan.levels, plan.softLevels] : [plan.levels];
        for (const chain of chains) {
            for (let k = 1; k < chain.length; k++) {
                if (!chain[k - 1]) continue;
                gl.bindTexture(gl.TEXTURE_2D, chain[k - 1].tex);
                this.fullscreen(chain[k], dn);
            }
        }
        this.blur(plan.small, sigmaSmall, fw, fh);
        this.blur(plan.large, sigmaLarge, fw, fh);

        // composite
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, cw, ch);
        const cp = scope ? this.programs.scope : this.programs.composite;
        gl.useProgram(cp.program);
        gl.uniform1i(cp.u.uSmall, 0);
        gl.uniform1i(cp.u.uLarge, 1);
        gl.uniform2f(cp.u.uCanvas, cw, ch);
        gl.uniform1f(cp.u.uDpr, ctx.dpr);
        gl.uniform1f(cp.u.uGradScale, gradScale);
        if (scope) {
            gl.uniform1i(cp.u.uPaper, 2);
            gl.uniform1f(cp.u.uReliefScale, rMax * pxPerWorld / (1 << ks) / PC_RMAX_SMALL_TEXELS);
            gl.uniform1f(cp.u.uStain, org.scopeStain);
            gl.uniform1f(cp.u.uVignette, org.scopeVignette);
            gl.uniform1f(cp.u.uSpeck, org.scopeSpeck);
            gl.uniform1f(cp.u.uNumTypes, numTypes);
            gl.uniform4fv(cp.u.uTransmit, this.transmit);
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, plan.paper.tex);
        } else {
            gl.uniform1f(cp.u.uRim, org.rimStrength);
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, plan.small.out.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, plan.large.out.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindTexture(gl.TEXTURE_2D, null);
        if (scope) {
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, null);
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);

        // 呼び出し側の状態 (アルファブレンド) に戻す
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        if (org.showParticles && n > 0) {
            const dp = this.programs.dots;
            gl.useProgram(dp.program);
            gl.uniform2f(dp.u.uWorld, W, H);
            gl.uniform2f(dp.u.uCanvas, cw, ch);
            gl.uniform4fv(dp.u.uPalette, pd);
            gl.uniform1f(dp.u.uRadiusPx, Math.max(0.5, view.particleRadius * ctx.dpr) * 0.5);
            gl.bindVertexArray(ctx.vao);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
        }
    }

    dispose() {
        const gl = this.gl;
        this.releasePlan();
        for (const p of Object.values(this.programs)) gl.deleteProgram(p.program);
        gl.deleteVertexArray(this.emptyVao);
        gl.deleteVertexArray(this.copyVao);
        gl.deleteBuffer(this.copyVbo);
    }
}
