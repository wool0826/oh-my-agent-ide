import fs from 'node:fs';
import path from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { AgentSession, summarizeTool } from './session';
import { alwaysAskHook } from './permissions';
import { adviseOnQuestion } from './advisor';
import { accounts } from '../accounts';
import { store } from '../store';
import { ask } from '../decisions';
import { remember } from '../memory';
import { paths } from '../paths';
import { loadSettings } from '../settings';
import { ensureWorktree, removeWorktree, ghEnv } from '../repos';
import { notifyInfo } from '../notify';
import { log } from '../log';
import { ensureDir, nowIso, oneLine, uid } from '../util';
import type { Task, Worker } from '../../shared/types';

const RESUME_MSG = '앱이 다시 시작돼 작업이 끊겼습니다. 하던 작업을 이어서 진행해 주세요.';

function workerPrompt(w: Worker) {
  const s = loadSettings();
  return [
    `당신은 Oh My Agent IDE의 Worker ${w.id}입니다. 작업은 Dispatcher가 맡기고, 사용자는 결과와 꼭 필요한 결정만 봅니다. 중간 메시지와 보고는 모두 한국어로 씁니다.`,
    '',
    '작업 메시지는 "[작업 T-xxxx]"로 시작합니다. "[Dispatcher]", "[사용자 메시지]", "[리뷰 코멘트]"로 시작하는 메시지는 진행 중인 일에 대한 추가 지시입니다.',
    '',
    '코드 작업:',
    '- 현재 폴더는 저장소의 git worktree입니다. 작업 메시지에 적힌 브랜치를 기본 브랜치에서 새로 만들어 작업합니다.',
    '- 저장소의 CLAUDE.md와 기존 관례를 따르고, 테스트와 린트를 돌려 통과시킵니다.',
    `- 끝나면 커밋하고 push한 뒤 \`gh pr create\`로 리뷰 가능한 상태(draft 아님)의 PR을 만듭니다. 리뷰어는 지정하지 않습니다.${s.githubHost ? ` GH_HOST는 ${s.githubHost}로 잡혀 있습니다.` : ''}`,
    '- PR 제목과 본문은 한국어로, 본문에는 바뀐 점과 확인한 테스트를 적습니다.',
    '- PR에 코멘트를 달거나 머지하지 않습니다.',
    '- "[리뷰 코멘트]"가 오면 같은 브랜치에서 고쳐서 push합니다.',
    '',
    '코드가 아닌 작업(조사, 문서, 보고서):',
    '- 작업 메시지에 적힌 결과물 폴더를 만들고, 결과는 그 안에 파일(주로 마크다운)로 저장합니다.',
    '',
    '질문:',
    '- 사용자의 결정이 꼭 필요할 때만 AskUserQuestion을 씁니다. 사소한 선택은 합리적으로 정하고 마지막 보고에 적습니다.',
    '',
    '마지막 메시지는 아래 형식으로 시작합니다.',
    'RESULT: 한 줄 요약',
    'PR: PR 주소 (있을 때)',
    'FILE: 결과 파일의 절대 경로 (파일마다 한 줄)',
    '그 아래에 필요한 설명을 짧게 씁니다.',
  ].join('\n');
}

function parseResult(text: string, cwd: string) {
  const lines = text.split('\n').map((l) => l.trim());
  const pick = (k: string) => lines.filter((l) => l.toUpperCase().startsWith(k + ':')).map((l) => l.slice(k.length + 1).trim()).filter(Boolean);
  const summary = pick('RESULT')[0] ?? oneLine(lines.find((l) => l && !l.startsWith('#')) ?? text, 200);
  const prLine = pick('PR')[0];
  const prUrl = (prLine?.match(/https?:\/\/\S+\/pull\/\d+/) ?? text.match(/https?:\/\/[^\s)>\]]+\/pull\/\d+/))?.[0] ?? null;
  const files = pick('FILE')
    .map((f) => f.replace(/^`|`$/g, ''))
    .map((f) => (path.isAbsolute(f) ? f : path.join(cwd, f)))
    .filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  return { summary, prUrl, files };
}

class WorkerManager {
  sessions = new Map<string, AgentSession>();
  /** 리뷰 코멘트 반영, 끝난 작업에 대한 추가 지시: 결과 카드 문구를 다르게 쓰려고 기억해 둔다. */
  private reviewing = new Set<string>();
  private followups = new Set<string>();

