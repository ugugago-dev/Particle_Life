// scope スタイルの種類ごとの染色色 (CPU 側。docs/scope-species-spec.md)。
// パレットが変わったときだけ計算し、vec4 配列 (uniform) として GPU へ渡す (PC = renderer.js の updatePalette)。DOM / GPU 非依存。

/** 明視野の背景色 (organic.wgsl.js の SCOPE_BG へ文字列で埋め込む) */
export const SCOPE_BG = [0.93, 0.94, 0.88];

export const STAIN_DL = 0.15;       // 染色は種類の色より L を下げる
export const STAIN_CHROMA = 1.2;
export const STAIN_CMAX = 0.19;
/** uniform 配列の長さ (種類数の上限) */
export const MAX_STAIN_TYPES = 16;

const smoothstep = (e0, e1, x) => {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
};

const srgbToLinear = (c) => (c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92);
const linearToSrgb = (c) => (c > 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : c * 12.92);

/** linear sRGB -> OKLab */
export function toOklab([r, g, b]) {
    const l = Math.cbrt(Math.max(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0));
    const m = Math.cbrt(Math.max(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 0));
    const s = Math.cbrt(Math.max(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b, 0));
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

/** OKLab -> linear sRGB (範囲外の値もそのまま) */
export function fromOklab([L, a, b]) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
}

/** 種類の色 (sRGB 0..1) -> 密度 1 の染色の色 (sRGB): OKLCH の色相を保って彩度を上げ L を下げる (黄は下げ幅小)。範囲外は同じ L の灰色へ寄せる */
export function stainColor(rgb) {
    const lab = toOklab(rgb.map(srgbToLinear));
    const chroma = Math.hypot(lab[1], lab[2]);
    const t = smoothstep(0.74, 0.9, lab[0]);
    const L = Math.max(lab[0] - STAIN_DL * (1 - 0.75 * t), 0);
    const scale = chroma > 1e-4 ? Math.min(chroma * STAIN_CHROMA, STAIN_CMAX) / chroma : 0;
    const lin = fromOklab([L, lab[1] * scale, lab[2] * scale]);
    const gray = L * L * L;
    let k = 1;
    for (const v of lin) {
        if (v > 1) k = Math.min(k, (1 - gray) / (v - gray));
        if (v < 0) k = Math.min(k, gray / (gray - v));
    }
    return lin.map((v) => {
        const mapped = Math.min(Math.max(gray + (v - gray) * k, 0), 1);
        return Math.min(Math.max(linearToSrgb(mapped), 0.03), 1);
    });
}

/** 背景 * (色 / 背景)^密度 の「色 / 背景」 (密度 1 の透過率) */
export function stainTransmit(rgb) {
    return stainColor(rgb).map((v, i) => Math.min(v / SCOPE_BG[i], 1));
}

/**
 * パレットから uniform 用の配列を作る (vec4 x 16、xyz を使い w = 0)。
 * numTypes 以降の要素は最後の種類の値で埋める (範囲外参照・mod の取りこぼしでも有効な色になる)。numTypes = 0 のときは全て 0。
 * @param {Float32Array} paletteRgb 種類あたり 3 要素 (sRGB 0..1)
 * @param {number} numTypes
 * @returns {{stain: Float32Array, transmit: Float32Array}}
 */
export function buildStainTables(paletteRgb, numTypes) {
    const stain = new Float32Array(MAX_STAIN_TYPES * 4);
    const transmit = new Float32Array(MAX_STAIN_TYPES * 4);
    const n = Math.min(numTypes, MAX_STAIN_TYPES);
    let lastS = [0, 0, 0];
    let lastT = [0, 0, 0];
    for (let i = 0; i < MAX_STAIN_TYPES; i++) {
        if (i < n) {
            const c = [paletteRgb[i * 3], paletteRgb[i * 3 + 1], paletteRgb[i * 3 + 2]];
            lastS = stainColor(c);
            lastT = stainTransmit(c);
        }
        stain.set(lastS, i * 4);
        transmit.set(lastT, i * 4);
    }
    return { stain, transmit };
}
