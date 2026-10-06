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
//     rMax:           number                                  organic のスプラット / ぼかし半径 (x rMax) と密度の正規化
//     organic:        { renderMode, organicStyle, fieldScale, splatRadius, fieldGain, blurSmall, blurLarge,
//                       glowIntensity, bandFreq, bandBase, threshold, nucleusThreshold, coreThreshold, rimStrength,
//                       speciesTint, showParticles }
//                                                             config.js の Organic 項目。スタイルごとの違い (使うパス・
//                                                             スタイル固有の項目) は organicStyles.js の表
//   }
//
// トレイルなし: canvas に BG クリア -> パーティクル -> ポインタ円 を 1 パスで描く。
// トレイルあり: 永続テクスチャ (rgba16float) を BG で薄くフェード -> パーティクルを重ね描き、
//               そのあと canvas へ等倍コピー -> ポインタ円 (円はトレイルに残さない)。
//
// organic モード (docs/organic-rendering-spec.md): トレイルは無視して、不透明な全画面を描く。
//   1. splat      : 粒子を field (rgba16float, canvas x fieldScale + 周囲に margin px の余白) に加算
//                   (cell だけ顆粒テクスチャ r16float に MRT)。1 粒子 = 1 instance (4 頂点の strip)
//   2. shape      : 余白に落ちた端のはみ出しを反対側へ折り返し (周期境界)、スタイルの shape
//                   (occupancy / compress / nucleus) で 0..1 の指標に整形 (cell は顆粒も折り返す)
//   3. downsample : ブラーの σ が大きいときだけ、1/2 ずつ縮小 (ピラミッド)
//   4. blur       : small (disk) と large (ring) の分離ガウス (水平 -> 垂直)。それぞれ必要なら低解像度で
//                   (large を使わないスタイルは large を作らない)
//   5. composite  : スタイル (glass / cell / glow / bands / mono) で着色して canvas へ -> パーティクル (任意) -> ポインタ円
//   (cell だけ: 画面固定のノイズを canvas 解像度のテクスチャに焼いておく。canvas のサイズ / dpr が変わったときだけ)

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

const BG = { r: 1 / 255, g: 14 / 255, b: 29 / 255, a: 1 };   // style.css の --bg
const TRAIL_FORMAT = 'rgba16float';  // 8bit だとフェードの丸めで残像が消えきらないため
const FIELD_FORMAT = 'rgba16float';  // 加算ブレンド可能で、色 x 重みが 1 を超えても飽和しない (ぼかしの中間も同じ)
const GRANULE_FORMAT = 'r16float';   // 顆粒 (cell の小器官)。1 チャンネルで足りる。16bit float は加算ブレンド可能
const PAPER_FORMAT = 'rgba8unorm';   // cell の画面固定のノイズ (0..1 の 3 値)
const TRAIL_FADE = 0.14;             // Canvas2D 版と同じ (小さいほど長く残る)

const SIGMA_MAX_TEXELS = 5;          // 1 方向のぼかしの σ の上限 (テクセル)。超える分は解像度を 1/2 ずつ落として収める
const MAX_BLUR_LEVEL = 6;            // 縮小の段数の上限 (1/64)

// OrganicParams のフィールド位置 (organic.wgsl.js の ORGANIC_FIELDS の順)
const OF = Object.fromEntries(ORGANIC_FIELDS.map((name, i) => [name, i]));
// config.js の項目をそのままコピーするフィールド (同名)。残り (weightNorm, splatRadius, style, shape, dpr, fieldW, fieldH, margin) は計算して入れる
const COPIED_PARAMS = ['fieldGain', 'glowIntensity', 'bandFreq', 'threshold', 'nucleusThreshold', 'speciesTint', 'bandBase', 'rimStrength', 'coreThreshold'];

