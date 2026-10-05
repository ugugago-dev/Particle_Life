// GPU 時間の計測 (timestamp-query)。feature が無ければ何もしない (enabled === false)。
//
//   フレームの流れ:
//     simWrites() / drawBegin() / drawEnd() を各パスの timestampWrites に渡す
//     encoder.finish() の前に  const slot = timer.resolve(encoder)
//     submit のあとに          timer.collect(slot)   (非同期。CPU をブロックしない)
//
//   読み戻し用バッファはリングで持ち、空きが無いフレームは計測を飛ばす (描画は止めない)。
//   注意: Chrome は既定でタイムスタンプを粗く丸める (~100us)。
//   --enable-webgpu-developer-features を付けると丸めなしになる。

const QUERY_COUNT = 4;       // 0,1 = sim の開始/終了  2,3 = draw の開始/終了
const SLOTS = 3;

export class GpuTimer {
    constructor(device) {
        this.enabled = device.features.has('timestamp-query');
        this.simMs = null;   // 直近の値 (生の値。平滑化は呼び出し側)
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

    /** compute pass 用 */
    simWrites() {
        if (!this.enabled) return undefined;
        return { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
    }

    /** 描画の最初の render pass 用 (開始時刻だけ) */
    drawBeginWrites() {
        if (!this.enabled) return undefined;
        return { querySet: this.querySet, beginningOfPassWriteIndex: 2 };
    }

    /** 描画の最後の render pass 用 (終了時刻だけ) */
    drawEndWrites() {
        if (!this.enabled) return undefined;
        return { querySet: this.querySet, endOfPassWriteIndex: 3 };
    }

    /** 1 パスで完結する場合 */
    drawWrites() {
        if (!this.enabled) return undefined;
        return { querySet: this.querySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 };
    }

    /** 4 つ全部を書いたあとに呼ぶ。空きスロットが無ければ null。 */
    resolve(encoder) {
        if (!this.enabled) return null;
        const slot = this.slots.find((s) => !s.busy);
        if (!slot) return null;
        slot.busy = true;
        encoder.resolveQuerySet(this.querySet, 0, QUERY_COUNT, this.resolveBuffer, 0);
        encoder.copyBufferToBuffer(this.resolveBuffer, 0, slot.buffer, 0, QUERY_COUNT * 8);
        return slot;
    }

    /** submit のあとに呼ぶ。結果は this.simMs / this.drawMs に入る。 */
    async collect(slot) {
        if (!slot) return;
        try {
            await slot.buffer.mapAsync(GPUMapMode.READ);
            const t = new BigUint64Array(slot.buffer.getMappedRange().slice(0));
            slot.buffer.unmap();
            this.simMs = Number(t[1] - t[0]) / 1e6;
            this.drawMs = Number(t[3] - t[2]) / 1e6;
        } catch {
            // デバイス喪失など。次のフレームで再試行されるだけ
        } finally {
            slot.busy = false;
        }
    }
}
