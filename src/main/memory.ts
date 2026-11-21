import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths';
import { loadSettings } from './settings';
import { debounce, ensureDir, month, run, today } from './util';
import { log } from './log';
import { t } from './i18n';
import type { MemoryFile, MemoryHit, MemoryHits } from '../shared/types';

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
}

const commitSoon = debounce(async (msg: string) => {
  const cwd = root();
  await run('git', ['add', '-A'], { cwd });
  const st = await run('git', ['status', '--porcelain'], { cwd });
  if (!st.stdout.trim()) return;
  await run('git', [...GIT_ID, 'commit', '-q', '-m', msg], { cwd });
  const remote = loadSettings().memoryRemote.trim();
  if (remote) {
    const has = await run('git', ['remote', 'get-url', 'origin'], { cwd });
    if (has.code !== 0) await run('git', ['remote', 'add', 'origin', remote], { cwd });
    else if (has.stdout.trim() !== remote) await run('git', ['remote', 'set-url', 'origin', remote], { cwd });
    const r = await run('git', ['push', '-q', '-u', 'origin', 'HEAD'], { cwd, timeoutMs: 60_000 });
    if (r.code !== 0) log.warn('memory push failed', r.stderr.trim());
  }
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
  const body = text.trim().replace(/\n/g, '\n  ');
  fs.appendFileSync(f, `- ${body} _(${today()}${source ? `, source: ${source}` : ''})_\n`, 'utf8');
  commitSoon(`${scope}: ${text.slice(0, 60)}`);
  return path.relative(root(), f).replace(/\\/g, '/');
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
