// CpuSimulation を Worker で回す。メッセージ処理は純関数 createSimHandler に分けて Node でテストする
// 受信 world / rules / randomize / assignTypes / setCount / step、step ごとに snapshot (x / y / typeBuf を transfer) を返す

import { CpuSimulation } from './cpuSimulation.js';

// main が記録した rng の値を同じ順で返す (main と Worker で同じ状態を作る)
function replayRng(values) {
    let i = 0;
    return () => values[i++];
}

/** メッセージ 1 通を処理し、返信 { msg, transfer } か null を返す。 */
export function createSimHandler(sim = new CpuSimulation(), now = () => performance.now()) {
    let epoch = 0;
    return function handle(m) {
        if (m.epoch !== undefined) epoch = m.epoch;
        switch (m.type) {
            case 'world':
                sim.setWorld(m.width, m.height);
                return null;
            case 'rules':
                sim.setRules({ numTypes: m.numTypes, data: m.data });
                return null;
            case 'randomize':
                sim.randomize(m.count, m.numTypes, replayRng(m.rng));
                return null;
            case 'assignTypes':
                sim.assignTypes(m.numTypes, replayRng(m.rng));
                return null;
            case 'setCount':
                sim.setCount(m.count, replayRng(m.rng));
                return null;
            case 'step': {
                const t0 = now();
                sim.step(m.params, m.pointer, m.steps);
                const stepMs = m.steps > 0 ? (now() - t0) / m.steps : 0;
                const n = sim.count;
                // 送られてきたバッファを使い回す (大きさが合わなければ作る)
                const x = m.x && m.x.length === n ? m.x : new Float32Array(n);
                const y = m.y && m.y.length === n ? m.y : new Float32Array(n);
                const type = m.typeBuf && m.typeBuf.length === n ? m.typeBuf : new Uint8Array(n);
                x.set(sim.x);
                y.set(sim.y);
                type.set(sim.type);
                const g = sim.grid;
                return {
                    msg: {
                        type: 'snapshot', epoch, count: n, numTypes: sim.numTypes, x, y, typeBuf: type,
                        grid: { nx: g.nx, ny: g.ny, nCells: g.nCells, reach: g.reach }, stepMs, steps: m.steps,
                    },
                    transfer: [x.buffer, y.buffer, type.buffer],
                };
            }
            default:
                return null;
        }
    };
}

// Worker として読み込まれたときだけ結線する (Node の import では何もしない)
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
    const handle = createSimHandler();
    self.onmessage = (e) => {
        const r = handle(e.data);
        if (r) self.postMessage(r.msg, r.transfer);
    };
    self.postMessage({ type: 'ready' });
}
