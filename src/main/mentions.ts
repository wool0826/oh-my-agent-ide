import { store } from './store';
import { paths } from './paths';
import { log } from './log';
import { listFiles } from './gitwork';
import { MENTION_FILES_MAX, repoWhere } from '../shared/mentions';

// The file index behind "@" (shared/mentions.ts): each registered repository's files, read with git ls-files and
// read again when a list opens after FRESH_MS. A list shows the files already read while a new read runs.

const FRESH_MS = 60_000;
const cache = new Map<string, { files: string[]; at: number }>();
let job: Promise<void> | null = null;
let failed = false;

function start(force: boolean) {
  if (job) return;
  failed = false;
  job = (async () => {
    for (const r of [...store.data.repos]) {
      const had = cache.get(r.name);
      if (!force && had && Date.now() - had.at <= FRESH_MS) continue;
      try {
        cache.set(r.name, { files: await listFiles(r.path, MENTION_FILES_MAX), at: Date.now() });
      } catch (e) {
        failed = true;
        log.warn('mentions', `file index of ${r.name}: ${(e as Error).message}`);
      }
    }
    for (const name of [...cache.keys()]) if (!store.repo(name)) cache.delete(name);
  })().finally(() => { job = null; });
}

export interface MentionIndex {
  /** 'indexing' while a repository has never been read; 'error' when one could not be. */
  state: 'ready' | 'indexing' | 'error';
  count: number;
  repos: { name: string; where: string; files: string[] }[];
}

/** The index for a list that opens. `wait`: once the read under way ends. `retry`: read every repository again. */
export async function mentionIndex(opts: { wait?: boolean; retry?: boolean } = {}): Promise<MentionIndex> {
  const stale = store.data.repos.some((r) => { const c = cache.get(r.name); return !c || Date.now() - c.at > FRESH_MS; });
  if (!opts.wait && (opts.retry || stale)) start(!!opts.retry);
  if (opts.wait && job) await job;
  const repos = store.data.repos.map((r) => ({ name: r.name, where: repoWhere(r, paths().repos), files: cache.get(r.name)?.files ?? [] }));
  const missing = store.data.repos.some((r) => !cache.has(r.name));
  return {
    state: missing && job ? 'indexing' : missing && failed ? 'error' : 'ready',
    count: repos.reduce((n, r) => n + r.files.length, 0),
    repos,
  };
}
