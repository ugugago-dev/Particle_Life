// CpuSimulation を O(N²) 総当たり (最小イメージで全ペア) と比較する Node テスト。依存なし: node tests/cpuSimulation.test.mjs

import { CpuSimulation } from '../src/mobile/cpuSimulation.js';
import { createParams } from '../src/config.js';
import { RuleMatrix } from '../src/rules.js';
import { wrap } from '../src/particles.js';
import { createSimHandler } from '../src/mobile/simWorker.js';
import { SimClient, createSim } from '../src/mobile/simClient.js';

let failures = 0;
function check(cond, msg) {
    if (cond) return;
    failures++;
    console.error(`FAIL: ${msg}`);
}

// seed つき乱数 (mulberry32)
function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const minImage = (d, size) => d - size * Math.round(d / size);

// 仕様の式をそのまま書いた参照実装 (古い状態のスナップショットだけを読む)
function referenceStep(state, world, rules, params, pointer) {
    const { count, x, y, vx, vy, type } = state;
    const W = world.width, H = world.height;
    const nt = rules.numTypes;
    const dt = params.dt, rMax = params.rMax;
    const beta = Math.min(Math.max(params.beta, 0), 0.999);
    const pressureOn = !!params.limitPressure && params.pressureStrength > 0;
    const pressureScale = 0.5 * Math.max(params.pressureStrength, 0);
    const viscosity = pressureOn
        ? Math.min(Math.max(params.viscosity, 0), 0.01 / (rMax * params.forceFactor * dt)) : 0;
    const friction = 0.5 ** (dt / Math.max(params.frictionHalfLife, 1e-6));
    const maxSpeed = params.limitSpeed ? Math.max(params.maxSpeed, 0) : 0;

    const P = new Float64Array(count);
    if (pressureOn) {
        for (let i = 0; i < count; i++) {
            let rho = 0;
            for (let j = 0; j < count; j++) {
                const dx = minImage(x[j] - x[i], W), dy = minImage(y[j] - y[i], H);
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d >= rMax || d === 0) continue;
                rho += (1 - d / rMax) ** 2;
            }
            P[i] = Math.max(0, rho - params.restDensity);
        }
    }

    const out = { count, x: new Float64Array(count), y: new Float64Array(count), vx: new Float64Array(count), vy: new Float64Array(count), P };
    for (let i = 0; i < count; i++) {
        let ax = 0, ay = 0;
        for (let j = 0; j < count; j++) {
            const dx = minImage(x[j] - x[i], W), dy = minImage(y[j] - y[i], H);
            const d2 = dx * dx + dy * dy;
            if (d2 >= rMax * rMax || d2 === 0) continue;
            const d = Math.sqrt(d2);
            const r = d / rMax;
            let f = r < beta ? r / beta - 1
                : rules.data[type[i] * nt + type[j]] * (1 - Math.abs(2 * r - 1 - beta) / (1 - beta));
            if (pressureOn) {
                f -= pressureScale * (P[i] + P[j]) * (1 - r);
                if (viscosity > 0) {
                    f += viscosity * (1 - r) * Math.min(P[i] + P[j], 1) * ((vx[j] - vx[i]) * dx + (vy[j] - vy[i]) * dy) / d;
                }
            }
            ax += dx / d * f;
            ay += dy / d * f;
        }
        ax *= rMax * params.forceFactor;
        ay *= rMax * params.forceFactor;
        if (pointer && pointer.active) {
            const dx = minImage(pointer.x - x[i], W), dy = minImage(pointer.y - y[i], H);
            const d2 = dx * dx + dy * dy;
            const pR = params.pointerRadius;
            if (d2 < pR * pR && d2 > 1e-12) {
                const d = Math.sqrt(d2);
                const w = 1 - d / pR;
                const g = pointer.mode * params.pointerStrength * params.forceFactor * w * w * (3 - 2 * w);
                ax += dx / d * g;
                ay += dy / d * g;
            }
        }
        let nvx = vx[i] * friction + ax * dt;
        let nvy = vy[i] * friction + ay * dt;
        const s = Math.hypot(nvx, nvy);
        if (maxSpeed > 0 && s > maxSpeed) { nvx *= maxSpeed / s; nvy *= maxSpeed / s; }
        out.vx[i] = nvx;
        out.vy[i] = nvy;
        out.x[i] = wrap(x[i] + nvx * dt, W);
        out.y[i] = wrap(y[i] + nvy * dt, H);
    }
    return out;
}

