// URL options and share links:
//   ?style=scope|glass|cell|dots   look (dots = renderMode 'dots', the others = organic with that style)
//   ?rules=<base64url>             rule matrix: n x n signed bytes, value x 100 (n = sqrt(length))
//   ?preset=1..6                   a preset (ignored when ?rules is given)

import { ORGANIC_STYLES } from './organicStyles.js';

const MAX_TYPES = 16;

function toBase64Url(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** @param {{numTypes: number, data: Float32Array}} rules */
export function encodeRules(rules) {
    const bytes = Int8Array.from(rules.data, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 100));
    return toBase64Url(new Uint8Array(bytes.buffer));
}

/** @returns {number[][] | null} rows for RuleMatrix.load, or null if the text is not a valid matrix */
export function decodeRules(text) {
    let bytes;
    try {
        bytes = fromBase64Url(text);
    } catch {
        return null;
    }
    const n = Math.round(Math.sqrt(bytes.length));
    if (n < 1 || n > MAX_TYPES || n * n !== bytes.length) return null;
    const values = Array.from(new Int8Array(bytes.buffer), (v) => Math.max(-1, Math.min(1, v / 100)));
    return Array.from({ length: n }, (_, i) => values.slice(i * n, (i + 1) * n));
}

/** Applies ?style to params. @returns {boolean} whether a valid style was given */
export function applyStyleQuery(params, query) {
    const style = query.get('style');
    if (style === 'dots') {
        params.renderMode = 'dots';
        return true;
    }
    if (style && Object.hasOwn(ORGANIC_STYLES, style)) {
        params.renderMode = 'organic';
        params.organicStyle = style;
        return true;
    }
    return false;
}

/** ?rules as rows, or null. */
export function rulesFromQuery(query) {
    const text = query.get('rules');
    return text ? decodeRules(text) : null;
}

/** A link to this page that reproduces the current rules and look (keeps ?advanced / ?desktop / ?n). */
export function shareUrl(params, rules, href = location.href) {
    const url = new URL(href);
    const keep = new URLSearchParams();
    for (const k of ['advanced', 'desktop', 'n']) {
        if (url.searchParams.has(k)) keep.set(k, url.searchParams.get(k));
    }
    keep.set('style', params.renderMode === 'dots' ? 'dots' : params.organicStyle);
    keep.set('rules', encodeRules(rules));
    url.search = keep.toString().replace(/=(?=&|$)/g, ''); // ?advanced, not ?advanced=
    url.hash = '';
    return url.toString();
}

/** Copies text to the clipboard. @returns {Promise<boolean>} false when the clipboard is unavailable (it is logged instead) */
export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        console.log(text);
        return false;
    }
}
