// スマホ版の結線。CPU シミュレーション + WebGL2 描画。WebGL2 が無ければメッセージだけ出す

import { createParams } from '../config.js';
import { RuleMatrix } from '../rules.js';
import { PRESETS, formatRules } from '../presets.js';
import { createPalette } from '../palette.js';
import { createInput } from '../input.js';
import { StatsOverlay } from '../ui/stats.js';
import { GlRenderer } from './glRenderer.js';
import { createToolbar } from './ui/toolbar.js';
import { createRulesSheet } from './ui/rulesSheet.js';
import { createSettingsSheet } from './ui/settingsSheet.js';
import { createImmersive } from './ui/immersive.js';
import { createToast } from './ui/toast.js';
import { createMobileGUI } from './mobileGui.js';
import { applyStyleQuery, rulesFromQuery, shareUrl, copyText } from '../share.js';
import { createSettingsStore, saveOnHide } from '../settings.js';

const DENSITY = 30;          // N * rMax^2 / A の不変量 (PC 版と同じ近傍密度)
const DEFAULT_N = 2500;
const MIN_N = 1000;          // 自動品質の下限
const MAX_N = 20000;
const RMAX_RETARGET = 0.2;   // A がこの割合以上変わったら rMax を決め直す
const QUALITY_WINDOW_MS = 2000;
const QUALITY_SLOW_MS = 20;
const QUALITY_SHRINK = 0.8;
// 再読み込みで残す設定 (粒子数・rMax は自動品質と画面の比率で決まるので残さない)
const KEPT_SETTINGS = ['renderMode', 'organicStyle', 'particleRadius', 'trails', 'numTypes', 'ruleGenerator'];
const settings = createSettingsStore('particle-life:mobile-settings', KEPT_SETTINGS);

// sim の生成はここだけ。simClient.js (Worker 版) があればそれ、無い / 失敗なら CpuSimulation
async function createSimulation() {
    try {
        const { createSim } = await import('./simClient.js');
        return await createSim();
    } catch (e) {
        console.info('simClient.js を使えないため CpuSimulation にします', e?.message ?? e);
        const { CpuSimulation } = await import('./cpuSimulation.js');
        return new CpuSimulation();
    }
}

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

