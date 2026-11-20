import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths';
import { loadSettings } from './settings';
import { debounce, ensureDir, month, run, today } from './util';
import { log } from './log';
import type { MemoryFile, MemoryHit } from '../shared/types';

/**
 * IDE 메모리: 홈/memory 아래 마크다운이 원본이고 git으로 버전을 남긴다.
 * 검색은 파일이 많지 않아 매번 읽어서 단어 일치로 점수를 매긴다.
 */

const root = () => paths().memory;

export async function initMemory() {
  ensureDir(root());
  ensureDir(path.join(root(), 'repos'));
  ensureDir(path.join(root(), 'decisions'));
  ensureDir(path.join(root(), 'tasks'));
  const pref = path.join(root(), 'preferences.md');
  if (!fs.existsSync(pref)) fs.writeFileSync(pref, '# 선호와 원칙\n\n사용자가 밝힌 선호, 반복해서 쓰는 원칙을 적습니다. Dispatcher가 대신 답할 때 근거로 씁니다.\n', 'utf8');
  if (!fs.existsSync(path.join(root(), '.git'))) {
    await run('git', ['init', '-q'], { cwd: root() });
    await run('git', ['add', '-A'], { cwd: root() });
    await run('git', ['-c', 'user.name=Oh My Agent IDE', '-c', 'user.email=ide@localhost', 'commit', '-q', '-m', '메모리 시작'], { cwd: root() });
  }
}

const commitSoon = debounce(async (msg: string) => {
  const cwd = root();
  await run('git', ['add', '-A'], { cwd });
  const st = await run('git', ['status', '--porcelain'], { cwd });
  if (!st.stdout.trim()) return;
  await run('git', ['-c', 'user.name=Oh My Agent IDE', '-c', 'user.email=ide@localhost', 'commit', '-q', '-m', msg], { cwd });
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

export function remember(scope: 'preference' | 'repo' | 'decision' | 'task' | 'note', text: string, repo?: string | null) {
  const f = fileFor(scope, repo);
  ensureDir(path.dirname(f));
  if (!fs.existsSync(f)) {
    const title = scope === 'repo' ? `# ${repo} 저장소` : scope === 'decision' ? `# ${month()} 결정` : scope === 'task' ? `# ${month()} 작업` : '# 메모';
    fs.writeFileSync(f, title + '\n\n', 'utf8');
  }
  const body = text.trim().replace(/\n/g, '\n  ');
  fs.appendFileSync(f, `- ${body} _(${today()})_\n`, 'utf8');
  commitSoon(`${scope}: ${text.slice(0, 60)}`);
  return path.relative(root(), f).replace(/\\/g, '/');
}

/** 선호 한 줄을 고친다: 같은 내용을 가진 줄을 찾아 바꾸고, 없으면 새로 적는다. */
export function revisePreference(oldText: string, newText: string) {
  const f = fileFor('preference');
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  const key = oldText.trim().slice(0, 40);
  const idx = key ? lines.findIndex((l) => l.includes(key)) : -1;
  if (idx >= 0) lines[idx] = `- ${newText.trim()} _(${today()} 정정)_`;
  else lines.push(`- ${newText.trim()} _(${today()} 정정)_`);
  fs.writeFileSync(f, lines.join('\n'), 'utf8');
  commitSoon(`preference 정정: ${newText.slice(0, 60)}`);
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

export function readMemory(rel: string) {
  const p = path.resolve(root(), rel);
  if (!p.startsWith(path.resolve(root()))) throw new Error('메모리 폴더 밖은 읽을 수 없어요.');
  return fs.readFileSync(p, 'utf8');
}

export function writeMemory(rel: string, content: string) {
  const p = path.resolve(root(), rel);
  if (!p.startsWith(path.resolve(root()))) throw new Error('메모리 폴더 밖에는 쓸 수 없어요.');
  fs.writeFileSync(p, content, 'utf8');
  commitSoon(`직접 수정: ${rel}`);
}

function terms(q: string) {
  return q.toLowerCase().split(/[\s,.;:!?()"'`[\]{}]+/).filter((t) => t.length >= 2);
}

export function searchMemory(query: string, limit = 8): MemoryHit[] {
  const ts = terms(query);
  if (!ts.length || !fs.existsSync(root())) return [];
  const hits: MemoryHit[] = [];
  for (const p of walk(root())) {
    const rel = path.relative(root(), p).replace(/\\/g, '/');
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const l = line.toLowerCase();
      let score = 0;
      for (const t of ts) if (l.includes(t)) score += t.length >= 4 ? 2 : 1;
      if (score > 0 && line.trim().length > 2) hits.push({ path: rel, line: i + 1, text: line.trim(), score: score + (rel === 'preferences.md' ? 1 : 0) });
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Dispatcher 시스템 프롬프트에 넣을 요약: 선호 전체와 저장소 메모 앞부분. */
export function memoryDigest(maxChars = 6000) {
  const parts: string[] = [];
  try { parts.push(fs.readFileSync(fileFor('preference'), 'utf8')); } catch { /* 없음 */ }
  try {
    for (const f of fs.readdirSync(path.join(root(), 'repos'))) {
      parts.push(fs.readFileSync(path.join(root(), 'repos', f), 'utf8').slice(0, 1200));
    }
  } catch { /* 없음 */ }
  const s = parts.join('\n\n');
  return s.length > maxChars ? s.slice(0, maxChars) + '\n…' : s;
}
