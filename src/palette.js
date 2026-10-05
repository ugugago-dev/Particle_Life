// Type -> color, HSL hues evenly spaced. Exposes CSS strings (Canvas2D) and a
// flat float RGB array (future GPU uniform/storage buffer). No DOM access.

/** h in [0,1), s/l in [0,1] -> [r,g,b] in [0,1] */
function hslToRgb(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
        const k = (n + h * 12) % 12;
        return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
}

/**
 * @returns {{numTypes: number, css: string[], rgb: Float32Array}}
 *   css[t] = 'hsl(...)', rgb[3t..3t+2] = float RGB in [0,1]
 */
export function createPalette(numTypes, saturation = 0.9, lightness = 0.6) {
    const css = [];
    const rgb = new Float32Array(numTypes * 3);
    for (let t = 0; t < numTypes; t++) {
        const hue = t / numTypes;
        css.push(`hsl(${(hue * 360).toFixed(1)} ${saturation * 100}% ${lightness * 100}%)`);
        rgb.set(hslToRgb(hue, saturation, lightness), t * 3);
    }
    return { numTypes, css, rgb };
}
