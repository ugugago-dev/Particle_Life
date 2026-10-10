// ボトムシート (横長画面では右端のサイドパネル)。ドラッグ / 背景タップ / Esc で閉じる

import { icon } from './icons.js';

const CLOSE_DISTANCE = 80;   // px。これ以上引いたら閉じる
const CLOSE_VELOCITY = 0.6;  // px/ms
const SIDE_QUERY = '(orientation: landscape) and (max-height: 520px)';
const FOCUSABLE = 'button:not([disabled]), input, [href], [tabindex]:not([tabindex="-1"])';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let current = null; // 同時に開くのは 1 枚だけ

export class BottomSheet {
    /** @param {{id: string, title: string, parent?: HTMLElement, onChange?: (open: boolean) => void}} opts */
    constructor({ id, title, parent = document.body, onChange }) {
        this.onChange = onChange;
        this.isOpen = false;
        this.opener = null;
        this.hideTimer = 0;

        this.root = document.createElement('div');
        this.root.className = 'sheet-root';
        this.root.hidden = true;

        this.backdrop = document.createElement('div');
        this.backdrop.className = 'sheet-backdrop';
        this.backdrop.addEventListener('click', () => this.close());

        this.panel = document.createElement('div');
        this.panel.className = 'sheet';
        this.panel.id = id;
        this.panel.setAttribute('role', 'dialog');
        this.panel.setAttribute('aria-modal', 'true');
        this.panel.setAttribute('aria-labelledby', `${id}-title`);
        this.panel.tabIndex = -1;

        const header = document.createElement('div');
        header.className = 'sheet-header';
        const grip = document.createElement('div');
        grip.className = 'sheet-grip';
        const heading = document.createElement('h2');
        heading.id = `${id}-title`;
        heading.textContent = title;
        this.closeBtn = document.createElement('button');
        this.closeBtn.type = 'button';
        this.closeBtn.className = 'sheet-close';
        this.closeBtn.setAttribute('aria-label', `${title}を閉じる`);
        this.closeBtn.append(icon('close', 20));
        this.closeBtn.addEventListener('click', () => this.close());
        header.append(grip, heading, this.closeBtn);

        this.body = document.createElement('div');
        this.body.className = 'sheet-body';
        this.footer = document.createElement('div');
        this.footer.className = 'sheet-footer';
        this.footer.hidden = true;

        this.panel.append(header, this.body, this.footer);
        this.root.append(this.backdrop, this.panel);
        parent.append(this.root);

        this.panel.addEventListener('keydown', (e) => this.onKey(e));
        this.setupDrag(header);
    }

    setFooter(...nodes) {
        this.footer.replaceChildren(...nodes);
        this.footer.hidden = nodes.length === 0;
    }

    open(opener = document.activeElement) {
        if (this.isOpen) return;
        if (current && current !== this) current.close(false);
        current = this;
        this.isOpen = true;
        this.opener = opener;
        clearTimeout(this.hideTimer);
        this.root.hidden = false;
        document.body.classList.add('sheet-open');
        this.panel.style.transform = '';
        void this.panel.offsetHeight; // 初期位置を確定してから遷移
        this.root.classList.add('open');
        this.panel.focus({ preventScroll: true });
        this.onChange?.(true);
    }

    close(restoreFocus = true) {
        if (!this.isOpen) return;
        this.isOpen = false;
        if (current === this) current = null;
        this.panel.style.transform = '';
        this.root.classList.remove('open');
        this.hideTimer = setTimeout(() => {
            this.root.hidden = true;
        }, reduced() ? 0 : 260);
        if (!current) document.body.classList.remove('sheet-open');
        if (restoreFocus) this.opener?.focus?.({ preventScroll: true });
        this.opener = null;
        this.onChange?.(false);
    }

    onKey(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            this.close();
        } else if (e.key === 'Tab') {
            const items = [...this.panel.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
            if (items.length === 0) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (e.shiftKey && (document.activeElement === first || document.activeElement === this.panel)) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    }

    setupDrag(handle) {
        let drag = null;
        const side = () => matchMedia(SIDE_QUERY).matches;
        handle.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button') || drag) return;
            drag = { id: e.pointerId, x: e.clientX, y: e.clientY, d: 0, t: performance.now(), v: 0, side: side() };
            handle.setPointerCapture(e.pointerId);
            this.panel.classList.add('dragging');
        });
        handle.addEventListener('pointermove', (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            const d = Math.max(0, drag.side ? e.clientX - drag.x : e.clientY - drag.y);
            const now = performance.now();
            drag.v = (d - drag.d) / Math.max(1, now - drag.t);
            drag.d = d;
            drag.t = now;
            this.panel.style.transform = drag.side ? `translateX(${d}px)` : `translateY(${d}px)`;
        });
        const end = (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            const { d, v } = drag;
            drag = null;
            this.panel.classList.remove('dragging');
            if (d > CLOSE_DISTANCE || v > CLOSE_VELOCITY) this.close();
            else this.panel.style.transform = '';
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }
}
