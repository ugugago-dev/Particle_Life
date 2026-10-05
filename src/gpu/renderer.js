// WebGPU レンダラ。シミュレーションのストレージバッファ (バッファ A) を頂点シェーダから直接読んで
// インスタンス描画する (CPU への読み戻しなし)。
//
//   resize(cssW, cssH, dpr) : バックバッファ = CSS サイズ x devicePixelRatio
//   draw(encoder, sim, view, timer) : 1 フレーム分の render pass を encoder に積む
//
//   view = {
//     palette:        { numTypes, css, rgb: Float32Array }    (palette.js)
//     particleRadius: number                                  CSS px
//     trails:         boolean                                 フェードさせながら重ね描き
//     pointer:        { x, y, active, mode }                  ワールド座標、mode +1 引力 / -1 斥力
//     pointerRadius:  number                                  ワールド単位
//     rMax, maxSpeed, restDensity: number                     organic のスプラット半径 / 伸び / 密度の基準
//     organic:        { renderMode, fieldScale, splatRadius, threshold, edge, coreBoost, stretch,
//                       rimStrength, showParticles }          config.js の Organic 項目
//   }
//
// トレイルなし: canvas に BG クリア -> パーティクル -> ポインタ円 を 1 パスで描く。
//
// organic モード (docs/organic-rendering-spec.md): 先に field テクスチャ (rgba16float, canvas x fieldScale) へ
// 粒子を加算スプラットし、パーティクル描画の代わりに field をしきい値処理した合成 (メタボール) を描く。
// トレイルあり: 永続テクスチャ (rgba16float) を BG で薄くフェード -> パーティクルを重ね描き、
//               そのあと canvas へ等倍コピー -> ポインタ円 (円はトレイルに残さない)。

import { createShaderModule, withErrorScope } from './device.js';
import {
    MAX_PALETTE, RENDER_UNIFORM_FLOATS,
    particleWGSL, fadeWGSL, blitWGSL, pointerWGSL,
} from './shaders/render.wgsl.js';
import { ORGANIC_UNIFORM_FLOATS, splatWGSL, compositeWGSL } from './shaders/organic.wgsl.js';

const BG = { r: 1 / 255, g: 14 / 255, b: 29 / 255, a: 1 };   // style.css の --bg
const TRAIL_FORMAT = 'rgba16float';  // 8bit だとフェードの丸めで残像が消えきらないため
const FIELD_FORMAT = 'rgba16float';  // 加算ブレンド可能で、色 x 重みが 1 を超えても飽和しない
const TRAIL_FADE = 0.14;             // Canvas2D 版と同じ (小さいほど長く残る)

