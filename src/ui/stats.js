// Small DOM overlay (top-left): fps, GPU time (if timestamp-query is available), particle count.
// DOM rather than canvas text, so it survives a renderer swap.

const SMOOTHING = 0.1;  // exponential moving average weight of the newest sample
const REFRESH_MS = 250; // DOM text update interval

const ema = (prev, value) => (prev === null ? value : prev + (value - prev) * SMOOTHING);

export class StatsOverlay {
    /** @param {boolean} gpuTimes true when timestamp-query is available (shows sim/draw GPU ms) */
    constructor(gpuTimes = false, parent = document.body) {
        this.el = document.createElement('div');
        this.el.className = 'stats';
        parent.append(this.el);

        this.gpuTimes = gpuTimes;
        this.frameMs = null;
        this.cpuMs = null;
        this.simMs = null;
        this.drawMs = null;
        this.lastTime = 0;
        this.lastRefresh = 0;
    }

    /** CPU time spent encoding + submitting one frame (not the GPU time). */
    recordCpu(ms) {
        this.cpuMs = ema(this.cpuMs, ms);
    }

    /** GPU time of the simulation pass (all substeps) and of the draw passes, in ms. */
    recordGpu(simMs, drawMs) {
        if (simMs !== null && Number.isFinite(simMs)) this.simMs = ema(this.simMs, simMs);
        if (drawMs !== null && Number.isFinite(drawMs)) this.drawMs = ema(this.drawMs, drawMs);
    }

    /** Call once per animation frame with the rAF timestamp. `info` is an optional extra line. */
    tick(now, particleCount, info = '') {
        if (this.lastTime) this.frameMs = ema(this.frameMs, now - this.lastTime);
        this.lastTime = now;

        if (now - this.lastRefresh < REFRESH_MS || this.frameMs === null) return;
        this.lastRefresh = now;
        const fps = 1000 / this.frameMs;
        let text = `fps       ${fps.toFixed(1)}\n`;
        if (this.gpuTimes) {
            text += `sim gpu   ${(this.simMs ?? 0).toFixed(2)} ms\n`;
            text += `draw gpu  ${(this.drawMs ?? 0).toFixed(2)} ms\n`;
        }
        text += `cpu       ${(this.cpuMs ?? 0).toFixed(2)} ms\n`;
        text += `particles ${particleCount}`;
        if (info) text += `\n${info}`;
        this.el.textContent = text;
    }
}