const snapshot = (sim) => ({
    count: sim.count,
    x: Float32Array.from(sim.x), y: Float32Array.from(sim.y),
    vx: Float32Array.from(sim.vx), vy: Float32Array.from(sim.vy),
    type: Uint8Array.from(sim.type),
});

// float32 相当の誤差で一致するか (速度は最大 |v| で正規化、位置は最小イメージの差)
function compare(name, sim, ref) {
    let vScale = 1e-6;
    for (let i = 0; i < ref.count; i++) vScale = Math.max(vScale, Math.abs(ref.vx[i]), Math.abs(ref.vy[i]));
    const W = sim.world.width, H = sim.world.height;
    let worstV = 0, worstX = 0;
    for (let i = 0; i < ref.count; i++) {
        worstV = Math.max(worstV, Math.abs(sim.vx[i] - ref.vx[i]) / vScale, Math.abs(sim.vy[i] - ref.vy[i]) / vScale);
        worstX = Math.max(worstX, Math.abs(minImage(sim.x[i] - ref.x[i], W)), Math.abs(minImage(sim.y[i] - ref.y[i], H)));
    }
    check(worstV < 1e-4, `${name}: velocity mismatch (rel ${worstV.toExponential(2)})`);
    check(worstX < 1e-5, `${name}: position mismatch (abs ${worstX.toExponential(2)})`);
    check(Number.isFinite(worstV) && Number.isFinite(worstX), `${name}: non-finite values`);
    return { worstV, worstX, vScale };
}

function setup({ seed, N, numTypes, width, height = 1, initSpeed = 0 }) {
    const rng = makeRng(seed);
    const sim = new CpuSimulation();
    sim.setWorld(width, height);
    sim.randomize(N, numTypes, rng);
    for (let i = 0; i < N; i++) {
        sim.vx[i] = (rng() * 2 - 1) * initSpeed;
        sim.vy[i] = (rng() * 2 - 1) * initSpeed;
    }
    const rules = new RuleMatrix(numTypes, rng);
    sim.setRules(rules);
    return { sim, rules, rng };
}

function baseParams(over) {
    return Object.assign(createParams(), { limitPressure: false, viscosity: 0 }, over);
}

function runCase(name, opts, paramsOver, pointer = null, steps = 1, extraCheck = null, expectGrid = null) {
    const { sim, rules } = setup(opts);
    const params = baseParams(paramsOver);
    let state = snapshot(sim);
    let ref;
    for (let s = 0; s < steps; s++) {
        ref = referenceStep(state, sim.world, rules, params, pointer);
        state = {
            count: ref.count, type: state.type,
            x: Float32Array.from(ref.x), y: Float32Array.from(ref.y),
            vx: Float32Array.from(ref.vx), vy: Float32Array.from(ref.vy),
        };
    }
    const before = snapshot(sim);
    sim.step(params, pointer, steps);
    const res = compare(name, sim, ref);
    if (extraCheck) extraCheck({ sim, ref, before, params });
    // 狙った近傍探索の経路を通っているか (K と、ペアごとの最小イメージへの切り替え)
    const g = sim.grid;
    if (expectGrid) {
        check(g.reach === expectGrid.reach && sim.minImage === expectGrid.minImage,
            `${name}: grid K=${g.reach} minImage=${sim.minImage}, expected K=${expectGrid.reach} minImage=${expectGrid.minImage}`);
    }
    console.log(`- ${name}: grid ${g.nx}x${g.ny} K=${g.reach}${sim.minImage ? ' minImage' : ''}, |v|max ${res.vScale.toFixed(3)}, `
        + `dv ${res.worstV.toExponential(1)}, dx ${res.worstX.toExponential(1)}`);
}