const ALPHA_BLEND = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const ADDITIVE_BLEND = {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

/** σ (field の px) のガウシアンを 1 方向 SIGMA_MAX_TEXELS 以下に収めるのに必要な縮小の段数 (1 段 = 1/2)。 */
function blurLevel(sigmaPx) {
    const k = Math.ceil(Math.log2(Math.max(sigmaPx, 1e-3) / SIGMA_MAX_TEXELS));
    return Math.min(MAX_BLUR_LEVEL, Math.max(0, k));
}

/**
 * σ (テクセル) の離散ガウシアン (半径 3σ) を、バイリニアの「2 テクセルを 1 フェッチ」にまとめたタップ表にして
 * out[base...] (vec4 単位) に書く。out[base] = 中心 (offset 0, weight)、続く各 vec4 = 左右対称のペア (offset, weight)。
 * 隣り合う 2 テクセル i, i+1 (重み wa, wb) を、位置 (i*wa + (i+1)*wb) / (wa + wb) の 1 回のバイリニアで置き換える。
 * @returns {number} ペアの数 (フェッチ数は 1 + 2 * ペア数)
 */
const TAP_WEIGHTS = new Float64Array(2 * BLUR_MAX_PAIRS + 1);   // writeGaussianTaps の作業用 (半径の上限 + 1)

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
     * @param {GPUCanvasContext} context  configureCanvas() 済み
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

        this.trailTexture = null;
        this.trailView = null;
        this.trailGroup = null;
        this.needsTrailClear = true;

        this.particleGroup = null;
        this.particleGroupKey = null; // [posVelA, metaA] が変わったら作り直す

        // OrganicParams (ORGANIC_FIELDS の順)。style / shape だけ u32 なので同じバッファの u32 ビューで書く。
        // 値が変わったときだけアップロードする (前回送った値をビットで比較)
        this.organicData = new Float32Array(ORGANIC_UNIFORM_FLOATS);
        this.organicU32 = new Uint32Array(this.organicData.buffer);
        this.organicSent = new Uint32Array(ORGANIC_UNIFORM_FLOATS);
        this.organicBuffer = device.createBuffer({
            label: 'organic params',
            size: ORGANIC_UNIFORM_FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        // ブラーのパス (small / large x 水平 / 垂直) ごとに別のタップ表 (σ が変わったパスだけ書き直す)
        this.blurData = new Float32Array(BLUR_UNIFORM_FLOATS);
        this.blurU32 = new Uint32Array(this.blurData.buffer);          // count (u32)
        this.blurBuffers = Object.fromEntries(['smallH', 'smallV', 'largeH', 'largeV'].map((name) => [name, device.createBuffer({
            label: `organic blur ${name}`,
            size: BLUR_UNIFORM_FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })]));
        // ワールドは周期境界なので repeat (端のぼかしが反対側から回り込む。splat も端をまたぐ分を反対側に描く)
        this.fieldSampler = device.createSampler({
            magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat',
        });
        this.organicLayout = { fw: 0, fh: 0, margin: 0, sigmaSmall: 0, sigmaLarge: 0, ks: 0, kl: 0 };   // 毎フレーム更新 (updateOrganicLayout)
        this.organicPlan = null;      // 中間テクスチャ・パス・バインドグループ (ensureOrganicPlan)
        this.splatGroups = null;      // { plain, granule } (パイプラインごとに auto layout が別)
        this.splatGroupKey = null;    // [posVelA, metaA]
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
                primitive: { topology: 'triangle-strip' },    // 4 頂点の四角形 (quadCorner)
            });
            // 全画面三角形 + ブレンドなし (downsample / blur は field 形式へ、composite は canvas へ書き切る)
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
                primitive: { topology: 'triangle-strip' },    // 4 頂点の四角形 (quadCorner)
            });
            this.pipelines = {
                // field だけ (cell 以外) / field + 顆粒の MRT (cell)
                splat: splatPipeline('organic splat', 'fs', [{ format: FIELD_FORMAT, blend: ADDITIVE_BLEND }]),
                splatGranule: splatPipeline('organic splat + granule', 'fsGranule', [
                    { format: FIELD_FORMAT, blend: ADDITIVE_BLEND },
                    { format: GRANULE_FORMAT, blend: ADDITIVE_BLEND },
                ]),
                shape: fullscreenPipeline('organic shape', shape, FIELD_FORMAT),
                // cell: 整形した field + 折り返した顆粒の MRT
                shapeGranule: device.createRenderPipeline({
                    label: 'organic shape + granule',
                    layout: 'auto',
                    vertex: { module: shape, entryPoint: 'vs' },
                    fragment: { module: shape, entryPoint: 'fsGranule', targets: [{ format: FIELD_FORMAT }, { format: GRANULE_FORMAT }] },
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
                    primitive: { topology: 'triangle-strip' },    // 4 頂点の四角形 (quadCorner)
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

    /**
     * organic のスタイルと画面から、field の解像度とブラーの σ (field の px) / 縮小の段数を決める (this.organicLayout を更新)。
     * large を使わないスタイルは kl = -1 (large のブラーを作らない)。
     */
    updateOrganicLayout(org, style, rMax, worldH) {
        const { canvas, organicLayout: L } = this;
        L.fw = Math.max(1, Math.round(canvas.width * org.fieldScale));
        L.fh = Math.max(1, Math.round(canvas.height * org.fieldScale));
        const pxPerWorld = L.fh / worldH;
        L.sigmaSmall = Math.max(org.blurSmall * style.fine.small * rMax * pxPerWorld, 0.3);
        L.sigmaLarge = Math.max(org.blurLarge * style.fine.large * rMax * pxPerWorld, 0.3);
        L.ks = blurLevel(L.sigmaSmall);
        L.kl = style.params.includes('blurLarge') ? blurLevel(L.sigmaLarge) : -1;
        // splat の余白: スプラット半径 (px) + 1。field より大きいと 1 回の折り返しで足りないので field の大きさで頭打ち
        // (以前の 4 コピー方式も 1 回分しかずらさなかったので同じ)
        const splatPx = org.splatRadius * style.fine.splat * rMax * pxPerWorld;
        L.margin = Math.min(Math.ceil(splatPx) + 1, L.fw, L.fh);
        return L;
    }

    /**
     * organic の中間テクスチャとパス (整形 / 縮小 / ブラー / 合成) の計画を、field サイズ・ブラーの縮小段数・
     * スタイルが使うもの (large / 顆粒 / 紙のノイズ) が変わったときだけ作り直す。リサイズ・fieldScale・ブラー半径・スタイルの変更で呼ばれる。
     * 紙のノイズ (cell) は canvas の px で決まるので、使うときは canvas のサイズと dpr も比べる。
     * @returns {object} plan
     */
    ensureOrganicPlan(L, style) {
        const p = this.organicPlan;
        const { canvas, dpr } = this;
        const paperStale = style.paper && (p?.paperW !== canvas.width || p?.paperH !== canvas.height || p?.paperDpr !== dpr);
        if (!p || p.fw !== L.fw || p.fh !== L.fh || p.margin !== L.margin || p.ks !== L.ks || p.kl !== L.kl || p.granules !== style.granules
            || p.paper !== style.paper || paperStale) {
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

    buildOrganicPlan({ fw, fh, margin, ks, kl }, { granules, paper }) {
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

        // field: splat の出力 (密度そのもの、周囲に margin px の余白)。levels[0]: それを折り返して shape で整形したもの (余白なし)。
        // 解像度ピラミッド: levels[k] = levels[0] の 1/2^k (偶数でなければ切り上げ)。ブラーは levels から読む
        const field = make('field', fw + 2 * margin, fh + 2 * margin);
        const levels = [make('shaped', fw, fh)];
        for (let k = 1; k <= Math.max(ks, kl); k++) {
            const prev = levels[k - 1];
            levels.push(make(`level ${k}`, Math.max(1, Math.ceil(prev.w / 2)), Math.max(1, Math.ceil(prev.h / 2))));
        }
        // 顆粒 (cell): splat が余白付きの granuleRaw に書き、shape が折り返して余白なしの granule にする
        const granuleRaw = granules ? make('granule (padded)', fw + 2 * margin, fh + 2 * margin, GRANULE_FORMAT) : null;
        const granule = granules ? make('granule', fw, fh, GRANULE_FORMAT) : null;
        // 紙のノイズ (cell): canvas 解像度。焼くのは作った直後の 1 回だけ (drawOrganic が paperDirty を見る)
        const paperTex = paper ? make('paper', canvas.width, canvas.height, PAPER_FORMAT) : null;
        const paperGroup = paper ? device.createBindGroup({
            layout: pipelines.paper.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: this.organicBuffer } }],
        }) : null;

        const shapePipeline = granules ? pipelines.shapeGranule : pipelines.shape;
        const passes = [{    // 実行順。どれも全画面三角形 (draw(3))、書き込み先は target (+ extraTarget)
            label: 'organic shape',
            pipeline: shapePipeline,
            target: levels[0].view,
            extraTarget: granule?.view,
            group: device.createBindGroup({
                layout: shapePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.organicBuffer } },
                    { binding: 1, resource: field.view },
                    ...(granules ? [{ binding: 2, resource: granuleRaw.view }] : []),
                ],
            }),
        }];
        for (let k = 1; k < levels.length; k++) {
            passes.push({
                label: `organic downsample ${k}`,
                pipeline: pipelines.downsample,
                target: levels[k].view,
                group: device.createBindGroup({
                    layout: pipelines.downsample.getBindGroupLayout(0),
                    entries: [{ binding: 0, resource: levels[k - 1].view }],
                }),
            });
        }
        // ブラー: level k で 水平 (src -> tmp) -> 垂直 (tmp -> out)
        const blurs = [];    // passes の部分集合。タップ表の更新用 (branch, axis, w, h, 前回の σ)
        const blurPair = (branch, k) => {
            const lv = levels[k];
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
        const small = blurPair('small', ks);
        const large = kl >= 0 ? blurPair('large', kl) : small;    // large を使わないスタイルは small を入れておく (読まれない)

        const compositeGroup = device.createBindGroup({
            layout: pipelines.composite.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: { buffer: this.organicBuffer } },
                { binding: 2, resource: this.fieldSampler },
                { binding: 3, resource: small.view },
                { binding: 4, resource: large.view },
                { binding: 5, resource: (granule ?? small).view },    // 顆粒は cell だけ (ほかは読まれない)
                { binding: 6, resource: (paperTex ?? small).view },   // 紙のノイズも cell だけ
            ],
        });

        return {
            fw, fh, margin, ks, kl, granules, textures, passes, blurs, compositeGroup,
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
            // organic はトレイルを使わない (不透明な全画面)。次にトレイルを有効にしたときは BG から始める
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

    /** organic: splat -> shape -> (縮小) -> ブラー -> 合成 を encoder に積む。canvas は不透明に塗り切る。 */
    drawOrganic(encoder, sim, view, canvasView, { dots, pointerOn, timer }) {
        const { pipelines } = this;
        const org = view.organic;
        const style = ORGANIC_STYLES[org.organicStyle];
        const count = sim.count;
        const layout = this.updateOrganicLayout(org, style, view.rMax, sim.world.height);
        const plan = this.ensureOrganicPlan(layout, style);
        this.writeOrganicUniform(org, style, view.rMax, sim, layout);
        this.writeBlurUniforms(plan, layout);
        this.updateSplatGroup(sim);

        // 0. 紙のノイズ (cell): plan を作り直した直後だけ焼く (uniform の dpr は上の writeOrganicUniform が書いた)
        if (plan.paperDirty) {
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

        // 1. splat: 余白付きの field (色 x w, w)。cell は顆粒も同時に (MRT)。instance = 粒子 (周期境界は shape で折り返す)
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

        // 2-3. 整形 + 縮小 + ブラー (全画面三角形、書き切るので clear)
        for (const p of plan.passes) {
            const colorAttachments = [{ view: p.target, clearValue: clear, loadOp: 'clear', storeOp: 'store' }];
            if (p.extraTarget) colorAttachments.push({ view: p.extraTarget, clearValue: clear, loadOp: 'clear', storeOp: 'store' });
            const pass = encoder.beginRenderPass({ label: p.label, colorAttachments });
            pass.setPipeline(p.pipeline);
            pass.setBindGroup(0, p.group);
            pass.draw(3);
            pass.end();
        }

        // 4. 合成 (+ 粒子の重ね描き + ポインタ円)
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

    writeOrganicUniform(org, style, rMax, sim, layout) {
        const f = this.organicData;
        const u = this.organicU32;
        const world = sim.world;
        // field の正規化: 画面全体の平均密度のとき field = 1 (粒子数・画面サイズ・rMax に依存しない)。
        // 密度 ρ (重み付き近傍数 Σ(1 - r/rMax)^2) の一様な場は、粒子数密度 n = 6ρ / (π rMax^2)。
        // カーネル (1 - d^2)^3 の面積は π s^2 / 4 (s = スプラット半径) なので、粒子 1 個の重み w で
        // field = w * n * π s^2 / 4 = 1.5 * w * ρ * (s / rMax)^2。ρ = 平均密度 = N π rMax^2 / (6 A) のとき field = 1。
        // 既定の設定での実測 (60,000 粒子、16:9): 粒子ごとの密度は二峰性で、ガス (小さな塊) は平均の ~0.4 倍、構造は 4〜11 倍。
        // field (スプラット 0.5 rMax) ではガスの塊が ~0.5〜2、構造の芯が 5〜25 (docs/organic-rendering-spec.md の「実測した密度」)。
        // 平均密度の下限 0.5: 粒子がほとんど無いときに重みが発散しないように (通常の画面は ~10 以上なので影響しない)。
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
        for (const name of COPIED_PARAMS) f[OF[name]] = org[name];

        const sent = this.organicSent;
        for (let i = 0; i < u.length; i++) {
            if (u[i] !== sent[i]) {
                sent.set(u);
                this.device.queue.writeBuffer(this.organicBuffer, 0, f);
                return;
            }
        }
    }

    /** ブラーのパスごとのタップ表。σ は field の px で持っていて、そのパスの解像度のテクセルに換算する。変わったパスだけ書き直す。 */
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
