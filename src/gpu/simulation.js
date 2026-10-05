// Particle Life の GPU 版: バッファ + コンピュートパイプライン + step の encode。DOM には触れない。
//
// 1 ステップのパス (すべて同じ compute pass 内、dispatch 間はストレージの書き込みが自動で同期される):
//   clearCells -> countCells -> prefixSum -> scatter -> force
//
//   バッファ A : 「現在の状態」 (x, y, vx, vy, type, id)。ステップの入力かつ出力。描画も A を読む。
//   バッファ B : scatter でセル順に並べ替えた作業コピー。force が読む (近傍が連続メモリになる)。
//   force は B を読んで A に書く (近傍の位置を読み続けるので in-place は不可)。
//   A も B も同じ「セル順」の並びになる。id (= meta.y) で元の index を追える。
//
// シミュレーションの意味 (力のモデル、friction、ポインタ、トーラス) は legacy/js-cpu の
// simulation.js と同一。数値は f32 なので CPU 版 (f64 で計算して f32 に格納) と下位桁だけ違う。

import { createShaderModule, withErrorScope } from './device.js';
import { PARAMS_FLOATS, PARAMS_STRUCT_FIELDS, assertParamsLayout } from './shaders/common.wgsl.js';
import {
    PARTICLE_WORKGROUP,
    clearCellsWGSL, countCellsWGSL, prefixSumWGSL, scatterWGSL, wrapAllWGSL,
} from './shaders/grid.wgsl.js';
import { FORCE_WORKGROUP, forceWGSL } from './shaders/force.wgsl.js';
import { alloc, randomize as randomizeState } from '../particles.js';

/** セル数の上限 (rMax が極端に小さいときのメモリ保護。GUI の範囲では到達しない)。 */
const MAX_CELLS = 1 << 22;
/** dispatch 次元の上限 65535 x workgroup size から決まるパーティクル数の上限。 */
const MAX_PARTICLES = 65535 * FORCE_WORKGROUP;

const STORAGE = GPUBufferUsage.STORAGE;
const COPY_SRC = GPUBufferUsage.COPY_SRC;
const COPY_DST = GPUBufferUsage.COPY_DST;

const FIELD = Object.fromEntries(PARAMS_STRUCT_FIELDS.map((name, i) => [name, i]));
const ceilDiv = (a, b) => Math.ceil(a / b);

export class GpuSimulation {
    /** @param {GPUDevice} device */
    static async create(device) {
        assertParamsLayout();
        const sim = new GpuSimulation(device);
        await sim.createPipelines();
        return sim;
    }

    constructor(device) {
        this.device = device;
        this.count = 0;
        this.numTypes = 1;
        /** ワールド: height = 1、width = キャンバスのアスペクト比。 */
        this.world = { width: 1, height: 1 };

        // セルグリッド (configureGrid が決める)
        this.grid = { rMax: NaN, width: NaN, height: NaN, nx: 3, ny: 3, nCells: 9, capacity: 0 };

        this.uniformData = new ArrayBuffer(PARAMS_FLOATS * 4);
        this.uf32 = new Float32Array(this.uniformData);
        this.uu32 = new Uint32Array(this.uniformData);
        this.uniformBuffer = device.createBuffer({
            label: 'params',
            size: PARAMS_FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | COPY_DST,
        });

        this.buffers = null;      // setCount で作る
        this.cellBuffers = null;  // configureGrid で作る
        this.rulesBuffer = null;  // setRules で作る
        this.bindGroups = null;
        this.rulesVersion = 0;
    }

    // ------------------------------------------------------------------ pipelines

    async createPipelines() {
        const { device } = this;
        const make = async (label, code, entry = 'main') => {
            const module = await createShaderModule(device, label, code);
            return device.createComputePipelineAsync({
                label,
                layout: 'auto',
                compute: { module, entryPoint: entry },
            });
        };
        await withErrorScope(device, 'sim pipelines', async () => {
            this.pipelines = {
                clear: await make('clearCells', clearCellsWGSL),
                count: await make('countCells', countCellsWGSL),
                scan: await make('prefixSum', prefixSumWGSL),
                scatter: await make('scatter', scatterWGSL),
                force: await make('force', forceWGSL),
                wrap: await make('wrapAll', wrapAllWGSL),
            };
        });
    }

