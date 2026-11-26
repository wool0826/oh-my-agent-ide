import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { paths } from './paths';
import { loadSettings } from './settings';
import { debounce, ensureDir, month, nowIso, run, today } from './util';
import { commitAll, syncRepo } from './memorySync';
import { log } from './log';
import { t } from './i18n';
import { alreadySaved, cleanDecisionFile } from '../shared/decisionMemory';
import type { MemoryFile, MemoryHit, MemoryHits, MemorySync } from '../shared/types';

/**
 * IDE memory: markdown under <home>/memory is the source of truth, versioned with git.
 * There are few files, so search reads them each time and scores by word matches.
 */

const root = () => paths().memory;
const GIT_ID = ['-c', 'user.name=Oh My Agent IDE', '-c', 'user.email=ide@localhost'];

export async function initMemory() {
  ensureDir(root());
  ensureDir(path.join(root(), 'repos'));
  ensureDir(path.join(root(), 'decisions'));
  ensureDir(path.join(root(), 'tasks'));
  const pref = path.join(root(), 'preferences.md');
  if (!fs.existsSync(pref)) fs.writeFileSync(pref, `# ${t('mem.prefTitle')}\n\n${t('mem.prefIntro')}\n`, 'utf8');
  if (!fs.existsSync(path.join(root(), '.git'))) {
    await run('git', ['init', '-q'], { cwd: root() });
    await run('git', ['add', '-A'], { cwd: root() });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'Start memory'], { cwd: root() });
  }
  if (cleanDecisionFiles() > 0) await inTurn(() => commitAll(root(), 'Remove permission answers and repeats from decisions'));
  // What another PC saved comes in at launch; commits a failed push left behind go out.
  void syncMemory();
}

/**
 * 'synced' after each sync (the status changed), 'pulled' when a sync merged commits from the remote
 * (memory files changed on disk, so whoever holds them in a prompt reads them again).
 */
export const memoryEvents = new EventEmitter();

let sync: MemorySync = { remote: false, state: 'off', at: null, error: null, pulled: 0, pushed: 0, pending: 0 };
export const memorySync = (): MemorySync => ({ ...sync, remote: !!loadSettings().memoryRemote.trim() });

/** git runs one at a time on the folder: a commit never starts while a merge or push is under way. */
let chain: Promise<unknown> = Promise.resolve();
const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
};

async function syncNow() {
  const remote = loadSettings().memoryRemote.trim();
  if (!remote) {
    sync = { remote: false, state: 'off', at: null, error: null, pulled: 0, pushed: 0, pending: 0 };
    memoryEvents.emit('synced');
    return;
  }
  sync = { ...sync, remote: true, state: 'syncing' };
  memoryEvents.emit('synced');
  const r = await syncRepo(root(), remote);
  if (!r.ok) log.warn('memory sync failed', r.error ?? '');
  sync = { remote: true, state: r.ok ? 'ok' : 'error', at: nowIso(), error: r.error, pulled: r.pulled, pushed: r.pushed, pending: r.pending };
  if (r.pulled > 0) memoryEvents.emit('pulled');
  memoryEvents.emit('synced');
}

/** Sync with the remote now: at launch, when its address changes, and from "Sync now". */
export function syncMemory(): Promise<void> {
  return inTurn(async () => {
    await commitAll(root(), 'Memory changes');
    await syncNow();
  });
}

const commitSoon = debounce((msg: string) => {
  void inTurn(async () => {
    await commitAll(root(), msg);
    // Also when nothing was committed: an earlier push may have failed and left commits behind.
    await syncNow();
  });
}, 1500);

function fileFor(scope: string, repo?: string | null) {
  switch (scope) {
    case 'preference': return path.join(root(), 'preferences.md');
    case 'repo': return path.join(root(), 'repos', `${(repo || 'misc').replace(/[^\w.-]+/g, '-')}.md`);
    case 'decision': return path.join(root(), 'decisions', `${month()}.md`);
    case 'task': return path.join(root(), 'tasks', `${month()}.md`);
    default: return path.join(root(), 'notes.md');
  }
}

/** source: where the fact came from (task, Worker, decision ids), kept after the date. */
export function remember(scope: 'preference' | 'repo' | 'decision' | 'task' | 'note', text: string, repo?: string | null, source?: string) {
  const f = fileFor(scope, repo);
  ensureDir(path.dirname(f));
  if (!fs.existsSync(f)) {
    const title = scope === 'repo' ? t('mem.repoTitle', { name: repo ?? '' })
      : scope === 'decision' ? t('mem.decTitle', { month: month() })
      : scope === 'task' ? t('mem.taskTitle', { month: month() })
      : t('mem.notesTitle');
    fs.writeFileSync(f, `# ${title}\n\n`, 'utf8');
  }
  // A decision already saved, on any day, is not saved again.
  if (scope === 'decision' && alreadySaved(fs.readFileSync(f, 'utf8'), text)) return path.relative(root(), f).replace(/\\/g, '/');
  const body = text.trim().replace(/\n/g, '\n  ');
  fs.appendFileSync(f, `- ${body} _(${today()}${source ? `, source: ${source}` : ''})_\n`, 'utf8');
  commitSoon(`${scope}: ${text.slice(0, 60)}`);
  return path.relative(root(), f).replace(/\\/g, '/');
}

