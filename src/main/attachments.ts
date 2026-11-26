/* eslint-disable @typescript-eslint/no-explicit-any -- tool input is whatever the model sent, read field by field. */
import fs from 'node:fs';
import path from 'node:path';
import { store } from './store';
import { uid } from './util';
import { PASTE_IMAGE_MAX, pastedImageName } from '../shared/paste';
import { t } from './i18n';

/**
 * Files the user dragged into a message. We pass their paths, not their contents;
 * agents may read anything at or under these paths without asking.
 */

const norm = (p: string) => path.resolve(p).toLowerCase();

export function registerAttachments(files: string[]): string[] {
  const ok = files.filter((f) => typeof f === 'string' && f && fs.existsSync(f)).map((f) => path.resolve(f));
  if (!ok.length) return [];
  const list = (store.data.attachments ??= []);
  for (const f of ok) if (!list.includes(f)) list.push(f);
  if (list.length > 500) list.splice(0, list.length - 500);
  store.changed();
  return ok;
}

export function isAttached(p: string): boolean {
  if (!p) return false;
  const target = norm(p);
  return (store.data.attachments ?? []).some((a) => {
    const base = norm(a);
    return target === base || target.startsWith(base + path.sep);
  });
}

/** Writes an image pasted from the clipboard (a screenshot, no file behind it) under `dir` and returns its path. */
export function savePastedImage(dir: string, type: string, bytes: Uint8Array, at = new Date()): string {
  const name = pastedImageName(type, at, uid());
  if (!name) throw new Error(t('err.pasteType', { type: type || '?' }));
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > PASTE_IMAGE_MAX) throw new Error(t('err.pasteSize'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

/** The text block appended to a message that carries attachments. */
export function attachmentBlock(files: string[]) {
  return files.length ? `\n\n[Attached files]\n${files.map((f) => `- ${f}`).join('\n')}` : '';
}

/** Path argument of a read-only tool call, if any. */
export function readPath(tool: string, input: any): string | null {
  if (tool === 'Read') return String(input?.file_path ?? '');
  if (tool === 'Glob' || tool === 'Grep') return input?.path ? String(input.path) : null;
  return null;
}
