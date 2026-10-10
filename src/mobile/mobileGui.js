const LIL_GUI_URL = 'https://cdn.jsdelivr.net/npm/lil-gui@0.20/+esm';

/**
 * スマホ版の調整 GUI (?advanced のときだけ呼ぶ)。読み込みに失敗したら null。
 * @param {object} params
 * @param {{
 *   setNumParticles: (n: number) => void,
 *   setNumTypes: (n: number) => void,
 *   recomputeRMax: () => void,
 *   resetParticles: () => void,
 *   copyRules: () => void,
 * }} actions
 */
export async function createMobileGUI(params, actions) {
    let GUI;
    try {
        ({ default: GUI } = await import(LIL_GUI_URL));
    } catch (err) {
        console.error('[mobile GUI] lil-gui を読み込めませんでした', err);
        return null;
    }

    const gui = new GUI({ title: 'Particle Life (Mobile)' });
    gui.close();

    // on release, so dragging does not rebuild every frame
    gui.add(params, 'numParticles', 500, 20000, 500).onFinishChange(actions.setNumParticles);
    gui.add(params, 'numTypes', 1, 12, 1).onFinishChange(actions.setNumTypes);
    gui.add(params, 'rMax', 0.02, 0.25, 0.0025);
    gui.add({ run: actions.recomputeRMax }, 'run').name('Recompute rMax');
    gui.add({ run: actions.resetParticles }, 'run').name('Reset particles');
    gui.add(params, 'forceFactor', 0.5, 40, 0.5);
    gui.add(params, 'frictionHalfLife', 0.005, 0.3, 0.005);
    gui.add(params, 'dt', 0.001, 0.03, 0.001);
    gui.add(params, 'substeps', 1, 4, 1);
    gui.add(params, 'particleRadius', 0.5, 6, 0.1).name('particleRadius (px)');
    gui.add(params, 'trails');
    gui.add(params, 'pointerRadius', 0.02, 0.5, 0.005);
    gui.add(params, 'pointerStrength', 0, 20, 0.1);
    gui.add(params, 'limitPressure').name('limit compression');
    gui.add(params, 'pressureStrength', 0, 2, 0.01);
    gui.add(params, 'viscosity', 0, 5, 0.1);
    gui.add({ run: actions.copyRules }, 'run').name('Copy rules');

    return gui;
}
