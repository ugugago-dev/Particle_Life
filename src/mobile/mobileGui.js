import { Panel } from '../ui/panel.js';
import { RULE_GENERATORS } from '../ruleGen.js';

/**
 * スマホ版の調整パネル (?advanced のときだけ呼ぶ)。
 * @param {object} params
 * @param {{
 *   setNumParticles: (n: number) => void,
 *   setNumTypes: (n: number) => void,
 *   recomputeRMax: () => void,
 *   resetParticles: () => void,
 *   copyRules: () => void,
 * }} actions
 */
export function createMobileGUI(params, actions) {
    const gui = new Panel({ title: 'Particle Life (Mobile)', closed: true });

    // on release, so dragging does not rebuild every frame
    gui.add(params, 'numParticles', 500, 20000, 500).onFinishChange(actions.setNumParticles);
    gui.add(params, 'numTypes', 1, 12, 1).onFinishChange(actions.setNumTypes);
    gui.add(params, 'ruleGenerator', RULE_GENERATORS).name('random rules');
    gui.add(params, 'ruleExponent', 1, 6, 0.5).name('strength (^n)');
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
