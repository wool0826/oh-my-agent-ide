import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { ico, icns, ICNS_SIZES, pngRgba, rle } from '../scripts/icon-files.mjs';

/** Decodes ICNS run-length coding, written from the format rather than from the encoder. */
function unrle(d: Buffer, start: number, count: number) {
  const out: number[] = [];
  let p = start;
  while (out.length < count) {
    const n = d[p++];
    if (n < 128) for (let i = 0; i <= n; i++) out.push(d[p++]);
    else { const v = d[p++]; for (let i = 0; i < n - 125; i++) out.push(v); }
  }
  return { bytes: out, next: p };
}

/** An 8-bit RGBA PNG whose rows use the given filter types. */
function png(width: number, height: number, rgba: number[], filters: number[]) {
  const stride = width * 4;
  const at = (x: number, y: number) => (x < 0 || y < 0 ? 0 : rgba[y * stride + x]);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length];
    raw.push(f);
    for (let x = 0; x < stride; x++) {
      const a = at(x - 4, y), b = at(x, y - 1), c = x >= 4 ? at(x - 4, y - 1) : 0;
      const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f];
      raw.push((at(x, y) - predicted) & 255);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  // Two IDAT chunks: a reader has to join them before inflating.
  const idat = zlib.deflateSync(Buffer.from(raw));
  const cut = idat.length >> 1;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat.subarray(0, cut)), chunk('IDAT', idat.subarray(cut)), chunk('IEND', Buffer.alloc(0))]);
}

/** Pixels that give every channel short runs, long runs and stretches with no repeats. */
function pixels(width: number, height = width) {
  const out: number[] = [];
  for (let i = 0; i < width * height; i++) out.push((i * 7) & 255, i < width * 9 ? 40 : (i * 13) & 255, (i >> 3) & 255, i % width < 3 ? 0 : 255);
  return out;
}

test('icon files: run-length coding round-trips runs of every kind', () => {
  const cases = [
    [],
    [5],
    [1, 2, 3],
    [9, 9],
    [9, 9, 9],
    Array(130).fill(7),
    Array(131).fill(7),
    Array(400).fill(0),
    Array.from({ length: 300 }, (_, i) => i & 255),
    [1, 2, 2, 3, 3, 3, 4, 4, 4, 4, 5],
    [...Array(127).fill(0).map((_, i) => i), 200, 200, 200, 1],
  ];
  for (const bytes of cases) {
    const coded = rle(Buffer.from(bytes));
    const { bytes: back, next } = unrle(coded, 0, bytes.length);
    assert.deepEqual(back, bytes);
    assert.equal(next, coded.length);
  }
  // A run packs into two bytes; 131 equal bytes need a second code.
  assert.deepEqual([...rle(Buffer.from(Array(130).fill(7)))], [255, 7]);
  assert.deepEqual([...rle(Buffer.from(Array(131).fill(7)))], [255, 7, 0, 7]);
  assert.deepEqual([...rle(Buffer.from([1, 2, 3]))], [2, 1, 2, 3]);
});

test('icon files: the PNG reader undoes every row filter', () => {
  const rgba = pixels(5, 6);
  for (const filters of [[0], [1], [2], [3], [4], [4, 3, 2, 1, 0]]) {
    const read = pngRgba(png(5, 6, rgba, filters));
    assert.equal(read.width, 5);
    assert.equal(read.height, 6);
    assert.deepEqual([...read.data], rgba, `filters ${filters}`);
  }
  // Only 8-bit RGBA is read; anything else is refused rather than misread.
  const rgb = png(1, 1, [1, 2, 3, 4], [0]);
  rgb[25] = 2;
  assert.throws(() => pngRgba(rgb), /8-bit RGBA/);
  // Fewer rows than the header promises would leave pixels unset.
  const short = png(5, 6, rgba, [0]);
  short.writeUInt32BE(7, 20);
  assert.throws(() => pngRgba(short), /incomplete/);
});

test('icon files: ICNS holds the entries macOS expects, ARGB at 16 and 32 px', () => {
  assert.deepEqual(ICNS_SIZES, [16, 32, 64, 128, 256, 512, 1024]);
  const pngs: Record<number, Buffer> = {};
  // Only 16 and 32 px are decoded; the larger ones are stored as given.
  for (const size of ICNS_SIZES) pngs[size] = size <= 32 ? png(size, size, pixels(size), [4, 1]) : Buffer.from(`png ${size}`);
  const file = icns(pngs);
  assert.equal(file.toString('latin1', 0, 4), 'icns');
  assert.equal(file.readUInt32BE(4), file.length);

  const entries: [string, Buffer][] = [];
  for (let o = 8; o < file.length;) {
    const length = file.readUInt32BE(o + 4);
    entries.push([file.toString('latin1', o, o + 4), file.subarray(o + 8, o + length)]);
    o += length;
  }
  assert.deepEqual(entries.map(([type]) => type), ['ic04', 'ic05', 'ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']);
  const sizes: Record<string, number> = { ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512 };
  for (const [type, data] of entries.slice(2)) assert.ok(data.equals(pngs[sizes[type]]), type);

  // ARGB: the four planes in the order A, R, G, B, alpha not premultiplied.
  for (const [type, size] of [['ic04', 16], ['ic05', 32]] as const) {
    const data = entries.find(([t]) => t === type)![1];
    assert.equal(data.toString('latin1', 0, 4), 'ARGB');
    const want = pixels(size);
    let p = 4;
    for (const channel of [3, 0, 1, 2]) {
      const { bytes, next } = unrle(data, p, size * size);
      assert.deepEqual(bytes, want.filter((_, i) => i % 4 === channel), `${type} channel ${channel}`);
      p = next;
    }
    assert.equal(p, data.length);
  }
  assert.throws(() => icns({ 16: pngs[16] }), /no 32 px image/);
});

test('icon files: ICO directory points at each PNG', () => {
  const images = [16, 48, 256].map((size) => ({ size, png: Buffer.from(`png-${size}`) }));
  const file = ico(images);
  assert.deepEqual([file.readUInt16LE(0), file.readUInt16LE(2), file.readUInt16LE(4)], [0, 1, 3]);
  images.forEach(({ size, png: data }, i) => {
    const e = 6 + i * 16;
    // 256 px is written as 0.
    assert.equal(file[e], size === 256 ? 0 : size);
    assert.equal(file[e + 1], size === 256 ? 0 : size);
    assert.equal(file.readUInt16LE(e + 6), 32);
    const length = file.readUInt32LE(e + 8), offset = file.readUInt32LE(e + 12);
    assert.equal(file.subarray(offset, offset + length).toString(), data.toString());
  });
});
