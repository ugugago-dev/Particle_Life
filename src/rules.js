// data[i * numTypes + j] in [-1, 1]: how strongly type i is attracted (+) / repelled (-) by type j

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class RuleMatrix {
    constructor(numTypes, rng = Math.random) {
        this.numTypes = 0;
        this.data = new Float32Array(0);
        this.resize(numTypes, rng);
    }

    get(i, j) {
        return this.data[i * this.numTypes + j];
    }

    set(i, j, value) {
        const k = i * this.numTypes + j;
        this.data[k] = clamp(value, -1, 1);
        return this.data[k];
    }

    randomize(rng = Math.random) {
        const d = this.data;
        for (let k = 0; k < d.length; k++) d[k] = rng() * 2 - 1;
    }

    zero() {
        this.data.fill(0);
    }

    /** Keeps the overlapping top-left block; new entries are random. */
    resize(numTypes, rng = Math.random) {
        const old = this.data;
        const oldN = this.numTypes;
        const data = new Float32Array(numTypes * numTypes);
        for (let i = 0; i < numTypes; i++) {
            for (let j = 0; j < numTypes; j++) {
                data[i * numTypes + j] =
                    i < oldN && j < oldN ? old[i * oldN + j] : rng() * 2 - 1;
            }
        }
        this.numTypes = numTypes;
        this.data = data;
    }
}