const ALPHA_BLEND = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const ADDITIVE_BLEND = {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

export class GpuRenderer {
    /**
     * @param {GPUDevice} device
     * @param {GPUCanvasContext} context  configureCanvas() 済み
     * @param {GPUTextureFormat} format
     * @param {HTMLCanvasElement} canvas
     */
    static async create(device, context, format, canvas) {
        const r = new GpuRenderer(device, context, format, canvas);
        await r.createPipelines();
        return r;
    }

    constructor(device, context, format, canvas) {
        this.device = device;
        this.context = context;
        this.format = format;
        this.canvas = canvas;
        this.dpr = 1;

        this.uniformData = new Float32Array(RENDER_UNIFORM_FLOATS);
        this.uniformBuffer = device.createBuffer({
            label: 'render params',
            size: RENDER_UNIFORM_FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.paletteBuffer = device.createBuffer({
            label: 'palette',
            size: MAX_PALETTE * 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.paletteSource = null;

        this.trailTexture = null;
        this.trailView = null;
        this.trailGroup = null;
        this.needsTrailClear = true;

        this.particleGroup = null;
        this.particleGroupKey = null; // [posVelA, metaA] が変わったら作り直す

        this.organicData = new Float32Array(ORGANIC_UNIFORM_FLOATS);
        this.organicBuffer = device.createBuffer({
            label: 'organic params',
            size: ORGANIC_UNIFORM_FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.fieldSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
        this.fieldTexture = null;
        this.fieldView = null;
        this.compositeGroup = null;   // { canvas, trail } (パイプラインごとに auto layout が別)
        this.splatGroup = null;
        this.splatGroupKey = null;    // [posVelA, metaA, densityA]
    }

    async createPipelines() {
        const { device, format } = this;
        await withErrorScope(device, 'render pipelines', async () => {
            const [particle, fade, blit, pointer, splat, composite] = await Promise.all([
                createShaderModule(device, 'particle', particleWGSL),
                createShaderModule(device, 'fade', fadeWGSL),
                createShaderModule(device, 'blit', blitWGSL),
                createShaderModule(device, 'pointer', pointerWGSL),
                createShaderModule(device, 'organic splat', splatWGSL),
                createShaderModule(device, 'organic composite', compositeWGSL),
            ]);
            const target = (fmt, blend) => [{ format: fmt, blend }];
            const particlePipeline = (fmt) => device.createRenderPipeline({
                label: `particles -> ${fmt}`,
                layout: 'auto',
                vertex: { module: particle, entryPoint: 'vs' },
                fragment: { module: particle, entryPoint: 'fs', targets: target(fmt, ALPHA_BLEND) },
                primitive: { topology: 'triangle-list' },
            });
            const compositePipeline = (fmt) => device.createRenderPipeline({
                label: `organic composite -> ${fmt}`,
                layout: 'auto',
                vertex: { module: composite, entryPoint: 'vs' },
                fragment: { module: composite, entryPoint: 'fs', targets: target(fmt, ALPHA_BLEND) },
                primitive: { topology: 'triangle-list' },
            });
            this.pipelines = {
                splat: device.createRenderPipeline({
                    label: 'organic splat',
                    layout: 'auto',
                    vertex: { module: splat, entryPoint: 'vs' },
                    fragment: { module: splat, entryPoint: 'fs', targets: target(FIELD_FORMAT, ADDITIVE_BLEND) },
                    primitive: { topology: 'triangle-list' },
                }),
                compositeToCanvas: compositePipeline(format),
                compositeToTrail: compositePipeline(TRAIL_FORMAT),
                particleToCanvas: particlePipeline(format),
                particleToTrail: particlePipeline(TRAIL_FORMAT),
                fade: device.createRenderPipeline({
                    label: 'trail fade',
                    layout: 'auto',
                    vertex: { module: fade, entryPoint: 'vs' },
                    fragment: { module: fade, entryPoint: 'fs', targets: target(TRAIL_FORMAT, ALPHA_BLEND) },
                    primitive: { topology: 'triangle-list' },
                }),
                blit: device.createRenderPipeline({
                    label: 'trail blit',
                    layout: 'auto',
                    vertex: { module: blit, entryPoint: 'vs' },
                    fragment: { module: blit, entryPoint: 'fs', targets: target(format) },
                    primitive: { topology: 'triangle-list' },
                }),
                pointer: device.createRenderPipeline({
                    label: 'pointer circle',
                    layout: 'auto',
                    vertex: { module: pointer, entryPoint: 'vs' },
                    fragment: { module: pointer, entryPoint: 'fs', targets: target(format, ALPHA_BLEND) },
                    primitive: { topology: 'triangle-list' },
                }),
            };
            // uniform だけのバインドグループ (fade / pointer 用)
            const uniformOnly = (pipeline) => device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
            });
            this.fadeGroup = uniformOnly(this.pipelines.fade);
            this.pointerGroup = uniformOnly(this.pipelines.pointer);
        });
    }

    /** バックバッファを CSS サイズ x dpr にする (ページ側 CSS が要素のレイアウトサイズを決める)。 */
    resize(cssW, cssH, dpr) {
        this.dpr = dpr;
        // 極端に大きい画面 x dpr がテクスチャ上限を超えないようにする (超えたら縮小。比率は保つ)
        const maxDim = this.device.limits.maxTextureDimension2D;
        const fit = Math.min(1, maxDim / (cssW * dpr), maxDim / (cssH * dpr));
        const w = Math.max(1, Math.floor(cssW * dpr * fit));
        const h = Math.max(1, Math.floor(cssH * dpr * fit));
        if (w === this.canvas.width && h === this.canvas.height) return;
        this.canvas.width = w;
        this.canvas.height = h;
        this.needsTrailClear = true; // トレイルテクスチャは次の draw で作り直す
    }

    /** field テクスチャ (canvas x fieldScale) と、それを読む composite のバインドグループを作る。 */
    ensureField(scale) {
        const { canvas, device } = this;
        const w = Math.max(1, Math.round(canvas.width * scale));
        const h = Math.max(1, Math.round(canvas.height * scale));
        const t = this.fieldTexture;
        if (t && t.width === w && t.height === h) return;
        if (t) t.destroy();
        this.fieldTexture = device.createTexture({
            label: 'organic field',
            size: [w, h],
            format: FIELD_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.fieldView = this.fieldTexture.createView();
        const group = (pipeline) => device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: { buffer: this.organicBuffer } },
                { binding: 2, resource: this.fieldView },
                { binding: 3, resource: this.fieldSampler },
            ],
        });
        this.compositeGroup = {
            canvas: group(this.pipelines.compositeToCanvas),
            trail: group(this.pipelines.compositeToTrail),
        };
    }

    updateSplatGroup(sim) {
        const { posVelA, metaA, densityA } = sim.buffers;
        const k = this.splatGroupKey;
        if (k && k[0] === posVelA && k[1] === metaA && k[2] === densityA) return;
        this.splatGroupKey = [posVelA, metaA, densityA];
        this.splatGroup = this.device.createBindGroup({
            layout: this.pipelines.splat.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: { buffer: this.paletteBuffer } },
                { binding: 2, resource: { buffer: posVelA } },
                { binding: 3, resource: { buffer: metaA } },
                { binding: 4, resource: { buffer: densityA } },
                { binding: 5, resource: { buffer: this.organicBuffer } },
            ],
        });
    }

    ensureTrailTexture() {
        const { canvas, device } = this;
        const t = this.trailTexture;
        if (t && t.width === canvas.width && t.height === canvas.height) return;
        if (t) t.destroy();
        this.trailTexture = device.createTexture({
            label: 'trail',
            size: [canvas.width, canvas.height],
            format: TRAIL_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.trailView = this.trailTexture.createView();
        this.trailGroup = this.device.createBindGroup({
            layout: this.pipelines.blit.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: this.trailView }],
        });
        this.needsTrailClear = true;
    }

    updatePalette(palette) {
        if (this.paletteSource === palette) return;
        this.paletteSource = palette;
        const data = new Float32Array(MAX_PALETTE * 4);
        const n = Math.min(palette.numTypes, MAX_PALETTE);
        for (let t = 0; t < n; t++) {
            data[4 * t] = palette.rgb[3 * t];
            data[4 * t + 1] = palette.rgb[3 * t + 1];
            data[4 * t + 2] = palette.rgb[3 * t + 2];
            data[4 * t + 3] = 1;
        }
        this.device.queue.writeBuffer(this.paletteBuffer, 0, data);
    }

    updateParticleGroup(sim) {
        const { posVelA, metaA } = sim.buffers;
        if (this.particleGroupKey && this.particleGroupKey[0] === posVelA && this.particleGroupKey[1] === metaA) return;
        this.particleGroupKey = [posVelA, metaA];
        this.particleGroup = {
            // パイプラインごとに auto layout が別物なので、両方分作る
            canvas: this.makeParticleGroup(this.pipelines.particleToCanvas, posVelA, metaA),
            trail: this.makeParticleGroup(this.pipelines.particleToTrail, posVelA, metaA),
        };
    }

    makeParticleGroup(pipeline, posVelA, metaA) {
        return this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: { buffer: this.paletteBuffer } },
                { binding: 2, resource: { buffer: posVelA } },
                { binding: 3, resource: { buffer: metaA } },
            ],
        });
    }

    /**
     * @param {GPUCommandEncoder} encoder
     * @param {import('./simulation.js').GpuSimulation} sim
     * @param {object} view
     * @param {import('./timer.js').GpuTimer} [timer]
     */
    draw(encoder, sim, view, timer) {
        const { device, canvas, pipelines } = this;
        const world = sim.world;
        const pointer = view.pointer;
        const pointerOn = !!pointer && pointer.active;

        // ---- uniform
        const u = this.uniformData;
        u[0] = world.width; u[1] = world.height;
        u[2] = canvas.width; u[3] = canvas.height;
        u[4] = Math.max(0.5, view.particleRadius * this.dpr);          // CPU 版と同じ下限
        u[5] = view.pointerRadius * (canvas.height / world.height);
        u[6] = Math.max(1, this.dpr);
        u[7] = TRAIL_FADE;
        u[8] = pointerOn ? pointer.x : 0; u[9] = pointerOn ? pointer.y : 0;
        u[10] = pointerOn ? pointer.mode : 1;
        u[11] = 1;

        const count = sim.count;
        const org = view.organic;
        const organic = org?.renderMode === 'organic' && count > 0;
        // organic のとき粒子は「中の小器官」として半径半分・薄く重ねる (showParticles)
        const dots = !organic || org.showParticles;
        if (organic) {
            u[4] *= 0.5;
            u[11] = 0.3;
        }
        device.queue.writeBuffer(this.uniformBuffer, 0, u);

        this.updatePalette(view.palette);
        this.updateParticleGroup(sim);

        const canvasView = this.context.getCurrentTexture().createView();
        const bgClear = { r: BG.r, g: BG.g, b: BG.b, a: 1 };

        if (organic) {
            this.ensureField(org.fieldScale);
            this.writeOrganicUniform(view, world);
            this.updateSplatGroup(sim);
            const splatPass = encoder.beginRenderPass({
                label: 'organic splat',
                colorAttachments: [{
                    view: this.fieldView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store',
                }],
                timestampWrites: timer?.drawBeginWrites(),
            });
            splatPass.setPipeline(pipelines.splat);
            splatPass.setBindGroup(0, this.splatGroup);
            splatPass.draw(6, count);
            splatPass.end();
        }

        if (!view.trails) {
            const pass = encoder.beginRenderPass({
                label: 'draw',
                colorAttachments: [{ view: canvasView, clearValue: bgClear, loadOp: 'clear', storeOp: 'store' }],
                timestampWrites: organic ? timer?.drawEndWrites() : timer?.drawWrites(),
            });
            if (organic) this.drawComposite(pass, pipelines.compositeToCanvas, this.compositeGroup.canvas);
            if (dots) this.drawParticles(pass, pipelines.particleToCanvas, this.particleGroup.canvas, count);
            if (pointerOn) this.drawPointer(pass);
            pass.end();
            this.needsTrailClear = true; // 次にトレイルを有効にしたときは BG から始める
            return;
        }

        // ---- トレイル: 永続テクスチャへ
        this.ensureTrailTexture();
        const clear = this.needsTrailClear;
        this.needsTrailClear = false;
        const trailPass = encoder.beginRenderPass({
            label: 'trail',
            colorAttachments: [{
                view: this.trailView,
                clearValue: bgClear,
                loadOp: clear ? 'clear' : 'load',
                storeOp: 'store',
            }],
            timestampWrites: organic ? undefined : timer?.drawBeginWrites(),
        });
        if (!clear) {
            trailPass.setPipeline(pipelines.fade);
            trailPass.setBindGroup(0, this.fadeGroup);
            trailPass.draw(3);
        }
        if (organic) this.drawComposite(trailPass, pipelines.compositeToTrail, this.compositeGroup.trail);
        if (dots) this.drawParticles(trailPass, pipelines.particleToTrail, this.particleGroup.trail, count);
        trailPass.end();

        // ---- canvas へコピー + ポインタ円
        const finalPass = encoder.beginRenderPass({
            label: 'present',
            colorAttachments: [{ view: canvasView, loadOp: 'clear', clearValue: bgClear, storeOp: 'store' }],
            timestampWrites: timer?.drawEndWrites(),
        });
        finalPass.setPipeline(pipelines.blit);
        finalPass.setBindGroup(0, this.trailGroup);
        finalPass.draw(3);
        if (pointerOn) this.drawPointer(finalPass);
        finalPass.end();
    }

    writeOrganicUniform(view, world) {
        const org = view.organic;
        const o = this.organicData;
        const fw = this.fieldTexture.width;
        const fh = this.fieldTexture.height;
        const splatRadius = org.splatRadius * view.rMax;
        // 勾配はテクセル単位なので、スプラット半径 (テクセル数) で正規化して傾きを解像度に依存させない
        const radiusTexels = splatRadius * fh / world.height;
        o[0] = fw; o[1] = fh;
        o[2] = splatRadius;
        o[3] = org.stretch;
        o[4] = view.maxSpeed;
        o[5] = view.restDensity;
        o[6] = org.coreBoost;
        o[7] = org.threshold;
        o[8] = org.edge;
        o[9] = org.rimStrength;
        o[10] = radiusTexels * 0.6;
        // 半径 s*rMax の円内の粒子数 ~ 6 * density * s^2、カーネルの平均 = 1/4
        o[11] = 1 / Math.max(1.5 * view.restDensity * org.splatRadius * org.splatRadius, 1e-3);
        this.device.queue.writeBuffer(this.organicBuffer, 0, o);
    }

    drawComposite(pass, pipeline, group) {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.draw(3);
    }

    drawParticles(pass, pipeline, group, count) {
        if (count === 0) return;
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.draw(6, count);
    }

    drawPointer(pass) {
        pass.setPipeline(this.pipelines.pointer);
        pass.setBindGroup(0, this.pointerGroup);
        pass.draw(6, 9);
    }
}
