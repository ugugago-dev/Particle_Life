// CPU 版シミュレーション (スマホ用、DOM 非依存)。物理は src/gpu/shaders/force.wgsl.js + simulation.js の writeUniforms と同じ
// 1 ステップ = counting sort した並べ替えコピーを読み、ライブ配列 (元の添字) へ書く。全粒子が古い位置・速度から力を受ける
// 近傍は対称ペア (半分のステンシルで i, j を 1 回だけ評価し、rules[ti][tj] と rules[tj][ti] の両方向を足す)

import { wrap, randomize as randomizeState, assignTypes as assignTypesState } from '../particles.js';

const MAX_CELLS = 1 << 20;
const MAX_VISCOSITY_STEP = 0.01;   // simulation.js と同じ (粘性で 1 ステップに相対速度を消しすぎない上限)
const MAX_RANGES = 2 + 2 * 4;      // 自分の列 + 右の K 列 (K <= 4)、それぞれ y の回り込みで最大 2 範囲

export class CpuSimulation {
    constructor() {
        this.count = 0;
        this.numTypes = 1;
        this.world = { width: 1, height: 1 };
        this.x = new Float32Array(0);
        this.y = new Float32Array(0);
        this.vx = new Float32Array(0);
        this.vy = new Float32Array(0);
        this.type = new Uint8Array(0);
        this.grid = { nx: 3, ny: 3, nCells: 9, reach: 1 };

        // グリッドの内部状態 (rMax / world が変わったときだけ作り直す)
        this.gridKey = { rMax: -1, reachWanted: -1, width: -1, height: -1 };
        this.invCellW = 3;
        this.invCellH = 3;
        this.minImage = false;
        this.cellStart = new Int32Array(10);
        this.cursor = new Int32Array(9);

        // 並べ替えコピー (SoA、容量 = count)
        this.allocSorted(0);

        // ルール (setRules のコピー) と粒子の numTypes に合わせた表
        this.rulesN = 0;
        this.rules = new Float32Array(0);
        this.table = new Float64Array(1);
        this.tableN = 1;
        this.tableDirty = true;

        // 粒子ごとの走査範囲 [start, end) とずらし量
        this.rStart = new Int32Array(MAX_RANGES);
        this.rEnd = new Int32Array(MAX_RANGES);
        this.rShiftX = new Float64Array(MAX_RANGES);
        this.rShiftY = new Float64Array(MAX_RANGES);

        // step の定数 (writeUniforms 相当)
        this.consts = {};
    }

    allocSorted(n) {
        this.sx = new Float64Array(n);
        this.sy = new Float64Array(n);
        this.svx = new Float64Array(n);
        this.svy = new Float64Array(n);
        this.stype = new Uint8Array(n);
        this.sp = new Float64Array(n);     // 密度 -> 圧力 P (並べ替え後の添字)
        this.sax = new Float64Array(n);    // 加速度の和 (未スケール)
        this.say = new Float64Array(n);
        this.sidx = new Int32Array(n);     // 並べ替え後 -> 元の添字
        this.pcell = new Int32Array(n);    // 元の添字 -> セル
    }

    /** 範囲外の粒子は wrap で戻す。 */
    setWorld(width, height = 1) {
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
    }

    setRules(rules) {
        const n = rules.numTypes;
        if (this.rules.length !== n * n) this.rules = new Float32Array(n * n);
        for (let k = 0; k < n * n; k++) this.rules[k] = rules.data[k];
        this.rulesN = n;
        this.tableDirty = true;
    }

    /** 位置は一様、速度 0、type は i.i.d.。 */
    randomize(count, numTypes, rng = Math.random) {
        this.resizeArrays(count, 0);
        this.numTypes = Math.max(1, numTypes | 0);
        this.tableDirty = true;
        randomizeState(this, this.world, this.numTypes, rng);
    }

    /** type だけ振り直す。 */
    assignTypes(numTypes, rng = Math.random) {
        this.numTypes = Math.max(1, numTypes | 0);
        this.tableDirty = true;
        assignTypesState(this, this.numTypes, rng);
    }

