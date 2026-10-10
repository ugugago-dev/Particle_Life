// 設定シート: 品質 (粒子数 / 自動品質)、描画 (点 / 有機)、粒子の大きさ、軌跡、種類数、リセット

import { BottomSheet } from './sheet.js';
import { actionButton, section, segmented, slider, toggle } from './controls.js';
import { icon } from './icons.js';

/**
 * @param {{params: object, onChange: (open: boolean) => void, canOrganic: () => boolean,
 *   getAuto: () => boolean, setAuto: (v: boolean) => void,
 *   setNumParticles: (n: number) => void, setNumTypes: (n: number) => void, reset: () => void}} o
 */
export function createSettingsSheet(o) {
    const { params } = o;
    const sheet = new BottomSheet({ id: 'sheet-settings', title: '設定', onChange: o.onChange });

    const quality = section('品質');
    const count = slider({
        label: '粒子数',
        min: 500,
        max: 20000,
        step: 500,
        get: () => params.numParticles,
        format: (v) => `${v}`,
        onChange: (v) => {
            params.numParticles = v;
            o.setNumParticles(v); // 離したときだけ作り直す
            controls.forEach((c) => c.sync());
        },
    });
    const auto = toggle({
        label: '自動品質',
        hint: '重いときに粒子を減らす',
        get: o.getAuto,
        set: o.setAuto,
    });
    quality.append(count.el, auto.el);

    const view = section('描画');
    const mode = segmented({
        label: '表示',
        options: [
            { value: 'dots', label: '点' },
            { value: 'organic', label: '有機', disabled: () => !o.canOrganic() },
        ],
        get: () => params.renderMode,
        set: (v) => {
            params.renderMode = v;
        },
    });
    const radius = slider({
        label: '粒子の大きさ',
        min: 0.5,
        max: 6,
        step: 0.1,
        get: () => params.particleRadius,
        format: (v) => `${v.toFixed(1)} px`,
        onInput: (v) => {
            params.particleRadius = v;
        },
    });
    const trails = toggle({
        label: '軌跡',
        get: () => params.trails,
        set: (v) => {
            params.trails = v;
        },
    });
    view.append(mode.el, radius.el, trails.el);

    const world = section('世界');
    const types = slider({
        label: '種類数',
        min: 1,
        max: 12,
        step: 1,
        get: () => params.numTypes,
        format: (v) => `${v}`,
        onChange: (v) => {
            params.numTypes = v;
            o.setNumTypes(v);
        },
    });
    world.append(types.el);

    sheet.body.append(quality, view, world);
    sheet.setFooter(actionButton('粒子をリセット', icon('reset', 20), o.reset, 'wide'));

    const controls = [count, auto, mode, radius, trails, types];
    return { sheet, sync: () => controls.forEach((c) => c.sync()), controls };
}
