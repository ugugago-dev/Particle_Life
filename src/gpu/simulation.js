// Particle Life の GPU 版。A = 現在の状態 (描画も読む)、B = scatter でセル順に並べ替えた近傍ループ用のコピー (force は B -> A)
// 物理は legacy/js-cpu の simulation.js と同じ (f32 なので下位桁だけ違う)

import { createShaderModule, withErrorScope } from './device.js';
import { PARAMS_FLOATS, PARAMS_STRUCT_FIELDS, assertParamsLayout } from './shaders/common.wgsl.js';
import {
    PARTICLE_WORKGROUP,
    countCellsWGSL, prefixSumWGSL, scatterWGSL, wrapAllWGSL,
} from './shaders/grid.wgsl.js';
import { FORCE_WORKGROUP, forceWGSL, densityWGSL } from './shaders/force.wgsl.js';
import { alloc, randomize as randomizeState } from '../particles.js';

/** rMax が極端に小さいときのメモリ保護 (GUI の範囲では到達しない)。 */
const MAX_CELLS = 1 << 22;
/** dispatch の上限 65535 x workgroup size。 */
const MAX_PARTICLES = 65535 * FORCE_WORKGROUP;

/** viscosity * accelScale * dt の上限 (超えると陽的な減衰が発散する)。 */
const MAX_VISCOSITY_STEP = 0.01;

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
        this.world = { width: 1, height: 1 };

        this.grid = { rMax: NaN, reachWanted: 0, width: NaN, height: NaN, nx: 3, ny: 3, nCells: 9, reach: 1, capacity: 0 };

        this.uniformData = new ArrayBuffer(PARAMS_FLOATS * 4);
        this.uf32 = new Float32Array(this.uniformData);
        this.uu32 = new Uint32Array(this.uniformData);
        this.uniformBuffer = device.createBuffer({
            label: 'params',
            size: PARAMS_FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | COPY_DST,
        });

        this.buffers = null;
        this.cellBuffers = null;
        this.rulesBuffer = null;
        this.bindGroups = null;
        this.rulesVersion = 0;
    }

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
                count: await make('countCells', countCellsWGSL),
                scan: await make('prefixSum', prefixSumWGSL),
                scatter: await make('scatter', scatterWGSL),
                force: await make('force', forceWGSL(false, false)),
                forceP: await make('forceP', forceWGSL(true, false)),
                forcePV: await make('forcePV', forceWGSL(true, true)),
                density: await make('density', densityWGSL),
                wrap: await make('wrapAll', wrapAllWGSL),
            };
        });
    }

    /** パーティクル数に依存するバッファを作り直す (中身は 0)。 */
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
            posTypeB: mk('posType B (cell-sorted)', m * 16),  // vec4f (x, y, type, 0)
            velIdB: mk('velId B (cell-sorted)', m * 16),      // vec4f (vx, vy, id, 0)
            posTypeP: mk('posType + pressure (cell-sorted)', m * 16),  // vec4f (x, y, type, pressure)。圧力ありの force が読む
            slot: mk('particleSlot', m * 8),   // vec2<u32> (cell, セル内通し番号)
        };
        this.rebuildBindGroups();
    }

    allocCells(nCells) {
        const { device } = this;
        if (this.cellBuffers) for (const b of Object.values(this.cellBuffers)) b.destroy();
        // リサイズ中に毎フレーム作り直さないよう余裕を持たせる
        const capacity = Math.max(16, Math.ceil(nCells * 1.25));
        this.grid.capacity = capacity;
        const mk = (label, bytes) => device.createBuffer({ label, size: bytes, usage: STORAGE | COPY_SRC | COPY_DST });
        this.cellBuffers = {
            numCellParticles: mk('numCellParticles', capacity * 4),
            firstCellParticle: mk('firstCellParticle', (capacity + 1) * 4),
        };
        this.rebuildBindGroups();
    }

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
        const { posVelA, metaA, posTypeB, velIdB, posTypeP, slot } = buffers;
        this.bindGroups.wrap = bg('wrap', [posVelA]);
        if (!cellBuffers) return;
        const { numCellParticles, firstCellParticle } = cellBuffers;
        this.bindGroups.count = bg('count', [posVelA, numCellParticles, slot]);
        this.bindGroups.scan = bg('scan', [numCellParticles, firstCellParticle]);
        this.bindGroups.scatter = bg('scatter', [posVelA, metaA, slot, firstCellParticle, posTypeB, velIdB]);
        this.bindGroups.density = bg('density', [posTypeB, firstCellParticle, posTypeP]);
        if (rulesBuffer) {
            this.bindGroups.force = bg('force', [posTypeB, velIdB, firstCellParticle, rulesBuffer, posVelA, metaA]);
            const pressureBuffers = [posTypeP, velIdB, firstCellParticle, rulesBuffer, posVelA, metaA];
            this.bindGroups.forceP = bg('forceP', pressureBuffers);
            this.bindGroups.forcePV = bg('forcePV', pressureBuffers);
        }
    }

    /** @param {import('../particles.js').ParticleState} state  id = 0..count-1 で上げる */
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

    randomize(count, numTypes, rng = Math.random) {
        const state = alloc(count);
        randomizeState(state, this.world, numTypes, rng);
        this.numTypes = numTypes;
        this.loadState(state);
    }

    assignTypes(numTypes, rng = Math.random) {
        const n = this.count;
        this.numTypes = numTypes;
        if (n === 0) return;
        const { device } = this;
        const types = new Uint32Array(n);
        for (let i = 0; i < n; i++) types[i] = Math.min(numTypes - 1, Math.floor(rng() * numTypes));
        // type は i.i.d. なのでどのスロットに書いてもよい。meta の .x だけ compute で書き換える
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
        // 一度しか使わないので同期生成 (エラーは uncapturederror に出る)
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

    /** 既存のパーティクルは新しい範囲へ巻き戻す。グリッドは次の encode で追従する。 */
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

    /** 単発パス (wrap / retype) 用に world と count だけ最新にして uniform を上げる。 */
    writeWorldUniforms() {
        this.uf32[FIELD.worldW] = this.world.width;
        this.uf32[FIELD.worldH] = this.world.height;
        this.uu32[FIELD.numParticles] = this.count;
        this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
    }

    /** セル幅 >= rMax / K。±K セルが回り込んで重複しないよう各軸 2K + 1 セル未満なら K を下げる。 */
    configureGrid(rMax, reachWanted = 1) {
        const g = this.grid;
        const { width, height } = this.world;
        if (g.rMax === rMax && g.reachWanted === reachWanted && g.width === width && g.height === height
            && this.cellBuffers) return;

        let reach = Math.max(1, Math.min(4, Math.round(reachWanted) || 1));
        let r, nx, ny;
        for (;;) {
            r = Math.max(rMax, 1e-4) / reach;
            nx = Math.floor(width / r);
            ny = Math.floor(height / r);
            const fits = nx >= 2 * reach + 1 && ny >= 2 * reach + 1;
            if (reach > 1 && (!fits || nx * ny > MAX_CELLS)) { reach--; continue; }
            break;
        }
        for (;;) {
            nx = Math.max(3, Math.floor(width / r));
            ny = Math.max(3, Math.floor(height / r));
            if (nx * ny <= MAX_CELLS) break;
            r *= 1.25; // セルを大きくしても正確さは変わらない (遅くなるだけ)
        }
        g.rMax = rMax;
        g.reachWanted = reachWanted;
        g.width = width;
        g.height = height;
        g.reach = reach;
        g.nx = nx;
        g.ny = ny;
        g.nCells = nx * ny;
        g.invCellW = nx / width;
        g.invCellH = ny / height;

        if (!this.cellBuffers || g.nCells > g.capacity || g.nCells * 4 < g.capacity) {
            this.allocCells(g.nCells);
        }
    }

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
        f[FIELD.invBeta] = beta > 0 ? 1 / beta : 0;      // beta == 0 では使われない
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
        // forceFactor を掛けて粒子間の力に負けないようにする (CPU 版と同じ)
        f[FIELD.pointerStrength] = usePointer ? pointer.mode * params.pointerStrength * params.forceFactor : 0;

        f[FIELD.rMax] = rMax;
        u[FIELD.reach] = g.reach;
        f[FIELD.maxSpeed] = params.limitSpeed ? Math.max(params.maxSpeed, 0) : 0;
        f[FIELD.restDensity] = params.restDensity;
        f[FIELD.pressureScale] = params.limitPressure ? 0.5 * Math.max(params.pressureStrength, 0) : 0;
        f[FIELD.viscosity] = params.limitPressure
            ? Math.min(Math.max(params.viscosity, 0), MAX_VISCOSITY_STEP / (rMax * params.forceFactor * dt)) : 0;
        this.viscosityOn = f[FIELD.viscosity] > 0;

        this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
    }

    /**
     * steps 回の substep を 1 つの compute pass に積む (steps = 0 でも計測用に空の pass を作る)。
     * @param {GPUCommandEncoder} encoder
     * @param {{params: object, pointer?: object, steps: number, dt?: number,
     *          timestampWrites?: GPUComputePassTimestampWrites}} opts
     */
    encode(encoder, { params, pointer, steps, dt = params.dt, timestampWrites }) {
        if (!this.buffers || !this.rulesBuffer) throw new Error('GpuSimulation: setRules / setCount first');
        this.configureGrid(params.rMax, params.cellsPerRMax);
        this.pressureOn = !!params.limitPressure && params.pressureStrength > 0;
        this.writeUniforms(params, pointer, dt);
        const pass = encoder.beginComputePass({ label: 'simulation', timestampWrites });
        if (this.count > 0) {
            for (let s = 0; s < steps; s++) this.encodeStep(pass);
        }
        pass.end();
    }

    encodeStep(pass) {
        const { pipelines, bindGroups, count } = this;
        const particleGroups = ceilDiv(count, PARTICLE_WORKGROUP);

        // セルの個数は前ステップの scan が 0 に戻してある
        pass.setPipeline(pipelines.count);
        pass.setBindGroup(0, bindGroups.count);
        pass.dispatchWorkgroups(particleGroups);
        pass.setPipeline(pipelines.scan);
        pass.setBindGroup(0, bindGroups.scan);
        pass.dispatchWorkgroups(1);
        pass.setPipeline(pipelines.scatter);
        pass.setBindGroup(0, bindGroups.scatter);
        pass.dispatchWorkgroups(particleGroups);
        // 圧力は force と同じステップの位置から作る (1 ステップ遅れると振動する)
        if (this.pressureOn) {
            pass.setPipeline(pipelines.density);
            pass.setBindGroup(0, bindGroups.density);
            pass.dispatchWorkgroups(ceilDiv(count, FORCE_WORKGROUP));
        }
        const force = !this.pressureOn ? 'force' : this.viscosityOn ? 'forcePV' : 'forceP';
        pass.setPipeline(pipelines[force]);
        pass.setBindGroup(0, bindGroups[force]);
        pass.dispatchWorkgroups(ceilDiv(count, FORCE_WORKGROUP));
    }
}