// 本番と同じ近傍探索の経路 (K = 2、弦で絞る、列/行の回り込みはずらし量) を通る大きさ: N = 1500 で 近傍密度 N rMax² / A ≈ 30
const N = 1500;
const rMaxFor = (A) => Math.sqrt(30 * A / N);
const PROD = { reach: 2, minImage: false };

// 1. 基本: 圧力なし、16:9
runCase('basic 16:9', { seed: 1, N, numTypes: 5, width: 1.78 }, { rMax: rMaxFor(1.78) }, null, 1, null, PROD);

// 2. 縦長 (A = 0.46)、beta = 0
runCase('portrait A=0.46, beta=0', { seed: 2, N, numTypes: 4, width: 0.46 }, { rMax: rMaxFor(0.46), beta: 0 }, null, 1, null, PROD);

// 3. 圧力あり (restDensity を下げて P > 0 を多くする)
runCase('pressure', { seed: 3, N, numTypes: 6, width: 0.46 },
    { rMax: rMaxFor(0.46), limitPressure: true, pressureStrength: 0.05, restDensity: 3 }, null, 1,
    ({ ref }) => {
        let pos = 0;
        for (let i = 0; i < ref.count; i++) if (ref.P[i] > 0) pos++;
        check(pos > ref.count * 0.1, `pressure: only ${pos} particles have P > 0`);
    }, PROD);

// 4. 圧力 + 粘性 (初速あり、一部は maxSpeed の上限を超えている)。maxSpeed を上げて粘性の差が上限で隠れないようにする
runCase('pressure + viscosity', { seed: 4, N, numTypes: 3, width: 0.46, initSpeed: 0.5 },
    { rMax: rMaxFor(0.46), limitPressure: true, pressureStrength: 0.05, restDensity: 3, viscosity: 0.5, maxSpeed: 0.6 }, null, 1,
    ({ before, params }) => {
        let fast = 0;
        for (let i = 0; i < before.count; i++) if (Math.hypot(before.vx[i], before.vy[i]) > params.maxSpeed) fast++;
        check(fast > 0, 'viscosity: no particle above maxSpeed initially');
    }, PROD);

// 5. 粘性の上限 (clamp) が効く値、16:9
runCase('viscosity clamp', { seed: 5, N, numTypes: 3, width: 1.78, initSpeed: 0.2 },
    { rMax: rMaxFor(1.78), limitPressure: true, pressureStrength: 0.05, restDensity: 3, viscosity: 1e3, limitSpeed: false }, null, 1, null, PROD);

// 6. 粘性ありでも圧力が無効なら粘性も無効
runCase('viscosity without pressure', { seed: 6, N, numTypes: 3, width: 1.0, initSpeed: 0.2 },
    { rMax: rMaxFor(1.0), limitPressure: true, pressureStrength: 0, viscosity: 0.5 }, null, 1, null, PROD);

// 7. ポインタ (端の近く、引力 / 斥力)
for (const mode of [1, -1]) {
    const pointer = { x: 0.02, y: 0.97, active: true, mode };
    runCase(`pointer mode ${mode}`, { seed: 7, N, numTypes: 4, width: 0.46 }, { rMax: rMaxFor(0.46), pointerRadius: 0.15 }, pointer, 1,
        ({ before, params }) => {
            let inside = 0, wrapped = 0;
            for (let i = 0; i < before.count; i++) {
                const dx = pointer.x - before.x[i], dy = pointer.y - before.y[i];
                const mx = minImage(dx, 0.46), my = minImage(dy, 1);
                if (Math.hypot(mx, my) < params.pointerRadius) {
                    inside++;
                    if (mx !== dx || my !== dy) wrapped++;
                }
            }
            check(inside > 5 && wrapped > 0, `pointer: inside ${inside}, across boundary ${wrapped}`);
        }, PROD);
}

// 8. 2 ステップ (毎ステップ並べ替え直す)
runCase('2 steps with pressure', { seed: 8, N, numTypes: 5, width: 1.78, initSpeed: 0.1 },
    { rMax: rMaxFor(1.78), limitPressure: true, pressureStrength: 0.05, restDensity: 3, viscosity: 0.3 }, null, 2, null, PROD);