async function main() {
    const canvas = document.querySelector('#canvas');
    const toolbarEl = document.querySelector('#toolbar');
    const edgeEl = document.querySelector('#edge-reveal');

    let renderer;
    try {
        renderer = GlRenderer.create(canvas);
    } catch (e) {
        toolbarEl.hidden = true;
        return showUnsupported(String(e?.message ?? e));
    }

    const query = new URLSearchParams(location.search);
    const advanced = query.has('advanced');
    const urlRules = rulesFromQuery(query); // ?rules (共有リンク) は ?preset より優先
    const initialPreset = urlRules ? undefined : PRESETS[Number(query.get('preset')) - 1]; // 1 始まり、無ければ undefined
    const nQuery = Number(query.get('n'));
    const fixedN = query.has('n') && Number.isFinite(nQuery) && nQuery >= 1; // 指定時は自動品質を切る
    let autoQuality = !fixedN;

    const canOrganic = () => !!renderer.capabilities?.organic; // organic 担当が立てる

    // スマホ版の既定 <- 保存した設定 <- URL。organic を描けない端末は常に dots
    const params = createParams();
    params.fieldScale = 0.25;
    params.numParticles = fixedN ? Math.min(Math.round(nQuery), MAX_N) : DEFAULT_N;
    params.substeps = 1;
    params.particleRadius = 1.6;
    params.showMatrix = false;
    settings.load(params);
    applyStyleQuery(params, query);
    if (!canOrganic()) params.renderMode = 'dots';
    if (params.organicStyle !== 'glass') params.organicStyle = 'scope'; // スマホは glass / scope だけ (cell は scope で描く)
    let keepSettings = true;
    const saveSettings = saveOnHide({ save: (p) => keepSettings && settings.save(p) }, params);

    const loaded = urlRules ?? initialPreset?.rules;
    const rules = new RuleMatrix(loaded ? 0 : params.numTypes, Math.random, params.ruleGenerator);
    if (loaded) {
        rules.load(loaded);
        params.numTypes = rules.numTypes;
    }
    const sim = await createSimulation();
    const { pointer } = createInput(canvas);
    const stats = advanced ? new StatsOverlay(false) : null;
    const toast = createToast();
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

    renderer.setContextLostHandler?.((state) => {
        toast.show(state === 'lost' ? '描画が中断されました。復帰を待っています' : '描画を再開しました', 4000);
    });

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

    // ---- UI ----
    let sheetOpen = false;
    const immersive = createImmersive({
        toolbar: toolbarEl,
        edge: edgeEl,
        isBusy: () => sheetOpen || pointer.active,
    });

    const toolbar = createToolbar(toolbarEl, {
        onRun() {
            params.running = !params.running;
            toolbar.setRunning(params.running);
        },
        onMode() {
            push = !push;
            toolbar.setPush(push);
            applyMode();
        },
        onRules: (e) => toggleSheet(rulesUi.sheet, e?.currentTarget),
        onSettings: (e) => toggleSheet(settingsUi.sheet, e?.currentTarget),
    });

    function onSheetChange(name) {
        return (open) => {
            sheetOpen = open;
            toolbar.setSheet(open ? name : null);
            if (!open) {
                immersive.poke();
                saveSettings(); // シートで変えた値をすぐ残す (PC のパネルの確定と同じ)
            }
        };
    }

    function toggleSheet(sheet, opener) {
        if (sheet.isOpen) return sheet.close();
        if (sheet === settingsUi.sheet) settingsUi.sync();
        sheet.open(opener);
    }

    function rulesEdited() {
        rulesDirty = true;
        markCustom();
    }

    function markCustom() {
        rulesUi.setActivePreset(-1);
        ui?.markCustom?.();
    }

    const rulesUi = createRulesSheet({
        rules,
        palette,
        onChange: onSheetChange('rules'),
        onEdited: rulesEdited,
        onPreset: (preset, i) => actions.loadPreset(preset, i),
        onRandom: () => actions.randomizeRules(),
        onZero: () => actions.zeroRules(),
        onCopy: async () => {
            const ok = await actions.copyRules();
            toast.show(ok ? 'ルールをコピーしました' : 'コンソールに出力しました');
        },
        onShare: async () => {
            const ok = await copyText(shareUrl(params, rules));
            toast.show(ok ? 'リンクをコピーしました' : 'コンソールに出力しました');
        },
    });
    rulesUi.setActivePreset(initialPreset ? PRESETS.indexOf(initialPreset) : -1);

    const settingsUi = createSettingsSheet({
        params,
        onChange: onSheetChange('settings'),
        canOrganic,
        getAuto: () => autoQuality,
        setAuto: (v) => {
            autoQuality = v;
            qStart = 0;
        },
        setNumParticles: (n) => actions.setNumParticles(n),
        setNumTypes: (n) => actions.setNumTypes(n),
        reset: () => actions.resetParticles(),
        resetSettings: () => {
            keepSettings = false; // 再読み込みで今の値を保存し直さない
            settings.clear();
            location.reload();
        },
    });

    // フレームごとに使い回す
    const view = {
        palette,
        particleRadius: params.particleRadius,
        trails: params.trails,
        pointer,
        pointerRadius: params.pointerRadius,
        renderMode: params.renderMode,
        organic: params,
    };

    const actions = {
        setNumParticles(n) {
            autoQuality = false; // 手動で決めたら自動品質は触らない
            sim.randomize(n, rules.numTypes);
            recomputeRMax();
            settingsUi.sync();
        },
        setNumTypes(n) {
            rules.resize(n, Math.random, params.ruleGenerator);
            palette = createPalette(n);
            sim.setRules(rules);
            rulesDirty = false;
            sim.assignTypes(n);
            rulesUi.rebuild(rules, palette);
            markCustom();
        },
        recomputeRMax,
        loadPreset(preset, index = PRESETS.indexOf(preset)) {
            rules.load(preset.rules);
            params.numTypes = rules.numTypes;
            palette = createPalette(rules.numTypes);
            sim.setRules(rules);
            rulesDirty = false;
            sim.randomize(sim.count, rules.numTypes);
            rulesUi.rebuild(rules, palette);
            rulesUi.setActivePreset(index);
            settingsUi.sync();
        },
        randomizeRules() {
            rules.randomize(Math.random, params.ruleGenerator);
            rulesUi.refresh();
            rulesEdited();
        },
        zeroRules() {
            rules.zero();
            rulesUi.refresh();
            rulesEdited();
        },
        copyRules() {
            return copyText(formatRules(rules)); // クリップボード不可 (非 HTTPS) ならコンソールに出す
        },
        resetParticles() {
            sim.randomize(sim.count, rules.numTypes);
        },
    };

    if (advanced) {
        ui = createMobileGUI(params, {
            ...actions,
            copyRules: () => actions.copyRules().then((ok) => toast.show(ok ? 'ルールをコピーしました' : 'コンソールに出力しました')),
        });
    }

    // ---- 自動品質: 直近 2 秒の平均フレーム時間が 20 ms 超なら粒子を 2 割減らす ----
    let qSum = 0;
    let qFrames = 0;
    let qStart = 0;
    let lastNow = 0;
    function autoTune(now) {
        if (lastNow > 0 && params.running) {
            qSum += Math.max(now - lastNow, (sim.stepMs ?? 0) * params.substeps); // Worker 版は rAF が詰まらないので sim の実時間も見る
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
            settingsUi.sync();
            toast.show(`軽くしました: ${sim.count} 粒子`);
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
        view.renderMode = canOrganic() ? params.renderMode : 'dots';

        const t0 = performance.now();
        sim.step(params, pointer, params.running ? params.substeps : 0);
        const simMs = performance.now() - t0;
        renderer.draw(sim, view);

        if (stats) {
            stats.recordCpu(sim.stepMs ?? simMs);
            const g = sim.grid;
            const cells = g ? `cells     ${g.nx}x${g.ny} (±${g.reach})\n` : '';
            stats.tick(now, sim.count, `${cells}rMax      ${params.rMax.toFixed(4)}`);
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

main().catch((e) => {
    console.error(e);
    showUnsupported(String(e?.message ?? e));
});
