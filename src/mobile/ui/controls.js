// 設定シート用の小さな部品 (スライダ / スイッチ / セグメント / ボタン)

let uid = 0;

function row(label) {
    const el = document.createElement('div');
    el.className = 'row';
    const name = document.createElement('div');
    name.className = 'row-label';
    name.textContent = label;
    el.append(name);
    return { el, name };
}

/** 値の表示つきスライダ。onInput は動かしている間、onChange は離したとき */
export function slider({ label, min, max, step, get, format = String, onInput, onChange }) {
    const { el, name } = row(label);
    const value = document.createElement('span');
    value.className = 'row-value';
    name.append(value);
    const input = document.createElement('input');
    input.type = 'range';
    input.id = `sl-${++uid}`;
    input.min = min;
    input.max = max;
    input.step = step;
    input.setAttribute('aria-label', label);
    const show = () => {
        value.textContent = format(Number(input.value));
    };
    input.addEventListener('input', () => {
        show();
        onInput?.(Number(input.value));
    });
    input.addEventListener('change', () => onChange?.(Number(input.value)));
    el.append(input);
    return {
        el,
        sync() {
            input.value = get();
            show();
        },
    };
}

export function toggle({ label, hint, get, set }) {
    const el = document.createElement('div');
    el.className = 'row row-switch';
    const text = document.createElement('div');
    text.className = 'row-label';
    text.textContent = label;
    if (hint) {
        const h = document.createElement('small');
        h.textContent = hint;
        text.append(h);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'switch';
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-label', label);
    btn.append(document.createElement('span'));
    const paint = () => btn.setAttribute('aria-checked', String(!!get()));
    btn.addEventListener('click', () => {
        set(!get());
        paint();
    });
    el.append(text, btn);
    return { el, sync: paint };
}

/** 排他の選択 (点 / 有機)。options = [{value, label, disabled}] */
export function segmented({ label, options, get, set }) {
    const { el } = row(label);
    const group = document.createElement('div');
    group.className = 'segmented';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    const buttons = options.map((o) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.textContent = o.label;
        b.addEventListener('click', () => {
            if (b.disabled) return;
            set(o.value);
            paint();
        });
        return b;
    });
    const paint = () => {
        buttons.forEach((b, i) => {
            b.setAttribute('aria-checked', String(options[i].value === get()));
            b.disabled = typeof options[i].disabled === 'function' ? options[i].disabled() : !!options[i].disabled;
        });
    };
    group.append(...buttons);
    el.append(group);
    return { el, sync: paint };
}

export function section(title) {
    const el = document.createElement('section');
    el.className = 'group';
    const h = document.createElement('h3');
    h.textContent = title;
    el.append(h);
    return el;
}

export function actionButton(label, iconEl, onClick, cls = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${cls}`.trim();
    if (iconEl) b.append(iconEl);
    const t = document.createElement('span');
    t.textContent = label;
    b.append(t);
    b.addEventListener('click', onClick);
    return b;
}
