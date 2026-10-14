// Wiring only. The state lives on the GPU and is never read back; without WebGPU only a message is shown (no CPU fallback)

import { createParams, defaults } from './config.js';
import { RuleMatrix } from './rules.js';
import { PRESETS, formatRules } from './presets.js';
import { createPalette } from './palette.js';
import { createInput } from './input.js';
import { MatrixEditor } from './ui/matrixEditor.js';
import { StatsOverlay } from './ui/stats.js';
import { requestGPU, configureCanvas, showUnsupported } from './gpu/device.js';
import { GpuSimulation } from './gpu/simulation.js';
import { GpuRenderer } from './gpu/renderer.js';
import { GpuTimer } from './gpu/timer.js';
import { createGUI } from './ui/gui.js';
import { applyStyleQuery, rulesFromQuery, shareUrl, copyText } from './share.js';
import { createSettingsStore, saveOnHide } from './settings.js';

// every param is kept across reloads except the run / pause state
const settings = createSettingsStore('particle-life:settings', Object.keys(defaults).filter((k) => k !== 'running'));

async function main() {
    const canvas = document.querySelector('#canvas');

    const gpu = await requestGPU();
    if (!gpu.ok) return showUnsupported(gpu.reason, 'unsupported');
    const { device } = gpu;
    const cfg = configureCanvas(canvas, device);
    if (!cfg.ok) return showUnsupported(cfg.reason, 'unsupported');

    let alive = true;
    device.lost.then((info) => {
        alive = false;
        showUnsupported(`${info.reason}: ${info.message}`, 'lost');
    });
    device.addEventListener('uncapturederror', (e) => console.error('[WebGPU]', e.error?.message ?? e));

    let sim, renderer;
    try {
        sim = await GpuSimulation.create(device);
        renderer = await GpuRenderer.create(device, cfg.context, cfg.format, canvas);
    } catch (e) {
        console.error(e);
        return showUnsupported(String(e.message ?? e), 'error');
    }
    const query = new URLSearchParams(location.search);
    const advanced = query.has('advanced'); // public page: basic controls only
    const urlRules = rulesFromQuery(query); // ?rules (share link) wins over ?preset
    const initialPreset = urlRules ? undefined : PRESETS[Number(query.get('preset')) - 1]; // 1-based, undefined if absent / out of range

    // defaults <- saved settings <- URL
    const params = createParams();
    settings.load(params);
    applyStyleQuery(params, query);
    let keepSettings = true;
    const saveSettings = saveOnHide({ save: (p) => keepSettings && settings.save(p) }, params);

    const loaded = urlRules ?? initialPreset?.rules;
    const rules = new RuleMatrix(loaded ? 0 : params.numTypes, Math.random, params.ruleGenerator);
    if (loaded) {
        rules.load(loaded);
        params.numTypes = rules.numTypes;
    }
    const { pointer } = createInput(canvas);
    // timestamp queries only feed the stats overlay: the public page writes none
    const timer = advanced ? new GpuTimer(device) : null;
    const stats = timer ? new StatsOverlay(timer.enabled) : null;
    let palette = createPalette(params.numTypes);
    let rulesDirty = true;
    let ui = null; // set once the control panel is built

    function resize() {
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;
        if (cssW === 0 || cssH === 0) return;
        renderer.resize(cssW, cssH, window.devicePixelRatio || 1);
        sim.setWorld(cssW / cssH, 1);
    }
    new ResizeObserver(resize).observe(canvas);
    window.addEventListener('resize', resize); // browser zoom changes devicePixelRatio without resizing the element

    sim.setRules(rules);
    rulesDirty = false;
    resize();
    sim.randomize(params.numParticles, rules.numTypes);

    function rulesEdited() {
        rulesDirty = true;
        ui?.markCustom();
    }

    const matrix = new MatrixEditor(document.body, rules, palette, rulesEdited);
    matrix.setVisible(params.showMatrix);

    // reused every frame (no per-frame allocation)
    const view = {
        palette,
        particleRadius: params.particleRadius,
        trails: params.trails,
        pointer,
        pointerRadius: params.pointerRadius,
        rMax: params.rMax,
        organic: params,
    };

    const actions = {
        setNumParticles(n) {
            sim.randomize(n, rules.numTypes);
        },
        setNumTypes(n) {
            rules.resize(n, Math.random, params.ruleGenerator);
            palette = createPalette(n);
            sim.setRules(rules);
            rulesDirty = false;
            sim.assignTypes(n);
            matrix.rebuild(rules, palette);
            ui?.markCustom();
        },
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
            rules.randomize(Math.random, params.ruleGenerator);
            matrix.refresh();
            rulesEdited();
        },
        zeroRules() {
            rules.zero();
            matrix.refresh();
            rulesEdited();
        },
        async copyRules() {
            await copyText(formatRules(rules)); // no clipboard access (insecure context): logged to the console
        },
        async shareLink() {
            const url = shareUrl(params, rules);
            if (!(await copyText(url))) window.prompt('Share link', url);
        },
        resetSettings() {
            keepSettings = false; // the reload must not save the current values again
            settings.clear();
            location.reload();
        },
        resetParticles() {
            sim.randomize(sim.count, rules.numTypes);
        },
        setMatrixVisible(visible) {
            matrix.setVisible(visible);
        },
    };

    ui = createGUI(params, actions, { advanced, preset: initialPreset?.name });
    ui.gui.domElement.addEventListener('change', saveSettings); // every committed edit in the panel

    function frame(now) {
        if (!alive) return;
        requestAnimationFrame(frame);

        const t0 = performance.now();
        if (rulesDirty) {
            sim.setRules(rules);
            rulesDirty = false;
        }
        view.palette = palette;
        view.particleRadius = params.particleRadius;
        view.trails = params.trails;
        view.pointerRadius = params.pointerRadius;
        view.rMax = params.rMax;

        const encoder = device.createCommandEncoder({ label: 'frame' });
        sim.encode(encoder, {
            params,
            pointer,
            steps: params.running ? params.substeps : 0,
            timestampWrites: timer?.simWrites(),
        });
        renderer.draw(encoder, sim, view, timer ?? undefined);
        const slot = timer ? timer.resolve(encoder) : null;
        device.queue.submit([encoder.finish()]);
        if (slot) timer.collect(slot).then(() => stats.recordGpu(timer.simMs, timer.drawMs));

        if (stats) {
            const g = sim.grid;
            stats.recordCpu(performance.now() - t0);
            stats.tick(now, sim.count, `cells     ${g.nx}x${g.ny} (±${g.reach})`);
        }
    }
    requestAnimationFrame(frame);
}

main().catch((e) => {
    console.error(e);
    showUnsupported(String(e?.message ?? e), 'error');
});
