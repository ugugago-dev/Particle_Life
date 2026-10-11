// Minimal dependency-free PNG encode / decode (8-bit RGB/RGBA, non-interlaced) for the render harness.
import zlib from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

/** rgba: Uint8Array/Buffer of width*height*4 */
export function encodePng(width, height, rgba) {
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** @returns {{width: number, height: number, data: Uint8Array}} RGBA */
export function decodePng(buf) {
    let pos = 8, width = 0, height = 0, ctype = 0; const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), body = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            width = body.readUInt32BE(0); height = body.readUInt32BE(4); ctype = body[9];
            if (body[8] !== 8 || body[12] !== 0 || (ctype !== 2 && ctype !== 6)) throw new Error('unsupported PNG (need 8-bit RGB/RGBA, non-interlaced)');
        } else if (type === 'IDAT') idat.push(body);
        pos += 12 + len;
    }
    const bpp = ctype === 6 ? 4 : 3, stride = width * bpp;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const cur = new Uint8Array(stride), prev = new Uint8Array(stride), data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
            let p = 0;
            if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
            else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
            cur[i] = (line[i] + p) & 255;
        }
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4;
            data[o] = cur[x * bpp]; data[o + 1] = cur[x * bpp + 1]; data[o + 2] = cur[x * bpp + 2]; data[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
        }
        prev.set(cur);
    }
    return { width, height, data };
}
