// Photos and files sent from the phone (decision 252): which one of a message is taken, how big it may be, what
// kinds are refused, and the name it is saved under. Pure: remote/inbound.ts asks, remote/files.ts writes.
import type { TgMessage } from './remote';

/** The largest file the Bot API lets a bot download. */
export const TG_FILE_MAX = 20 * 1024 * 1024;

/** One file to fetch: Telegram's id for it, the name to save it under, and its size when Telegram told it. */
export interface TgAttachment { fileId: string; name: string; size: number | null }

export type PickedFile =
  | { kind: 'file'; file: TgAttachment }
  /** Bigger than a bot may download. */
  | { kind: 'tooBig' }
  /** A kind that runs when it is opened on the computer. */
  | { kind: 'blocked' };

/** Kinds that run, install or open something else when double-clicked on Windows or macOS: never written. */
const RUNS = new Set([
  'exe', 'msi', 'msix', 'appx', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'lnk', 'url', 'hta', 'reg', 'vbs', 'vbe',
  'wsf', 'wsh', 'jse', 'ps1', 'psm1', 'msc', 'jar', 'app', 'command', 'pkg', 'dmg', 'workflow', 'inetloc', 'webloc',
]);

const ext = (name: string) => (/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase();

/** Windows device names, which cannot be a file name with any extension. */
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * A name safe to write in a folder of the app's: the last path part only, without characters Windows or macOS
 * refuse, control characters, leading dots or a trailing dot or space, at most 100 characters (its extension kept).
 */
export function safeFileName(raw: string | undefined, fallback: string): string {
  let name = (raw ?? '').split(/[\\/]/).pop() ?? '';
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!name) name = fallback;
  if (DEVICE.test(name)) name = `_${name}`;
  if (name.length > 100) {
    const e = ext(name);
    const keep = e && e.length < 12 ? `.${e}` : '';
    name = name.slice(0, 100 - keep.length).replace(/[.\s]+$/, '') + keep;
  }
  return name;
}

/**
 * The file a message carries: a photo at its largest size a bot may download, or a document as it was sent.
 * null: the message carries neither (text, a sticker, a voice note...).
 */
export function pickFile(m: Pick<TgMessage, 'photo' | 'document' | 'date'>): PickedFile | null {
  if (m.photo?.length) {
    const fits = m.photo.filter((p) => (p.file_size ?? 0) <= TG_FILE_MAX);
    if (!fits.length) return { kind: 'tooBig' };
    const best = fits.reduce((a, b) => ((b.width ?? 0) * (b.height ?? 0) >= (a.width ?? 0) * (a.height ?? 0) ? b : a));
    const at = new Date(m.date * 1000).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    return { kind: 'file', file: { fileId: best.file_id, name: `photo-${at}.jpg`, size: best.file_size ?? null } };
  }
  const d = m.document;
  if (!d) return null;
  if ((d.file_size ?? 0) > TG_FILE_MAX) return { kind: 'tooBig' };
  const name = safeFileName(d.file_name, 'file');
  if (RUNS.has(ext(name))) return { kind: 'blocked' };
  return { kind: 'file', file: { fileId: d.file_id, name, size: d.file_size ?? null } };
}

/** Telegram's path for a downloaded file, checked before it goes into the download address. */
export function fileUrlPath(p: string): string | null {
  return /^[\w-]+(\/[\w.-]+)*$/.test(p) && !p.split('/').includes('..') ? p : null;
}

/** Photos of one album arrive as messages of their own; they go to the Dispatcher together after this pause. */
export const ALBUM_SETTLE_MS = 1_500;
/** At most this many files go in one message to the Dispatcher. */
export const ALBUM_MAX = 10;
