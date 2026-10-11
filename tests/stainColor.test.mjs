// src/stainColor.js の Node テスト。依存なし: node tests/stainColor.test.mjs

import { SCOPE_BG, stainColor, stainTransmit, buildStainTables, toOklab } from '../src/stainColor.js';
import { createPalette } from '../src/palette.js';

let failures = 0;
function check(cond, msg) {
    if (cond) return;
    failures++;
    console.error(`FAIL: ${msg}`);
}

const srgbToLinear = (c) => (c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92);
const lab = (rgb) => toOklab(rgb.map(srgbToLinear));
const colorOf = (pal, i) => [pal.rgb[i * 3], pal.rgb[i * 3 + 1], pal.rgb[i * 3 + 2]];
const hueDiff = (a, b) => Math.abs(((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);

// 1. 全 N で範囲に収まる / 色相が保たれる
let worstHue = 0;
for (let n = 1; n <= 16; n++) {
    const pal = createPalette(n);
    const { stain, transmit } = buildStainTables(pal.rgb, n);
    for (let i = 0; i < 16 * 4; i++) {
        check(stain[i] >= 0 && stain[i] <= 1, `N=${n}: stain[${i}] = ${stain[i]} out of range`);
        check(transmit[i] >= 0 && transmit[i] <= 1, `N=${n}: transmit[${i}] = ${transmit[i]} out of range`);
    }
    for (let i = 0; i < 16; i++) {
        check(stain[i * 4 + 3] === 0 && transmit[i * 4 + 3] === 0, `N=${n}: w != 0 at ${i}`);
        if (i >= n) {
            for (let c = 0; c < 3; c++) check(stain[i * 4 + c] === stain[(n - 1) * 4 + c], `N=${n}: padding ${i} != last`);
        }
    }
    for (let t = 0; t < n; t++) {
        const c = colorOf(pal, t);
        const s = stainColor(c);
        for (let k = 0; k < 3; k++) {
            check(s[k] >= 0.03 - 1e-6 && s[k] <= 1, `N=${n} t=${t}: stain ${s[k]} out of [0.03, 1]`);
            check(Math.abs(stain[t * 4 + k] - s[k]) < 1e-6, `N=${n} t=${t}: table mismatch`);
        }
        const tr = stainTransmit(c);
        for (let k = 0; k < 3; k++) {
            check(Math.abs(tr[k] - Math.min(s[k] / SCOPE_BG[k], 1)) < 1e-9, `N=${n} t=${t}: transmit formula`);
            check(tr[k] > 0 && tr[k] <= 1, `N=${n} t=${t}: transmit ${tr[k]} out of range`);
        }
        const li = lab(c);
        const lo = lab(s);
        if (Math.hypot(li[1], li[2]) > 0.05 && Math.hypot(lo[1], lo[2]) > 0.02) {
            const d = hueDiff(Math.atan2(li[2], li[1]), Math.atan2(lo[2], lo[1]));
            worstHue = Math.max(worstHue, d);
            check(d < 0.2, `N=${n} t=${t}: hue moved ${((d * 180) / Math.PI).toFixed(1)} deg`);
        }
    }
}
console.log(`worst hue shift: ${((worstHue * 180) / Math.PI).toFixed(2)} deg`);

// 2. 種類間の最小 deltaE x100 が仕様書の値 (29 / 14 / 5) に近い
const expected = { 3: 29, 6: 14, 10: 5 };
for (const n of [3, 6, 10]) {
    const pal = createPalette(n);
    const labs = [];
    for (let t = 0; t < n; t++) labs.push(lab(stainColor(colorOf(pal, t))));
    let min = Infinity;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            min = Math.min(min, 100 * Math.hypot(labs[i][0] - labs[j][0], labs[i][1] - labs[j][1], labs[i][2] - labs[j][2]));
        }
    }
    console.log(`N=${n}: min pairwise deltaE x100 = ${min.toFixed(2)} (spec ${expected[n]})`);
    check(Math.abs(min - expected[n]) <= expected[n] * 0.3, `N=${n}: min deltaE x100 ${min.toFixed(2)} not within 30% of ${expected[n]}`);
}

if (failures) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
}
console.log('stainColor tests passed');
