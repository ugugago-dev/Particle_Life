// Settings kept across reloads (localStorage). Only values that differ from the defaults are stored, so a later change of a
// default still reaches people who never touched that setting. Storage may be unavailable (private mode): then nothing is kept.

import { defaults } from './config.js';
import { ORGANIC_STYLES } from './organicStyles.js';
import { RULE_GENERATORS } from './ruleGen.js';

const CHOICES = {
    renderMode: ['dots', 'organic'],
    organicStyle: Object.keys(ORGANIC_STYLES),
    ruleGenerator: RULE_GENERATORS,
};

function valid(key, value) {
    if (!Object.hasOwn(defaults, key) || typeof value !== typeof defaults[key]) return false;
    if (CHOICES[key]) return CHOICES[key].includes(value);
    return typeof value !== 'number' || Number.isFinite(value);
}

/**
 * @param {string} storageKey
 * @param {string[]} keys the params that are kept
 */
export function createSettingsStore(storageKey, keys) {
    return {
        /** Overwrites params with the stored values (unknown / invalid ones are skipped). */
        load(params) {
            let saved;
            try {
                saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
            } catch {
                return;
            }
            if (!saved || typeof saved !== 'object') return;
            for (const k of keys) {
                if (Object.hasOwn(saved, k) && valid(k, saved[k])) params[k] = saved[k];
            }
        },
        save(params) {
            const diff = {};
            for (const k of keys) {
                if (params[k] !== defaults[k]) diff[k] = params[k];
            }
            try {
                if (Object.keys(diff).length) localStorage.setItem(storageKey, JSON.stringify(diff));
                else localStorage.removeItem(storageKey);
            } catch {
                // storage blocked or full: settings are just not kept
            }
        },
        clear() {
            try {
                localStorage.removeItem(storageKey);
            } catch {
                // ignore
            }
        },
    };
}

/** Saves when the page is hidden or closed (covers every way a value can change without hooking each control). */
export function saveOnHide(store, params) {
    const save = () => store.save(params);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) save();
    });
    window.addEventListener('pagehide', save);
    return save;
}