    // ------------------------------------------------------------------ buffers

    /** パーティクル数に依存するバッファを作り直す (中身は未初期化 = 0)。 */
    setCount(n) {
        if (n > MAX_PARTICLES) throw new Error(`too many particles: ${n} > ${MAX_PARTICLES}`);
        const { device } = this;
        if (this.buffers) for (const b of Object.values(this.buffers)) b.destroy();
        this.count = n;
        const m = Math.max(n, 1);
        const mk = (label, bytes) => device.createBuffer({ label, size: bytes, usage: STORAGE | COPY_SRC | COPY_DST });
        this.buffers = {
            posVelA: mk('posVel A', m * 16),   // vec4f (x, y, vx, vy)
            metaA: mk('meta A', m * 8),        // vec2<u32> (type, id)
            posVelB: mk('posVel B (cell-sorted)', m * 16),
            metaB: mk('meta B (cell-sorted)', m * 8),
            slot: mk('particleSlot', m * 8),   // vec2<u32> (cell, セル内通し番号)
        };
        this.rebuildBindGroups();
    }

    /** セルバッファ (numCellParticles / firstCellParticle) を nCells 個分確保する。 */
    allocCells(nCells) {
        const { device } = this;
        if (this.cellBuffers) for (const b of Object.values(this.cellBuffers)) b.destroy();
        // 少し余裕を持たせて、ウィンドウリサイズで毎フレーム作り直さないようにする
        const capacity = Math.max(16, Math.ceil(nCells * 1.25));
        this.grid.capacity = capacity;
        const mk = (label, bytes) => device.createBuffer({ label, size: bytes, usage: STORAGE | COPY_SRC | COPY_DST });
        this.cellBuffers = {
            numCellParticles: mk('numCellParticles', capacity * 4),
            firstCellParticle: mk('firstCellParticle', (capacity + 1) * 4),
        };
        this.rebuildBindGroups();
    }

    /** ルール行列 (RuleMatrix) を GPU に上げる。numTypes が変わったらバッファも作り直す。 */
    setRules(rules) {
        const { device } = this;
        const bytes = Math.max(16, rules.data.byteLength);
        if (!this.rulesBuffer || this.rulesBuffer.size !== bytes) {
            if (this.rulesBuffer) this.rulesBuffer.destroy();
            this.rulesBuffer = device.createBuffer({ label: 'rules', size: bytes, usage: STORAGE | COPY_DST });
            this.rebuildBindGroups();
        }
        this.numTypes = rules.numTypes;
        device.queue.writeBuffer(this.rulesBuffer, 0, rules.data);
    }

    rebuildBindGroups() {
        const { device, pipelines, buffers, cellBuffers, rulesBuffer, uniformBuffer } = this;
        this.bindGroups = {};
        if (!pipelines || !buffers) return;
        const U = { binding: 0, resource: { buffer: uniformBuffer } };
        const bg = (name, entries) => device.createBindGroup({
            label: name,
            layout: pipelines[name].getBindGroupLayout(0),
            entries: [U, ...entries.map((buffer, i) => ({ binding: i + 1, resource: { buffer } }))],
        });
        const { posVelA, metaA, posVelB, metaB, slot } = buffers;
        this.bindGroups.wrap = bg('wrap', [posVelA]);
        if (!cellBuffers) return;
        const { numCellParticles, firstCellParticle } = cellBuffers;
        this.bindGroups.clear = bg('clear', [numCellParticles]);
        this.bindGroups.count = bg('count', [posVelA, numCellParticles, slot]);
        this.bindGroups.scan = bg('scan', [numCellParticles, firstCellParticle]);
        this.bindGroups.scatter = bg('scatter', [posVelA, metaA, slot, firstCellParticle, posVelB, metaB]);
        if (rulesBuffer) {
            this.bindGroups.force = bg('force', [posVelB, metaB, firstCellParticle, rulesBuffer, posVelA, metaA]);
        }
    }

    // ------------------------------------------------------------------ state upload