  /** 끝난 지 3일이 안 된 마지막 작업에 추가 지시가 오면 그 작업을 다시 연다. */
  private reopenLast(w: Worker) {
    if (this.currentTask(w)) return;
    const last = w.taskIds.length ? store.task(w.taskIds[w.taskIds.length - 1]) : null;
    if (!last || !last.finishedAt || Date.now() - Date.parse(last.finishedAt) > 3 * 86400_000) return;
    if (last.status !== 'done' && last.status !== 'pr_open' && last.status !== 'failed') return;
    if (last.prState === 'MERGED' || last.prState === 'CLOSED') return;
    this.followups.add(last.id);
    last.status = 'running';
    last.updatedAt = nowIso();
  }

  list() { return store.data.workers; }

  private touch(w: Worker) {
    w.lastActiveAt = nowIso();
    store.changed();
  }

  currentTask(w: Worker): Task | null {
    for (let i = w.taskIds.length - 1; i >= 0; i--) {
      const t = store.task(w.taskIds[i]);
      if (t && (t.status === 'running' || t.status === 'waiting' || t.status === 'queued')) return t;
    }
    return null;
  }

  async create(opts: { title: string; repo: string | null; model: string }): Promise<Worker> {
    const id = store.nextWorkerId();
    let cwd: string;
    const repo = opts.repo ? store.repo(opts.repo) : null;
    if (opts.repo && !repo) throw new Error(`등록되지 않은 저장소예요: ${opts.repo}`);
    if (repo) cwd = await ensureWorktree(repo, id);
    else {
      cwd = path.join(paths().workspaces, id);
      ensureDir(cwd);
    }
    const w: Worker = {
      id, title: opts.title, model: opts.model, accountId: null, sessionId: null, cwd,
      repo: repo?.name ?? null, status: 'idle', statusText: '', contextTokens: 0, taskIds: [],
      createdAt: nowIso(), lastActiveAt: nowIso(), knowledge: '',
    };
    store.data.workers.push(w);
    store.changed();
    store.chat('event', `${w.id}을 만들었어요. ${repo ? repo.name : '일반 작업'}, ${modelLabel(w.model)}`);
    return w;
  }

  /** 세션이 없으면 계정을 골라 연다. 모든 계정이 한도면 null. */
  ensureSession(w: Worker): AgentSession | null {
    const existing = this.sessions.get(w.id);
    if (existing && !existing.closed) return existing;
    const cur = accounts.get(w.accountId);
    const acc = cur && !accounts.isLimited(cur) ? cur : accounts.pick();
    if (!acc) return null;
    const roots = [w.cwd, paths().workspaces];
    const s = new AgentSession({
      label: w.id,
      model: w.model,
      cwd: w.cwd,
      systemAppend: workerPrompt(w),
      accountId: acc.id,
      resume: w.sessionId,
      settingSources: w.repo ? ['project', 'local'] : [],
      effort: 'high',
      canUseTool: this.permissionHandler(w),
      hooks: { PreToolUse: [alwaysAskHook(() => roots, () => {})] },
    }, {
      onInit: (sid) => { w.sessionId = sid; store.changed(); },
      onAccount: (id) => { w.accountId = id; store.changed(); },
      onText: (text) => {
        store.log(w.id, 'worker', text);
        w.statusText = oneLine(text, 140);
        this.touch(w);
      },
      onTool: (_name, summary) => { w.statusText = summary; store.changed(); },
      onContext: (t) => { w.contextTokens = t; },
      onStatus: (st, text) => {
        if (st === 'busy') { if (w.status !== 'waiting') w.status = 'running'; }
        else if (st === 'idle') { w.status = 'idle'; }
        else {
          w.status = 'error';
          w.statusText = text;
          store.log(w.id, 'event', `오류: ${text}`);
        }
        this.touch(w);
      },
      onTurnEnd: (r) => {
        if (r.internal) return;
        const t = this.currentTask(w);
        if (t) this.finalize(w, t, r.text, r.isError);
      },
      onLimited: () => {
        const t = this.currentTask(w);
        if (t) { t.status = 'queued'; t.updatedAt = nowIso(); }
        w.status = 'idle';
        w.statusText = '모든 계정이 한도라 대기 중';
        store.log(w.id, 'event', '모든 계정이 사용량 한도에 걸려 잠시 멈췄어요. 한도가 풀리면 이어서 진행합니다.');
        store.changed();
      },
    });
    this.sessions.set(w.id, s);
    return s;
  }

