// WebGL2 レンダラ (スマホ版): dots / トレイル / ポインタ円。見た目は src/gpu/shaders/render.wgsl.js と src/gpu/renderer.js に合わせる
// view = { palette, particleRadius (CSS px), trails, pointer, pointerRadius (ワールド単位), renderMode, organic }

const MAX_DPR = 2;
const MAX_PALETTE = 16;
const TRAIL_FADE = 0.14;                       // WebGPU 版と同じ
const BG = [1 / 255, 14 / 255, 29 / 255];      // style.css の --bg

const COMMON_GLSL = `#version 300 es
precision highp float;
uniform vec2 uWorld;      // ワールドサイズ
uniform vec2 uCanvas;     // デバイス px
vec2 quadCorner() { return vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0; }
vec4 pxToClip(vec2 px) { return vec4(px.x / uCanvas.x * 2.0 - 1.0, 1.0 - px.y / uCanvas.y * 2.0, 0.0, 1.0); }
`;

const PARTICLE_VS = COMMON_GLSL + `
layout(location = 0) in vec3 aInst;   // x, y, type
uniform vec4 uPalette[${MAX_PALETTE}];
uniform float uRadiusPx;
out vec2 vOffset;
out vec3 vColor;
void main() {
  vec2 corner = quadCorner();
  vOffset = corner * (uRadiusPx + 1.0);   // AA 用の 1px
  vColor = uPalette[min(int(aInst.z + 0.5), ${MAX_PALETTE - 1})].rgb;
  gl_Position = pxToClip(aInst.xy / uWorld * uCanvas + vOffset);
}
`;
const PARTICLE_FS = `#version 300 es
precision highp float;
uniform float uRadiusPx;
in vec2 vOffset;
in vec3 vColor;
out vec4 outColor;
void main() {
  float a = clamp(uRadiusPx + 0.5 - length(vOffset), 0.0, 1.0);
  outColor = vec4(vColor, a);
}
`;