    /**
     * CPU 側の ParticleState (SoA) をそのまま GPU に上げる。id = 0..count-1 (元の index)。
     * @param {import('../particles.js').ParticleState} state
     */
    loadState(state) {
        const n = state.count;
        if (n !== this.count || !this.buffers) this.setCount(n);
        const pv = new Float32Array(n * 4);
        const meta = new Uint32Array(n * 2);
        for (let i = 0; i < n; i++) {
            pv[4 * i] = state.x[i];
            pv[4 * i + 1] = state.y[i];
            pv[4 * i + 2] = state.vx[i];
            pv[4 * i + 3] = state.vy[i];
            meta[2 * i] = state.type[i];
            meta[2 * i + 1] = i;
        }
        const { queue } = this.device;
        if (n > 0) {
            queue.writeBuffer(this.buffers.posVelA, 0, pv);
            queue.writeBuffer(this.buffers.metaA, 0, meta);
        }
    }

    /** 一様ランダムな位置・速度 0・ランダムな type で初期化する (パーティクル数も指定)。 */
    randomize(count, numTypes, rng = Math.random) {
        const state = alloc(count);
        randomizeState(state, this.world, numTypes, rng);
        this.numTypes = numTypes;
        this.loadState(state);
    }

    /** 全パーティクルの type を振り直す (位置・速度・id はそのまま)。 */
    assignTypes(numTypes, rng = Math.random) {
        const n = this.count;
        this.numTypes = numTypes;
        if (n === 0) return;
        const { device } = this;
        const types = new Uint32Array(n);
        for (let i = 0; i < n; i++) types[i] = Math.min(numTypes - 1, Math.floor(rng() * numTypes));
        // 同じ id の type が変わっても、type は i.i.d. なので「どのスロットに書くか」は無関係。
        // meta は (type, id) が交互なので、小さな compute pass で .x だけ書き換える。
        const scratch = device.createBuffer({ label: 'types scratch', size: n * 4, usage: STORAGE | COPY_DST });
        device.queue.writeBuffer(scratch, 0, types);
        this.runRetype(scratch);
        scratch.destroy();
    }

