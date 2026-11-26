// Just enough PNG for the screen comparison (test/e2e/visual.e2e.mjs), without a dependency: reads the 8-bit RGB or
// RGBA pictures Chromium takes, compares two of them, and writes the picture of where they differ.
import zlib from 'node:zlib';

/** Width, height and the pixels as RGBA bytes of an 8-bit, non-interlaced RGB or RGBA PNG. */
export function decode(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let w = 0, h = 0, bpp = 0;
  const idat = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p), kind = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8 || (data[9] !== 2 && data[9] !== 6) || data[12]) throw new Error(`unsupported PNG (depth ${data[8]}, colour type ${data[9]}, interlace ${data[12]})`);
      bpp = data[9] === 6 ? 4 : 3;
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    p += 12 + len;
    if (p > buf.length) throw new Error('a cut-off PNG');
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp, px = Buffer.alloc(w * h * 4);
  if (!bpp || raw.length !== h * (stride + 1)) throw new Error(`a broken PNG (${raw.length} bytes of pixels for ${w}×${h})`);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    if (f > 4) throw new Error(`a broken PNG (filter ${f} on row ${y})`);
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (f === 1) add = a;
      else if (f === 2) add = b;
      else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = (line[i] + add) & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      line.copy(px, o, x * bpp, x * bpp + 3);
      px[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { w, h, px };
}

/** An RGBA picture as a PNG. */
export function encode({ w, h, px }) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (kind, data) => {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(kind, 'latin1'), data]);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Compares two pictures of the same size. A pixel differs when one of its channels is more than `threshold` apart.
 * Returns how many differ, and a picture of the expected one, faded, with those pixels in red.
 */
export function compare(expected, actual, threshold) {
  if (expected.w !== actual.w || expected.h !== actual.h) return { size: false, differ: expected.w * expected.h, diff: null };
  const a = expected.px, b = actual.px, out = Buffer.alloc(a.length);
  let differ = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
    if (d > threshold) { differ++; out[i] = 255; out[i + 1] = 0; out[i + 2] = 0; } else {
      const g = 255 - Math.round((255 - (a[i] * 0.3 + a[i + 1] * 0.59 + a[i + 2] * 0.11)) * 0.25);
      out[i] = out[i + 1] = out[i + 2] = g;
    }
    out[i + 3] = 255;
  }
  return { size: true, differ, diff: { w: expected.w, h: expected.h, px: out } };
}