/**
 * Take out of memory/decisions/*.md the permission answers and repeats saved before worthRemembering
 * (shared/decisionMemory.ts) chose what goes there. Each file it changes is copied to data/backups first, as it was.
 * Run at launch; a file with nothing to take out is not touched. Returns how many entries went.
 */
export function cleanDecisionFiles(): number {
  const dir = path.join(root(), 'decisions');
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { return 0; }
  let total = 0;
  const stamp = nowIso().replace(/[:.]/g, '-');
  for (const name of names) {
    const f = path.join(dir, name);
    try {
      const before = fs.readFileSync(f, 'utf8');
      const r = cleanDecisionFile(before);
      if (!r.removed) continue;
      ensureDir(paths().backups);
      fs.copyFileSync(f, path.join(paths().backups, `memory-decisions-${name.replace(/\.md$/, '')}-${stamp}.md`));
      fs.writeFileSync(f, r.text, 'utf8');
      total += r.removed;
      log.info(`memory: decisions/${name}: removed ${r.noise} permission and approval answers and ${r.repeats} repeats`);
    } catch (e) {
      log.warn(`memory: could not clean decisions/${name}`, (e as Error).message);
    }
  }
  return total;
}

/** Revise one preference line: replace the line holding the old text, or append. */
export function revisePreference(oldText: string, newText: string) {
  const f = fileFor('preference');
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const key = oldText.trim().slice(0, 40);
  const idx = key ? lines.findIndex((l) => l.includes(key)) : -1;
  const line = `- ${newText.trim()} _(${today()}, ${t('mem.corrected')})_`;
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  fs.writeFileSync(f, lines.join('\n'), 'utf8');
  commitSoon(`preference corrected: ${newText.slice(0, 60)}`);
}

function walk(dir: string, out: string[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

export function listMemory(): MemoryFile[] {
  if (!fs.existsSync(root())) return [];
  return walk(root()).map((p) => {
    const rel = path.relative(root(), p).replace(/\\/g, '/');
    const st = fs.statSync(p);
    const first = fs.readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith('# '));
    const kind: MemoryFile['kind'] = rel === 'preferences.md' ? 'preference' : rel.startsWith('repos/') ? 'repo' : rel.startsWith('decisions/') ? 'decision' : rel.startsWith('tasks/') ? 'task' : 'other';
    return { path: rel, title: first ? first.slice(2).trim() : rel, kind, size: st.size, updatedAt: st.mtime.toISOString() };
  }).sort((a, b) => (a.kind === 'preference' ? -1 : b.kind === 'preference' ? 1 : b.updatedAt.localeCompare(a.updatedAt)));
}

function inside(rel: string) {
  const p = path.resolve(root(), rel);
  if (!p.startsWith(path.resolve(root()))) throw new Error(t('mem.err.outside'));
  return p;
}

export function readMemory(rel: string) {
  return fs.readFileSync(inside(rel), 'utf8');
}

export function writeMemory(rel: string, content: string) {
  fs.writeFileSync(inside(rel), content, 'utf8');
  commitSoon(`edited: ${rel}`);
}

function terms(q: string) {
  return q.toLowerCase().split(/[\s,.;:!?()"'`[\]{}]+/).filter((x) => x.length >= 2);
}

export function searchMemory(query: string, limit = 8): MemoryHit[] {
  return searchMemoryPage(query, 0, limit).hits;
}

/** Hits `offset` to `offset + limit`, best first, out of `total` (the Memory view's "Show more", decision 85). */
export function searchMemoryPage(query: string, offset: number, limit: number): MemoryHits {
  const ts = terms(query);
  if (!ts.length || !fs.existsSync(root())) return { hits: [], total: 0 };
  const hits: MemoryHit[] = [];
  for (const p of walk(root())) {
    const rel = path.relative(root(), p).replace(/\\/g, '/');
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      const l = line.toLowerCase();
      let score = 0;
      for (const x of ts) if (l.includes(x)) score += x.length >= 4 ? 2 : 1;
      if (score > 0 && line.trim().length > 2) hits.push({ path: rel, line: i + 1, text: line.trim(), score: score + (rel === 'preferences.md' ? 1 : 0) });
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(offset, offset + limit), total: hits.length };
}

/** Digest for the Dispatcher system prompt: all preferences and the start of each repo note. */
export function memoryDigest(maxChars = 6000) {
  const parts: string[] = [];
  try { parts.push(fs.readFileSync(fileFor('preference'), 'utf8')); } catch { /* none yet */ }
  try {
    for (const f of fs.readdirSync(path.join(root(), 'repos'))) {
      parts.push(fs.readFileSync(path.join(root(), 'repos', f), 'utf8').slice(0, 1200));
    }
  } catch { /* none yet */ }
  const s = parts.join('\n\n');
  return s.length > maxChars ? s.slice(0, maxChars) + '\n…' : s;
}
