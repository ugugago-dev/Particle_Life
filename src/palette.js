// Type colours in OKLCH: equal lightness/chroma, hues on an arc violet -> red -> yellow -> green that skips the cyan..blue of the glass background

const HUE_START = 295;          // degrees
const HUE_END = 145 + 360;
const LIGHTNESS = 0.73;         // readable on both the light glass body and the dark dots background
const CHROMA = 0.16;
// Yellow only looks yellow at high L: raise L around it with a raised-cosine bump in hue
const BUMP_CENTER = 96;
const BUMP_HALF_WIDTH = 60;
const BUMP_LIGHTNESS = 0.16;
const BUMP_CHROMA = 0.01;
const MAX_LIGHTNESS = 0.93;
const ALTERNATE_FROM = 7;       // from this many types, alternate L so neighbours stay distinguishable
const LIGHTNESS_SWING = 0.05;

const srgbEncode = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

/** OKLCH -> linear sRGB (may be out of 0..1) */
function oklchToLinear(L, C, hDeg) {
    const h = (hDeg * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
}

const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLCH -> gamma-encoded sRGB; out-of-gamut colours lose chroma (hue and lightness kept). */
function oklchToSrgb(L, C, hDeg) {
    let rgb = oklchToLinear(L, C, hDeg);
    if (!inGamut(rgb)) {
        let lo = 0;
        let hi = C;
        for (let i = 0; i < 24; i++) {
            const mid = (lo + hi) / 2;
            if (inGamut(oklchToLinear(L, mid, hDeg))) lo = mid;
            else hi = mid;
        }
        rgb = oklchToLinear(L, lo, hDeg);
    }
    return rgb.map((v) => srgbEncode(Math.min(1, Math.max(0, v))));
}

function yellowBump(hueDeg) {
    const d = ((hueDeg - BUMP_CENTER + 540) % 360) - 180;
    return Math.abs(d) >= BUMP_HALF_WIDTH ? 0 : 0.5 * (1 + Math.cos((Math.PI * d) / BUMP_HALF_WIDTH));
}

/** @returns {{numTypes: number, css: string[], rgb: Float32Array}} */
export function createPalette(numTypes) {
    const css = [];
    const rgb = new Float32Array(numTypes * 3);
    for (let t = 0; t < numTypes; t++) {
        const hue = numTypes > 1 ? HUE_START + ((HUE_END - HUE_START) * t) / (numTypes - 1) : 30;
        const swing = numTypes >= ALTERNATE_FROM ? (t % 2 === 0 ? -LIGHTNESS_SWING : LIGHTNESS_SWING) : 0;
        const bump = yellowBump(hue);
        const c = oklchToSrgb(Math.min(MAX_LIGHTNESS, LIGHTNESS + swing + BUMP_LIGHTNESS * bump), CHROMA + BUMP_CHROMA * bump, hue);
        rgb.set(c, t * 3);
        css.push(`rgb(${c.map((v) => Math.round(v * 255)).join(' ')})`);
    }
    return { numTypes, css, rgb };
}
