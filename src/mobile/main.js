// スマホ版の結線。CPU シミュレーション + WebGL2 描画。WebGL2 が無ければメッセージだけ出す

import { createParams } from '../config.js';
import { RuleMatrix } from '../rules.js';
import { PRESETS, formatRules } from '../presets.js';
import { createPalette } from '../palette.js';
import { createInput } from '../input.js';
import { MatrixEditor } from '../ui/matrixEditor.js';
import { StatsOverlay } from '../ui/stats.js';
import { CpuSimulation } from './cpuSimulation.js';
import { GlRenderer } from './glRenderer.js';

const DENSITY = 30;          // N * rMax^2 / A の不変量 (PC 版と同じ近傍密度)
const DEFAULT_N = 2500;
const MIN_N = 1000;          // 自動品質の下限
const MAX_N = 20000;
const RMAX_RETARGET = 0.2;   // A がこの割合以上変わったら rMax を決め直す
const QUALITY_WINDOW_MS = 2000;
const QUALITY_SLOW_MS = 20;
const QUALITY_SHRINK = 0.8;

function showUnsupported(reason) {
    const el = document.createElement('div');
    el.className = 'unsupported';
    const title = document.createElement('div');
    title.className = 'unsupported-title';
    title.textContent = 'このブラウザは WebGL2 に対応していません';
    const detail = document.createElement('div');
    detail.className = 'unsupported-detail';
    detail.textContent = reason;
    el.append(title, detail);
    document.body.append(el);
    console.error('[WebGL2]', reason);
}

function makeButton(label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
}