    runRetype(scratch) {
        const { device } = this;
        if (!this.retypePipeline) this.retypePipeline = this.createRetypePipeline();
        const pipeline = this.retypePipeline;
        const group = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: scratch } },
                { binding: 1, resource: { buffer: this.buffers.metaA } },
            ],
        });
        const enc = device.createCommandEncoder({ label: 'retype' });
        const pass = enc.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(ceilDiv(this.count, PARTICLE_WORKGROUP));
        pass.end();
        device.queue.submit([enc.finish()]);
    }

    createRetypePipeline() {
        // 一度しか使わない小さなシェーダなので、同期生成 (エラーは uncapturederror に出る)
        const code = /* wgsl */`
@group(0) @binding(0) var<storage, read> types: array<u32>;
@group(0) @binding(1) var<storage, read_write> metaOut: array<vec2u>;
@compute @workgroup_size(${PARTICLE_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&types)) { return; }
  metaOut[i] = vec2u(types[i], metaOut[i].y);
}`;
        return this.device.createComputePipeline({
            label: 'retype',
            layout: 'auto',
            compute: { module: this.device.createShaderModule({ label: 'retype', code }), entryPoint: 'main' },
        });
    }

    // ------------------------------------------------------------------ world / grid

    /**
     * ワールド幅を変える (キャンバスのリサイズ時)。既存のパーティクルは新しい範囲へ巻き戻す。
     * グリッドは次の encode で追従する。
     */
    setWorld(width, height = 1) {
        const w = Math.fround(width);
        if (w === this.world.width && height === this.world.height) return;
        this.world.width = w;
        this.world.height = height;
        if (this.count > 0 && this.bindGroups?.wrap) this.wrapAllNow();
    }

    wrapAllNow() {
        const { device } = this;
        this.writeWorldUniforms();
        const enc = device.createCommandEncoder({ label: 'wrap all' });
        const pass = enc.beginComputePass();
        pass.setPipeline(this.pipelines.wrap);
        pass.setBindGroup(0, this.bindGroups.wrap);
        pass.dispatchWorkgroups(ceilDiv(this.count, PARTICLE_WORKGROUP));
        pass.end();
        device.queue.submit([enc.finish()]);
    }

    /** wrap / retype のような単発パス用: world と count だけ最新にして uniform を上げる。 */
    writeWorldUniforms() {
        this.uf32[FIELD.worldW] = this.world.width;
        this.uf32[FIELD.worldH] = this.world.height;
        this.uu32[FIELD.numParticles] = this.count;
        this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
    }

    /**
     * セル数を決める (CPU 版 Grid.configure と同じ: 1 軸あたり max(3, floor(サイズ / rMax)))。
     * 3 セル以上あれば周期境界で回り込む 3x3 は重複せず、セルサイズ >= rMax なので
     * rMax 以内の相手は必ず 3x3 に入る。
     */
    configureGrid(rMax) {
        const g = this.grid;
        const { width, height } = this.world;
        if (g.rMax === rMax && g.width === width && g.height === height && this.cellBuffers) return;

        let r = Math.max(rMax, 1e-4);
        let nx, ny;
        for (;;) {
            nx = Math.max(3, Math.floor(width / r));
            ny = Math.max(3, Math.floor(height / r));
            if (nx * ny <= MAX_CELLS) break;
            r *= 1.25; // 上限を超えるときだけセルを大きくする (正確さは保たれ、遅くなるだけ)
        }
        g.rMax = rMax;
        g.width = width;
        g.height = height;
        g.nx = nx;
        g.ny = ny;
        g.nCells = nx * ny;
        g.invCellW = nx / width;
        g.invCellH = ny / height;

        if (!this.cellBuffers || g.nCells > g.capacity || g.nCells * 4 < g.capacity) {
            this.allocCells(g.nCells);
        }
    }

    // ------------------------------------------------------------------ per-frame

    /** params / pointer から uniform を組み立てて上げる。1 フレーム分 (全 substep 共通)。 */
    writeUniforms(params, pointer, dt) {
        const f = this.uf32;
        const u = this.uu32;
        const g = this.grid;

        const rMax = params.rMax;
        const beta = Math.min(Math.max(params.beta, 0), 0.999);
        f[FIELD.dt] = dt;
        f[FIELD.rMax2] = rMax * rMax;
        f[FIELD.invRMax] = 1 / rMax;
        f[FIELD.beta] = beta;
        f[FIELD.invBeta] = beta > 0 ? 1 / beta : 0;      // beta == 0 では使われない (r < 0 は偽)
        f[FIELD.invOneMinusBeta] = 1 / (1 - beta);
        f[FIELD.accelScale] = rMax * params.forceFactor;
        f[FIELD.friction] = 0.5 ** (dt / Math.max(params.frictionHalfLife, 1e-6));
        f[FIELD.worldW] = this.world.width;
        f[FIELD.worldH] = this.world.height;
        f[FIELD.invCellW] = g.invCellW;
        f[FIELD.invCellH] = g.invCellH;
        u[FIELD.nx] = g.nx;
        u[FIELD.ny] = g.ny;
        u[FIELD.nCells] = g.nCells;
        u[FIELD.numParticles] = this.count;
        u[FIELD.numTypes] = this.numTypes;

        const usePointer = !!pointer && pointer.active;
        const pR = params.pointerRadius;
        u[FIELD.pointerActive] = usePointer ? 1 : 0;
        f[FIELD.pointerX] = usePointer ? pointer.x : 0;
        f[FIELD.pointerY] = usePointer ? pointer.y : 0;
        f[FIELD.pointerR2] = pR * pR;
        f[FIELD.invPointerR] = pR > 0 ? 1 / pR : 0;
        // forceFactor を掛けて、粒子間の力に対してポインタが弱くならないようにする (CPU 版と同じ)
        f[FIELD.pointerStrength] = usePointer ? pointer.mode * params.pointerStrength * params.forceFactor : 0;

        this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
    }

    /**
     * 1 フレーム分のシミュレーションを encoder に積む (CPU 読み戻しなし)。
     * @param {GPUCommandEncoder} encoder
     * @param {{params: object, pointer?: object, steps: number, dt?: number,
     *          timestampWrites?: GPUComputePassTimestampWrites}} opts
     *   steps 回の substep を 1 つの compute pass にまとめる。steps = 0 でも (計測用に) 空の pass を作る。
     */
    encode(encoder, { params, pointer, steps, dt = params.dt, timestampWrites }) {
        if (!this.buffers || !this.rulesBuffer) throw new Error('GpuSimulation: setRules / setCount first');
        this.configureGrid(params.rMax);
        this.writeUniforms(params, pointer, dt);
        const pass = encoder.beginComputePass({ label: 'simulation', timestampWrites });
        if (this.count > 0) {
            for (let s = 0; s < steps; s++) this.encodeStep(pass);
        }
        pass.end();
    }

    encodeStep(pass) {
        const { pipelines, bindGroups, count } = this;
        const { nCells } = this.grid;
        const particleGroups = ceilDiv(count, PARTICLE_WORKGROUP);

        // 1. セルごとの個数を 0 に
        pass.setPipeline(pipelines.clear);
        pass.setBindGroup(0, bindGroups.clear);
        pass.dispatchWorkgroups(ceilDiv(nCells, PARTICLE_WORKGROUP));
        // 2. 個数を数える (+ セル内通し番号を保存)
        pass.setPipeline(pipelines.count);
        pass.setBindGroup(0, bindGroups.count);
        pass.dispatchWorkgroups(particleGroups);
        // 3. 累積和 -> firstCellParticle
        pass.setPipeline(pipelines.scan);
        pass.setBindGroup(0, bindGroups.scan);
        pass.dispatchWorkgroups(1);
        // 4. セル順に並べ替え (A -> B)
        pass.setPipeline(pipelines.scatter);
        pass.setBindGroup(0, bindGroups.scatter);
        pass.dispatchWorkgroups(particleGroups);
        // 5. 力の計算 + 積分 (B -> A)
        pass.setPipeline(pipelines.force);
        pass.setBindGroup(0, bindGroups.force);
        pass.dispatchWorkgroups(ceilDiv(count, FORCE_WORKGROUP));
    }

    // ------------------------------------------------------------------ debug / test only

    /**
     * 現在の状態 (バッファ A) を CPU に読み戻す。通常のフレームループでは使わない。
     * @returns {Promise<{count:number, x:Float32Array, y:Float32Array, vx:Float32Array, vy:Float32Array,
     *                    type:Uint32Array, id:Uint32Array}>}
     */
    async readState() {
        const { device, count } = this;
        const n = count;
        const pvBytes = n * 16;
        const metaBytes = n * 8;
        const staging = device.createBuffer({
            size: Math.max(16, pvBytes + metaBytes),
            usage: GPUBufferUsage.MAP_READ | COPY_DST,
        });
        const enc = device.createCommandEncoder();
        if (n > 0) {
            enc.copyBufferToBuffer(this.buffers.posVelA, 0, staging, 0, pvBytes);
            enc.copyBufferToBuffer(this.buffers.metaA, 0, staging, pvBytes, metaBytes);
        }
        device.queue.submit([enc.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const raw = staging.getMappedRange().slice(0);
        staging.unmap();
        staging.destroy();

        const pv = new Float32Array(raw, 0, n * 4);
        const meta = new Uint32Array(raw, pvBytes, n * 2);
        const out = {
            count: n,
            x: new Float32Array(n), y: new Float32Array(n),
            vx: new Float32Array(n), vy: new Float32Array(n),
            type: new Uint32Array(n), id: new Uint32Array(n),
        };
        for (let i = 0; i < n; i++) {
            out.x[i] = pv[4 * i];
            out.y[i] = pv[4 * i + 1];
            out.vx[i] = pv[4 * i + 2];
            out.vy[i] = pv[4 * i + 3];
            out.type[i] = meta[2 * i];
            out.id[i] = meta[2 * i + 1];
        }
        return out;
    }

    /** デバッグ用: 直近の step で作られたセル配列 (firstCellParticle, nCells + 1 個) を読み戻す。 */
    async readFirstCellParticle() {
        const { device } = this;
        const bytes = (this.grid.nCells + 1) * 4;
        const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | COPY_DST });
        const enc = device.createCommandEncoder();
        enc.copyBufferToBuffer(this.cellBuffers.firstCellParticle, 0, staging, 0, bytes);
        device.queue.submit([enc.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const out = new Uint32Array(staging.getMappedRange().slice(0));
        staging.unmap();
        staging.destroy();
        return out;
    }
}
