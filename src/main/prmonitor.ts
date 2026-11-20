import { store } from './store';
import { workers } from './agents/workers';
import { cleanupBranch, ghEnv } from './repos';
import { run } from './util';
import { log } from './log';
import { nowIso } from './util';
import type { Task } from '../shared/types';

/**
 * 열린 PR을 주기적으로 본다.
 * - 머지되거나 닫히면 브랜치(로컬, 원격)를 지우고 작업을 끝낸다.
 * - 새 리뷰 코멘트가 달리면 PR을 만든 Worker에게 반영을 맡긴다.
 */

function parsePr(url: string) {
  const m = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { host: m[1], owner: m[2], repo: m[3], num: m[4] } : null;
}

interface Comment { id: string; author: string; body: string; where: string }

async function fetchComments(t: Task): Promise<Comment[] | null> {
  const p = parsePr(t.prUrl!);
  if (!p) return null;
  const env = { ...ghEnv(), GH_HOST: p.host };
  const out: Comment[] = [];
  const view = await run('gh', ['pr', 'view', t.prUrl!, '--json', 'comments,reviews'], { env, timeoutMs: 60_000 });
  if (view.code !== 0) return null;
  const j = JSON.parse(view.stdout);
  for (const c of j.comments ?? []) out.push({ id: `c:${c.id}`, author: c.author?.login ?? '?', body: c.body ?? '', where: '대화' });
  for (const r of j.reviews ?? []) if (r.body?.trim()) out.push({ id: `r:${r.id}`, author: r.author?.login ?? '?', body: r.body, where: `리뷰(${r.state})` });
  const inline = await run('gh', ['api', `repos/${p.owner}/${p.repo}/pulls/${p.num}/comments`, '--paginate'], { env, timeoutMs: 60_000 });
  if (inline.code === 0) {
    try {
      for (const c of JSON.parse(inline.stdout)) out.push({ id: `i:${c.id}`, author: c.user?.login ?? '?', body: c.body ?? '', where: `${c.path}:${c.line ?? c.original_line ?? ''}` });
    } catch { /* 페이지가 여러 개면 JSON 배열이 이어 붙어 올 수 있음. 첫 페이지만 쓴다. */ }
  }
  return out.filter((c) => !/\[bot\]$/.test(c.author));
}

async function checkOne(t: Task) {
  const p = parsePr(t.prUrl!);
  if (!p) return;
  const env = { ...ghEnv(), GH_HOST: p.host };
  const r = await run('gh', ['pr', 'view', t.prUrl!, '--json', 'state,headRefName'], { env, timeoutMs: 60_000 });
  if (r.code !== 0) {
    log.warn('pr view failed', t.prUrl, r.stderr.trim().slice(0, 200));
    return;
  }
  const j = JSON.parse(r.stdout) as { state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefName: string };
  if (j.state !== 'OPEN') {
    t.prState = j.state;
    t.status = 'done';
    t.updatedAt = nowIso();
    const repo = t.repo ? store.repo(t.repo) : null;
    const w = t.workerId ? store.worker(t.workerId) : null;
    const branch = t.branch ?? j.headRefName;
    if (repo && branch) await cleanupBranch(repo, w?.repo === repo.name ? w.cwd : null, branch).catch((e) => log.warn('cleanup', e));
    store.chat('event', `${t.title} PR이 ${j.state === 'MERGED' ? '머지돼' : '닫혀'} 브랜치를 정리했어요`);
    store.pushUpdate(`${t.id} "${t.title}" PR ${j.state === 'MERGED' ? '머지됨' : '닫힘'}, 브랜치 정리`);
    store.changed();
    return;
  }
  if (t.status !== 'pr_open') return; // 이미 반영 중
  const comments = await fetchComments(t);
  if (!comments) return;
  const fresh = comments.filter((c) => !t.seenCommentIds.includes(c.id));
  if (!fresh.length) return;
  t.seenCommentIds.push(...fresh.map((c) => c.id));
  t.reviewSyncedAt = nowIso();
  const body = fresh.map((c) => `- @${c.author} (${c.where}): ${c.body.trim()}`).join('\n');
  store.chat('event', `${t.workerId}이 ${t.title} PR 리뷰 코멘트 ${fresh.length}개를 반영하는 중이에요`);
  workers.sendReview(t, body);
}

let running = false;
export async function checkPrs() {
  if (running) return;
  running = true;
  try {
    for (const t of store.data.tasks) {
      if (!t.prUrl || t.prState === 'MERGED' || t.prState === 'CLOSED') continue;
      if (t.status !== 'pr_open') continue;
      try { await checkOne(t); } catch (e) { log.warn('pr check', t.prUrl, (e as Error).message); }
    }
  } finally {
    running = false;
  }
}

export function startPrMonitor() {
  setTimeout(() => void checkPrs(), 20_000).unref();
  setInterval(() => void checkPrs(), 3 * 60_000).unref();
}
