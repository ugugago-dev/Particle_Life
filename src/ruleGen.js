// Random rule matrices. 'uniform' = every entry in [-1, 1] (the classic Particle Life). 'lifelike' = built from motifs
// that tend to make cell-like bodies, membranes and things that swim, instead of one big blob or a gas. 'strong' = lifelike with
// every value pushed toward ±1 (smaller, tighter cells) (docs/rule-generation-spec.md)

export const RULE_GENERATORS = ['lifelike', 'strong', 'uniform'];
export const DEFAULT_RULE_EXPONENT = 3;

const NOISE = 0.1;            // |value| of the background entries (pairs without a motif)
const STEP = 0.05;            // values are rounded to this so copied rules stay readable

// role of a type, from its self-interaction. At least one 'body' is forced
const ROLES = [
    { role: 'body', p: 0.6, self: [0.4, 0.9] },     // sticks to itself: the cytoplasm / nucleus of a cell
    { role: 'shell', p: 0.3, self: [-0.4, 0.05] },  // does not stick to itself: spreads as a layer around what it likes
    { role: 'drifter', p: 0.1, self: [-0.2, 0.25] },
];

// what a pair (a, b) does; directed ones pick their direction at random
const MOTIFS = [
    { motif: 'none', p: 0.28 },
    { motif: 'coat', p: 0.3 },    // a coats b: a -> b attract, b -> a weak (a membrane when b is a body)
    { motif: 'chase', p: 0.26 },   // a chases b, b runs from a: a pair that moves (swimming)
    { motif: 'avoid', p: 0.16 },   // both repel: keeps bodies apart (separate cells instead of one blob)
];

const CHAIN_P = 0.4;          // chance of a directed cycle c0 -> c1 -> ... (worms, rotating rings)

function pick(table, rng) {
    let r = rng();
    for (const e of table) {
        if ((r -= e.p) < 0) return e;
    }
    return table[table.length - 1];
}

const between = (rng, [lo, hi]) => lo + (hi - lo) * rng();

// 'strong': every motif / role value is pushed toward ±1. |v| = 1 - (1 - u)^exponent (exponent 3: about half of all entries are
// 0.7..1), never below the weaker end of a one-signed range; the sign is the sign of the range's stronger end
function exaggerated(exponent) {
    return (rng, [lo, hi]) => {
        const strongEnd = Math.abs(lo) > Math.abs(hi) ? lo : hi;
        const minMag = Math.sign(lo) === Math.sign(hi) ? Math.min(Math.abs(lo), Math.abs(hi)) : 0;
        return (Math.sign(strongEnd) || 1) * Math.max(1 - Math.pow(1 - rng(), exponent), minMag);
    };
}
const quantize = (v) => Math.max(-1, Math.min(1, Math.round(v / STEP) * STEP));

function shuffled(n, rng) {
    const a = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * @param {number} n number of types
 * @param {() => number} [rng]
 * @param {number} [exponent] 0 = lifelike, > 0 = strong with this exponent
 * @returns {Float32Array} n x n, row i = how type i reacts to each type j
 */
export function lifelikeRules(n, rng = Math.random, exponent = 0) {
    const value = exponent > 0 ? exaggerated(exponent) : between;
    const m = new Float32Array(n * n);
    const set = (i, j, v) => { m[i * n + j] = v; };
    for (let k = 0; k < m.length; k++) m[k] = (rng() * 2 - 1) * NOISE;

    const roles = Array.from({ length: n }, () => pick(ROLES, rng));
    if (!roles.some((r) => r.role === 'body')) roles[Math.floor(rng() * n)] = ROLES[0];
    roles.forEach((r, i) => set(i, i, value(rng, r.self)));

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const [a, b] = rng() < 0.5 ? [i, j] : [j, i];
            switch (pick(MOTIFS, rng).motif) {
                case 'coat': {
                    // the non-body one coats the body one when there is a choice
                    const [s, t] = roles[a].role === 'body' && roles[b].role !== 'body' ? [b, a] : [a, b];
                    set(s, t, value(rng, [0.4, 0.85]));
                    set(t, s, value(rng, [-0.1, 0.3]));
                    break;
                }
                case 'chase':
                    set(a, b, value(rng, [0.3, 0.8]));
                    set(b, a, -value(rng, [0.2, 0.7]));
                    break;
                case 'avoid':
                    set(a, b, -value(rng, [0.2, 0.6]));
                    set(b, a, -value(rng, [0.2, 0.6]));
                    break;
                default:
                    break;
            }
        }
    }

    if (n >= 3 && rng() < CHAIN_P) {
        const len = Math.min(n, 3 + Math.floor(rng() * 3));
        const c = shuffled(n, rng).slice(0, len);
        for (let k = 0; k < len; k++) {
            const a = c[k], b = c[(k + 1) % len];
            set(a, b, value(rng, [0.5, 0.9]));
            set(b, a, value(rng, [-0.4, 0]));
        }
    }

    for (let k = 0; k < m.length; k++) m[k] = quantize(m[k]);
    return m;
}

/** @returns {Float32Array} n x n, every entry uniform in [-1, 1] */
export function uniformRules(n, rng = Math.random) {
    return Float32Array.from({ length: n * n }, () => rng() * 2 - 1);
}

/**
 * @param {'lifelike' | 'strong' | 'uniform'} kind unknown names fall back to 'lifelike'
 * @param {number} [exponent] 'strong' only: larger = more entries near ±1 (1 = uniform magnitudes)
 */
export function generateRules(kind, n, rng = Math.random, exponent = DEFAULT_RULE_EXPONENT) {
    if (kind === 'uniform') return uniformRules(n, rng);
    return lifelikeRules(n, rng, kind === 'strong' ? Math.max(exponent, 1) : 0);
}