  private permissionHandler(w: Worker): CanUseTool {
    return async (toolName, input, opts) => {
      if (toolName === 'AskUserQuestion') return this.answerQuestions(w, input, opts.signal);
      const t = this.currentTask(w);
      const prev = w.status;
      w.status = 'waiting';
      if (t) t.status = 'waiting';
      store.changed();
      try {
        const reason = (opts.decisionReason ?? '').replace(/^항상 확인:\s*/, '');
        const ans = await ask({
          source: 'permission', workerId: w.id, taskId: t?.id ?? null,
          title: toolName === 'Bash' ? '이 명령을 실행해도 될까요?' : `${toolName.replace(/^mcp__\w+__/, '')} 실행을 허용할까요?`,
          detail: reason ? `이유: ${reason}` : (opts.title ?? ''),
          code: summarizeTool(toolName, input, 1200),
          options: [{ label: '허용' }, { label: '거부' }],
          questionKey: null,
        }, opts.signal);
        store.log(w.id, 'user', `${summarizeTool(toolName, input)} → ${ans}`);
        if (ans === '허용') return { behavior: 'allow', updatedInput: input };
        return { behavior: 'deny', message: ans === '거부' ? '사용자가 이 작업을 거부했습니다. 다른 방법을 찾거나, 필요 없으면 건너뛰세요.' : `사용자가 거부하면서 이렇게 말했습니다: ${ans}` };
      } catch {
        return { behavior: 'deny', message: '요청이 취소됐습니다.' };
      } finally {
        if (w.status === 'waiting') w.status = prev === 'waiting' ? 'running' : prev;
        if (t && t.status === 'waiting') t.status = 'running';
        store.changed();
      }
    };
  }

  private async answerQuestions(w: Worker, input: Record<string, unknown>, signal: AbortSignal) {
    const questions = (input.questions as any[]) ?? [];
    const answers: Record<string, string> = {};
    const t = this.currentTask(w);
    for (const q of questions) {
      const opts: string[] = (q.options ?? []).map((o: any) => String(o.label));
      store.log(w.id, 'worker', `질문: ${q.question}${opts.length ? `\n선택지: ${opts.join(' / ')}` : ''}`);
      const verdict = await adviseOnQuestion({ workerId: w.id, taskTitle: t?.title ?? w.title, question: q.question, options: opts });
      if (verdict?.canAnswer) {
        answers[q.question] = verdict.answer;
        const aa = { id: uid(), workerId: w.id, question: q.question, answer: verdict.answer, basis: verdict.basis, createdAt: nowIso(), corrected: null, cleared: false };
        store.data.autoAnswers.push(aa);
        store.chat('auto', `${w.id}이 "${q.question}"라고 물어서 "${verdict.answer}"라고 답했습니다. ${verdict.basis}`, aa.id);
        store.log(w.id, 'auto', `Dispatcher가 대신 답했어요: ${verdict.answer} (${verdict.basis})`);
        continue;
      }
      const prev = w.status;
      w.status = 'waiting';
      if (t) t.status = 'waiting';
      store.changed();
      try {
        const ans = await ask({
          source: 'question', workerId: w.id, taskId: t?.id ?? null,
          title: q.question, detail: t ? t.title : w.title, code: null,
          options: (q.options ?? []).map((o: any) => ({ label: String(o.label), description: o.description ? String(o.description) : undefined })),
          questionKey: q.question,
        }, signal);
        answers[q.question] = ans;
        store.log(w.id, 'user', `답변: ${ans}`);
      } catch {
        answers[q.question] = '(사용자가 답하지 않았습니다. 합리적으로 판단해 진행하고 보고에 적어 주세요.)';
      } finally {
        w.status = prev === 'waiting' ? 'running' : prev;
        if (t && t.status === 'waiting') t.status = 'running';
        store.changed();
      }
    }
    return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
  }

