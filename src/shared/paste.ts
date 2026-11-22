/** What a paste into a composer carries, decided from the clipboard alone so it can be tested without a window. */

/** One clipboard file: its local path ('' for a screenshot or other data with no file behind it) and its type. */
export interface PastedFile { path: string; type: string }

export type PastePlan =
  /** Leave it to the textarea: plain text, or something we cannot attach. */
  | { kind: 'text' }
  /** Files copied in Explorer or Finder: attach these paths, as a drop would. */
  | { kind: 'paths'; paths: string[] }
  /** A bare image (a screenshot): save it, then attach the saved file. Indexes into the file list. */
  | { kind: 'images'; files: number[] };

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };

/** The largest pasted image we write to disk. */
export const PASTE_IMAGE_MAX = 25 * 1024 * 1024;

export function planPaste(files: PastedFile[], hasText: boolean): PastePlan {
  const paths = [...new Set(files.map((f) => f.path).filter(Boolean))];
  if (paths.length) return { kind: 'paths', paths };
  // Rich text from an editor or a page often brings an image of itself along; the text is what was meant.
  if (hasText) return { kind: 'text' };
  const images = files.map((f, i) => (IMAGE_EXT[f.type] ? i : -1)).filter((i) => i >= 0);
  return images.length ? { kind: 'images', files: images } : { kind: 'text' };
}

/** File name for a pasted image, or null for a type we do not save. */
export function pastedImageName(type: string, at: Date, id: string): string | null {
  const ext = IMAGE_EXT[type];
  if (!ext) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `pasted-${stamp}-${id.replace(/[^a-z0-9]/gi, '').slice(0, 8)}.${ext}`;
}
