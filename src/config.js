// Default parameters: the single source of truth.
// Units: the world is `height = 1` (width = canvas aspect ratio). Distances,
// rMax and pointerRadius are in world units; time is in simulation seconds.

export const defaults = Object.freeze({
    // particles / rules
    numParticles: 30000,     // GPU version (the CPU version used 3000)
    numTypes: 6,

    // force model
    rMax: 0.03,              // interaction radius (keep N * rMax^2 ~ 30: same neighbour density as the CPU default 3000 / 0.1)
    beta: 0.3,               // fraction of rMax that is universal repulsion
    forceFactor: 10,
    frictionHalfLife: 0.04,  // seconds for velocity to halve

    // time stepping
    dt: 0.01,                // fixed step per substep
    substeps: 1,             // steps per rendered frame
    running: true,

    // pointer interaction
    pointerRadius: 0.15,
    pointerStrength: 5,      // peak accel = pointerStrength * forceFactor (stays strong vs particle forces)

    // display
    particleRadius: 1.5,     // CSS px
    trails: false,
    showMatrix: true,
});

/** Fresh mutable copy of the defaults (the live params object). */
export function createParams() {
    return { ...defaults };
}