    /** 仕様外の追加: 粒子数だけ変える (先頭は保持、増えた分は一様・速度 0・ランダム type)。自動品質で末尾を捨てる用。 */
    setCount(count, rng = Math.random) {
        const keep = Math.min(count, this.count);
        this.resizeArrays(count, keep);
        const { width, height } = this.world;
        for (let i = keep; i < count; i++) {
            this.x[i] = wrap(rng() * width, width);
            this.y[i] = wrap(rng() * height, height);
            this.vx[i] = 0;
            this.vy[i] = 0;
            this.type[i] = Math.min(this.numTypes - 1, Math.floor(rng() * this.numTypes));
        }
    }

    resizeArrays(count, keep) {
        if (count === this.count && this.x.length === count) return;
        const grow = (old, Ctor) => {
            const a = new Ctor(count);
            a.set(old.subarray(0, keep));
            return a;
        };
        this.x = grow(this.x, Float32Array);
        this.y = grow(this.y, Float32Array);
        this.vx = grow(this.vx, Float32Array);
        this.vy = grow(this.vy, Float32Array);
        this.type = grow(this.type, Uint8Array);
        this.count = count;
        this.allocSorted(count);
    }

    /** セル幅 >= rMax / K で ±K セル (GPU 版 configureGrid と同じ決め方)。各軸 2K + 1 セル未満なら K を下げる。 */
    configureGrid(rMax, reachWanted = 2) {
        const { width, height } = this.world;
        const key = this.gridKey;
        if (key.rMax === rMax && key.reachWanted === reachWanted && key.width === width && key.height === height) return;
        key.rMax = rMax;
        key.reachWanted = reachWanted;
        key.width = width;
        key.height = height;

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
            r *= 1.25;
        }
        const g = this.grid;
        g.nx = nx;
        g.ny = ny;
        g.nCells = nx * ny;
        g.reach = reach;
        this.invCellW = nx / width;
        this.invCellH = ny / height;
        // 世界が狭く K セル < rMax のとき (K = 1 で 3 セルに満たない) は範囲ごとのずらしでは最小イメージにならないので、
        // 弦での絞り込みをやめて全行を走査し、ペアごとに最小イメージを取る
        this.minImage = (width / nx) * reach < rMax || (height / ny) * reach < rMax;
        if (this.cursor.length !== g.nCells) {
            this.cellStart = new Int32Array(g.nCells + 1);
            this.cursor = new Int32Array(g.nCells);
        }
    }

    /** 粒子の numTypes に合わせたルール表 (足りない分は 0)。 */
    buildTable() {
        const n = this.numTypes;
        const rn = this.rulesN;
        if (this.table.length !== n * n) this.table = new Float64Array(n * n);
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                this.table[i * n + j] = i < rn && j < rn ? this.rules[i * rn + j] : 0;
            }
        }
        this.tableN = n;
        this.tableDirty = false;
    }

    /** ライブ配列をセルで counting sort して並べ替えコピーを作る。 */
    sort() {
        const { count, x, y, vx, vy, type, pcell, sx, sy, svx, svy, stype, sidx, cellStart, cursor } = this;
        const { nx, ny, nCells } = this.grid;
        const invW = this.invCellW;
        const invH = this.invCellH;
        cellStart.fill(0);
        for (let i = 0; i < count; i++) {
            let cx = Math.floor(x[i] * invW);
            let cy = Math.floor(y[i] * invH);
            if (cx >= nx) cx = nx - 1;
            if (cy >= ny) cy = ny - 1;
            const c = cx * ny + cy;     // x-major (GPU 版と同じ)
            pcell[i] = c;
            cellStart[c + 1]++;
        }
        for (let c = 0; c < nCells; c++) {
            cellStart[c + 1] += cellStart[c];
            cursor[c] = cellStart[c];
        }
        for (let i = 0; i < count; i++) {
            const k = cursor[pcell[i]]++;
            sx[k] = x[i];
            sy[k] = y[i];
            svx[k] = vx[i];
            svy[k] = vy[i];
            stype[k] = type[i];
            sidx[k] = i;
        }
    }

    /**
     * 粒子 k (セル (cx, cy)、位置 (xi, yi)) の半分のステンシルを並べ替えコピー上の連続範囲にする。戻り値は本数。
     * 自分の列は上へ K 行 (開始は k + 1)、右の K 列は ±K 行。どのペアも 1 回だけ現れる (nx, ny >= 2K + 1)。
     * 行は半径 rMax の円の弦で絞る (GPU 版と同じ)。x-major なので同じ列の行は連続 (y の端だけ 2 範囲)。
     */
    particleRanges(k, xi, yi, cx, cy, rMax) {
        const { nx, ny, reach: K } = this.grid;
        const { cellStart, rStart, rEnd, rShiftX, rShiftY } = this;
        const mi = this.minImage;
        const W = mi ? 0 : this.world.width;
        const H = mi ? 0 : this.world.height;
        const invH = this.invCellH;
        let n = 0;

        // 自分の列: 自セルの k より後ろと上の行
        let base = cx * ny;
        let hi = cy + K;
        if (!mi) {
            const h = Math.floor((yi + rMax) * invH);
            if (h < hi) hi = h;
        }
        rStart[0] = k + 1;
        rShiftX[0] = 0;
        rShiftY[0] = 0;
        if (hi < ny) {
            rEnd[0] = cellStart[base + hi + 1];
            n = 1;
        } else {
            rEnd[0] = cellStart[base + ny];
            rStart[1] = cellStart[base]; rEnd[1] = cellStart[base + hi - ny + 1]; rShiftX[1] = 0; rShiftY[1] = H;
            n = 2;
        }

        // 右の K 列 (列の回り込みはずらし量で扱う)
        const xc = xi * this.invCellW;
        const cellW = this.world.width / nx;
        const rMax2 = rMax * rMax;
        for (let o = 1; o <= K; o++) {
            const c = cx + o;
            let lo = cy - K;
            hi = cy + K;
            if (!mi) {
                const gap = (c - xc) * cellW;
                if (gap >= rMax) break;
                const h = gap > 0 ? Math.sqrt(rMax2 - gap * gap) : rMax;
                const l = Math.floor((yi - h) * invH);
                const u = Math.floor((yi + h) * invH);
                if (l > lo) lo = l;
                if (u < hi) hi = u;
            }
            let col = c;
            let shx = 0;
            if (col >= nx) { col -= nx; shx = W; }
            base = col * ny;
            if (lo < 0) {
                rStart[n] = cellStart[base + lo + ny]; rEnd[n] = cellStart[base + ny]; rShiftX[n] = shx; rShiftY[n] = -H; n++;
                rStart[n] = cellStart[base]; rEnd[n] = cellStart[base + hi + 1]; rShiftX[n] = shx; rShiftY[n] = 0; n++;
            } else if (hi >= ny) {
                rStart[n] = cellStart[base + lo]; rEnd[n] = cellStart[base + ny]; rShiftX[n] = shx; rShiftY[n] = 0; n++;
                rStart[n] = cellStart[base]; rEnd[n] = cellStart[base + hi - ny + 1]; rShiftX[n] = shx; rShiftY[n] = H; n++;
            } else {
                rStart[n] = cellStart[base + lo]; rEnd[n] = cellStart[base + hi + 1]; rShiftX[n] = shx; rShiftY[n] = 0; n++;
            }
        }
        return n;
    }

    /** 同じステップの位置から P_i = max(0, Σ q² - restDensity) を並べ替え添字で sp に入れる。 */
    density(rMax, restDensity) {
        const { count, sx, sy, sp, cellStart, rStart, rEnd, rShiftX, rShiftY } = this;
        const { nx, ny } = this.grid;
        const rMax2 = rMax * rMax;
        const invRMax = 1 / rMax;
        const mi = this.minImage;
        const W = this.world.width, H = this.world.height, halfW = W * 0.5, halfH = H * 0.5;
        sp.fill(0);
        for (let cx = 0; cx < nx; cx++) {
            for (let cy = 0; cy < ny; cy++) {
                const c = cx * ny + cy;
                const kEnd = cellStart[c + 1];
                if (cellStart[c] === kEnd) continue;
                for (let k = cellStart[c]; k < kEnd; k++) {
                    const xi = sx[k], yi = sy[k];
                    const nr = this.particleRanges(k, xi, yi, cx, cy, rMax);
                    let sum = 0;
                    for (let r = 0; r < nr; r++) {
                        const e = rEnd[r], shx = rShiftX[r] - xi, shy = rShiftY[r] - yi;
                        for (let j = rStart[r]; j < e; j++) {
                            let dx = sx[j] + shx;
                            let dy = sy[j] + shy;
                            if (mi) {
                                if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
                                if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H;
                            }
                            const d2 = dx * dx + dy * dy;
                            if (d2 >= rMax2 || d2 === 0) continue;
                            const q = 1 - Math.sqrt(d2) * invRMax;
                            const w = q * q;
                            sum += w;
                            sp[j] += w;
                        }
                    }
                    sp[k] += sum;
                }
            }
        }
        for (let k = 0; k < count; k++) {
            const p = sp[k] - restDensity;
            sp[k] = p > 0 ? p : 0;
        }
    }

    /** dt = params.dt で steps 回進める (steps = 0 は何もしない)。 */
    step(params, pointer, steps) {
        if (!(steps > 0) || this.count === 0) return;
        const dt = params.dt;
        const rMax = params.rMax;
        this.configureGrid(rMax, params.cellsPerRMax ?? 2);
        if (this.tableDirty || this.tableN !== this.numTypes) this.buildTable();

        // writeUniforms と同じ定数
        const beta = Math.min(Math.max(params.beta, 0), 0.999);
        const pressureOn = !!params.limitPressure && params.pressureStrength > 0;
        const viscosity = params.limitPressure
            ? Math.min(Math.max(params.viscosity, 0), MAX_VISCOSITY_STEP / (rMax * params.forceFactor * dt)) : 0;
        const pointerOn = !!pointer && !!pointer.active && params.pointerRadius > 0;
        const c = this.consts;     // 使い回し (毎ステップ割り当てない)
        c.dt = dt;
        c.rMax = rMax;
        c.rMax2 = rMax * rMax;
        c.invRMax = 1 / rMax;
        c.beta = beta;
        c.invBeta = beta > 0 ? 1 / beta : 0;
        c.invOneMinusBeta = 1 / (1 - beta);
        c.accelScale = rMax * params.forceFactor;
        c.friction = 0.5 ** (dt / Math.max(params.frictionHalfLife, 1e-6));
        c.maxSpeed = params.limitSpeed ? Math.max(params.maxSpeed, 0) : 0;
        c.pressureOn = pressureOn;
        c.pressureScale = 0.5 * Math.max(params.pressureStrength, 0);
        c.viscosity = viscosity;
        c.viscOn = pressureOn && viscosity > 0;      // 圧力が無効なら粘性も無効 (GPU 版のパイプライン選択と同じ)
        c.pointerOn = pointerOn;
        c.px = pointerOn ? pointer.x : 0;
        c.py = pointerOn ? pointer.y : 0;
        c.pR2 = params.pointerRadius * params.pointerRadius;
        c.invPR = params.pointerRadius > 0 ? 1 / params.pointerRadius : 0;
        c.pStrength = pointerOn ? pointer.mode * params.pointerStrength * params.forceFactor : 0;

        for (let s = 0; s < steps; s++) {
            this.sort();
            if (pressureOn) this.density(rMax, params.restDensity);
            this.forces(c);
            this.integrate(c);
        }
    }

    /** 並べ替えコピー (古い値) から各粒子の力の和 (未スケール) を sax, say に入れる。 */
    forces(c) {
        const { sx, sy, svx, svy, stype, sp, sax, say, cellStart, rStart, rEnd, rShiftX, rShiftY, table } = this;
        const { nx, ny } = this.grid;
        const nt = this.tableN;
        const W = this.world.width, H = this.world.height, halfW = W * 0.5, halfH = H * 0.5;
        const mi = this.minImage;
        const rMax = c.rMax, rMax2 = c.rMax2, invRMax = c.invRMax, beta = c.beta, invBeta = c.invBeta, invOneMinusBeta = c.invOneMinusBeta;
        const pressureOn = c.pressureOn, viscOn = c.viscOn, pScale = c.pressureScale, visc = c.viscosity;
        sax.fill(0);
        say.fill(0);

        for (let cx = 0; cx < nx; cx++) {
            for (let cy = 0; cy < ny; cy++) {
                const cell = cx * ny + cy;
                const kEnd = cellStart[cell + 1];
                if (cellStart[cell] === kEnd) continue;
                for (let k = cellStart[cell]; k < kEnd; k++) {
                    const xi = sx[k], yi = sy[k], vxi = svx[k], vyi = svy[k];
                    const nr = this.particleRanges(k, xi, yi, cx, cy, rMax);
                    const ti = stype[k];
                    const row = ti * nt;
                    const pi = sp[k];
                    let ax = 0, ay = 0;
                    for (let r = 0; r < nr; r++) {
                        const e = rEnd[r], shx = rShiftX[r] - xi, shy = rShiftY[r] - yi;
                        for (let j = rStart[r]; j < e; j++) {
                            // (dx, dy) は i から j への変位。j が受ける力は向きが逆で rules[tj][ti]
                            let dx = sx[j] + shx;
                            let dy = sy[j] + shy;
                            if (mi) {
                                if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
                                if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H;
                            }
                            const d2 = dx * dx + dy * dy;
                            if (d2 >= rMax2 || d2 === 0) continue;   // 範囲外 / 同じ位置
                            const d = Math.sqrt(d2);
                            const invD = 1 / d;
                            const rr = d * invRMax;
                            let fi, fj;
                            if (rr < beta) {
                                fi = fj = rr * invBeta - 1;
                            } else {
                                const t = 2 * rr - 1 - beta;
                                const shape = 1 - Math.abs(t) * invOneMinusBeta;   // Math.abs は分岐なし (三項演算子だと分岐予測ミスで ~10% 遅い)
                                const tj = stype[j];
                                fi = table[row + tj] * shape;
                                fj = table[tj * nt + ti] * shape;
                            }
                            if (pressureOn) {
                                // 圧力と粘性は i, j で同じ値 (粘性の (vj - vi)·(dx, dy) は向きを入れ替えても同じ)
                                const q = 1 - rr;
                                const pSum = pi + sp[j];
                                let common = -pScale * pSum * q;
                                if (viscOn) {
                                    common += visc * q * (pSum < 1 ? pSum : 1) * ((svx[j] - vxi) * dx + (svy[j] - vyi) * dy) * invD;
                                }
                                fi += common;
                                fj += common;
                            }
                            const ux = dx * invD, uy = dy * invD;
                            ax += ux * fi;
                            ay += uy * fi;
                            sax[j] -= ux * fj;
                            say[j] -= uy * fj;
                        }
                    }
                    sax[k] += ax;
                    say[k] += ay;
                }
            }
        }
    }

    /** 力 -> 速度 -> 位置。古い値は並べ替えコピーから読み、ライブ配列の元の添字へ書く。 */
    integrate(c) {
        const { count, sx, sy, svx, svy, sax, say, sidx, x, y, vx, vy } = this;
        const W = this.world.width, H = this.world.height, halfW = W * 0.5, halfH = H * 0.5;
        const accelScale = c.accelScale, friction = c.friction, dt = c.dt, maxSpeed = c.maxSpeed;
        const maxSpeed2 = maxSpeed * maxSpeed;
        const pointerOn = c.pointerOn, px = c.px, py = c.py, pR2 = c.pR2, invPR = c.invPR, pStrength = c.pStrength;
        for (let k = 0; k < count; k++) {
            const xi = sx[k], yi = sy[k];
            let ax = sax[k] * accelScale;
            let ay = say[k] * accelScale;

            if (pointerOn) {
                let dx = px - xi;
                let dy = py - yi;
                if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
                if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H;
                const d2 = dx * dx + dy * dy;
                if (d2 < pR2 && d2 > 1e-12) {
                    const d = Math.sqrt(d2);
                    const w = 1 - d * invPR;
                    const g = pStrength * w * w * (3 - 2 * w) / d;
                    ax += dx * g;
                    ay += dy * g;
                }
            }

            let nvx = svx[k] * friction + ax * dt;
            let nvy = svy[k] * friction + ay * dt;
            if (maxSpeed > 0) {
                const s2 = nvx * nvx + nvy * nvy;
                if (s2 > maxSpeed2) {
                    const sc = maxSpeed / Math.sqrt(s2);
                    nvx *= sc;
                    nvy *= sc;
                }
            }
            const o = sidx[k];
            vx[o] = nvx;
            vy[o] = nvy;
            x[o] = wrap(xi + nvx * dt, W);
            y[o] = wrap(yi + nvy * dt, H);
        }
    }
}
