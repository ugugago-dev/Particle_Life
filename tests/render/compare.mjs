#!/usr/bin/env node
// node tests/render/compare.mjs DIR_A DIR_B  -- per-PNG: identical? max / mean abs diff (RGB, 0..255), differing pixel %.
// Exit code 0 if every file is pixel-identical, 1 otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';

const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error('usage: compare.mjs DIR_A DIR_B'); process.exit(2); }
const list = (d) => fs.readdirSync(d).filter((f) => f.endsWith('.png')).sort();
const names = [...new Set([...list(a), ...list(b)])].sort();
let allSame = true;
for (const n of names) {
    const fa = path.join(a, n), fb = path.join(b, n);
    if (!fs.existsSync(fa) || !fs.existsSync(fb)) { console.log(`${n}: MISSING in ${fs.existsSync(fa) ? 'B' : 'A'}`); allSame = false; continue; }
    const A = decodePng(fs.readFileSync(fa)), B = decodePng(fs.readFileSync(fb));
    if (A.width !== B.width || A.height !== B.height) { console.log(`${n}: SIZE ${A.width}x${A.height} vs ${B.width}x${B.height}`); allSame = false; continue; }
    let max = 0, sum = 0, diffPx = 0;
    for (let i = 0; i < A.data.length; i += 4) {
        let px = 0;
        for (let c = 0; c < 3; c++) { const d = Math.abs(A.data[i + c] - B.data[i + c]); sum += d; if (d > max) max = d; if (d) px = 1; }
        diffPx += px;
    }
    const npx = A.width * A.height, same = max === 0;
    if (!same) allSame = false;
    console.log(`${n}: ${same ? 'IDENTICAL' : 'DIFFERENT'}  max=${max} mean=${(sum / (npx * 3)).toFixed(4)} diffPixels=${(100 * diffPx / npx).toFixed(2)}%`);
}
process.exit(allSame ? 0 : 1);
