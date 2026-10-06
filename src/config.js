// Default parameters. World units: height = 1 (width = canvas aspect ratio); time in simulation seconds.

export const defaults = Object.freeze({
    numParticles: 60000,     // GPU version (the CPU version used 3000)
    numTypes: 6,

    // force model
    rMax: 0.03,              // interaction radius (keep N * rMax^2 ~ 30: same neighbour density as the CPU default 3000 / 0.1)
    beta: 0.3,               // fraction of rMax that is universal repulsion
    forceFactor: 10,
    frictionHalfLife: 0.04,  // seconds for velocity to halve

    // limits for structures (clusters) made of particles
    limitSpeed: true,
    maxSpeed: 0.3,           // world units / second (world height = 1)
    limitPressure: true,
    restDensity: 20,         // weighted neighbour count sum (1 - r/rMax)^2 above which pressure pushes back
    pressureStrength: 0.005,  // pressure force relative to the rule forces (0 = off)
    viscosity: 0,            // extra damping of the relative velocity between compressed neighbours (0 = off; costs a velocity read)

    // time stepping
    dt: 0.01,                // fixed step per substep
    substeps: 1,             // steps per rendered frame
    running: true,

    // performance
    cellsPerRMax: 2,         // grid cells per rMax (1 = classic 3x3 search; 2 scans ~40% fewer pairs)

    // pointer interaction
    pointerRadius: 0.15,
    pointerStrength: 5,      // peak accel = pointerStrength * forceFactor (stays strong vs particle forces)

    // display
    particleRadius: 0.2,     // CSS px
    trails: false,
    showMatrix: true,

    // organic rendering (docs/organic-rendering-spec.md). The field reads 1 at the mean density; thresholds are tuned to its measured density
    renderMode: 'organic',   // 'dots' | 'organic'
    organicStyle: 'glass',   // 'glass' | 'cell' | 'glow' | 'bands' | 'mono'
    fieldScale: 0.5,         // field resolution / canvas
    splatRadius: 0.5,        // x rMax
    fieldGain: 1,
    blurSmall: 0.15,         // x rMax, Gaussian sigma of the "disk" blur
    blurLarge: 0.45,         // x rMax, Gaussian sigma of the "ring" blur
    speciesTint: 0.3,        // how much of the particle-type colour is mixed into the style colours
    glowIntensity: 1,
    bandFreq: 25,            // bands: phase = bandFreq * r^3
    bandBase: 0.24,          // bands: r of empty space (phase 0.35 = light blue)
    threshold: 1.5,          // cell/glow/mono: density (x mean) below which is empty; drops ~90% of the gas clumps
    nucleusThreshold: 0.7,   // cell: large-blur occupancy (0..1) where the nucleus starts
    coreThreshold: 0.8,      // glass: compressed density (0..1) where the core starts (~4.6 x mean)
    rimStrength: 1.3,        // glass: membrane line width / opacity
    showParticles: false,    // faint dots on top of the organic look
});

/** The live (mutable) params object. */
export function createParams() {
    return { ...defaults };
}
