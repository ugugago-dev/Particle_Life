// CpuSimulation と同じ公開面で計算を Worker に任せる (SAB なし)。step は即座に返り、x / y / type は transfer で往復する最新 snapshot
// randomize / assignTypes / setCount は main で rng を引いて値を Worker へ送る (main の count / x / y / type は即座に正しい)

import { CpuSimulation } from './cpuSimulation.js';
import { wrap, randomize as randomizeState, assignTypes as assignTypesState } from '../particles.js';

const MAX_IN_FLIGHT = 2;    // 同時に依頼する step の上限 (超えた step は捨てる。待ち行列にしない)
const POOL_MAX = 3;         // 使い回す snapshot バッファの上限
// step が読む params (live の params 全体は送らない)
const STEP_KEYS = ['dt', 'rMax', 'cellsPerRMax', 'beta', 'limitPressure', 'pressureStrength', 'restDensity', 'viscosity',
    'forceFactor', 'frictionHalfLife', 'limitSpeed', 'maxSpeed', 'pointerRadius', 'pointerStrength'];

// rng の値を記録する (Worker 側で同じ順に再生する)
function recorder(rng) {
    const values = [];
    const f = () => {
        const v = rng();
        values.push(v);
        return v;
    };
    f.take = () => Float64Array.from(values);
    return f;
}

export class SimClient {
    /** worker: postMessage / onmessage / onerror / terminate を持つもの (テストでは偽物を渡す)。 */
    constructor(worker, { maxInFlight = MAX_IN_FLIGHT } = {}) {
        this.count = 0;
        this.numTypes = 1;
        this.world = { width: 1, height: 1 };
        this.x = new Float32Array(0);
        this.y = new Float32Array(0);
        this.type = new Uint8Array(0);
        this.grid = { nx: 3, ny: 3, nCells: 9, reach: 1 };

        // 状態の表示用 (仕様外の追加)
        this.isWorker = true;
        this.stepMs = 0;          // Worker の 1 ステップの時間 (直近)
        this.droppedSteps = 0;    // 依頼が詰まって捨てた step 数
        this.snapshots = 0;       // 受け取った snapshot 数
        this.version = 0;         // x / y / type の中身が変わるたびに増やす (描画側が同じ中身の再アップロードを省く。fallback 中は NaN = 常に変わる扱い)

        this.worker = worker;
        this.ready = false;
        this.epoch = 0;           // 状態を変える操作ごとに増やし、古い snapshot を捨てる
        this.inFlight = 0;
        this.maxInFlight = maxInFlight;
        this.pool = [];           // 空きバッファ {x, y, type}
        this.rulesCopy = null;
        this.fallback = null;
        this.stepMsg = { type: 'step', epoch: 0, params: {}, pointer: { x: 0, y: 0, active: false, mode: 1 }, steps: 0, x: null, y: null, typeBuf: null };

        worker.onmessage = (e) => this.onMessage(e.data);
        worker.onerror = (e) => {
            e?.preventDefault?.();
            this.toFallback(e?.message ?? e);
        };
        worker.onmessageerror = () => this.toFallback('messageerror');
    }

    post(msg, transfer) {
        if (this.fallback) return;
        try {
            this.worker.postMessage(msg, transfer ?? []);
        } catch (e) {
            this.toFallback(e);
        }
    }

    /** Worker が使えなくなったら手元の状態 (速度は 0) から CpuSimulation に切り替える。 */
    toFallback(reason) {
        if (this.fallback) return;
        console.warn('sim Worker を使えないため main スレッドの CpuSimulation にします:', reason);
        try {
            this.worker.terminate();
        } catch { /* 無視 */ }
        const fb = new CpuSimulation();
        fb.setWorld(this.world.width, this.world.height);
        if (this.count > 0) {
            fb.randomize(this.count, this.numTypes, () => 0.5);
            fb.x.set(this.x);
            fb.y.set(this.y);
            fb.type.set(this.type);
        }
        if (this.rulesCopy) fb.setRules(this.rulesCopy);
        this.fallback = fb;
        this.version = NaN;       // 以後は main スレッドで毎ステップ書き換わる
        this.isWorker = false;
        this.inFlight = 0;
        this.pool.length = 0;
        this.syncFallback();
    }

    syncFallback() {
        const fb = this.fallback;
        this.count = fb.count;
        this.numTypes = fb.numTypes;
        this.world = fb.world;
        this.x = fb.x;
        this.y = fb.y;
        this.type = fb.type;
        this.grid = fb.grid;
    }

    onMessage(m) {
        if (m.type === 'ready') {
            this.ready = true;
            return;
        }
        if (m.type !== 'snapshot' || this.fallback) return;
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.stepMs = m.stepMs;
        if (m.epoch === this.epoch && m.count === this.count) {
            // 表示中の配列は空きへ回し、新しい snapshot を指す (表示中の配列は transfer しない)
            this.recycle(this.x, this.y, this.type);
            this.x = m.x;
            this.y = m.y;
            this.type = m.typeBuf;
            this.numTypes = m.numTypes;
            this.grid = m.grid;
            this.snapshots++;
            this.version++;
        } else {
            this.recycle(m.x, m.y, m.typeBuf);
        }
    }

    recycle(x, y, type) {
        if (x.length === this.count && x.length > 0 && this.pool.length < POOL_MAX) this.pool.push({ x, y, type });
    }

    /** 状態を作り直したとき: 表示を新しい配列にして、古い snapshot と空きを捨てる。 */
    replaceState(x, y, type) {
        this.x = x;
        this.y = y;
        this.type = type;
        this.epoch++;
        this.version++;
        this.pool.length = 0;
    }

