// data[i * numTypes + j] in [-1, 1]: how strongly type i is attracted (+) / repelled (-) by type j

import { generateRules } from './ruleGen.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// `kind` ('uniform' | 'lifelike' | 'strong', see ruleGen.js) picks how random entries are made, `exponent` is for 'strong';
// the app passes params.ruleGenerator / params.ruleExponent
export class RuleMatrix {
    constructor(numTypes, rng = Math.random, kind = 'uniform', exponent = undefined) {
        this.numTypes = 0;
        this.data = new Float32Array(0);
        this.resize(numTypes, rng, kind, exponent);
    }

    get(i, j) {
        return this.data[i * this.numTypes + j];
    }

    set(i, j, value) {
        const k = i * this.numTypes + j;
        this.data[k] = clamp(value, -1, 1);
        return this.data[k];
    }

    randomize(rng = Math.random, kind = 'uniform', exponent = undefined) {
        this.data.set(generateRules(kind, this.numTypes, rng, exponent));
    }

    zero() {
        this.data.fill(0);
    }

    /** Replaces everything (numTypes included) with a square array of rows. */
    load(rows) {
        const n = rows.length;
        if (rows.some((row) => row.length !== n)) throw new Error('rule matrix must be square');
        this.numTypes = n;
        this.data = Float32Array.from(rows.flat(), (v) => clamp(v, -1, 1));
    }

    /** Keeps the overlapping top-left block; new entries are random. */
    resize(numTypes, rng = Math.random, kind = 'uniform', exponent = undefined) {
        const old = this.data;
        const oldN = Math.min(this.numTypes, numTypes);
        const data = numTypes > this.numTypes ? generateRules(kind, numTypes, rng, exponent) : new Float32Array(numTypes * numTypes);
        for (let i = 0; i < oldN; i++) {
            for (let j = 0; j < oldN; j++) data[i * numTypes + j] = old[i * this.numTypes + j];
        }
        this.numTypes = numTypes;
        this.data = data;
    }
}
