// WebGPU レンダラ: シミュレーションのバッファ A を頂点シェーダから直接読んで描く。organic のパス構成は docs/organic-rendering-spec.md
// view = { palette, particleRadius (CSS px), trails, pointer, pointerRadius (ワールド単位), rMax, organic (config.js の Organic 項目) }

import { createShaderModule, withErrorScope } from './device.js';
import {
    MAX_PALETTE, RENDER_UNIFORM_FLOATS,
    particleWGSL, fadeWGSL, blitWGSL, pointerWGSL,
} from './shaders/render.wgsl.js';
import {
    ORGANIC_FIELDS, ORGANIC_UNIFORM_FLOATS, BLUR_UNIFORM_FLOATS, BLUR_MAX_PAIRS, assertOrganicLayout,
    splatWGSL, shapeWGSL, downsampleWGSL, blurWGSL, compositeWGSL, paperWGSL,
} from './shaders/organic.wgsl.js';
import { ORGANIC_STYLES, SHAPE_INDEX } from '../organicStyles.js';
import { buildStainTables, MAX_STAIN_TYPES } from '../stainColor.js';

const BG = { r: 1 / 255, g: 14 / 255, b: 29 / 255, a: 1 };   // style.css の --bg
const TRAIL_FORMAT = 'rgba16float';  // 8bit だとフェードの丸めで残像が消えきらない
const FIELD_FORMAT = 'rgba16float';  // 加算しても 1 で飽和しない
const GRANULE_FORMAT = 'r16float';
const PAPER_FORMAT = 'rgba8unorm';
const TRAIL_FADE = 0.14;             // Canvas2D 版と同じ

const SIGMA_MAX_TEXELS = 5;          // これを超える σ は解像度を 1/2 ずつ落としてぼかす
const MAX_BLUR_LEVEL = 6;

const OF = Object.fromEntries(ORGANIC_FIELDS.map((name, i) => [name, i]));
// config.js から同名でコピーする項目 (残りは writeOrganicUniform で計算)
const COPIED_PARAMS = ['fieldGain', 'threshold', 'nucleusThreshold', 'speciesTint', 'rimStrength', 'coreThreshold', 'scopeStain', 'scopeVignette', 'scopeSpeck', 'scopeIsolation'];