const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;
const FADE_FS = `#version 300 es
precision highp float;
uniform vec4 uFade;   // rgb = 背景, a = fade
out vec4 outColor;
void main() { outColor = uFade; }
`;
const BLIT_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
out vec4 outColor;
void main() { outColor = vec4(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rgb, 1.0); }
`;

// ポインタ円: 周期境界なので 3x3 のコピーを instance で描く
const POINTER_VS = COMMON_GLSL + `
uniform vec2 uPointer;
uniform float uRadiusPx;
uniform float uLineWidthPx;
out vec2 vOffset;
void main() {
  vec2 o = vec2(float(gl_InstanceID % 3 - 1), float(gl_InstanceID / 3 - 1));
  vOffset = quadCorner() * (uRadiusPx + uLineWidthPx + 1.0);
  gl_Position = pxToClip((uPointer + o * uWorld) / uWorld * uCanvas + vOffset);
}
`;
const POINTER_FS = `#version 300 es
precision highp float;
uniform float uRadiusPx;
uniform float uLineWidthPx;
uniform float uMode;
in vec2 vOffset;
out vec4 outColor;
void main() {
  float d = length(vOffset);
  float fill = clamp(uRadiusPx - d + 0.5, 0.0, 1.0) * 0.08;
  float ring = clamp(uLineWidthPx * 0.5 + 0.5 - abs(d - uRadiusPx), 0.0, 1.0) * 0.9;
  float a = ring + fill * (1.0 - ring);
  vec3 c = uMode >= 0.0 ? vec3(80.0, 255.0, 140.0) : vec3(255.0, 90.0, 80.0);
  outColor = vec4(c / 255.0, a);
}
`;

export class GlRenderer {
    /** WebGL2 が無ければ throw */
    static create(canvas) {
        const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' });
        if (!gl) throw new Error('WebGL2 is not supported');
        return new GlRenderer(canvas, gl);
    }

    constructor(canvas, gl) {
        this.canvas = canvas;
        this.gl = gl;
        this.dpr = 1;
        this.capabilities = { halfFloatRT: false, floatBlend: false, maxTextureSize: 0 };
        this.onContextLost = null;
        this.scratch = new Float32Array(0);   // (x, y, type) interleaved
        this.paletteData = new Float32Array(MAX_PALETTE * 4);
        this.initResources();

        this.onLost = (e) => {
            e.preventDefault();
            this.onContextLost?.('lost');
        };
        this.onRestored = () => {
            this.initResources();
            this.onContextLost?.('restored');
        };
        canvas.addEventListener('webglcontextlost', this.onLost);
        canvas.addEventListener('webglcontextrestored', this.onRestored);
    }

    /** GL 資源をすべて作る (復帰後の作り直しも兼ねる) */
    initResources() {
        const gl = this.gl;
        this.programs = {
            particle: this.makeProgram('particle', PARTICLE_VS, PARTICLE_FS),
            fade: this.makeProgram('fade', FULLSCREEN_VS, FADE_FS),
            blit: this.makeProgram('blit', FULLSCREEN_VS, BLIT_FS),
            pointer: this.makeProgram('pointer', POINTER_VS, POINTER_FS),
        };
        this.uniforms = {};
        for (const [name, p] of Object.entries(this.programs)) {
            const map = {};
            const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
            for (let i = 0; i < n; i++) {
                const info = gl.getActiveUniform(p, i);
                const key = info.name.replace(/\[0\]$/, '');
                map[key] = gl.getUniformLocation(p, info.name);
            }
            this.uniforms[name] = map;
        }

        this.particleVao = gl.createVertexArray();
        this.particleVbo = gl.createBuffer();
        this.vboCapacity = 0;                  // 粒子数
        this.emptyVao = gl.createVertexArray();   // attribute なしの描画用

        this.trailTex = null;
        this.trailFbo = null;
        this.trailW = 0;
        this.trailH = 0;
        this.needsTrailClear = true;

        const caps = this.capabilities;
        caps.halfFloatRT = !!(gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float'));
        caps.floatBlend = !!gl.getExtension('EXT_float_blend');
        caps.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

        if (this.canvas.width > 0) gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    makeProgram(label, vsSrc, fsSrc) {
        const gl = this.gl;
        const compile = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(s);
                gl.deleteShader(s);
                throw new Error(`GLSL compile error (${label} ${type === gl.VERTEX_SHADER ? 'vs' : 'fs'}): ${log}`);
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
            throw new Error(`GLSL link error (${label}): ${log}`);
        }
        return p;
    }

    resize(cssW, cssH, dpr) {
        this.dpr = Math.min(dpr || 1, MAX_DPR);
        const w = Math.max(1, Math.round(cssW * this.dpr));
        const h = Math.max(1, Math.round(cssH * this.dpr));
        if (this.canvas.width !== w) this.canvas.width = w;
        if (this.canvas.height !== h) this.canvas.height = h;
        if (!this.gl.isContextLost()) this.gl.viewport(0, 0, w, h);
        this.needsTrailClear = true;
    }

    setContextLostHandler(fn) {
        this.onContextLost = fn;
    }

    ensureTrailTarget() {
        const gl = this.gl;
        const w = this.canvas.width;
        const h = this.canvas.height;
        if (this.trailTex && this.trailW === w && this.trailH === h) return;
        this.releaseTrailTarget();
        this.trailTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.trailTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        this.trailFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.trailFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.trailTex, 0);
        this.trailW = w;
        this.trailH = h;
        this.needsTrailClear = true;
    }

    releaseTrailTarget() {
        const gl = this.gl;
        if (this.trailFbo) gl.deleteFramebuffer(this.trailFbo);
        if (this.trailTex) gl.deleteTexture(this.trailTex);
        this.trailFbo = null;
        this.trailTex = null;
        this.trailW = 0;
        this.trailH = 0;
    }

    /** sim.x/y/type を interleaved VBO へ。容量は粒子数が増えたときだけ作り直す */
    uploadParticles(sim) {
        const gl = this.gl;
        const n = sim.count;
        if (this.scratch.length < n * 3) this.scratch = new Float32Array(n * 3);
        const s = this.scratch;
        const { x, y, type } = sim;
        for (let i = 0, k = 0; i < n; i++, k += 3) {
            s[k] = x[i];
            s[k + 1] = y[i];
            s[k + 2] = type[i];
        }
        gl.bindVertexArray(this.particleVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.particleVbo);
        if (n > this.vboCapacity) {
            gl.bufferData(gl.ARRAY_BUFFER, n * 12, gl.DYNAMIC_DRAW);
            this.vboCapacity = n;
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
            gl.vertexAttribDivisor(0, 1);
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, s, 0, n * 3);
    }

    drawParticles(sim, view) {
        const gl = this.gl;
        const u = this.uniforms.particle;
        const pal = view.palette.rgb;
        const nt = Math.min(view.palette.numTypes, MAX_PALETTE);
        const pd = this.paletteData;
        for (let t = 0; t < nt; t++) {
            pd[t * 4] = pal[t * 3];
            pd[t * 4 + 1] = pal[t * 3 + 1];
            pd[t * 4 + 2] = pal[t * 3 + 2];
        }
        gl.useProgram(this.programs.particle);
        gl.uniform2f(u.uWorld, sim.world.width, sim.world.height);
        gl.uniform2f(u.uCanvas, this.canvas.width, this.canvas.height);
        gl.uniform1f(u.uRadiusPx, Math.max(0.5, view.particleRadius * this.dpr));
        gl.uniform4fv(u.uPalette, pd);
        gl.bindVertexArray(this.particleVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sim.count);
    }

    drawPointer(sim, view) {
        const gl = this.gl;
        const p = view.pointer;
        const u = this.uniforms.pointer;
        gl.useProgram(this.programs.pointer);
        gl.uniform2f(u.uWorld, sim.world.width, sim.world.height);
        gl.uniform2f(u.uCanvas, this.canvas.width, this.canvas.height);
        gl.uniform2f(u.uPointer, p.x, p.y);
        gl.uniform1f(u.uRadiusPx, view.pointerRadius * (this.canvas.height / sim.world.height));
        gl.uniform1f(u.uLineWidthPx, Math.max(1, this.dpr));
        gl.uniform1f(u.uMode, p.mode);
        gl.bindVertexArray(this.emptyVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 9);
    }

    /** organic は phase 2。今は dots にフォールバック */
    draw(sim, view) {
        const gl = this.gl;
        if (gl.isContextLost()) return;
        const pointerOn = !!view.pointer && view.pointer.active;

        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        if (sim.count > 0) this.uploadParticles(sim);

        if (!view.trails) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.clearColor(BG[0], BG[1], BG[2], 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            if (sim.count > 0) this.drawParticles(sim, view);
            if (pointerOn) this.drawPointer(sim, view);
            if (this.trailTex) this.releaseTrailTarget();   // trails が偽の間は FBO を持たない
            this.needsTrailClear = true;
            return;
        }

        // トレイル: 永続テクスチャをフェードして重ね描き -> canvas へコピー (ポインタ円はトレイルに残さない)
        this.ensureTrailTarget();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.trailFbo);
        if (this.needsTrailClear) {
            gl.clearColor(BG[0], BG[1], BG[2], 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            this.needsTrailClear = false;
        } else {
            gl.useProgram(this.programs.fade);
            gl.uniform4f(this.uniforms.fade.uFade, BG[0], BG[1], BG[2], TRAIL_FADE);
            gl.bindVertexArray(this.emptyVao);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        if (sim.count > 0) this.drawParticles(sim, view);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.disable(gl.BLEND);
        gl.useProgram(this.programs.blit);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.trailTex);
        gl.uniform1i(this.uniforms.blit.uSrc, 0);
        gl.bindVertexArray(this.emptyVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (pointerOn) {
            gl.enable(gl.BLEND);
            this.drawPointer(sim, view);
        }
    }

    dispose() {
        this.canvas.removeEventListener('webglcontextlost', this.onLost);
        this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
        const gl = this.gl;
        if (gl.isContextLost()) return;
        this.releaseTrailTarget();
        for (const p of Object.values(this.programs)) gl.deleteProgram(p);
        gl.deleteBuffer(this.particleVbo);
        gl.deleteVertexArray(this.particleVao);
        gl.deleteVertexArray(this.emptyVao);
    }
}
