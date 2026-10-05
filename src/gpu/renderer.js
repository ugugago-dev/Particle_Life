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
//   }
//
// トレイルなし: canvas に BG クリア -> パーティクル -> ポインタ円 を 1 パスで描く。
// トレイルあり: 永続テクスチャ (rgba16float) を BG で薄くフェード -> パーティクルを重ね描き、
//               そのあと canvas へ等倍コピー -> ポインタ円 (円はトレイルに残さない)。

import { createShaderModule, withErrorScope } from './device.js';
import {
    MAX_PALETTE, RENDER_UNIFORM_FLOATS,
    particleWGSL, fadeWGSL, blitWGSL, pointerWGSL,
} from './shaders/render.wgsl.js';

const BG = { r: 1 / 255, g: 14 / 255, b: 29 / 255, a: 1 };   // style.css の --bg
const TRAIL_FORMAT = 'rgba16float';  // 8bit だとフェードの丸めで残像が消えきらないため
const TRAIL_FADE = 0.14;             // Canvas2D 版と同じ (小さいほど長く残る)

const ALPHA_BLEND = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
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
    }

    async createPipelines() {
        const { device, format } = this;
        await withErrorScope(device, 'render pipelines', async () => {
            const [particle, fade, blit, pointer] = await Promise.all([
                createShaderModule(device, 'particle', particleWGSL),
                createShaderModule(device, 'fade', fadeWGSL),
                createShaderModule(device, 'blit', blitWGSL),
                createShaderModule(device, 'pointer', pointerWGSL),
            ]);
            const target = (fmt, blend) => [{ format: fmt, blend }];
            const particlePipeline = (fmt) => device.createRenderPipeline({
                label: `particles -> ${fmt}`,
                layout: 'auto',
                vertex: { module: particle, entryPoint: 'vs' },
                fragment: { module: particle, entryPoint: 'fs', targets: target(fmt, ALPHA_BLEND) },
                primitive: { topology: 'triangle-list' },
            });
            this.pipelines = {
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
        u[11] = 0;
        device.queue.writeBuffer(this.uniformBuffer, 0, u);

        this.updatePalette(view.palette);
        this.updateParticleGroup(sim);

        const count = sim.count;
        const canvasView = this.context.getCurrentTexture().createView();
        const bgClear = { r: BG.r, g: BG.g, b: BG.b, a: 1 };

        if (!view.trails) {
            const pass = encoder.beginRenderPass({
                label: 'draw',
                colorAttachments: [{ view: canvasView, clearValue: bgClear, loadOp: 'clear', storeOp: 'store' }],
                timestampWrites: timer?.drawWrites(),
            });
            this.drawParticles(pass, pipelines.particleToCanvas, this.particleGroup.canvas, count);
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
            timestampWrites: timer?.drawBeginWrites(),
        });
        if (!clear) {
            trailPass.setPipeline(pipelines.fade);
            trailPass.setBindGroup(0, this.fadeGroup);
            trailPass.draw(3);
        }
        this.drawParticles(trailPass, pipelines.particleToTrail, this.particleGroup.trail, count);
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
