// organic 描画 (スマホ版、glass のみ)。PC 版 src/gpu/renderer.js と organic.wgsl.js の glass を WebGL2 へ移植 (docs/mobile-spec.md の phase 2)

import { ORGANIC_STYLES } from '../organicStyles.js';

const FINE = ORGANIC_STYLES.glass.fine;   // スプラット / small / large の倍率
const MAX_PALETTE = 16;
const SIGMA_MAX_TEXELS = 4;               // これを超える σ は 1/2 ずつ縮小してからぼかす
const MAX_BLUR_LEVEL = 6;
const MAX_PAIRS = 6;                      // 中心 + 6 ペア = 最大 13 フェッチ
const DEFAULT_FIELD_SCALE = 0.25;
const PC_RMAX_PX = 0.03 * 1080;           // PC 版の既定 (rMax 0.03、1080 px) での rMax の px。膜の勾配しきい値はこれで調整されている

const QUAD = `vec2 quadCorner() { return vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0; }`;

// 粒子 -> field (rgb = 色 x w, a = w) の加算。y はワールド上端が画面上端 (glRenderer の pxToClip と同じ向き)
const SPLAT_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aInst;   // x, y, type
uniform vec2 uWorld;
uniform float uRadius;                // ワールド単位
uniform vec4 uPalette[${MAX_PALETTE}];
out vec2 vD;
out vec3 vColor;
${QUAD}
void main() {
  vec2 c = quadCorner();
  vD = c;
  vColor = uPalette[min(int(aInst.z + 0.5), ${MAX_PALETTE - 1})].rgb;
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
// 3 次 B スプラインを 4 回のバイリニアで (4〜16 倍に引き伸ばすので、バイリニアだと fwidth がテクセルごとに段になり縁が折れ線・縞になる)
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
void main() {
  vec2 uv = gl_FragCoord.xy / uCanvas;
  vec4 s = bspline(uSmall, uv);
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

/** rgba16f のテクスチャ + FBO。完全でなければ throw */
function makeTarget(gl, w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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
        throw new Error(`organic: rgba16f framebuffer incomplete (0x${status.toString(16)})`);
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
            down: compileProgram(gl, 'downsample', FULLSCREEN_VS, DOWN_FS),
            blur: compileProgram(gl, 'blur', FULLSCREEN_VS, BLUR_FS),
            composite: compileProgram(gl, 'composite', FULLSCREEN_VS, COMPOSITE_FS),
            dots: compileProgram(gl, 'dots', DOTS_VS, DOTS_FS),
        };
        this.emptyVao = gl.createVertexArray();
        // 周期境界のコピー (端からスプラット半径以内の粒子を ±world でもう一度)
        this.copyVao = gl.createVertexArray();
        this.copyVbo = gl.createBuffer();
        this.copyCapacity = 0;
        this.copies = new Float32Array(0);
        this.palette = new Float32Array(MAX_PALETTE * 4);
        this.plan = null;
        this.tapCache = new Map();
    }

    /** field / 縮小列 / ぼかしの FBO を、解像度か段数が変わったときだけ作り直す */
    ensurePlan(fw, fh, ks, kl) {
        const p = this.plan;
        if (p && p.fw === fw && p.fh === fh && p.ks === ks && p.kl === kl) return p;
        this.releasePlan();
        const gl = this.gl;
        const targets = [];
        const make = (w, h) => {
            const t = makeTarget(gl, w, h);
            targets.push(t);
            return t;
        };
        try {
            const field = make(fw, fh);
            const levels = [make(fw, fh)];
            for (let k = 1; k <= Math.max(ks, kl); k++) {
                const prev = levels[k - 1];
                levels.push(make(Math.max(1, Math.ceil(prev.w / 2)), Math.max(1, Math.ceil(prev.h / 2))));
            }
            const pair = (lv) => ({ src: lv, tmp: make(lv.w, lv.h), out: make(lv.w, lv.h) });
            this.plan = { fw, fh, ks, kl, targets, field, levels, small: pair(levels[ks]), large: pair(levels[kl]) };
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
     * splat -> shape -> 縮小 -> ぼかし small / large -> composite (+ showParticles) を canvas へ。FBO が作れなければ throw
     * @param {object} ctx { vao: 粒子の instance VAO (glRenderer が詰めたもの), dpr }
     */
    draw(sim, view, ctx) {
        const gl = this.gl;
        const org = view.organic;
        const rMax = view.rMax ?? org.rMax;
        const { width: W, height: H } = sim.world;
        const cw = gl.canvas.width;
        const ch = gl.canvas.height;
        const fieldScale = org.fieldScale > 0 ? org.fieldScale : DEFAULT_FIELD_SCALE;
        const fw = Math.max(1, Math.round(cw * fieldScale));
        const fh = Math.max(1, Math.round(ch * fieldScale));
        const pxPerWorld = fh / H;
        const sigmaSmall = Math.max(org.blurSmall * FINE.small * rMax * pxPerWorld, 0.3);
        const sigmaLarge = Math.max(org.blurLarge * FINE.large * rMax * pxPerWorld, 0.3);
        const plan = this.ensurePlan(fw, fh, blurLevel(sigmaSmall), blurLevel(sigmaLarge));

        // 平均密度で field = 1 になる重み (仕様書の「正規化」)
        const n = sim.count;
        const meanDensity = Math.max(n / (W * H) * Math.PI * rMax * rMax / 6, 0.5);
        const splat = org.splatRadius * FINE.splat;
        const radius = splat * rMax;

        const pal = view.palette.rgb;
        const pd = this.palette;
        for (let t = 0; t < Math.min(view.palette.numTypes, MAX_PALETTE); t++) {
            pd[4 * t] = pal[3 * t]; pd[4 * t + 1] = pal[3 * t + 1]; pd[4 * t + 2] = pal[3 * t + 2]; pd[4 * t + 3] = 1;
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
        const sh = this.programs.shape;
        gl.useProgram(sh.program);
        gl.uniform1i(sh.u.uSrc, 0);
        gl.uniform1f(sh.u.uGain, org.fieldGain);
        gl.uniform1f(sh.u.uCore, org.coreThreshold);
        gl.bindTexture(gl.TEXTURE_2D, plan.field.tex);
        this.fullscreen(plan.levels[0], sh);
        const dn = this.programs.down;
        gl.useProgram(dn.program);
        gl.uniform1i(dn.u.uSrc, 0);
        for (let k = 1; k < plan.levels.length; k++) {
            gl.bindTexture(gl.TEXTURE_2D, plan.levels[k - 1].tex);
            this.fullscreen(plan.levels[k], dn);
        }
        this.blur(plan.small, sigmaSmall, fw, fh);
        this.blur(plan.large, sigmaLarge, fw, fh);

        // composite
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, cw, ch);
        const cp = this.programs.composite;
        gl.useProgram(cp.program);
        gl.uniform1i(cp.u.uSmall, 0);
        gl.uniform1i(cp.u.uLarge, 1);
        gl.uniform2f(cp.u.uCanvas, cw, ch);
        gl.uniform1f(cp.u.uDpr, ctx.dpr);
        gl.uniform1f(cp.u.uRim, org.rimStrength);
        gl.uniform1f(cp.u.uGradScale, Math.min(1, PC_RMAX_PX / Math.max(rMax * ch / H, 1)));
        gl.bindTexture(gl.TEXTURE_2D, plan.small.out.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, plan.large.out.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindTexture(gl.TEXTURE_2D, null);
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