// 9. 狭い世界 (K セル < rMax でペアごとの最小イメージに切り替わる)
runCase('narrow world', { seed: 9, N: 120, numTypes: 3, width: 0.18 }, { rMax: 0.08 }, null, 1, null, { reach: 1, minImage: true });
runCase('narrow both axes', { seed: 30, N: 150, numTypes: 3, width: 0.2, height: 0.22 }, { rMax: 0.09 }, null, 1, null, { reach: 1, minImage: true });

// 10. 多数の type、近傍探索の K (cellsPerRMax) を変える
runCase('many types, small rMax', { seed: 10, N, numTypes: 12, width: 1.78 }, { rMax: 0.04 }, null, 1, null, PROD);
runCase('cellsPerRMax 1', { seed: 21, N, numTypes: 5, width: 1.78, initSpeed: 0.1 },
    { rMax: 0.1, cellsPerRMax: 1, limitPressure: true, pressureStrength: 0.05, restDensity: 3, viscosity: 0.3 }, null, 1, null,
    { reach: 1, minImage: false });
runCase('cellsPerRMax 3', { seed: 23, N, numTypes: 5, width: 0.46, initSpeed: 0.1 },
    { rMax: 0.1, cellsPerRMax: 3, limitPressure: true, pressureStrength: 0.05, restDensity: 3, viscosity: 0.3 }, null, 1, null,
    { reach: 3, minImage: false });

// 10b. 既定の params (restDensity 20) で数百ステップ進めてクラスタができた状態から 1 ステップ
{
    const A = 0.46;
    const { sim, rules } = setup({ seed: 40, N, numTypes: 6, width: A });
    const params = Object.assign(createParams(), { rMax: rMaxFor(A), viscosity: 0.3 });
    sim.step(params, null, 300);
    const ref = referenceStep(snapshot(sim), sim.world, rules, params, null);
    sim.step(params, null, 1);
    const res = compare('evolved defaults', sim, ref);
    let pos = 0;
    for (let i = 0; i < ref.count; i++) if (ref.P[i] > 0) pos++;
    check(pos > ref.count * 0.05, `evolved defaults: only ${pos} particles have P > 0`);
    check(sim.grid.reach === 2 && !sim.minImage, 'evolved defaults: not on the production grid');
    console.log(`- evolved defaults: P > 0 for ${pos}/${N}, dv ${res.worstV.toExponential(1)}, dx ${res.worstX.toExponential(1)}`);
}

// 11. steps = 0 は何もしない
{
    const { sim } = setup({ seed: 11, N, numTypes: 4, width: 1, initSpeed: 0.1 });
    const before = snapshot(sim);
    sim.step(baseParams({ rMax: rMaxFor(1) }), { x: 0.5, y: 0.5, active: true, mode: 1 }, 0);
    const same = ['x', 'y', 'vx', 'vy', 'type'].every((k) => before[k].every((v, i) => Object.is(v, sim[k][i])));
    check(same, 'steps = 0 changed the state');
    console.log('- steps = 0');
}

// 12. 周期境界をまたぐペアが引き合う (x の端・y の端・角)
{
    const width = 0.46, rMax = 0.1, gap = 0.03;    // 距離 0.06 => r = 0.6 > beta (引力側)
    const cases = [
        { name: 'x edge', a: [gap, 0.5], b: [width - gap, 0.5] },
        { name: 'y edge', a: [0.2, gap], b: [0.2, 1 - gap] },
        { name: 'corner', a: [gap * 0.7, gap * 0.7], b: [width - gap * 0.7, 1 - gap * 0.7] },
    ];
    for (const { name, a, b } of cases) {
        const sim = new CpuSimulation();
        sim.setWorld(width, 1);
        sim.randomize(2, 1, makeRng(12));
        sim.x[0] = a[0]; sim.y[0] = a[1];
        sim.x[1] = b[0]; sim.y[1] = b[1];
        const rules = new RuleMatrix(1);
        rules.set(0, 0, 1);
        sim.setRules(rules);
        const params = baseParams({ rMax });
        const ref = referenceStep(snapshot(sim), sim.world, rules, params, null);
        sim.step(params, null, 1);
        // 粒子 0 は左下端にいるので、相手 (右/上の端) へは負の向きに動く
        const ex = b[0] !== a[0], ey = b[1] !== a[1];
        check(!ex || sim.vx[0] < 0 && sim.vx[1] > 0, `periodic ${name}: x not attracting (${sim.vx[0]}, ${sim.vx[1]})`);
        check(!ey || sim.vy[0] < 0 && sim.vy[1] > 0, `periodic ${name}: y not attracting (${sim.vy[0]}, ${sim.vy[1]})`);
        compare(`periodic ${name}`, sim, ref);
        console.log(`- periodic ${name}: v0 = (${sim.vx[0].toFixed(4)}, ${sim.vy[0].toFixed(4)})`);
    }
}

