// Small self-made control panel (replaces lil-gui: no CDN, styled with style.css).
// API is the subset of lil-gui this project used: add / addFolder / name / onChange / onFinishChange / show / updateDisplay.

let uid = 0;

const decimalsOf = (step) => {
    const s = String(step);
    const dot = s.indexOf('.');
    return dot < 0 ? 0 : s.length - dot - 1;
};

/** One row bound to `object[property]`. */
class Controller {
    constructor(parent, object, property, kind) {
        this.parent = parent;
        this.object = object;
        this.property = property;
        this.kind = kind;
        this._onChange = null;
        this._onFinishChange = null;
        this.domElement = document.createElement('div');
        this.domElement.className = `panel-row panel-${kind}`;
        this.$name = document.createElement('label');
        this.$name.className = 'panel-name';
        this.$name.htmlFor = `panel-${++uid}`;
        this.$name.textContent = property;
        this.$widget = document.createElement('div');
        this.$widget.className = 'panel-widget';
        this.domElement.append(this.$name, this.$widget);
    }

    getValue() {
        return this.object[this.property];
    }

    setValue(v) {
        this.object[this.property] = v;
        this.updateDisplay();
        this._onChange?.(v);
        this._onFinishChange?.(v);
        return this;
    }

    name(text) {
        this.$name.textContent = text;
        return this;
    }

    onChange(fn) {
        this._onChange = fn;
        return this;
    }

    onFinishChange(fn) {
        this._onFinishChange = fn;
        return this;
    }

    show(visible = true) {
        this.domElement.hidden = !visible;
        return this;
    }

    hide() {
        return this.show(false);
    }

    updateDisplay() {
        return this;
    }

    // value changed by the user: `finish` = released / committed
    _commit(v, finish) {
        this.object[this.property] = v;
        this._onChange?.(v);
        if (finish) this._onFinishChange?.(v);
    }
}

class NumberController extends Controller {
    constructor(parent, object, property, min, max, step) {
        super(parent, object, property, 'number');
        this.min = min;
        this.max = max;
        this.step = step ?? (max - min) / 100;
        this.decimals = decimalsOf(this.step);
        const id = this.$name.htmlFor;

        this.$range = document.createElement('input');
        this.$range.type = 'range';
        Object.assign(this.$range, { min, max, step: this.step, id });
        this.$text = document.createElement('input');
        this.$text.type = 'text';
        this.$text.inputMode = 'decimal';
        this.$text.className = 'panel-num';
        this.$text.setAttribute('aria-label', property);
        this.$widget.append(this.$range, this.$text);

        this.$range.addEventListener('input', () => {
            this._commit(Number(this.$range.value), false);
            this.$text.value = this._format(this.getValue());
        });
        this.$range.addEventListener('change', () => this._commit(Number(this.$range.value), true));
        const fromText = () => {
            const v = Number(this.$text.value);
            if (Number.isFinite(v)) this._commit(this._clamp(v), true);
            this.updateDisplay();
        };
        this.$text.addEventListener('change', fromText);
        this.$text.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.$text.blur();
            else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                const dir = e.key === 'ArrowUp' ? 1 : -1;
                this._commit(this._clamp(this.getValue() + dir * this.step * (e.shiftKey ? 10 : 1)), true);
                this.updateDisplay();
            }
        });
        this.updateDisplay();
    }

    _clamp(v) {
        const snapped = Math.round((v - this.min) / this.step) * this.step + this.min;
        return Number(Math.min(this.max, Math.max(this.min, snapped)).toFixed(this.decimals));
    }

    _format(v) {
        return Number(v).toFixed(this.decimals);
    }

    updateDisplay() {
        const v = this.getValue();
        this.$range.value = v;
        if (document.activeElement !== this.$text) this.$text.value = this._format(v);
        return this;
    }
}

