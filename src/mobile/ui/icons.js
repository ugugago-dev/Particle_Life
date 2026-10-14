// インライン SVG アイコン (24x24、currentColor の線画)。定数のみなので innerHTML で生成してよい

const PATHS = {
    play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6.5" y="5" width="3.8" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.7" y="5" width="3.8" height="14" rx="1" fill="currentColor" stroke="none"/>',
    // 引く: 外側から中心へ向かう矢印
    attract: '<path d="M3 3l5 5M8 4.5V8H4.5M21 3l-5 5M16 4.5V8h3.5M3 21l5-5M8 19.5V16H4.5M21 21l-5-5M16 19.5V16h3.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    // 押す: 中心から外へ向かう矢印
    repel: '<path d="M10 10L4 4M4 8.5V4h4.5M14 10l6-6M20 8.5V4h-4.5M10 14l-6 6M4 15.5V20h4.5M14 14l6 6M20 15.5V20h-4.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    rules: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" fill="currentColor" fill-opacity=".35"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" fill="currentColor" fill-opacity=".35"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.2" fill="currentColor" stroke="none"/>',
    zero: '<circle cx="12" cy="12" r="8"/><path d="M7 17L17 7"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
    reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4.5 4.5v4h4"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
};

/** @param {keyof typeof PATHS} name */
export function icon(name, size = 24) {
    const span = document.createElement('span');
    span.className = `icon icon-${name}`;
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML =
        `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false">${PATHS[name]}</svg>`;
    return span;
}
