// 小さなトースト (aria-live)。UI の上に一時的に出す

export function createToast(parent = document.body) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    parent.append(el);
    let timer = 0;
    return {
        show(message, ms = 2600) {
            el.textContent = message;
            el.classList.add('show');
            clearTimeout(timer);
            timer = setTimeout(() => el.classList.remove('show'), ms);
        },
    };
}
