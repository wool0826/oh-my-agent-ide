// File formats for the app icon: the ICO and ICNS containers, and the PNG reader ICNS needs.
// No Electron in here, so the tests can load it.
import zlib from 'node:zlib';

/** ICO container holding PNG images (supported since Windows Vista). `images`: [{ size, png }]. */
export function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const e = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e);
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt8(0, e + 2);
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((x) => x.png)]);
}

/** Pixels of an 8-bit RGBA PNG without interlacing, which is what Chromium writes: { width, height, data } with 4 bytes per pixel. */
export function pngRgba(png) {
  let width = 0, height = 0;
  const idat = [];
  for (let o = 8; o < png.length;) {
    const length = png.readUInt32BE(o);
    const type = png.toString('latin1', o + 4, o + 8);
    const data = png.subarray(o + 8, o + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('expected an 8-bit RGBA PNG without interlacing');
    } else if (type === 'IDAT') idat.push(data);
    o += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (!width || !height || raw.length !== height * (stride + 1)) throw new Error('PNG is incomplete');
  const data = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      // a: the pixel to the left, b: above, c: above left
      const a = x >= 4 ? data[y * stride + x - 4] : 0;
      const b = y ? data[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y ? data[(y - 1) * stride + x - 4] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predicted) & 255;
    }
  }
  return { width, height, data };
}

/** ICNS run-length coding: a byte n below 128 copies the next n + 1 bytes; a byte n from 128 repeats the next byte n - 125 times. */
export function rle(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length;) {
    let run = 1;
    while (run < 130 && i + run < bytes.length && bytes[i + run] === bytes[i]) run++;
    if (run >= 3) {
      out.push(run + 125, bytes[i]);
      i += run;
      continue;
    }
    // Copy up to 128 bytes, stopping where a run of three starts.
    const start = i;
    while (i < bytes.length && i - start < 128 && !(i + 2 < bytes.length && bytes[i] === bytes[i + 1] && bytes[i] === bytes[i + 2])) i++;
    out.push(i - start - 1, ...bytes.subarray(start, i));
  }
  return Buffer.from(out);
}

/** An ICNS "ARGB" image: one run-length coded plane per channel, alpha not premultiplied. */
function argb(png) {
  const { width, height, data } = pngRgba(png);
  const plane = (channel) => Buffer.from(Uint8Array.from({ length: width * height }, (_, i) => data[i * 4 + channel]));
  return Buffer.concat([Buffer.from('ARGB', 'latin1'), ...[3, 0, 1, 2].map((channel) => rle(plane(channel)))]);
}

// Same entries, in the same order, as electron-builder's own PNG to ICNS converter writes:
// ARGB at 16 and 32 px, PNG for the rest. ic11 to ic14 are the @2x slots of 16, 32, 128 and 256 pt.
const ICNS_ENTRIES = [['ic04', 16], ['ic05', 32], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
export const ICNS_SIZES = [...new Set(ICNS_ENTRIES.map(([, size]) => size))].sort((a, b) => a - b);

/** ICNS container. `pngs`: the PNG for each pixel size in ICNS_SIZES, keyed by size. */
export function icns(pngs) {
  const entries = ICNS_ENTRIES.map(([type, size]) => {
    if (!pngs[size]) throw new Error(`no ${size} px image for ${type}`);
    const data = type === 'ic04' || type === 'ic05' ? argb(pngs[size]) : pngs[size];
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(8 + entries.reduce((n, e) => n + e.length, 0), 4);
  return Buffer.concat([head, ...entries]);
}
