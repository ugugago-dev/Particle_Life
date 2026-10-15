// src/ruleGen.js / src/rules.js / src/share.js / src/settings.js の Node テスト。依存なし: node tests/rules.test.mjs

import { lifelikeRules, uniformRules, generateRules } from '../src/ruleGen.js';
import { RuleMatrix } from '../src/rules.js';
import { encodeRules, decodeRules, applyStyleQuery, shareUrl } from '../src/share.js';
import { createParams, defaults } from '../src/config.js';

let failures = 0;
function check(cond, msg) {
    if (cond) return;
    failures++;
    console.error(`FAIL: ${msg}`);
}

function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 1. lifelike: 範囲・0.05 刻み・少なくとも 1 種類は自分に引かれる・同じ seed で同じ値
for (let n = 1; n <= 12; n++) {
    for (let seed = 0; seed < 50; seed++) {
        const m = lifelikeRules(n, makeRng(seed));
        check(m.length === n * n, `lifelike n=${n}: length ${m.length}`);
        check(m.every((v) => v >= -1 && v <= 1), `lifelike n=${n} seed=${seed}: out of range`);
        check(m.every((v) => Math.abs(v * 20 - Math.round(v * 20)) < 1e-4), `lifelike n=${n} seed=${seed}: not on the 0.05 grid`);
        let body = false;
        for (let i = 0; i < n; i++) body ||= m[i * n + i] >= 0.4 - 1e-6;
        check(body, `lifelike n=${n} seed=${seed}: no self-attracting type`);
    }
    const a = lifelikeRules(n, makeRng(7)), b = lifelikeRules(n, makeRng(7));
    check(a.every((v, k) => v === b[k]), `lifelike n=${n}: not deterministic for a seed`);
}

// 2. 統計: lifelike は uniform より対角が正に寄り、絶対値の小さい (動機の無い) 成分が多い
{
    let diagL = 0, diagU = 0, smallL = 0, smallU = 0, cnt = 0, off = 0;
    const n = 6;
    for (let seed = 0; seed < 400; seed++) {
        const L = lifelikeRules(n, makeRng(seed)), U = uniformRules(n, makeRng(seed));
        for (let i = 0; i < n; i++) {
            diagL += L[i * n + i];
            diagU += U[i * n + i];
            cnt++;
            for (let j = 0; j < n; j++) {
                if (i === j) continue;
                off++;
                if (Math.abs(L[i * n + j]) <= 0.1 + 1e-6) smallL++;
                if (Math.abs(U[i * n + j]) <= 0.1) smallU++;
            }
        }
    }
    check(diagL / cnt > 0.25, `lifelike mean self-interaction ${diagL / cnt}`);
    check(Math.abs(diagU / cnt) < 0.1, `uniform mean self-interaction ${diagU / cnt}`);
    check(smallL / off > 2 * (smallU / off), `lifelike small entries ${smallL / off} vs uniform ${smallU / off}`);
}

// 2b. strong: 構造は lifelike と同じ (同じ seed で符号が同じ) で、絶対値が大きい。指数が大きいほど ±1 に寄る
{
    const n = 6;
    const big = (m) => m.filter((v) => Math.abs(v) >= 0.7 - 1e-6).length / m.length;
    let fL = 0, f2 = 0, f3 = 0, f6 = 0, signDiff = 0, cnt = 0;
    for (let seed = 0; seed < 300; seed++) {
        const L = lifelikeRules(n, makeRng(seed));
        const S3 = generateRules('strong', n, makeRng(seed), 3);
        fL += big(L);
        f2 += big(generateRules('strong', n, makeRng(seed), 2));
        f3 += big(S3);
        f6 += big(generateRules('strong', n, makeRng(seed), 6));
        check(S3.every((v) => v >= -1 && v <= 1 && Math.abs(v * 20 - Math.round(v * 20)) < 1e-4), `strong seed=${seed}: range / grid`);
        for (let k = 0; k < L.length; k++) {
            // 背景 (±0.1) 以外で符号が逆になる成分は無い (弱い向きの成分は強い端の符号になるので 0 をまたぐことはある)
            if (Math.abs(L[k]) >= 0.3 && Math.abs(S3[k]) >= 0.3 && Math.sign(L[k]) !== Math.sign(S3[k])) signDiff++;
            cnt++;
        }
    }
    check(f3 / 300 > 0.4 && f3 > 2 * fL, `strong ^3 share of |v| >= 0.7: ${(f3 / 300).toFixed(2)} vs lifelike ${(fL / 300).toFixed(2)}`);
    check(f2 < f3 && f3 < f6, `exponent order ${f2} ${f3} ${f6}`);
    check(signDiff / cnt < 0.02, `strong flipped signs: ${signDiff}/${cnt}`);
    check(generateRules('strong', 4, makeRng(5)).every((v, k) => v === generateRules('strong', 4, makeRng(5), 3)[k]), 'strong default exponent is 3');
}