  private finalize(w: Worker, t: Task, text: string, isError: boolean) {
    const { summary, prUrl, files } = parseResult(text, w.cwd);
    t.updatedAt = nowIso();
    if (isError) {
      t.status = 'failed';
      t.summary = oneLine(text || '오류로 멈췄어요', 200);
      store.chat('error', `${w.id}이 "${t.title}"을 끝내지 못했어요. ${t.summary}`, t.id);
      store.pushUpdate(`${w.id}의 ${t.id} "${t.title}" 실패: ${t.summary}`);
      return;
    }
    const wasReview = this.reviewing.delete(t.id);
    const wasFollowup = this.followups.delete(t.id);
    const firstFinish = !t.finishedAt;
    t.summary = summary;
    t.prUrl = prUrl ?? t.prUrl;
    t.files = files.length ? files : t.files;
    t.status = t.prUrl ? 'pr_open' : 'done';
    t.prState = t.prUrl ? (t.prState ?? 'OPEN') : null;
    t.finishedAt = nowIso();
    if (t.prUrl && !t.reviewSyncedAt) t.reviewSyncedAt = nowIso();
    const label = wasReview ? '리뷰 반영' : wasFollowup ? '추가 지시 반영' : '완료';
    store.chat('result', wasReview ? `리뷰 코멘트를 반영했어요. ${summary}` : wasFollowup ? `추가 지시를 반영했어요. ${summary}` : summary, t.id);
    store.pushUpdate(`${w.id}의 ${t.id} "${t.title}" ${label}: ${summary}${t.prUrl ? ` (PR ${t.prUrl})` : ''}${t.files.length ? ` 파일 ${t.files.length}개` : ''}`);
    if (firstFinish) remember('task', `${t.id} ${t.title} (${w.id}${w.repo ? `, ${w.repo}` : ''}) ${summary}${t.prUrl ? ` ${t.prUrl}` : ''}`);
    notifyInfo(`${w.id} ${label}`, `${t.title}: ${summary}`);
    store.changed();
  }

  /** Dispatcher가 작업을 맡길 때. workerId가 있으면 그 Worker가 이어 받는다. */
  async assign(task: Task, workerId: string | null, model: string): Promise<Worker> {
    let w = workerId ? store.worker(workerId) : null;
    if (workerId && !w) throw new Error(`없는 Worker예요: ${workerId}`);
    if (w && w.repo !== task.repo && task.kind === 'code') throw new Error(`${w.id}는 ${w.repo ?? '일반 작업'}용 Worker라 ${task.repo} 작업을 맡길 수 없어요.`);
    if (!w) w = await this.create({ title: task.title, repo: task.kind === 'code' ? task.repo : null, model });
    if (w.status === 'archived') await this.unarchive(w);
    task.workerId = w.id;
    if (task.kind === 'code') task.branch = `agent/${task.id.toLowerCase()}`;
    w.taskIds.push(task.id);
    w.title = task.title;
    task.status = 'running';
    task.updatedAt = nowIso();
    store.changed();
    store.log(w.id, 'dispatcher', `[작업 ${task.id}] ${task.title}\n\n${task.prompt}`);
    this.dispatch(w, task);
    return w;
  }

  private taskMessage(w: Worker, t: Task) {
    const repo = t.repo ? store.repo(t.repo) : null;
    const head = [`[작업 ${t.id}] ${t.title}`];
    if (t.kind === 'code' && repo) {
      head.push(`저장소: ${repo.name} (기본 브랜치 ${repo.defaultBranch})`);
      head.push(`브랜치: ${t.branch}. 먼저 \`git fetch origin\` 후 \`git switch -c ${t.branch} origin/${repo.defaultBranch}\`로 시작하세요. 이미 그 브랜치에 있으면 그대로 이어 갑니다.`);
    } else {
      head.push(`결과물 폴더: ${path.join(w.cwd, t.id)}`);
    }
    return `${head.join('\n')}\n\n${t.prompt}`;
  }

  private dispatch(w: Worker, t: Task) {
    const s = this.ensureSession(w);
    if (!s) {
      t.status = 'queued';
      w.statusText = '모든 계정이 한도라 대기 중';
      store.changed();
      return;
    }
    s.send(this.taskMessage(w, t));
  }

  send(workerId: string, from: 'user' | 'dispatcher', text: string) {
    const w = store.worker(workerId);
    if (!w) throw new Error(`없는 Worker예요: ${workerId}`);
    if (w.status === 'archived') void this.unarchive(w);
    store.log(w.id, from, text);
    if (from === 'user') store.pushUpdate(`사용자가 ${w.id}에게 직접 보냄: ${oneLine(text, 200)}`);
    const s = this.ensureSession(w);
    if (!s) throw new Error('모든 계정이 사용량 한도에 걸려 지금은 보낼 수 없어요.');
    this.reopenLast(w);
    s.send(`${from === 'user' ? '[사용자 메시지]' : '[Dispatcher]'} ${text}`);
    this.touch(w);
  }

