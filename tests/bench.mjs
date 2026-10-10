// CpuSimulation の計測: node tests/bench.mjs [実装のパス (既定 ../src/mobile/cpuSimulation.js)] [--json]
// 一様 (直後) と 500 ステップ後 (クラスタ形成後) を、A = 0.46 / 1.78、N = 2500 / 4000 で。config.js の既定 (圧力あり)

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createParams } from '../src/config.js';
import { RuleMatrix } from '../src/rules.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const implArg = args.find((a) => !a.startsWith('--'));
const implUrl = implArg ? pathToFileURL(resolve(implArg)).href : new URL('../src/mobile/cpuSimulation.js', import.meta.url).href;
const { CpuSimulation } = await import(implUrl);

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

// steps 回を 10 ステップずつ測り、ms/step の中央値 (GC や他プロセスの外れ値を避ける)
function timeSteps(sim, params, steps) {
    const chunk = 10, samples = [];
    for (let s = 0; s < steps; s += chunk) {
        const t0 = performance.now();
        sim.step(params, null, chunk);
        samples.push((performance.now() - t0) / chunk);
    }
    samples.sort((a, b) => a - b);
    return samples[samples.length >> 1];
}

function run(N, A, seed = 100) {
    const rng = makeRng(seed);
    const sim = new CpuSimulation();
    sim.setWorld(A, 1);
    sim.randomize(N, 6, rng);
    sim.setRules(new RuleMatrix(6, rng));
    const params = Object.assign(createParams(), { rMax: Math.sqrt(30 * A / N) });
    const uniform = timeSteps(sim, params, 60);          // 0..60 ステップ
    sim.step(params, null, 500 - 60);
    const evolved = timeSteps(sim, params, 200);         // 500..700 ステップ
    return { N, A, uniform, evolved };
}

// JIT のウォームアップ (結果は捨てる)
run(2500, 1.0, 1);

const rows = [];
for (const N of [2500, 4000]) {
    for (const A of [0.46, 1.78]) rows.push(run(N, A));
}
if (json) {
    console.log(JSON.stringify(rows));
} else {
    console.log(`impl: ${implUrl}`);
    console.log('N     A     uniform ms/step  after-500 ms/step');
    for (const r of rows) {
        console.log(`${String(r.N).padEnd(5)} ${r.A.toFixed(2)}  ${r.uniform.toFixed(2).padStart(14)}  ${r.evolved.toFixed(2).padStart(17)}`);
    }
}