    /** 範囲外の粒子は wrap で戻す。 */
    setWorld(width, height = 1) {
        if (this.fallback) {
            this.fallback.setWorld(width, height);
            return this.syncFallback();
        }
        const w = Math.fround(width);
        const h = Math.fround(height);
        if (w === this.world.width && h === this.world.height) return;
        this.world.width = w;
        this.world.height = h;
        const { x, y, count } = this;
        for (let i = 0; i < count; i++) {
            x[i] = wrap(x[i], w);
            y[i] = wrap(y[i], h);
        }
        this.epoch++;
        this.version++;
        this.post({ type: 'world', epoch: this.epoch, width, height });
    }

    setRules(rules) {
        this.rulesCopy = { numTypes: rules.numTypes, data: Float32Array.from(rules.data) };
        if (this.fallback) return this.fallback.setRules(rules);
        this.post({ type: 'rules', numTypes: rules.numTypes, data: this.rulesCopy.data });
    }

    /** 位置は一様、速度 0、type は i.i.d.。 */
    randomize(count, numTypes, rng = Math.random) {
        if (this.fallback) {
            this.fallback.randomize(count, numTypes, rng);
            return this.syncFallback();
        }
        const rec = recorder(rng);
        const nt = Math.max(1, numTypes | 0);
        const s = { count, x: new Float32Array(count), y: new Float32Array(count), vx: new Float32Array(count), vy: new Float32Array(count), type: new Uint8Array(count) };
        randomizeState(s, this.world, nt, rec);
        this.count = count;
        this.numTypes = nt;
        this.replaceState(s.x, s.y, s.type);
        const values = rec.take();
        this.post({ type: 'randomize', epoch: this.epoch, count, numTypes, rng: values }, [values.buffer]);
    }

    /** type だけ振り直す。 */
    assignTypes(numTypes, rng = Math.random) {
        if (this.fallback) {
            this.fallback.assignTypes(numTypes, rng);
            return this.syncFallback();
        }
        const rec = recorder(rng);
        this.numTypes = Math.max(1, numTypes | 0);
        const s = { count: this.count, type: new Uint8Array(this.count) };
        assignTypesState(s, this.numTypes, rec);
        this.replaceState(this.x, this.y, s.type);
        const values = rec.take();
        this.post({ type: 'assignTypes', epoch: this.epoch, numTypes, rng: values }, [values.buffer]);
    }

    /** 先頭の粒子を保持して増減 (増えた分は一様・速度 0・ランダム type)。rng を引く順は CpuSimulation.setCount と同じ。 */
    setCount(count, rng = Math.random) {
        if (this.fallback) {
            this.fallback.setCount(count, rng);
            return this.syncFallback();
        }
        if (count === this.count) return;
        const rec = recorder(rng);
        const keep = Math.min(count, this.count);
        const x = new Float32Array(count), y = new Float32Array(count), type = new Uint8Array(count);
        x.set(this.x.subarray(0, keep));
        y.set(this.y.subarray(0, keep));
        type.set(this.type.subarray(0, keep));
        const { width, height } = this.world;
        for (let i = keep; i < count; i++) {
            x[i] = wrap(rec() * width, width);
            y[i] = wrap(rec() * height, height);
            type[i] = Math.min(this.numTypes - 1, Math.floor(rec() * this.numTypes));
        }
        this.count = count;
        this.replaceState(x, y, type);
        const values = rec.take();
        this.post({ type: 'setCount', epoch: this.epoch, count, rng: values }, [values.buffer]);
    }

    /** Worker へ依頼して即座に返る (steps = 0 は何もしない)。依頼が maxInFlight 本たまっていたら捨てる。 */
    step(params, pointer, steps) {
        if (this.fallback) {
            this.fallback.step(params, pointer, steps);
            return this.syncFallback();
        }
        if (!(steps > 0) || this.count === 0) return;
        if (this.inFlight >= this.maxInFlight) {
            this.droppedSteps += steps;
            return;
        }
        const m = this.stepMsg;
        for (const k of STEP_KEYS) m.params[k] = params[k];
        m.pointer.active = !!pointer && !!pointer.active;
        if (m.pointer.active) {
            m.pointer.x = pointer.x;
            m.pointer.y = pointer.y;
            m.pointer.mode = pointer.mode;
        }
        m.steps = steps;
        m.epoch = this.epoch;
        const n = this.count;
        const buf = this.pool.pop() ?? { x: new Float32Array(n), y: new Float32Array(n), type: new Uint8Array(n) };
        m.x = buf.x;
        m.y = buf.y;
        m.typeBuf = buf.type;
        this.inFlight++;
        this.post(m, [buf.x.buffer, buf.y.buffer, buf.type.buffer]);
        m.x = m.y = m.typeBuf = null;    // transfer 済み (detached) を持たない
    }

    dispose() {
        if (!this.fallback) this.worker.terminate();
    }
}

/** Worker が使えれば SimClient、使えなければ CpuSimulation。main.js はこれだけ呼ぶ。 */
export function createSim({ worker = true } = {}) {
    if (worker && typeof Worker !== 'undefined') {
        try {
            return new SimClient(new Worker(new URL('./simWorker.js', import.meta.url), { type: 'module' }));
        } catch (e) {
            console.warn('sim Worker を作れないため CpuSimulation にします:', e?.message ?? e);
        }
    }
    return new CpuSimulation();
}
