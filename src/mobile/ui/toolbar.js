// 下部ツールバー (主操作 4 つ): 再生/停止、引く/押す、ルール、設定

import { icon } from './icons.js';

function makeButton(label, iconName) {
    const b = document.createElement('button');
    b.type = 'button';
    const ic = icon(iconName);
    const t = document.createElement('span');
    t.className = 'tb-label';
    t.textContent = label;
    b.append(ic, t);
    return { b, ic, t };
}

function swapIcon(btn, name) {
    const next = icon(name);
    btn.ic.replaceWith(next);
    btn.ic = next;
}

/**
 * @param {HTMLElement} root
 * @param {{onRun: () => void, onMode: () => void, onRules: () => void, onSettings: () => void}} h
 */
export function createToolbar(root, h) {
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', '操作');

    const run = makeButton('停止', 'pause');
    run.b.setAttribute('aria-label', '一時停止');
    run.b.setAttribute('aria-pressed', 'false');
    run.b.addEventListener('click', h.onRun);

    const mode = makeButton('引く', 'attract');
    mode.b.classList.add('tb-mode');
    mode.b.setAttribute('aria-label', '押す (斥力)');
    mode.b.setAttribute('aria-pressed', 'false');
    mode.b.addEventListener('click', h.onMode);

    const rules = makeButton('ルール', 'rules');
    rules.b.setAttribute('aria-haspopup', 'dialog');
    rules.b.setAttribute('aria-controls', 'sheet-rules');
    rules.b.setAttribute('aria-expanded', 'false');
    rules.b.addEventListener('click', h.onRules);

    const settings = makeButton('設定', 'settings');
    settings.b.setAttribute('aria-haspopup', 'dialog');
    settings.b.setAttribute('aria-controls', 'sheet-settings');
    settings.b.setAttribute('aria-expanded', 'false');
    settings.b.addEventListener('click', h.onSettings);

    root.append(run.b, mode.b, rules.b, settings.b);

    return {
        buttons: { rules: rules.b, settings: settings.b },
        setRunning(running) {
            run.t.textContent = running ? '停止' : '再生';
            run.b.setAttribute('aria-pressed', String(!running));
            swapIcon(run, running ? 'pause' : 'play');
        },
        setPush(push) {
            mode.t.textContent = push ? '押す' : '引く';
            mode.b.classList.toggle('push', push);
            mode.b.setAttribute('aria-pressed', String(push));
            swapIcon(mode, push ? 'repel' : 'attract');
        },
        setSheet(name) {
            rules.b.setAttribute('aria-expanded', String(name === 'rules'));
            settings.b.setAttribute('aria-expanded', String(name === 'settings'));
            rules.b.classList.toggle('active', name === 'rules');
            settings.b.classList.toggle('active', name === 'settings');
        },
    };
}
