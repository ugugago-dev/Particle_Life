// Wiring only: WebGPU init, simulation (compute), renderer, input and UI, then the rAF loop.
// The simulation state lives entirely on the GPU; the frame loop never reads it back.
// If WebGPU is unavailable a centered message is shown and nothing else runs (no CPU fallback).

import { createParams } from './config.js';
import { RuleMatrix } from './rules.js';
import { createPalette } from './palette.js';
import { createInput } from './input.js';
import { MatrixEditor } from './ui/matrixEditor.js';
import { StatsOverlay } from './ui/stats.js';
import { requestGPU, configureCanvas, showUnsupported } from './gpu/device.js';
import { GpuSimulation } from './gpu/simulation.js';
import { GpuRenderer } from './gpu/renderer.js';
import { GpuTimer } from './gpu/timer.js';

async function main() {
    const canvas = document.querySelector('#canvas');

    // ---- WebGPU init (failure -> message + stop)
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
    const timer = new GpuTimer(device);

    // ---- state
    const params = createParams();
    const rules = new RuleMatrix(params.numTypes);
    const { pointer } = createInput(canvas);
    const stats = new StatsOverlay(timer.enabled);
    let palette = createPalette(params.numTypes);
    let rulesDirty = true; // re-upload the rule matrix before the next frame

    // ---- layout: world width follows the canvas aspect ratio (height is always 1)
    function resize() {
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;
        if (cssW === 0 || cssH === 0) return;
        renderer.resize(cssW, cssH, window.devicePixelRatio || 1);
        sim.setWorld(cssW / cssH, 1); // wraps existing particles on the GPU; the grid follows on the next step
    }
    new ResizeObserver(resize).observe(canvas);
    window.addEventListener('resize', resize); // also fires when browser zoom changes devicePixelRatio

    sim.setRules(rules);
    rulesDirty = false;
    resize();
    sim.randomize(params.numParticles, rules.numTypes);

    const matrix = new MatrixEditor(document.body, rules, palette, () => { rulesDirty = true; });
    matrix.setVisible(params.showMatrix);

    // Reused every frame (no per-frame allocation); mutated from params / palette.
    const view = {
        palette,
        particleRadius: params.particleRadius,
        trails: params.trails,
        pointer,
        pointerRadius: params.pointerRadius,
        rMax: params.rMax,
        maxSpeed: params.maxSpeed,
        restDensity: params.restDensity,
        organic: params, // renderMode / fieldScale / splatRadius ... (config.js の Organic 項目)
    };

    const actions = {
        setNumParticles(n) {
            sim.randomize(n, rules.numTypes);
        },
        setNumTypes(n) {
            rules.resize(n);
            palette = createPalette(n);
            sim.setRules(rules);
            rulesDirty = false;
            sim.assignTypes(n);
            matrix.rebuild(rules, palette);
        },
        randomizeRules() {
            rules.randomize();
            matrix.refresh();
            rulesDirty = true;
        },
        zeroRules() {
            rules.zero();
            matrix.refresh();
            rulesDirty = true;
        },
        resetParticles() {
            sim.randomize(sim.count, rules.numTypes);
        },
        setMatrixVisible(visible) {
            matrix.setVisible(visible);
        },
    };

    // lil-gui comes from a CDN: load it last so a network problem cannot hide the WebGPU message.
    try {
        const { createGUI } = await import('./ui/gui.js');
        createGUI(params, actions);
    } catch (e) {
        console.error('lil-gui could not be loaded (offline?). Running without the control panel.', e);
    }

    // ---- main loop
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
        view.maxSpeed = params.maxSpeed;
        view.restDensity = params.restDensity;

        const encoder = device.createCommandEncoder({ label: 'frame' });
        sim.encode(encoder, {
            params,
            pointer,
            steps: params.running ? params.substeps : 0,
            needDensity: params.renderMode === 'organic',   // organic の splat が density を読む
            timestampWrites: timer.simWrites(),
        });
        renderer.draw(encoder, sim, view, timer);
        const slot = timer.resolve(encoder);
        device.queue.submit([encoder.finish()]);
        if (slot) timer.collect(slot).then(() => stats.recordGpu(timer.simMs, timer.drawMs));
        stats.recordCpu(performance.now() - t0);

        const g = sim.grid;
        stats.tick(now, sim.count, `cells     ${g.nx}x${g.ny} (±${g.reach})`);
    }
    requestAnimationFrame(frame);
}

main().catch((e) => {
    console.error(e);
    showUnsupported(String(e?.message ?? e), 'error');
});
