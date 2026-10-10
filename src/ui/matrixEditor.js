// Rule matrix overlay ("row is attracted to column"): click +0.1 | right click -0.1 | wheel +-0.05 | shift+click -> 0

const CLICK_STEP = 0.1;
const WHEEL_STEP = 0.05;
const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 300;
const MOVE_TOLERANCE = 10; // px
const SYNTH_GUARD_MS = 700; // タッチ後の合成 click / contextmenu を無視する期間

const fmt = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);

export class MatrixEditor {
    /**
     * @param {HTMLElement} parent
     * @param {import('../rules.js').RuleMatrix} rules edited in place
     * @param {{css: string[]}} palette
     * @param {() => void} [onChange]
     */
    constructor(parent, rules, palette, onChange) {
        this.rules = rules;
        this.onChange = onChange;
        this.cells = []; // flat, same layout as rules.data

        this.panel = document.createElement('div');
        this.panel.className = 'matrix-panel';
        this.panel.title = 'Row is attracted to column';

        const caption = document.createElement('div');
        caption.className = 'matrix-caption';
        caption.textContent = 'Rule matrix: row is attracted to column';

        this.grid = document.createElement('div');
        this.grid.className = 'matrix-grid';

        const help = document.createElement('div');
        help.className = 'matrix-help';
        const helpMouse = document.createElement('span');
        helpMouse.className = 'matrix-help-mouse';
        helpMouse.textContent = 'click +0.1 / right-click -0.1 / wheel +-0.05 / shift+click 0';
        const helpTouch = document.createElement('span');
        helpTouch.className = 'matrix-help-touch';
        helpTouch.textContent = 'タップ +0.1 / 長押し −0.1 / ダブルタップ 0';
        help.append(helpMouse, helpTouch);

        this.panel.append(caption, this.grid, help);
        parent.append(this.panel);

        this.touch = null; // 進行中のタッチ { id, cell, x, y, timer, long }
        this.lastTap = null; // { cell, t }
        this.touchUntil = 0; // この時刻まで合成イベントを無視
        this.onCellEdit = null; // (i, j, value) 編集のたびに呼ぶ (読み出し表示用)

        this.grid.addEventListener('click', (e) => {
            if (this.isSynthetic(e)) return;
            this.onEdit(e, +CLICK_STEP);
        });
        this.grid.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (this.isSynthetic(e)) return;
            this.onEdit(e, -CLICK_STEP);
        });
        this.grid.addEventListener('pointerdown', (e) => this.onTouchDown(e));
        this.grid.addEventListener('pointermove', (e) => this.onTouchMove(e));
        this.grid.addEventListener('pointerup', (e) => this.onTouchUp(e));
        this.grid.addEventListener('pointercancel', () => this.endTouch());
        this.grid.addEventListener('wheel', (e) => {
            e.preventDefault();
            const dy = e.deltaY || e.deltaX; // shift+wheel may report on the x axis
            this.onEdit(e, dy < 0 ? +WHEEL_STEP : -WHEEL_STEP, false);
        }, { passive: false });

        this.rebuild(rules, palette);
    }

    setVisible(visible) {
        this.panel.hidden = !visible;
    }

    /** After numTypes changed. */
    rebuild(rules, palette) {
        this.rules = rules;
        const n = rules.numTypes;
        this.cells = new Array(n * n);
        this.grid.style.gridTemplateColumns = `repeat(${n + 1}, var(--cell))`;

        const frag = document.createDocumentFragment();
        frag.append(document.createElement('div')); // top-left corner
        for (let j = 0; j < n; j++) frag.append(this.makeHeader(palette.css[j], `column: type ${j} (target)`));

        for (let i = 0; i < n; i++) {
            frag.append(this.makeHeader(palette.css[i], `row: type ${i} (acting)`));
            for (let j = 0; j < n; j++) {
                const cell = document.createElement('div');
                cell.className = 'matrix-cell';
                cell.dataset.i = i;
                cell.dataset.j = j;
                this.cells[i * n + j] = cell;
                frag.append(cell);
            }
        }
        this.grid.replaceChildren(frag);
        this.refresh();
    }

    /** After randomize / zero. */
    refresh() {
        const n = this.rules.numTypes;
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) this.paintCell(i, j);
        }
    }

    makeHeader(color, title) {
        const head = document.createElement('div');
        head.className = 'matrix-head';
        head.title = title;
        const dot = document.createElement('span');
        dot.className = 'matrix-dot';
        dot.style.background = color;
        head.append(dot);
        return head;
    }

    paintCell(i, j) {
        const v = this.rules.get(i, j);
        const cell = this.cells[i * this.rules.numTypes + j];
        if (v === 0) {
            cell.style.background = '';
        } else {
            const alpha = (0.08 + 0.92 * Math.abs(v)).toFixed(3);
            cell.style.background = `rgba(var(${v > 0 ? '--attract' : '--repel'}), ${alpha})`;
        }
        cell.title = `type ${i} -> type ${j}: ${fmt(v)}  (row ${i} is ${v >= 0 ? 'attracted to' : 'repelled by'} column ${j})`;
    }

    isSynthetic(e) {
        return e.pointerType === 'touch' || this.touch !== null || performance.now() < this.touchUntil;
    }

    editCell(cell, delta, zero = false) {
        const i = Number(cell.dataset.i);
        const j = Number(cell.dataset.j);
        const next = zero ? 0 : this.rules.get(i, j) + delta;
        this.rules.set(i, j, Math.round(next * 1000) / 1000);
        this.paintCell(i, j);
        this.onChange?.();
        this.onCellEdit?.(i, j, this.rules.get(i, j));
    }

    onTouchDown(e) {
        if (e.pointerType !== 'touch') return;
        const cell = e.target.closest('.matrix-cell');
        if (!cell || this.touch) return;
        const t = { id: e.pointerId, cell, x: e.clientX, y: e.clientY, timer: 0, long: false };
        t.timer = setTimeout(() => {
            t.long = true;
            this.editCell(cell, -CLICK_STEP);
            navigator.vibrate?.(10);
        }, LONG_PRESS_MS);
        this.touch = t;
        cell.classList.add('pressing'); // 長押しの進行を CSS で見せる
    }

    onTouchMove(e) {
        const t = this.touch;
        if (!t || e.pointerId !== t.id) return;
        if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > MOVE_TOLERANCE) {
            this.endTouch();
            this.lastTap = null;
        }
    }

    onTouchUp(e) {
        const t = this.touch;
        if (!t || e.pointerId !== t.id) return;
        const wasLong = t.long;
        this.endTouch();
        if (wasLong) return;
        const now = performance.now();
        if (this.lastTap && this.lastTap.cell === t.cell && now - this.lastTap.t < DOUBLE_TAP_MS) {
            this.editCell(t.cell, 0, true); // ダブルタップ: 0
            this.lastTap = null;
        } else {
            this.editCell(t.cell, +CLICK_STEP);
            this.lastTap = { cell: t.cell, t: now };
        }
    }

    endTouch() {
        if (this.touch) {
            clearTimeout(this.touch.timer);
            this.touch.cell.classList.remove('pressing');
        }
        this.touch = null;
        this.touchUntil = performance.now() + SYNTH_GUARD_MS;
    }

    onEdit(e, delta, allowZero = true) {
        const cell = e.target.closest('.matrix-cell');
        if (!cell) return;
        const i = Number(cell.dataset.i);
        const j = Number(cell.dataset.j);
        const next = allowZero && e.shiftKey ? 0 : this.rules.get(i, j) + delta;
        this.rules.set(i, j, Math.round(next * 1000) / 1000); // strip float noise
        this.paintCell(i, j);
        this.onChange?.();
        this.onCellEdit?.(i, j, this.rules.get(i, j));
    }
}
