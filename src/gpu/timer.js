// timestamp-query による GPU 時間 (無ければ enabled = false)。読み戻しはリングで、空きが無いフレームは飛ばす
// Chrome は既定で ~100us に丸める (--enable-webgpu-developer-features で丸めなし)

const QUERY_COUNT = 4;       // sim の開始 / 終了、draw の開始 / 終了
const SLOTS = 3;

export class GpuTimer {
    constructor(device) {
        this.enabled = device.features.has('timestamp-query');
        this.simMs = null;   // 平滑化は呼び出し側
        this.drawMs = null;
        if (!this.enabled) return;

        this.querySet = device.createQuerySet({ type: 'timestamp', count: QUERY_COUNT });
        this.resolveBuffer = device.createBuffer({
            label: 'timestamp resolve',
            size: QUERY_COUNT * 8,
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        });
        this.slots = Array.from({ length: SLOTS }, () => ({
            buffer: device.createBuffer({
                label: 'timestamp staging',
                size: QUERY_COUNT * 8,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            }),
            busy: false,
        }));
    }

    simWrites() {
        if (!this.enabled) return undefined;
        return { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
    }

    /** 描画が複数パスのときの最初のパス用 */
    drawBeginWrites() {
        if (!this.enabled) return undefined;
        return { querySet: this.querySet, beginningOfPassWriteIndex: 2 };
    }

    drawEndWrites() {
        if (!this.enabled) return undefined;
        return { querySet: this.querySet, endOfPassWriteIndex: 3 };
    }

    drawWrites() {
        if (!this.enabled) return undefined;
        return { querySet: this.querySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 };
    }

    /** encoder.finish() の前に呼ぶ。空きスロットが無ければ null。 */
    resolve(encoder) {
        if (!this.enabled) return null;
        const slot = this.slots.find((s) => !s.busy);
        if (!slot) return null;
        slot.busy = true;
        encoder.resolveQuerySet(this.querySet, 0, QUERY_COUNT, this.resolveBuffer, 0);
        encoder.copyBufferToBuffer(this.resolveBuffer, 0, slot.buffer, 0, QUERY_COUNT * 8);
        return slot;
    }

    /** submit のあとに呼ぶ (非同期)。 */
    async collect(slot) {
        if (!slot) return;
        try {
            await slot.buffer.mapAsync(GPUMapMode.READ);
            const t = new BigUint64Array(slot.buffer.getMappedRange().slice(0));
            slot.buffer.unmap();
            this.simMs = Number(t[1] - t[0]) / 1e6;
            this.drawMs = Number(t[3] - t[2]) / 1e6;
        } catch {
            // デバイス喪失など。次のフレームで再試行される
        } finally {
            slot.busy = false;
        }
    }
}
