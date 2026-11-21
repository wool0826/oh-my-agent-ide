// Types for icon-files.mjs, for the tests.
export function ico(images: { size: number; png: Buffer }[]): Buffer;
export function pngRgba(png: Buffer): { width: number; height: number; data: Buffer };
export function rle(bytes: Buffer): Buffer;
export const ICNS_SIZES: number[];
export function icns(pngs: Record<number, Buffer>): Buffer;