// 13. ルールの type 数が粒子より少なくても NaN にならない (足りない分は 0)
{
    const { sim } = setup({ seed: 13, N, numTypes: 6, width: 1 });
    sim.setRules(new RuleMatrix(3, makeRng(1)));
    sim.step(baseParams({ rMax: rMaxFor(1) }), null, 3);
    check(sim.vx.every(Number.isFinite) && sim.x.every(Number.isFinite), 'rules smaller than numTypes produced NaN');
    console.log('- rules/numTypes mismatch');
}

// 14. setWorld で範囲外の粒子が戻る
{
    const { sim } = setup({ seed: 14, N, numTypes: 3, width: 1.78 });
    sim.setWorld(0.46);
    let inside = true;
    for (let i = 0; i < sim.count; i++) inside &&= sim.x[i] >= 0 && sim.x[i] < sim.world.width && sim.y[i] >= 0 && sim.y[i] < 1;
    check(inside, 'setWorld left particles outside');
    console.log('- setWorld wraps');
}

// 15. Worker のメッセージ処理 (純関数) と SimClient (偽の Worker で structuredClone + transfer を往復) が CpuSimulation とビット一致
{
    // 偽の Worker: 実物と同じく postMessage で transfer したバッファは送り側で detached になる。deliver() で 1 通ずつ処理
    class FakeWorker {
        constructor() {
            this.handle = createSimHandler();
            this.queue = [];
            this.terminated = false;
        }
        postMessage(msg, transfer = []) {
            this.queue.push(structuredClone(msg, { transfer }));
        }
        deliver() {
            const m = this.queue.shift();
            const r = this.handle(m);
            if (r) this.onmessage({ data: structuredClone(r.msg, { transfer: r.transfer }) });
        }
        deliverAll() {
            while (this.queue.length) this.deliver();
        }
        terminate() {
            this.terminated = true;
        }
    }
    const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    const intact = (c) => c.x.length === c.count && c.y.length === c.count && c.type.length === c.count
        && c.x.buffer.byteLength === c.count * 4 && c.type.buffer.byteLength === c.count;
    const sameState = (c, s) => c.count === s.count && same(c.x, s.x) && same(c.y, s.y) && same(c.type, s.type);

    const fw = new FakeWorker();
    const client = new SimClient(fw, { maxInFlight: 2 });
    const direct = new CpuSimulation();
    const params = Object.assign(createParams(), { rMax: rMaxFor(0.46), viscosity: 0.3 });
    const pointer = { x: 0.1, y: 0.95, active: true, mode: -1 };
    const rulesA = new RuleMatrix(5, makeRng(50));
    let ok = true;
    const both = (f) => {
        f(client);
        f(direct);
        ok &&= intact(client);
    };
    both((s) => s.setWorld(0.46, 1));
    both((s) => s.setRules(rulesA));
    both((s) => s.randomize(N, 5, makeRng(51)));
    ok &&= sameState(client, direct);                       // 送る前から main の x / y / type が正しい
    both((s) => s.step(params, pointer, 1));
    ok &&= intact(client);
    fw.deliverAll();
    ok &&= intact(client) && sameState(client, direct);
    check(ok, 'SimClient: state after randomize + step differs from CpuSimulation');

    // 依頼は 2 本まで、3 本目は捨てる (待ち行列にしない)
    client.step(params, pointer, 1);
    client.step(params, null, 1);
    client.step(params, null, 1);
    check(client.droppedSteps === 1 && client.inFlight === 2, `SimClient: backpressure (dropped ${client.droppedSteps}, inFlight ${client.inFlight})`);
    direct.step(params, pointer, 1);
    direct.step(params, null, 1);
    fw.deliver();
    ok = intact(client);
    // 届く前に状態を変える操作: 古い snapshot は捨てる (epoch)
    both((s) => s.setCount(N + 200, makeRng(52)));
    fw.deliverAll();
    ok &&= intact(client) && client.count === N + 200;
    both((s) => s.step(params, null, 2));
    fw.deliverAll();
    ok &&= sameState(client, direct);
    // 粒子数が同じでも、依頼中に type を振り直したら古い snapshot (古い type) は表示しない
    both((s) => s.step(params, null, 1));
    both((s) => s.assignTypes(5, makeRng(53)));
    fw.deliverAll();
    check(client.snapshots > 0 && same(client.type, direct.type), 'SimClient: stale snapshot shown after assignTypes');
    // version: 配列の中身が変わる操作で増え、何も変わらないとき (step の依頼だけ) は同じ (描画側が再アップロードを省く)
    const v0 = client.version;
    both((s) => s.step(params, null, 1));
    check(client.version === v0, 'SimClient: version changed without new data');
    fw.deliverAll();
    check(client.version === v0 + 1, 'SimClient: version not bumped by snapshot');
    both((s) => s.setWorld(0.5, 1));
    check(client.version === v0 + 2, 'SimClient: version not bumped by setWorld');
    both((s) => s.setRules(new RuleMatrix(5, makeRng(54))));
    both((s) => s.step(params, pointer, 1));
    fw.deliverAll();
    ok &&= intact(client) && sameState(client, direct);
    both((s) => s.setCount(N - 300, makeRng(55)));
    ok &&= intact(client) && sameState(client, direct);    // 減らすときも main 側で即座に正しい
    both((s) => s.step(params, null, 3));
    fw.deliverAll();
    ok &&= sameState(client, direct) && client.grid.nx === direct.grid.nx && client.grid.reach === direct.grid.reach;
    check(ok, 'SimClient: state after setCount / assignTypes / setWorld differs from CpuSimulation');
    check(client.pool.length <= 3, `SimClient: pool grew to ${client.pool.length}`);

    // Worker が落ちたら手元の状態から CpuSimulation に切り替わり、そのまま動く
    client.step(params, null, 1);
    client.worker.onerror({ message: 'test' });
    const before = Float32Array.from(client.x);
    client.step(params, null, 1);
    check(!client.isWorker && fw.terminated && client.count === N - 300 && !same(before, client.x) && client.x.every(Number.isFinite),
        'SimClient: fallback after a worker error');

    // Node には Worker が無いので createSim は CpuSimulation を返す
    check(createSim() instanceof CpuSimulation, 'createSim: no fallback to CpuSimulation without Worker');
    console.log(`- SimClient / simWorker handler: bit-identical to CpuSimulation, dropped ${client.droppedSteps}, fallback ok`);
}

// 性能の目安 (合否には使わない): N = 4000、rMax = sqrt(30 A / N)、config.js の既定 (圧力あり)
{
    const { performance } = globalThis;
    const NB = 4000;
    for (const A of [0.46, 1.78]) {
        const { sim } = setup({ seed: 100, N: NB, numTypes: 6, width: A });
        const params = Object.assign(createParams(), { rMax: Math.sqrt(30 * A / NB) });
        const time = (n) => {
            const t0 = performance.now();
            for (let i = 0; i < n; i++) sim.step(params, null, 1);
            return (performance.now() - t0) / n;
        };
        time(30);                       // JIT のウォームアップ
        const uniform = time(100);
        time(400);                      // クラスタができた状態
        const evolved = time(200);
        const g = sim.grid;
        console.log(`perf N=${NB} A=${A} rMax=${params.rMax.toFixed(4)} grid ${g.nx}x${g.ny}: `
            + `${uniform.toFixed(2)} ms/step (uniform), ${evolved.toFixed(2)} ms/step (after 500 steps)`);
    }
}

if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
}
console.log('all passed');
