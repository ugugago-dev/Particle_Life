// Rule matrix overlay ("row is attracted to column"): click +0.1 | right click -0.1 | wheel +-0.05 | shift+click -> 0

const CLICK_STEP = 0.1;
const WHEEL_STEP = 0.05;

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
        help.textContent = 'click +0.1 / right-click -0.1 / wheel +-0.05 / shift+click 0';

        this.panel.append(caption, this.grid, help);
        parent.append(this.panel);

        this.grid.addEventListener('click', (e) => this.onEdit(e, +CLICK_STEP));
        this.grid.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.onEdit(e, -CLICK_STEP);
        });
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

    onEdit(e, delta, allowZero = true) {
        const cell = e.target.closest('.matrix-cell');
        if (!cell) return;
        const i = Number(cell.dataset.i);
        const j = Number(cell.dataset.j);
        const next = allowZero && e.shiftKey ? 0 : this.rules.get(i, j) + delta;
        this.rules.set(i, j, Math.round(next * 1000) / 1000); // strip float noise
        this.paintCell(i, j);
        this.onChange?.();
    }
}
