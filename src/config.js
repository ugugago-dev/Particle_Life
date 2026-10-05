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
});

/** Fresh mutable copy of the defaults (the live params object). */
export function createParams() {
    return { ...defaults };
}