  /** PR 리뷰 코멘트가 달렸을 때 */
  sendReview(t: Task, body: string) {
    const w = t.workerId ? store.worker(t.workerId) : null;
    if (!w) return;
    if (w.status === 'archived') void this.unarchive(w);
    t.status = 'running';
    t.updatedAt = nowIso();
    this.reviewing.add(t.id);
    store.log(w.id, 'event', `PR 리뷰 코멘트가 달려 반영을 시작했어요.`);
    const s = this.ensureSession(w);
    if (!s) { t.status = 'queued'; store.changed(); return; }
    s.send(`[리뷰 코멘트] ${t.prUrl} 에 새 코멘트가 달렸습니다. 같은 브랜치(${t.branch})에서 반영해 push하고, 무엇을 고쳤는지 보고하세요. 반영하지 않을 코멘트가 있으면 이유를 보고에 적으세요.\n\n${body}`);
    store.changed();
  }

  async stop(workerId: string) {
    await this.sessions.get(workerId)?.interrupt();
  }

  async archive(workerId: string) {
    const w = store.worker(workerId);
    if (!w) return;
    this.sessions.get(w.id)?.close();
    this.sessions.delete(w.id);
    w.status = 'archived';
    w.statusText = '';
    const openPr = w.taskIds.some((id) => store.task(id)?.status === 'pr_open');
    const repo = w.repo ? store.repo(w.repo) : null;
    if (repo && !openPr && fs.existsSync(w.cwd)) await removeWorktree(repo, w.cwd).catch(() => {});
    store.changed();
  }

  async unarchive(w: Worker) {
    const repo = w.repo ? store.repo(w.repo) : null;
    if (repo && !fs.existsSync(path.join(w.cwd, '.git'))) await ensureWorktree(repo, w.id);
    if (!repo) ensureDir(w.cwd);
    w.status = 'idle';
    this.touch(w);
  }

  autoArchive() {
    const days = loadSettings().archiveDays || 7;
    const cutoff = Date.now() - days * 24 * 3600_000;
    for (const w of store.data.workers) {
      if (w.status !== 'idle' && w.status !== 'error') continue;
      if (Date.parse(w.lastActiveAt) > cutoff) continue;
      if (w.taskIds.some((id) => store.task(id)?.status === 'pr_open')) continue;
      log.info(`auto-archive ${w.id}`);
      void this.archive(w.id);
    }
  }

  /** 계정 한도로 멈춘 작업을 다시 시도한다. */
  retryQueued() {
    for (const t of store.data.tasks) {
      if (t.status !== 'queued' || !t.workerId) continue;
      const w = store.worker(t.workerId);
      if (!w) continue;
      const s = this.ensureSession(w);
      if (!s) return;
      t.status = 'running';
      w.statusText = '';
      store.log(w.id, 'event', '계정 한도가 풀려 이어서 진행해요.');
      s.send(w.sessionId ? '계정 한도가 풀렸습니다. 하던 작업을 이어서 진행해 주세요.' : this.taskMessage(w, t));
      store.changed();
    }
  }

  /** 앱 시작 시: 실행 중이던 Worker를 이어서 돌린다. */
  resumeAfterRestart() {
    for (const w of store.data.workers) {
      if (w.status === 'archived') continue;
      const t = this.currentTask(w);
      if (w.status === 'running' || w.status === 'waiting' || w.status === 'starting' || (t && t.status !== 'queued')) {
        w.status = 'idle';
        if (!t) continue;
        const s = this.ensureSession(w);
        if (!s) { t.status = 'queued'; continue; }
        t.status = 'running';
        store.log(w.id, 'event', '앱이 다시 시작돼 이어서 진행해요.');
        s.send(w.sessionId ? RESUME_MSG : this.taskMessage(w, t));
      }
    }
    store.changed();
  }

  closeAll() {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  /** 작업 폴더 경로가 Worker의 것인지 확인할 때 쓴다. */
  ghEnv() { return ghEnv(); }
}

export function modelLabel(m: string) {
  if (m.includes('fable')) return 'Fable 5.2';
  if (m.includes('opus')) return 'Opus 5.5';
  if (m.includes('sonnet')) return 'Sonnet 5.5';
  return m;
}

export const workers = new WorkerManager();
