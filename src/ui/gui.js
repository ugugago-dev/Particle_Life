import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.20/+esm';

/**
 * Build the lil-gui panel. It edits `params` directly (the live params object)
 * and calls `actions` for anything that needs more than a value change.
 *
 * @param {object} params live params object (see config.js)
 * @param {{
 *   setNumParticles: (n: number) => void,
 *   setNumTypes: (n: number) => void,
 *   randomizeRules: () => void,
 *   resetParticles: () => void,
 *   zeroRules: () => void,
 *   setMatrixVisible: (visible: boolean) => void,
 * }} actions
 */
export function createGUI(params, actions) {
    const gui = new GUI({ title: 'Particle Life' });

    const sim = gui.addFolder('Simulation');
    sim.add(params, 'running');
    sim.add(params, 'rMax', 0.005, 0.25, 0.0025);
    sim.add(params, 'beta', 0.05, 0.95, 0.01);
    sim.add(params, 'forceFactor', 0.5, 40, 0.5);
    sim.add(params, 'frictionHalfLife', 0.005, 0.3, 0.005);
    sim.add(params, 'dt', 0.001, 0.03, 0.001);
    sim.add(params, 'substeps', 1, 10, 1);
    sim.add(params, 'cellsPerRMax', 1, 3, 1).name('cells / rMax');

    const limits = gui.addFolder('Limits');
    limits.add(params, 'limitSpeed').name('limit speed');
    limits.add(params, 'maxSpeed', 0.02, 2, 0.01);
    limits.add(params, 'limitPressure').name('limit compression');
    limits.add(params, 'restDensity', 0, 40, 0.5);
    limits.add(params, 'pressureStrength', 0, 2, 0.01);
    limits.add(params, 'viscosity', 0, 5, 0.1);

    const world = gui.addFolder('Particles');
    // Re-initialise on release so dragging the slider does not rebuild every frame.
    world.add(params, 'numParticles', 1000, 500000, 1000).onFinishChange(actions.setNumParticles);
    world.add(params, 'numTypes', 1, 12, 1).onFinishChange(actions.setNumTypes);

    const pointer = gui.addFolder('Pointer');
    pointer.add(params, 'pointerRadius', 0.02, 0.5, 0.005);
    pointer.add(params, 'pointerStrength', 0, 20, 0.1);

    const display = gui.addFolder('Display');
    display.add(params, 'particleRadius', 0.5, 6, 0.1).name('particleRadius (px)');
    display.add(params, 'trails');
    display.add(params, 'showMatrix').name('Show matrix').onChange(actions.setMatrixVisible);

    const buttons = gui.addFolder('Actions');
    buttons.add({ run: actions.randomizeRules }, 'run').name('Randomize rules');
    buttons.add({ run: actions.resetParticles }, 'run').name('Reset particles');
    buttons.add({ run: actions.zeroRules }, 'run').name('Zero rules');

    return gui;
}
