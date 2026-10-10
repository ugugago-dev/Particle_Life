// WebGPU の初期化と非対応時のメッセージ

/**
 * canvas には触らない (テスト用ハーネスからも使う)。
 * @returns {Promise<{ok: true, adapter: GPUAdapter, device: GPUDevice, timestamps: boolean}
 *                  | {ok: false, reason: string}>}
 */
export async function requestGPU() {
    if (!('gpu' in navigator) || !navigator.gpu) {
        return { ok: false, reason: 'navigator.gpu is not available' };
    }
    let adapter;
    try {
        adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    } catch (e) {
        return { ok: false, reason: `requestAdapter failed: ${e.message ?? e}` };
    }
    if (!adapter) return { ok: false, reason: 'no suitable GPU adapter' };

    const timestamps = adapter.features.has('timestamp-query');
    try {
        const device = await adapter.requestDevice({
            requiredFeatures: timestamps ? ['timestamp-query'] : [],
        });
        return { ok: true, adapter, device, timestamps };
    } catch (e) {
        return { ok: false, reason: `requestDevice failed: ${e.message ?? e}` };
    }
}

export function configureCanvas(canvas, device) {
    const context = canvas.getContext('webgpu');
    if (!context) return { ok: false, reason: 'canvas.getContext("webgpu") returned null' };
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    return { ok: true, context, format };
}

/** validation / out-of-memory エラーを例外にして fn を実行する (パイプライン生成のエラーを確実に拾うため)。 */
export async function withErrorScope(device, label, fn) {
    device.pushErrorScope('validation');
    device.pushErrorScope('out-of-memory');
    let result;
    try {
        result = await fn();
    } finally {
        const oom = await device.popErrorScope();
        const validation = await device.popErrorScope();
        if (oom) throw new Error(`[${label}] out of memory: ${oom.message}`);
        if (validation) throw new Error(`[${label}] validation error: ${validation.message}`);
    }
    return result;
}

/** コンパイルエラーは行番号つきで投げる。 */
export async function createShaderModule(device, label, code) {
    const module = device.createShaderModule({ label, code });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length > 0) {
        const lines = code.split('\n');
        const text = errors
            .map((m) => `  ${label}:${m.lineNum}:${m.linePos} ${m.message}\n    | ${lines[m.lineNum - 1] ?? ''}`)
            .join('\n');
        throw new Error(`WGSL compile error\n${text}`);
    }
    return module;
}

/** kind: 'unsupported' | 'lost' (デバイス喪失) | 'error' (初期化中のエラー) */
export function showUnsupported(reason, kind = 'unsupported') {
    const TEXT = {
        unsupported: ['このブラウザ/端末は WebGPU に対応していません', 'Chrome / Edge の最新版でお試しください。'],
        lost: ['GPU デバイスが失われました', 'ページを再読み込みしてください。'],
        error: ['WebGPU の初期化に失敗しました', 'Chrome / Edge の最新版でお試しください。コンソールにも詳細を出しています。'],
    };
    const [titleText, hintText] = TEXT[kind] ?? TEXT.unsupported;
    const el = document.createElement('div');
    el.className = 'unsupported';
    const title = document.createElement('div');
    title.className = 'unsupported-title';
    title.textContent = titleText;
    const hint = document.createElement('div');
    hint.className = 'unsupported-hint';
    hint.textContent = hintText;
    const detail = document.createElement('div');
    detail.className = 'unsupported-detail';
    detail.textContent = reason;
    const link = document.createElement('a');
    link.className = 'unsupported-link';
    link.href = 'mobile.html';
    link.textContent = 'スマホ版 (WebGL2) を開く';
    el.append(title, hint, link, detail);
    document.body.append(el);
    console.error('[WebGPU]', reason);
}
