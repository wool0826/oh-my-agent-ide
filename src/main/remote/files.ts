// Where photos and files from the phone are written (decision 252): each in a folder of its own under
// <data>/telegram, so two files of one name never meet and the name sent stays as it was (made safe first).
import fs from 'node:fs';
import path from 'node:path';
import { uid } from '../util';

/** Writes `bytes` as `name` (already a safe name, remoteFile.ts) in a new folder under `dir`; returns its path. */
export function saveRemoteFile(dir: string, name: string, bytes: Uint8Array, at = new Date()): string {
  const day = at.toISOString().slice(0, 10).replace(/-/g, '');
  const folder = path.join(dir, `${day}-${uid().slice(0, 8)}`);
  const file = path.join(folder, name);
  // The name is one path part; anything that still leads elsewhere is refused.
  if (path.dirname(path.resolve(file)) !== path.resolve(folder)) throw new Error('bad file name');
  fs.mkdirSync(folder, { recursive: true });
  // 'wx': never over a file that is already there.
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return file;
}
