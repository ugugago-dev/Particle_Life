// Default parameters: the single source of truth.
// Units: the world is `height = 1` (width = canvas aspect ratio). Distances,
// rMax and pointerRadius are in world units; time is in simulation seconds.

export const defaults = Object.freeze({
    // particles / rules
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

    // organic rendering (screen-space density field; see docs/organic-rendering-spec.md)
    // The splatted field is normalised so that the world's mean density reads 1.0 (robust to N, canvas size, rMax);
    // fieldGain scales it. Blur radii are Gaussian sigmas in x rMax.
    // Thresholds are tuned to the measured density of the defaults above (60k particles, 16:9, 15 s of random rules):
    // the gas between structures is made of small clumps reading ~0.5-2 at splatRadius 0.5, structure cores read 5-25.
    renderMode: 'organic',   // 'dots' | 'organic'
    organicStyle: 'glass',   // 'glass' | 'cell' | 'glow' | 'bands' | 'mono'
    fieldScale: 0.5,         // field texture resolution relative to the canvas
    splatRadius: 0.5,        // x rMax
    fieldGain: 1,            // multiplier on the normalised field (all styles)
    blurSmall: 0.15,         // x rMax, the "disk" (small) blur
    blurLarge: 0.45,         // x rMax, the "ring" (large) blur (computed at reduced resolution when wide)
    speciesTint: 0.3,        // how much of the particle-type colour is mixed into the style colours (0 = none)
    glowIntensity: 1,        // glow: brightness of the outline
    bandFreq: 25,            // bands: sin(vec3(1,2,3) * bandFreq * r^3), r = bandBase + 0.8 * compressed density
    bandBase: 0.24,          // bands: r of empty space (st1's density_target); bandFreq * bandBase^3 ~ 0.35 = light blue
    threshold: 1.5,          // density (x mean) below which cell/glow/mono see "empty": drops ~90% of the gas clumps, keeps thin membranes partly
    nucleusThreshold: 0.7,   // cell: how full the large-blur neighbourhood must be (0..1) for the nucleus to start
    coreThreshold: 0.8,      // glass: compressed density (0..1) where the flat core starts (0.8 ~ 4.6 x mean at the fine splat; drops most gas clumps)
    rimStrength: 1.3,        // glass: thickness/opacity of the white membrane line
    showParticles: false,    // overlay the dots (faint) on top of the organic look
});

/** Fresh mutable copy of the defaults (the live params object). */
export function createParams() {
    return { ...defaults };
}
