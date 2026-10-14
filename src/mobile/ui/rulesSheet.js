// ルールシート: プリセットのチップ + 行列エディタ (タッチ版) + ランダム / ゼロ / コピー / リンク

import { PRESETS } from '../../presets.js';
import { MatrixEditor } from '../../ui/matrixEditor.js';
import { BottomSheet } from './sheet.js';
import { actionButton } from './controls.js';
import { icon } from './icons.js';

const CELL_MIN = 28;
const CELL_MAX = 34;

/**
 * @param {{rules: object, palette: object, onEdited: () => void, onChange: (open: boolean) => void,
 *   onPreset: (preset: object, index: number) => void, onRandom: () => void, onZero: () => void, onCopy: () => void, onShare: () => void}} o
 */
export function createRulesSheet(o) {
    const sheet = new BottomSheet({ id: 'sheet-rules', title: 'ルール', onChange: o.onChange });
    sheet.root.classList.add('sheet-rules');

    const chips = document.createElement('div');
    chips.className = 'chips';
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'プリセット');
    const chipButtons = PRESETS.map((p, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = p.name.replace(/^Preset\s*/i, 'P');
        b.setAttribute('aria-label', p.name);
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', () => o.onPreset(p, i));
        return b;
    });
    chips.append(...chipButtons);


    const matrixHost = document.createElement('div');
    matrixHost.className = 'matrix-host';
    // 操作の説明。セルを編集すると「行 → 列: 値」の表示に変わる
    const HINT = 'タップ +0.1 / 長押し −0.1 / ダブルタップ 0';
    const readout = document.createElement('p');
    readout.className = 'hint';
    readout.textContent = HINT;
    sheet.body.append(chips, readout, matrixHost);
    const matrix = new MatrixEditor(matrixHost, o.rules, o.palette, o.onEdited);
    matrix.setVisible(true);
    matrix.onCellEdit = (i, j, v) => {
        readout.textContent = `行 ${i + 1} が列 ${j + 1} に: ${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(2)}`;
    };

    sheet.setFooter(
        actionButton('ランダム', icon('dice', 20), o.onRandom),
        actionButton('ゼロ', icon('zero', 20), o.onZero),
        actionButton('コピー', icon('copy', 20), o.onCopy),
        actionButton('リンク', icon('link', 20), o.onShare),
    );

    // セルの大きさを幅に合わせる (28px 未満にはせず、足りなければ横スクロール)
    const fit = () => {
        const w = matrixHost.clientWidth;
        if (w <= 0) return;
        const n = o.rules.numTypes + 1;
        const cell = Math.max(CELL_MIN, Math.min(CELL_MAX, Math.floor((w - 2 * (n - 1)) / n)));
        matrixHost.style.setProperty('--cell', `${cell}px`);
    };
    new ResizeObserver(fit).observe(matrixHost);

    return {
        sheet,
        matrix,
        /** @param {number} index -1 でカスタム (どれも選ばない) */
        setActivePreset(index) {
            chipButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(i === index)));
            chipButtons[index]?.scrollIntoView({ block: 'nearest', inline: 'center' });
        },
        rebuild(rules, palette) {
            matrix.rebuild(rules, palette);
            readout.textContent = HINT;
            fit();
        },
        /** ランダム / ゼロの後 */
        refresh() {
            matrix.refresh();
            readout.textContent = HINT;
        },
    };
}