function main() {
    const canvas = document.querySelector('#canvas');
    const toolbar = document.querySelector('#toolbar');

    let renderer;
    try {
        renderer = GlRenderer.create(canvas);
    } catch (e) {
        toolbar.hidden = true;
        return showUnsupported(String(e?.message ?? e));
    }

    const query = new URLSearchParams(location.search);
    const advanced = query.has('advanced');
    const initialPreset = PRESETS[Number(query.get('preset')) - 1]; // 1 始まり、無ければ undefined
    const nQuery = Number(query.get('n'));
    const fixedN = query.has('n') && Number.isFinite(nQuery) && nQuery >= 1; // 指定時は自動品質を切る
    let autoQuality = !fixedN;

    const params = createParams();
    params.renderMode = 'dots';
    params.numParticles = fixedN ? Math.min(Math.round(nQuery), MAX_N) : DEFAULT_N;
    params.substeps = 1;
    params.particleRadius = 1.6;
    params.showMatrix = false;

    const rules = new RuleMatrix(params.numTypes);
    if (initialPreset) {
        rules.load(initialPreset.rules);
        params.numTypes = rules.numTypes;
    }
    const sim = new CpuSimulation();
    const { pointer } = createInput(canvas);
    const stats = advanced ? new StatsOverlay(false) : null;
    let palette = createPalette(params.numTypes);
    let rulesDirty = true;
    let ui = null;
    let lastA = 0; // rMax を最後に決めたときのアスペクト比

    // 引く/押す: createInput の後に登録して pointer.mode を上書きする
    let push = false;
    const applyMode = () => {
        pointer.mode = push ? -1 : 1;
    };
    canvas.addEventListener('pointerdown', applyMode);
    canvas.addEventListener('pointermove', applyMode);

    function aspect() {
        const h = canvas.clientHeight;
        return h > 0 ? canvas.clientWidth / h : 0;
    }

    // rMax = sqrt(30 A / N)。GUI の表示も更新する
    function recomputeRMax() {
        const A = aspect();
        if (A <= 0 || sim.count <= 0) return;
        params.rMax = Math.sqrt((DENSITY * A) / sim.count);
        lastA = A;
        if (ui) for (const c of ui.controllersRecursive()) c.updateDisplay();
    }

    function resize() {
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;
        if (cssW === 0 || cssH === 0) return;
        renderer.resize(cssW, cssH, window.devicePixelRatio || 1);
        sim.setWorld(cssW / cssH, 1);
        if (lastA > 0 && Math.abs(cssW / cssH / lastA - 1) >= RMAX_RETARGET) recomputeRMax();
    }
    new ResizeObserver(resize).observe(canvas);
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);

    sim.setRules(rules);
    rulesDirty = false;
    resize();
    sim.randomize(params.numParticles, rules.numTypes);
    recomputeRMax();

    const matrix = new MatrixEditor(document.body, rules, palette, rulesEdited);
    matrix.setVisible(params.showMatrix);

    // ---- ツールバー ----
    const select = document.createElement('select');
    select.title = 'プリセット';
    select.setAttribute('aria-label', 'プリセット');
    const custom = new Option('カスタム', '');
    select.append(custom);
    PRESETS.forEach((p, i) => select.append(new Option(p.name, String(i))));
    select.value = initialPreset ? String(PRESETS.indexOf(initialPreset)) : '';

    function markCustom() {
        select.value = '';
        ui?.markCustom?.();
    }

    function rulesEdited() {
        rulesDirty = true;
        markCustom();
    }

    const runBtn = makeButton('⏯', '実行 / 停止', () => {
        params.running = !params.running;
        runBtn.setAttribute('aria-pressed', String(!params.running));
    });
    runBtn.setAttribute('aria-pressed', 'false');

    const modeBtn = makeButton('引く', '引く / 押す', () => {
        push = !push;
        modeBtn.textContent = push ? '押す' : '引く';
        modeBtn.setAttribute('aria-pressed', String(push));
        applyMode();
    });
    modeBtn.setAttribute('aria-pressed', 'false');

    const matrixBtn = makeButton('ルール', 'ルール行列の開閉', () => {
        params.showMatrix = !params.showMatrix;
        matrix.setVisible(params.showMatrix);
        matrixBtn.setAttribute('aria-pressed', String(params.showMatrix));
    });
    matrixBtn.setAttribute('aria-pressed', 'false');

    const randomBtn = makeButton('🎲', 'ルールをランダム', () => actions.randomizeRules());
    const resetBtn = makeButton('↺', '粒子をリセット', () => actions.resetParticles());

    select.addEventListener('change', () => {
        const preset = PRESETS[Number(select.value)];
        if (select.value !== '' && preset) actions.loadPreset(preset);
    });

    toolbar.append(runBtn, modeBtn, matrixBtn, randomBtn, resetBtn, select);

    // ルール行列パネルがツールバーの上に載るよう高さを CSS 変数へ (mobile.css の --toolbar-h)
    const syncToolbarHeight = () => {
        document.documentElement.style.setProperty('--toolbar-h', `${toolbar.offsetHeight}px`);
    };
    new ResizeObserver(syncToolbarHeight).observe(toolbar);
    syncToolbarHeight();

    // フレームごとに使い回す
    const view = {
        palette,
        particleRadius: params.particleRadius,
        trails: params.trails,
        pointer,
        pointerRadius: params.pointerRadius,
        renderMode: 'dots',
        organic: params,
    };

    const actions = {
        setNumParticles(n) {
            autoQuality = false; // 手動で決めたら自動品質は触らない
            sim.randomize(n, rules.numTypes);
            recomputeRMax();
        },
        setNumTypes(n) {
            rules.resize(n);
            palette = createPalette(n);
            sim.setRules(rules);
            rulesDirty = false;
            sim.assignTypes(n);
            matrix.rebuild(rules, palette);
            markCustom();
        },
        recomputeRMax,
        loadPreset(preset) {
            rules.load(preset.rules);
            params.numTypes = rules.numTypes;
            palette = createPalette(rules.numTypes);
            sim.setRules(rules);
            rulesDirty = false;
            sim.randomize(sim.count, rules.numTypes);
            matrix.rebuild(rules, palette);
        },
        randomizeRules() {
            rules.randomize();
            matrix.refresh();
            rulesEdited();
        },
        async copyRules() {
            const text = formatRules(rules);
            try {
                await navigator.clipboard.writeText(text);
            } catch {
                console.log(text); // クリップボード不可 (非 HTTPS): コンソールから取る
            }
        },
        resetParticles() {
            sim.randomize(sim.count, rules.numTypes);
        },
    };

    if (advanced) {
        // lil-gui は CDN: 失敗しても本体は動かす
        import('./mobileGui.js')
            .then(({ createMobileGUI }) => createMobileGUI(params, actions))
            .then((gui) => {
                ui = gui;
            })
            .catch((e) => console.error('mobile GUI could not be loaded', e));
    }

    // ---- 自動品質: 直近 2 秒の平均フレーム時間が 20 ms 超なら粒子を 2 割減らす ----
    let qSum = 0;
    let qFrames = 0;
    let qStart = 0;
    let lastNow = 0;
    function autoTune(now) {
        if (lastNow > 0 && params.running) {
            qSum += now - lastNow;
            qFrames++;
        }
        lastNow = now;
        if (!autoQuality) return;
        if (qStart === 0) qStart = now;
        if (now - qStart < QUALITY_WINDOW_MS) return;
        if (qFrames > 0 && qSum / qFrames > QUALITY_SLOW_MS && sim.count > MIN_N) {
            sim.setCount(Math.max(MIN_N, Math.round(sim.count * QUALITY_SHRINK)));
            params.numParticles = sim.count;
            recomputeRMax();
        }
        qSum = 0;
        qFrames = 0;
        qStart = now;
    }

    let rafId = 0;
    function frame(now) {
        rafId = requestAnimationFrame(frame);
        autoTune(now);

        if (rulesDirty) {
            sim.setRules(rules);
            rulesDirty = false;
        }
        view.palette = palette;
        view.particleRadius = params.particleRadius;
        view.trails = params.trails;
        view.pointerRadius = params.pointerRadius;

        const t0 = performance.now();
        sim.step(params, pointer, params.running ? params.substeps : 0);
        const simMs = performance.now() - t0;
        renderer.draw(sim, view);

        if (stats) {
            stats.recordCpu(simMs);
            const g = sim.grid;
            stats.tick(now, sim.count, `cells     ${g.nx}x${g.ny} (±${g.reach})\nrMax      ${params.rMax.toFixed(4)}`);
        }
    }

    // 非表示の間は rAF を止め、戻ったら経過時間を捨てて再開
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            cancelAnimationFrame(rafId);
            rafId = 0;
        } else if (rafId === 0) {
            lastNow = 0;
            qStart = 0;
            qSum = 0;
            qFrames = 0;
            if (stats) stats.lastTime = 0;
            rafId = requestAnimationFrame(frame);
        }
    });
    if (!document.hidden) rafId = requestAnimationFrame(frame);
}

try {
    main();
} catch (e) {
    console.error(e);
    showUnsupported(String(e?.message ?? e));
}