class BooleanController extends Controller {
    constructor(parent, object, property) {
        super(parent, object, property, 'boolean');
        this.$input = document.createElement('input');
        this.$input.type = 'checkbox';
        this.$input.id = this.$name.htmlFor;
        this.$widget.append(this.$input);
        this.$input.addEventListener('change', () => this._commit(this.$input.checked, true));
        this.updateDisplay();
    }

    updateDisplay() {
        this.$input.checked = !!this.getValue();
        return this;
    }
}

class OptionController extends Controller {
    /** @param {string[] | Record<string, any>} options array of values, or {label: value} */
    constructor(parent, object, property, options) {
        super(parent, object, property, 'option');
        const entries = Array.isArray(options) ? options.map((v) => [String(v), v]) : Object.entries(options);
        this.values = entries.map(([, v]) => v);
        this.$select = document.createElement('select');
        this.$select.id = this.$name.htmlFor;
        for (const [label] of entries) this.$select.append(new Option(label));
        this.$widget.append(this.$select);
        this.$select.addEventListener('change', () => this._commit(this.values[this.$select.selectedIndex], true));
        this.updateDisplay();
    }

    updateDisplay() {
        this.$select.selectedIndex = Math.max(0, this.values.indexOf(this.getValue()));
        return this;
    }
}

class ButtonController extends Controller {
    constructor(parent, object, property) {
        super(parent, object, property, 'button');
        this.$name.remove();
        this.$button = document.createElement('button');
        this.$button.type = 'button';
        this.$button.textContent = property;
        this.$widget.append(this.$button);
        this.$button.addEventListener('click', () => {
            this.object[this.property].call(this.object);
            this._onChange?.();
        });
    }

    name(text) {
        this.$button.textContent = text;
        return this;
    }
}

/** A collapsible group of controllers. The root panel is fixed to the top-right corner. */
export class Panel {
    /** @param {{title?: string, parent?: Panel, closed?: boolean}} [options] */
    constructor({ title = 'Controls', parent = null, closed = false } = {}) {
        this.parent = parent;
        this.children = [];
        this.folders = [];
        this.controllers = [];

        this.domElement = document.createElement('details');
        this.domElement.className = parent ? 'panel-folder' : 'panel';
        this.domElement.open = !closed;
        this.$title = document.createElement('summary');
        this.$title.className = 'panel-title';
        this.$title.textContent = title;
        this.$children = document.createElement('div');
        this.$children.className = 'panel-children';
        this.domElement.append(this.$title, this.$children);
        if (!parent) document.body.append(this.domElement);
    }

    /**
     * lil-gui style: (obj, prop, [options]) select, (obj, prop, min, max, step) slider, boolean -> checkbox, function -> button.
     */
    add(object, property, a, b, c) {
        const v = object[property];
        let ctrl;
        if (Array.isArray(a) || (a && typeof a === 'object')) ctrl = new OptionController(this, object, property, a);
        else if (typeof v === 'boolean') ctrl = new BooleanController(this, object, property);
        else if (typeof v === 'function') ctrl = new ButtonController(this, object, property);
        else if (typeof v === 'number') ctrl = new NumberController(this, object, property, a ?? 0, b ?? Math.max(1, v * 2), c);
        else throw new Error(`panel: cannot make a control for ${property} (${typeof v})`);
        this.controllers.push(ctrl);
        this.children.push(ctrl);
        this.$children.append(ctrl.domElement);
        return ctrl;
    }

    addFolder(title) {
        const folder = new Panel({ title, parent: this });
        this.folders.push(folder);
        this.children.push(folder);
        this.$children.append(folder.domElement);
        return folder;
    }

    controllersRecursive() {
        return [...this.controllers, ...this.folders.flatMap((f) => f.controllersRecursive())];
    }

    open(open = true) {
        this.domElement.open = open;
        return this;
    }

    close() {
        return this.open(false);
    }

    show(visible = true) {
        this.domElement.hidden = !visible;
        return this;
    }

    destroy() {
        this.domElement.remove();
    }
}
