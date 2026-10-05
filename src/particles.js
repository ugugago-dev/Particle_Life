// CPU-side particle state (Structure-of-Arrays typed arrays), used only to *initialise* the
// GPU buffers (the live state lives on the GPU: see gpu/simulation.js loadState). No DOM access.

/** @typedef {{width: number, height: number}} World */

/**
 * @typedef {object} ParticleState
 * @property {number} count
 * @property {Float32Array} x
 * @property {Float32Array} y
 * @property {Float32Array} vx
 * @property {Float32Array} vy
 * @property {Uint32Array} type
 */

/** World is `height = 1`; width follows the canvas aspect ratio. */
export function createWorld(width = 1) {
    return { width: Math.fround(width), height: 1 };
}

/** @returns {ParticleState} zero-initialised state */
export function alloc(count) {
    return {
        count,
        x: new Float32Array(count),
        y: new Float32Array(count),
        vx: new Float32Array(count),
        vy: new Float32Array(count),
        type: new Uint32Array(count),
    };
}

/**
 * Wrap `v` into [0, size). The result is also guaranteed to be representable
 * as float32 and strictly below `size` (a float32 store can round up to `size`).
 */
export function wrap(v, size) {
    if (v < 0 || v >= size) v -= size * Math.floor(v / size);
    const q = Math.fround(v);
    return q < size ? q : 0;
}

/** Uniform random positions, zero velocity, random types. */
export function randomize(state, world, numTypes, rng = Math.random) {
    const { count, x, y, vx, vy } = state;
    for (let i = 0; i < count; i++) {
        x[i] = wrap(rng() * world.width, world.width);
        y[i] = wrap(rng() * world.height, world.height);
        vx[i] = 0;
        vy[i] = 0;
    }
    assignTypes(state, numTypes, rng);
}

/** Re-roll the type of every particle (positions are kept). */
export function assignTypes(state, numTypes, rng = Math.random) {
    const { count, type } = state;
    for (let i = 0; i < count; i++) type[i] = Math.min(numTypes - 1, Math.floor(rng() * numTypes));
}
