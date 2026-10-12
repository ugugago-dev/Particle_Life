#!/usr/bin/env node
// Headless screenshot harness for the organic render styles (PC WebGPU + mobile WebGL2). No src/ changes needed.
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/render/shot.mjs [--out DIR] [--target pc|mobile|all]
//        [--steps N] [--preset 1..6] [--seed S] [--styles scope,glass,cell,dots] [--particles N] [--mobile-particles N] [--no-fixture] [--verbose]
//        [--set key=value,key=value]   (overrides render params on the live params object, e.g. --set scopeDensity=1)
//   node tests/render/compare.mjs DIR_A DIR_B   (pixel diff of two output dirs)
// Playwright is NOT a repo dependency: it is found via $PLAYWRIGHT_MODULE_DIR, /opt/node-tools/node_modules or `npm root -g`.
//
// Determinism: (1) Math.random is replaced by a seeded PRNG before any page script runs (particle init + palette),
// (2) requestAnimationFrame is replaced by a manual queue stepped from node, so exactly N frames (= N sim steps at
// substeps 1) run, (3) rules come from ?preset=K, (4) config.js is served with a one-line wrapper that exposes the live
// params object as window.__params (src/ on disk is untouched), (5) all styles are rendered from the SAME simulation state
// (sim paused, then only the render style param changes). WebGPU: the sim itself is NOT bit-reproducible on swiftshader (atomicAdd
// ordering in the cell binning, amplified chaotically), so the particle state after N steps is cached in tests/render/fixtures/*.bin
// (created automatically when missing, ~2 min) and injected into the posVel/meta buffers; delete the .bin or pass --no-fixture to regenerate.
// WebGPU swapchain presentation kills the device under swiftshader, so the PC canvas is redirected to a plain texture and read back. Mobile: the Worker sim is blocked so the synchronous
// CpuSimulation is used (the Worker version is asynchronous and therefore not reproducible).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { encodePng } from './png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadPlaywright() {
    const dirs = [process.env.PLAYWRIGHT_MODULE_DIR, root, '/opt/node-tools/node_modules'].filter(Boolean);
    try { dirs.push(execSync('npm root -g', { encoding: 'utf8' }).trim()); } catch { /* ignore */ }
    for (const d of dirs) {
        try { return createRequire(path.join(d, '/'))('playwright'); } catch { /* next */ }
    }
    throw new Error('playwright not found; set PLAYWRIGHT_MODULE_DIR to a node_modules dir containing it');
}

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    if (!process.argv[i].startsWith('--')) continue;
    const next = process.argv[i + 1];
    args[process.argv[i].slice(2)] = next === undefined || next.startsWith('--') ? 'true' : next;
}
const out = path.resolve(args.out ?? path.join(root, 'tests/render/out'));
const target = args.target ?? 'all';
const steps = Number(args.steps ?? 400);
const preset = Number(args.preset ?? 1);
const seed = Number(args.seed ?? 12345);
const styles = (args.styles ?? 'scope,glass,cell,dots').split(',');
const pcParticles = Number(args.particles ?? 10000); // 0 = config default (60000: ~1.6 s per step under swiftshader)
const mobileParticles = Number(args['mobile-particles'] ?? 5000);
const overrides = Object.fromEntries((args.set ?? '').split(',').filter(Boolean).map((kv) => {
    const [k, v] = kv.split('=');
    return [k, v === 'true' ? true : v === 'false' ? false : Number.isNaN(Number(v)) ? v : Number(v)];
}));
fs.mkdirSync(out, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wgsl': 'text/plain', '.json': 'application/json' };
const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const file = path.join(root, decodeURIComponent(u.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('404'); }
    let body = fs.readFileSync(file);
    if (u.pathname === '/src/config.js') {
        const src = body.toString();
        if (!src.includes('return { ...defaults };')) throw new Error('config.js createParams changed; update shot.mjs');
        // PC particle count / rMax are overridden here (no src hook exists); rMax keeps N * rMax^2 / A = 30 like mobile does
        const over = pcParticles ? `p.numParticles = ${pcParticles}; p.rMax = Math.sqrt(30 * (1280 / 720) / ${pcParticles});` : '';
        body = Buffer.from(src.replace('return { ...defaults };', `const p = { ...defaults }; ${over} window.__params = p; return p;`));
    }
    res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.end(body);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://localhost:${server.address().port}`;

const initScript = (seed) => {
    let s = seed >>> 0;
    Math.random = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    // Presenting a WebGPU swapchain loses the device under swiftshader ("A valid external Instance reference no longer exists"),
    // so the app renders into an ordinary texture instead and window.__readback() copies it out (also removes compositor timing).
    if (window.GPUCanvasContext) {
        let tex = null, dev = null, fmt = null;
        // the particle state buffers ('posVel A' = vec4f x,y,vx,vy ; 'meta A' = vec2u type,id), for window.__dumpState / __loadState
        const bufs = {};
        const createBuffer = GPUDevice.prototype.createBuffer;
        GPUDevice.prototype.createBuffer = function (d) { const b = createBuffer.call(this, d); if (d?.label === 'posVel A' || d?.label === 'meta A') bufs[d.label] = b; return b; };
        const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
        window.__dumpState = async () => {
            const out = [];
            for (const k of ['posVel A', 'meta A']) {
                const src = bufs[k], tmp = dev.createBuffer({ size: src.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                const enc = dev.createCommandEncoder(); enc.copyBufferToBuffer(src, 0, tmp, 0, src.size); dev.queue.submit([enc.finish()]);
                await tmp.mapAsync(GPUMapMode.READ); out.push(b64(new Uint8Array(tmp.getMappedRange().slice(0)))); tmp.destroy();
            }
            return out;
        };
        window.__loadState = (pv, meta) => {
            const dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
            dev.queue.writeBuffer(bufs['posVel A'], 0, dec(pv)); dev.queue.writeBuffer(bufs['meta A'], 0, dec(meta));
        };
        const configure = GPUCanvasContext.prototype.configure;
        GPUCanvasContext.prototype.configure = function (c) { dev = c.device; fmt = c.format; return configure.call(this, c); };
        GPUCanvasContext.prototype.getCurrentTexture = function () {
            const c = this.canvas;
            if (!tex || tex.width !== c.width || tex.height !== c.height) {
                tex = dev.createTexture({ label: 'harness canvas', size: [c.width, c.height], format: fmt, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
            }
            if (!window.__readback) {
                window.__sync = () => dev.queue.onSubmittedWorkDone();
                window.__readback = async () => {
                    const w = tex.width, h = tex.height, bpr = Math.ceil(w * 4 / 256) * 256;
                    const buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                    const enc = dev.createCommandEncoder();
                    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
                    dev.queue.submit([enc.finish()]);
                    await buf.mapAsync(GPUMapMode.READ);
                    const src = new Uint8Array(buf.getMappedRange()), out = new Uint8Array(w * h * 4), bgra = fmt.startsWith('bgra');
                    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                        const i = y * bpr + x * 4, o = (y * w + x) * 4;
                        out[o] = src[i + (bgra ? 2 : 0)]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + (bgra ? 0 : 2)]; out[o + 3] = 255;
                    }
                    buf.unmap(); buf.destroy();
                    let s = ''; for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
                    return { w, h, b64: btoa(s) };
                };
            }
            return tex;
        };
    }
    let q = []; let id = 0; let fake = 0; window.__rafCalls = 0;
    window.requestAnimationFrame = (cb) => { window.__rafCalls++; q.push([++id, cb]); return id; };
    window.cancelAnimationFrame = (i) => { q = q.filter((e) => e[0] !== i); };
    window.__sync ??= () => document.querySelector('#canvas')?.getContext('webgl2')?.finish(); // WebGL: drain queued frames (WebGPU overrides this)
    // WebGL: read the default framebuffer synchronously in the same task as the draw (the drawing buffer is cleared after compositing)
    window.__glReadback = () => {
        const g = document.querySelector('#canvas').getContext('webgl2'), w = g.drawingBufferWidth, h = g.drawingBufferHeight;
        const px = new Uint8Array(w * h * 4), out = new Uint8Array(w * h * 4);
        g.bindFramebuffer(g.FRAMEBUFFER, null);
        g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
        for (let y = 0; y < h; y++) { out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4); }
        for (let i = 3; i < out.length; i += 4) out[i] = 255;
        let s = ''; for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
        return { w, h, b64: btoa(s) };
    };
    window.__frames = (n) => { for (let i = 0; i < n; i++) { const cur = q; q = []; fake += 1000 / 60; for (const [, cb] of cur) cb(fake); } };
};

async function run(name, launchOpts, ctxOpts, url, abortPred) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.launch(launchOpts);
    const ctx = await browser.newContext({ ...ctxOpts, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const problems = [];
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`[${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
    await page.route((u) => !u.href.startsWith(base) || (abortPred && abortPred(u)), (r) => r.abort()); // offline: lil-gui CDN fails fast
    await page.addInitScript(initScript, seed);
    await page.goto(base + url);
    try {
        await page.waitForFunction(() => window.__params && window.__rafCalls > 0, null, { timeout: Number(args.timeout ?? 60000), polling: 200 });
    } catch {
        console.error(`${name}: app did not start. Page messages:\n${problems.join('\n')}\n${await page.evaluate(() => document.body.innerText).catch(() => '')}`);
        await browser.close();
        return false;
    }
    // hide the matrix editor / panels so only the canvas is captured
    await page.addStyleTag({ content: 'body > *:not(canvas):not(script){display:none !important}' });
    await page.evaluate(() => { window.__params.running = false; });
    const fixture = path.join(root, 'tests/render/fixtures', `${name}-p${preset}-n${pcParticles}-s${steps}-seed${seed}.bin`);
    const gpuState = name === 'pc' && pcParticles > 0;
    if (gpuState && !args['no-fixture'] && fs.existsSync(fixture)) {
        // WebGPU: the sim is not bit-reproducible (atomicAdd order in the cell binning, amplified chaotically), so the particle
        // state after `steps` steps is stored once and injected here; only the render passes are then under test.
        const buf = fs.readFileSync(fixture), n = pcParticles, split = n * 16;
        await page.evaluate(([pv, meta]) => window.__loadState(pv, meta), [buf.subarray(0, split).toString('base64'), buf.subarray(split).toString('base64')]);
        console.log(`${name}: loaded particle state from ${path.relative(root, fixture)}`);
    } else {
        // simulate in cheap 'dots' mode (the organic passes dominate the cost under swiftshader), drained in chunks
        await page.evaluate(() => { window.__params.running = true; window.__params.renderMode = 'dots'; });
        const t0 = Date.now();
        for (let done = 0; done < steps; done += 25) {
            await page.evaluate(async (n) => { window.__frames(n); await window.__sync?.(); }, Math.min(25, steps - done));
            if (args.verbose) console.log(`${name}: ${done + Math.min(25, steps - done)}/${steps} steps, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        }
        await page.evaluate(() => { window.__params.running = false; });
        if (gpuState && !args['no-fixture']) {
            const [pv, meta] = await page.evaluate(() => window.__dumpState());
            fs.mkdirSync(path.dirname(fixture), { recursive: true });
            fs.writeFileSync(fixture, Buffer.concat([Buffer.from(pv, 'base64'), Buffer.from(meta, 'base64')]));
            console.log(`${name}: wrote particle state fixture ${path.relative(root, fixture)} (commit it)`);
        }
    }
    for (const style of styles) {
        const { w, h, b64 } = await page.evaluate(async ([st, over]) => {
            const p = window.__params;
            Object.assign(p, over);
            if (st === 'dots') p.renderMode = 'dots'; else { p.renderMode = 'organic'; p.organicStyle = st; }
            window.__frames(3); // sim is paused, so the state does not move; extra frames just settle resize/params
            const r = window.__sync?.(); // WebGL: finish() is synchronous -> no await before the readback
            if (r) await r;
            return await (window.__readback ?? window.__glReadback)();
        }, [style, overrides]);
        const file = path.join(out, `${name}-${style}.png`);
        fs.writeFileSync(file, encodePng(w, h, Buffer.from(b64, 'base64')));
        console.log('wrote', path.relative(process.cwd(), file));
    }
    if (problems.length) console.log(`${name}: console messages (informational):\n  ` + [...new Set(problems)].slice(0, 8).join('\n  '));
    await browser.close();
    return true;
}

let ok = true;
if (target === 'pc' || target === 'all') {
    const flags = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'];
    ok = (await run('pc', { args: flags }, { viewport: { width: 1280, height: 720 } }, `/index.html?preset=${preset}`)) && ok;
}
if (target === 'mobile' || target === 'all') {
    const flags = ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
    ok = (await run('mobile', { args: flags }, { viewport: { width: 390, height: 844 } }, `/mobile.html?preset=${preset}&n=${mobileParticles}`,
        (u) => /\/(simClient|simWorker)\.js$/.test(u.pathname))) && ok;
}
server.close();
process.exit(ok ? 0 : 1);