// 3. generateRules: 未知の名前は lifelike
check(generateRules('???', 4, makeRng(3)).every((v, k) => v === lifelikeRules(4, makeRng(3))[k]), 'unknown generator is not lifelike');

// 4. RuleMatrix: randomize は配列を差し替えない、resize は左上を残す
{
    const r = new RuleMatrix(4, makeRng(1));
    const data = r.data;
    r.randomize(makeRng(2), 'lifelike');
    check(r.data === data, 'randomize replaced the data array');
    const before = Array.from(r.data);
    r.resize(6, makeRng(3), 'lifelike');
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) check(r.get(i, j) === before[i * 4 + j], `resize up lost (${i}, ${j})`);
    r.resize(3);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) check(r.get(i, j) === before[i * 4 + j], `resize down lost (${i}, ${j})`);
}

// 5. 共有リンクの行列: 0.01 単位で往復する、壊れた文字列は null
for (const n of [1, 3, 6, 12, 16]) {
    const r = new RuleMatrix(n, makeRng(n));
    const rows = decodeRules(encodeRules(r));
    check(rows && rows.length === n, `decode n=${n}: ${rows?.length}`);
    if (rows) {
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) check(Math.abs(rows[i][j] - r.get(i, j)) <= 0.005 + 1e-6, `roundtrip n=${n} (${i}, ${j})`);
    }
}
check(decodeRules('abc') === null, 'non-square accepted');
check(decodeRules('!!!') === null, 'invalid base64 accepted');
check(decodeRules('') === null, 'empty accepted');

// 6. ?style と共有リンク
{
    const p = createParams();
    check(!applyStyleQuery(p, new URLSearchParams('style=nope')) && p.organicStyle === defaults.organicStyle, 'bad style applied');
    check(applyStyleQuery(p, new URLSearchParams('style=glass')) && p.renderMode === 'organic' && p.organicStyle === 'glass', 'style=glass');
    check(applyStyleQuery(p, new URLSearchParams('style=dots')) && p.renderMode === 'dots', 'style=dots');
    const r = new RuleMatrix(5, makeRng(9));
    const url = new URL(shareUrl(p, r, 'https://example.com/pl/index.html?advanced&preset=2&foo=1#x'));
    check(url.pathname === '/pl/index.html' && url.hash === '', `share url path ${url}`);
    check(url.searchParams.has('advanced') && !url.searchParams.has('preset') && !url.searchParams.has('foo'), `share url query ${url.search}`);
    check(url.searchParams.get('style') === 'dots', `share url style ${url.search}`);
    check(decodeRules(url.searchParams.get('rules'))?.length === 5, 'share url rules');
    check(/^\?advanced&/.test(url.search), `share url keeps bare ?advanced: ${url.search}`);
}

// 7. 設定の保存 (localStorage の代わりの Map)
{
    const mem = new Map();
    globalThis.localStorage = {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
        removeItem: (k) => mem.delete(k),
    };
    const { createSettingsStore } = await import('../src/settings.js');
    const store = createSettingsStore('t', ['organicStyle', 'trails', 'numTypes', 'ruleGenerator']);
    const p = createParams();
    store.save(p);
    check(!mem.has('t'), 'defaults were stored');
    p.organicStyle = 'glass';
    p.numTypes = 9;
    p.rMax = 0.2; // not in the kept list
    store.save(p);
    check(JSON.parse(mem.get('t')).numTypes === 9 && !('rMax' in JSON.parse(mem.get('t'))), `stored ${mem.get('t')}`);
    const q = createParams();
    store.load(q);
    check(q.organicStyle === 'glass' && q.numTypes === 9 && q.rMax === defaults.rMax, 'load');
    mem.set('t', JSON.stringify({ organicStyle: 'glow', trails: 'yes', numTypes: null, ruleGenerator: 'uniform' }));
    const z = createParams();
    store.load(z);
    check(z.organicStyle === defaults.organicStyle && z.trails === defaults.trails && z.numTypes === defaults.numTypes, 'invalid values loaded');
    check(z.ruleGenerator === 'uniform', 'valid value skipped');
    mem.set('t', '{broken');
    store.load(createParams()); // must not throw
    store.clear();
    check(!mem.has('t'), 'clear');
}

if (failures) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
}
console.log('rules tests passed');