const ALPHA_BLEND = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const ADDITIVE_BLEND = {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

/** σ (px) を SIGMA_MAX_TEXELS 以下に収める縮小の段数。 */
function blurLevel(sigmaPx) {
    const k = Math.ceil(Math.log2(Math.max(sigmaPx, 1e-3) / SIGMA_MAX_TEXELS));
    return Math.min(MAX_BLUR_LEVEL, Math.max(0, k));
}

const TAP_WEIGHTS = new Float64Array(2 * BLUR_MAX_PAIRS + 1);

/** 半径 3σ のガウシアンを、隣り合う 2 テクセルを 1 回のバイリニアにまとめたタップ表 (中心 + ペア) にして out に書き、ペア数を返す。 */
function writeGaussianTaps(out, base, sigma) {
    const s = Math.max(sigma, 0.3);
    const radius = Math.min(Math.ceil(3 * s), 2 * BLUR_MAX_PAIRS);
    const w = TAP_WEIGHTS;
    let total = 0;
    for (let i = 0; i <= radius; i++) {
        w[i] = Math.exp(-0.5 * (i / s) * (i / s));
        total += i === 0 ? w[i] : 2 * w[i];
    }
    out[base] = 0;
    out[base + 1] = w[0] / total;
    let pairs = 0;
    for (let i = 1; i <= radius; i += 2) {
        const wa = w[i];
        const wb = i + 1 <= radius ? w[i + 1] : 0;
        pairs++;
        out[base + 4 * pairs] = (i * wa + (i + 1) * wb) / (wa + wb);
        out[base + 4 * pairs + 1] = (wa + wb) / total;
    }
    return pairs;
}

export class GpuRenderer {
    /**
     * @param {GPUDevice} device
     * @param {GPUCanvasContext} context
     * @param {GPUTextureFormat} format
     * @param {HTMLCanvasElement} canvas
     */
    static async create(device, context, format, canvas) {
        assertOrganicLayout();
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
        // scope の種類ごとの染色 (WGSL の StainTables = stain[16] + transmit[16])
        this.stainBuffer = device.createBuffer({
            label: 'scope stain tables',
            size: 2 * MAX_STAIN_TYPES * 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.trailTexture = null;
        this.trailView = null;
        this.trailGroup = null;
        this.needsTrailClear = true;

        this.particleGroup = null;
        this.particleGroupKey = null;

        // style / shape だけ u32。前回送った値とビットで比べて、変わったときだけ送る
        this.organicData = new Float32Array(ORGANIC_UNIFORM_FLOATS);
        this.organicU32 = new Uint32Array(this.organicData.buffer);
        this.organicSent = new Uint32Array(ORGANIC_UNIFORM_FLOATS);
        this.organicBuffer = device.createBuffer({
            label: 'organic params',
            size: ORGANIC_UNIFORM_FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.blurData = new Float32Array(BLUR_UNIFORM_FLOATS);
        this.blurU32 = new Uint32Array(this.blurData.buffer);
        this.blurBuffers = Object.fromEntries(['smallH', 'smallV', 'largeH', 'largeV'].map((name) => [name, device.createBuffer({
            label: `organic blur ${name}`,
            size: BLUR_UNIFORM_FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })]));
        // 周期境界なので repeat
        this.fieldSampler = device.createSampler({
            magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat',
        });
        this.organicLayout = { fw: 0, fh: 0, margin: 0, sigmaSmall: 0, sigmaLarge: 0, ks: 0, kl: 0 };
        this.organicPlan = null;
        this.splatGroups = null;      // auto layout はパイプラインごとに別なので plain / granule の 2 つ
        this.splatGroupKey = null;
    }

    async createPipelines() {
        const { device, format } = this;
        await withErrorScope(device, 'render pipelines', async () => {
            const [particle, fade, blit, pointer, splat, shape, downsample, blur, composite, paper] = await Promise.all([
                createShaderModule(device, 'particle', particleWGSL),
                createShaderModule(device, 'fade', fadeWGSL),
                createShaderModule(device, 'blit', blitWGSL),
                createShaderModule(device, 'pointer', pointerWGSL),
                createShaderModule(device, 'organic splat', splatWGSL),
                createShaderModule(device, 'organic shape', shapeWGSL),
                createShaderModule(device, 'organic downsample', downsampleWGSL),
                createShaderModule(device, 'organic blur', blurWGSL),
                createShaderModule(device, 'organic composite', compositeWGSL),
                createShaderModule(device, 'organic paper', paperWGSL),
            ]);
            const target = (fmt, blend) => [{ format: fmt, blend }];
            const particlePipeline = (fmt) => device.createRenderPipeline({
                label: `particles -> ${fmt}`,
                layout: 'auto',
                vertex: { module: particle, entryPoint: 'vs' },
                fragment: { module: particle, entryPoint: 'fs', targets: target(fmt, ALPHA_BLEND) },
                primitive: { topology: 'triangle-strip' },
            });
            const fullscreenPipeline = (label, module, fmt) => device.createRenderPipeline({
                label,
                layout: 'auto',
                vertex: { module, entryPoint: 'vs' },
                fragment: { module, entryPoint: 'fs', targets: target(fmt) },
                primitive: { topology: 'triangle-list' },
            });
            const splatPipeline = (label, entryPoint, targets) => device.createRenderPipeline({
                label,
                layout: 'auto',
                vertex: { module: splat, entryPoint: 'vs' },
                fragment: { module: splat, entryPoint, targets },
                primitive: { topology: 'triangle-strip' },
            });
            this.pipelines = {
                splat: splatPipeline('organic splat', 'fs', [{ format: FIELD_FORMAT, blend: ADDITIVE_BLEND }]),
                splatGranule: splatPipeline('organic splat + granule', 'fsGranule', [
                    { format: FIELD_FORMAT, blend: ADDITIVE_BLEND },
                    { format: GRANULE_FORMAT, blend: ADDITIVE_BLEND },
                ]),
                shape: fullscreenPipeline('organic shape', shape, FIELD_FORMAT),
                shapeGranule: device.createRenderPipeline({
                    label: 'organic shape + granule',
                    layout: 'auto',
                    vertex: { module: shape, entryPoint: 'vs' },
                    fragment: { module: shape, entryPoint: 'fsGranule', targets: [{ format: FIELD_FORMAT }, { format: GRANULE_FORMAT }] },
                    primitive: { topology: 'triangle-list' },
                }),
                shapeSoft: device.createRenderPipeline({
                    label: 'organic shape + soft large',
                    layout: 'auto',
                    vertex: { module: shape, entryPoint: 'vs' },
                    fragment: { module: shape, entryPoint: 'fsSoft', targets: [{ format: FIELD_FORMAT }, { format: FIELD_FORMAT }] },
                    primitive: { topology: 'triangle-list' },
                }),
                downsample: fullscreenPipeline('organic downsample', downsample, FIELD_FORMAT),
                blur: fullscreenPipeline('organic blur', blur, FIELD_FORMAT),
                composite: fullscreenPipeline('organic composite', composite, format),
                paper: fullscreenPipeline('organic paper', paper, PAPER_FORMAT),
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
                    primitive: { topology: 'triangle-strip' },
                }),
            };
            const uniformOnly = (pipeline) => device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
            });
            this.fadeGroup = uniformOnly(this.pipelines.fade);
            this.pointerGroup = uniformOnly(this.pipelines.pointer);
        });
    }

    /** バックバッファを CSS サイズ x dpr にする (テクスチャ上限を超えるときは比率を保って縮める)。 */
    resize(cssW, cssH, dpr) {
        this.dpr = dpr;
        const maxDim = this.device.limits.maxTextureDimension2D;
        const fit = Math.min(1, maxDim / (cssW * dpr), maxDim / (cssH * dpr));
        const w = Math.max(1, Math.floor(cssW * dpr * fit));
        const h = Math.max(1, Math.floor(cssH * dpr * fit));
        if (w === this.canvas.width && h === this.canvas.height) return;
        this.canvas.width = w;
        this.canvas.height = h;
        this.needsTrailClear = true;
    }

    /** field の解像度・余白、ブラーの σ (field の px) と縮小段数を決める。large を使わないスタイルは kl = -1。 */
    updateOrganicLayout(org, style, rMax, worldH) {
        const { canvas, organicLayout: L } = this;
        L.fw = Math.max(1, Math.round(canvas.width * org.fieldScale));
        L.fh = Math.max(1, Math.round(canvas.height * org.fieldScale));
        const pxPerWorld = L.fh / worldH;
        L.sigmaSmall = Math.max(org.blurSmall * style.fine.small * rMax * pxPerWorld, 0.3);
        L.sigmaLarge = Math.max(org.blurLarge * style.fine.large * rMax * pxPerWorld, 0.3);
        L.ks = blurLevel(L.sigmaSmall);
        L.kl = style.params.includes('blurLarge') ? blurLevel(L.sigmaLarge) : -1;
        // 折り返しは 1 回分だけなので field の大きさで頭打ち
        const splatPx = org.splatRadius * style.fine.splat * rMax * pxPerWorld;
        L.margin = Math.min(Math.ceil(splatPx) + 1, L.fw, L.fh);
        return L;
    }

    /** 中間テクスチャ・パス・バインドグループ (plan) を、layout かスタイルの使うもの (紙のノイズなら canvas と dpr も) が変わったときだけ作り直す。 */
    ensureOrganicPlan(L, style) {
        const p = this.organicPlan;
        const { canvas, dpr } = this;
        const paperStale = style.paper && (p?.paperW !== canvas.width || p?.paperH !== canvas.height || p?.paperDpr !== dpr);
        if (!p || p.fw !== L.fw || p.fh !== L.fh || p.margin !== L.margin || p.ks !== L.ks || p.kl !== L.kl || p.granules !== style.granules
            || p.softLarge !== !!style.softLarge || p.paper !== style.paper || paperStale) {
            this.destroyOrganicPlan();
            this.organicPlan = this.buildOrganicPlan(L, style);
        }
        return this.organicPlan;
    }

    destroyOrganicPlan() {
        const plan = this.organicPlan;
        if (!plan) return;
        for (const t of plan.textures) t.destroy();
        this.organicPlan = null;
    }

    buildOrganicPlan({ fw, fh, margin, ks, kl }, { granules, paper, softLarge }) {
        const { device, pipelines, canvas } = this;
        const textures = [];
        const make = (label, w, h, format = FIELD_FORMAT) => {
            const texture = device.createTexture({
                label: `organic ${label}`,
                size: [w, h],
                format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            textures.push(texture);
            return { view: texture.createView(), w, h };
        };

        // field は余白付き、levels[0] (shape の出力) 以降は余白なし。levels[k] = 1/2^k
        const field = make('field', fw + 2 * margin, fh + 2 * margin);
        const halve = (name, chain, k) => {
            const prev = chain[k - 1];
            chain.push(make(`${name} ${k}`, Math.max(1, Math.ceil(prev.w / 2)), Math.max(1, Math.ceil(prev.h / 2))));
        };
        const levels = [make('shaped', fw, fh)];
        for (let k = 1; k <= (softLarge ? ks : Math.max(ks, kl)); k++) halve('level', levels, k);
        // softLarge: large ぼかしは別の整形の縮小列から作る
        const levelsL = softLarge ? [make('shaped large', fw, fh)] : levels;
        if (softLarge) for (let k = 1; k <= kl; k++) halve('large level', levelsL, k);
        const granuleRaw = granules ? make('granule (padded)', fw + 2 * margin, fh + 2 * margin, GRANULE_FORMAT) : null;
        const granule = granules ? make('granule', fw, fh, GRANULE_FORMAT) : null;
        const paperTex = paper ? make('paper', canvas.width, canvas.height, PAPER_FORMAT) : null;
        const paperGroup = paper ? device.createBindGroup({
            layout: pipelines.paper.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: this.organicBuffer } }],
        }) : null;

        const shapePipeline = granules ? pipelines.shapeGranule : softLarge ? pipelines.shapeSoft : pipelines.shape;
        const shapePass = {
            label: 'organic shape',
            pipeline: shapePipeline,
            target: levels[0].view,
            extraTarget: granule?.view ?? (softLarge ? levelsL[0].view : undefined),
            group: null,    // softLarge は large ぼかしの出力 (前フレームの値) も読むので、それを作ったあとで
        };
        const passes = [shapePass];    // 実行順の全画面パス
        for (const chain of softLarge ? [levels, levelsL] : [levels]) {
            for (let k = 1; k < chain.length; k++) {
                passes.push({
                    label: `organic downsample ${k}`,
                    pipeline: pipelines.downsample,
                    target: chain[k].view,
                    group: device.createBindGroup({
                        layout: pipelines.downsample.getBindGroupLayout(0),
                        entries: [{ binding: 0, resource: chain[k - 1].view }],
                    }),
                });
            }
        }
        const blurs = [];    // タップ表の更新用 (passes の部分集合)
        const blurPair = (branch, lv) => {
            const tmp = make(`${branch} blur tmp`, lv.w, lv.h);
            const out = make(`${branch} blur`, lv.w, lv.h);
            const add = (name, axis, src, dst) => {
                const pass = {
                    label: `organic blur ${name}`,
                    pipeline: pipelines.blur,
                    target: dst.view,
                    group: device.createBindGroup({
                        layout: pipelines.blur.getBindGroupLayout(0),
                        entries: [
                            { binding: 0, resource: { buffer: this.blurBuffers[name] } },
                            { binding: 1, resource: src.view },
                            { binding: 2, resource: this.fieldSampler },
                        ],
                    }),
                    buffer: this.blurBuffers[name], branch, axis, w: lv.w, h: lv.h, sigmaTexels: NaN,
                };
                passes.push(pass);
                blurs.push(pass);
            };
            add(`${branch}H`, 0, lv, tmp);
            add(`${branch}V`, 1, tmp, out);
            return out;
        };
        const small = blurPair('small', levels[ks]);
        const large = kl >= 0 ? blurPair('large', levelsL[kl]) : small;    // 使わないスタイルでは読まれない
        // softLarge (scope) の shape は前フレームの large ぼかしを読む (異種の分離)。このフレームではあとのパスで書かれるので
        // 同じパスで読み書きはしない。作り直した直後は 0 (減衰なし)
        shapePass.group = device.createBindGroup({
            layout: shapePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.organicBuffer } },
                { binding: 1, resource: field.view },
                ...(granules ? [{ binding: 2, resource: granuleRaw.view }] : []),
                ...(softLarge ? [{ binding: 3, resource: large.view }, { binding: 4, resource: this.fieldSampler }] : []),
            ],
        });

        const compositeGroup = device.createBindGroup({
            layout: pipelines.composite.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: { buffer: this.organicBuffer } },
                { binding: 2, resource: this.fieldSampler },
                { binding: 3, resource: small.view },
                { binding: 4, resource: large.view },
                { binding: 5, resource: (granule ?? small).view },    // cell 以外では読まれない
                { binding: 6, resource: (paperTex ?? small).view },
                { binding: 7, resource: { buffer: this.stainBuffer } },    // scope だけ
            ],
        });

        return {
            fw, fh, margin, ks, kl, granules, softLarge: !!softLarge, textures, passes, blurs, compositeGroup,
            fieldView: field.view, granuleView: granuleRaw?.view ?? null,
            paper, paperW: canvas.width, paperH: canvas.height, paperDpr: this.dpr,
            paperView: paperTex?.view ?? null, paperGroup, paperDirty: paper,
        };
    }

    updateSplatGroup(sim) {
        const { posVelA, metaA } = sim.buffers;
        const k = this.splatGroupKey;
        if (k && k[0] === posVelA && k[1] === metaA) return;
        this.splatGroupKey = [posVelA, metaA];
        const group = (pipeline) => this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: { buffer: this.paletteBuffer } },
                { binding: 2, resource: { buffer: posVelA } },
                { binding: 3, resource: { buffer: metaA } },
                { binding: 4, resource: { buffer: this.organicBuffer } },
            ],
        });
        this.splatGroups = { plain: group(this.pipelines.splat), granule: group(this.pipelines.splatGranule) };
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
        const { stain, transmit } = buildStainTables(palette.rgb, palette.numTypes);
        this.device.queue.writeBuffer(this.stainBuffer, 0, stain);
        this.device.queue.writeBuffer(this.stainBuffer, stain.byteLength, transmit);
    }

    updateParticleGroup(sim) {
        const { posVelA, metaA } = sim.buffers;
        if (this.particleGroupKey && this.particleGroupKey[0] === posVelA && this.particleGroupKey[1] === metaA) return;
        this.particleGroupKey = [posVelA, metaA];
        this.particleGroup = {
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
        if (organic) {    // showParticles の重ね描きは半径半分・薄く
            u[4] *= 0.5;
            u[11] = 0.3;
        }
        device.queue.writeBuffer(this.uniformBuffer, 0, u);

        this.updatePalette(view.palette);
        this.updateParticleGroup(sim);

        const canvasView = this.context.getCurrentTexture().createView();
        const bgClear = { r: BG.r, g: BG.g, b: BG.b, a: 1 };

        if (organic) {
            this.drawOrganic(encoder, sim, view, canvasView, { dots: !!org.showParticles, pointerOn, timer });
            this.needsTrailClear = true;
            return;
        }

        if (!view.trails) {
            const pass = encoder.beginRenderPass({
                label: 'draw',
                colorAttachments: [{ view: canvasView, clearValue: bgClear, loadOp: 'clear', storeOp: 'store' }],
                timestampWrites: timer?.drawWrites(),
            });
            this.drawParticles(pass, pipelines.particleToCanvas, this.particleGroup.canvas, count);
            if (pointerOn) this.drawPointer(pass);
            pass.end();
            this.needsTrailClear = true;
            return;
        }

        // トレイル: 永続テクスチャをフェードして重ね描き -> canvas へコピー (ポインタ円はトレイルに残さない)
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

    drawOrganic(encoder, sim, view, canvasView, { dots, pointerOn, timer }) {
        const { pipelines } = this;
        const org = view.organic;
        const style = ORGANIC_STYLES[org.organicStyle] ?? ORGANIC_STYLES.glass;    // 廃止したスタイル名は glass
        const count = sim.count;
        const layout = this.updateOrganicLayout(org, style, view.rMax, sim.world.height);
        const plan = this.ensureOrganicPlan(layout, style);
        this.writeOrganicUniform(org, style, view.rMax, sim, layout, view.palette);
        this.writeBlurUniforms(plan, layout);
        this.updateSplatGroup(sim);

        if (plan.paperDirty) {    // 紙のノイズは plan を作り直した直後だけ焼く
            const pass = encoder.beginRenderPass({
                label: 'organic paper',
                colorAttachments: [{ view: plan.paperView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
            });
            pass.setPipeline(pipelines.paper);
            pass.setBindGroup(0, plan.paperGroup);
            pass.draw(3);
            pass.end();
            plan.paperDirty = false;
        }

        const clear = { r: 0, g: 0, b: 0, a: 0 };
        const colorAttachments = [{ view: plan.fieldView, clearValue: clear, loadOp: 'clear', storeOp: 'store' }];
        if (plan.granuleView) colorAttachments.push({ view: plan.granuleView, clearValue: clear, loadOp: 'clear', storeOp: 'store' });
        const splatPass = encoder.beginRenderPass({
            label: 'organic splat',
            colorAttachments,
            timestampWrites: timer?.drawBeginWrites(),
        });
        splatPass.setPipeline(plan.granuleView ? pipelines.splatGranule : pipelines.splat);
        splatPass.setBindGroup(0, plan.granuleView ? this.splatGroups.granule : this.splatGroups.plain);
        splatPass.draw(4, count);
        splatPass.end();

        for (const p of plan.passes) {
            const colorAttachments = [{ view: p.target, clearValue: clear, loadOp: 'clear', storeOp: 'store' }];
            if (p.extraTarget) colorAttachments.push({ view: p.extraTarget, clearValue: clear, loadOp: 'clear', storeOp: 'store' });
            const pass = encoder.beginRenderPass({ label: p.label, colorAttachments });
            pass.setPipeline(p.pipeline);
            pass.setBindGroup(0, p.group);
            pass.draw(3);
            pass.end();
        }

        const pass = encoder.beginRenderPass({
            label: 'organic composite',
            colorAttachments: [{ view: canvasView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
            timestampWrites: timer?.drawEndWrites(),
        });
        pass.setPipeline(pipelines.composite);
        pass.setBindGroup(0, plan.compositeGroup);
        pass.draw(3);
        if (dots) this.drawParticles(pass, pipelines.particleToCanvas, this.particleGroup.canvas, count);
        if (pointerOn) this.drawPointer(pass);
        pass.end();
    }

    writeOrganicUniform(org, style, rMax, sim, layout, palette) {
        const f = this.organicData;
        const u = this.organicU32;
        const world = sim.world;
        // 平均密度のとき field = 1 になる重み (導出は仕様書の「正規化」)。下限 0.5 は粒子がほぼ無いときの発散よけ
        const meanDensity = Math.max(sim.count / (world.width * world.height) * Math.PI * rMax * rMax / 6, 0.5);
        const splatRadius = org.splatRadius * style.fine.splat;
        f[OF.weightNorm] = 1 / Math.max(1.5 * meanDensity * splatRadius * splatRadius, 1e-3);
        f[OF.splatRadius] = splatRadius * rMax;
        u[OF.style] = style.index;
        u[OF.shape] = SHAPE_INDEX[style.shape];
        f[OF.dpr] = this.dpr;
        f[OF.fieldW] = layout.fw;
        f[OF.fieldH] = layout.fh;
        f[OF.margin] = layout.margin;
        f[OF.numTypes] = Math.min(Math.max(palette.numTypes, 1), MAX_STAIN_TYPES);
        for (const name of COPIED_PARAMS) f[OF[name]] = org[name];
        f[OF.threshold] *= style.thresholdScale ?? 1;

        const sent = this.organicSent;
        for (let i = 0; i < u.length; i++) {
            if (u[i] !== sent[i]) {
                sent.set(u);
                this.device.queue.writeBuffer(this.organicBuffer, 0, f);
                return;
            }
        }
    }

    /** σ が変わったブラーのパスだけタップ表を書き直す。 */
    writeBlurUniforms(plan, layout) {
        const d = this.blurData;
        for (const b of plan.blurs) {
            const sigmaPx = b.branch === 'small' ? layout.sigmaSmall : layout.sigmaLarge;
            const sigmaTexels = sigmaPx * (b.axis === 0 ? b.w / plan.fw : b.h / plan.fh);
            if (sigmaTexels === b.sigmaTexels) continue;
            b.sigmaTexels = sigmaTexels;
            if (b.axis === 0) {
                d[0] = 1 / b.w; d[1] = 0;
            } else {
                d[0] = 0; d[1] = 1 / b.h;
            }
            this.blurU32[2] = writeGaussianTaps(d, 4, sigmaTexels);
            this.device.queue.writeBuffer(b.buffer, 0, d);
        }
    }

    drawParticles(pass, pipeline, group, count) {
        if (count === 0) return;
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.draw(4, count);
    }

    drawPointer(pass) {
        pass.setPipeline(this.pipelines.pointer);
        pass.setBindGroup(0, this.pointerGroup);
        pass.draw(4, 9);
    }
}
