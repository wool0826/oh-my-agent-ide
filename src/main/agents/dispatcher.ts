import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { AgentSession } from './session';
import { workers, modelLabel } from './workers';
import { accounts } from '../accounts';
import { store } from '../store';
import { createDecision } from '../decisions';
import { remember, searchMemory, memoryDigest } from '../memory';
import { registerRepo } from '../repos';
import { paths } from '../paths';
import { loadSettings } from '../settings';
import { log } from '../log';
import { nowIso, oneLine, today } from '../util';
import type { Task } from '../../shared/types';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

function repoLine(r: { name: string; description: string; defaultBranch: string; url: string }) {
  return `- ${r.name}: ${r.description || '(설명 없음)'} [기본 브랜치 ${r.defaultBranch}] ${r.url}`;
}

function workerLine(id: string) {
  const w = store.worker(id)!;
  const tasks = w.taskIds.map((t) => store.task(t)).filter(Boolean) as Task[];
  const last = tasks[tasks.length - 1];
  const idleDays = Math.floor((Date.now() - Date.parse(w.lastActiveAt)) / 86400_000);
  return `- ${w.id} [${w.status}] ${w.repo ?? '일반 작업'}, ${modelLabel(w.model)}, 컨텍스트 ${Math.round(w.contextTokens / 1000)}K` +
    `${idleDays ? `, ${idleDays}일 전 마지막 활동` : ''}\n  맡았던 작업: ${tasks.map((t) => `${t.id} ${t.title}(${t.status}${t.prUrl ? ` ${t.prUrl}` : ''})`).join('; ') || '없음'}` +
    `${last?.summary ? `\n  최근 결과: ${oneLine(last.summary, 160)}` : ''}`;
}

/** 작업을 만들어 Worker에게 맡긴다. Dispatcher 도구와 화면의 버튼이 함께 쓴다. */
export async function createTask(a: { title: string; prompt: string; kind: 'code' | 'other'; repo?: string; worker_id?: string; model?: 'opus' | 'fable' }) {
  if (a.kind === 'code' && !a.repo) throw new Error('code 작업에는 repo가 필요합니다. list_repos로 확인하세요.');
  if (a.repo && !store.repo(a.repo)) throw new Error(`등록되지 않은 저장소입니다: ${a.repo}`);
  const s = loadSettings();
  const model = a.model === 'fable' ? s.designModel : s.workerModel;
  const t: Task = {
    id: store.nextTaskId(), title: a.title, prompt: a.prompt, kind: a.kind,
    repo: a.repo ? store.repo(a.repo)?.name ?? null : null,
    workerId: null, status: 'queued', branch: null, prUrl: null, prState: null, summary: null, files: [],
    createdAt: nowIso(), updatedAt: nowIso(), finishedAt: null, reviewSyncedAt: null, seenCommentIds: [],
  };
  store.data.tasks.push(t);
  store.changed();
  const worker = await workers.assign(t, a.worker_id ?? null, model);
  return { task: t, worker };
}

function ideServer() {
  return createSdkMcpServer({
    // 'ide'는 Claude Code가 IDE 연동용으로 예약한 이름이라 도구가 걸러진다. 다른 이름을 써야 한다.
    name: 'board',
    version: '0.1.0',
    // 도구 검색 뒤로 미루지 않고 항상 보이게 한다. 저장소 클론은 오래 걸릴 수 있어 시간 제한을 넉넉히 둔다.
    alwaysLoad: true,
    timeout: 45 * 60_000,
    tools: [
      tool('list_repos', '등록된 저장소 목록과 설명을 봅니다.', {}, async () => {
        const rs = store.data.repos;
        return ok(rs.length ? rs.map(repoLine).join('\n') : '등록된 저장소가 없습니다.');
      }),
      tool('register_repo', '저장소를 클론해서 등록합니다. url은 git 주소, "org/name"(사내 GitHub), 또는 이미 있는 로컬 폴더 경로.', {
        url: z.string(),
        name: z.string().optional().describe('짧은 이름. 없으면 주소에서 만듭니다.'),
        description: z.string().optional().describe('무엇을 담당하는 저장소인지. 작업 배정 판단에 씁니다.'),
      }, async (a) => {
        try {
          store.chat('event', `${a.name ?? a.url} 저장소를 받는 중이에요`);
          const r = await registerRepo(a);
          store.chat('event', `${r.name} 저장소를 등록했어요. ${r.path}`);
          return ok(`등록 완료: ${repoLine(r)}\n경로: ${r.path}`);
        } catch (e) {
          return fail(`등록 실패: ${(e as Error).message}`);
        }
      }),
      tool('list_workers', 'Worker 목록, 상태, 맡았던 작업을 봅니다. 새 작업을 맡기기 전에 맥락을 가진 Worker가 있는지 확인하세요.', {
        include_archived: z.boolean().optional(),
      }, async (a) => {
        const ws = store.data.workers.filter((w) => a.include_archived || w.status !== 'archived');
        return ok(ws.length ? ws.map((w) => workerLine(w.id)).join('\n') : 'Worker가 없습니다.');
      }),
      tool('create_task', '작업을 만들어 Worker에게 맡깁니다. worker_id를 주면 그 Worker가 이어 받고(맥락 재사용), 없으면 새 Worker를 만듭니다.', {
        title: z.string().describe('짧은 작업 이름'),
        prompt: z.string().describe('Worker에게 줄 지시. 배경, 원하는 결과, 완료 기준을 구체적으로.'),
        kind: z.enum(['code', 'other']).describe('code: 저장소를 고치고 PR까지. other: 조사, 문서, 보고서'),
        repo: z.string().optional().describe('code 작업의 저장소 이름'),
        worker_id: z.string().optional(),
        model: z.enum(['opus', 'fable']).optional().describe('기본 opus. 깊은 설계가 필요한 작업만 fable'),
      }, async (a) => {
        try {
          const { task: t, worker: w } = await createTask(a);
          store.chat('event', `${w.id}에게 "${t.title}"을 맡겼어요${a.worker_id ? ' (이어서)' : ''}`);
          return ok(`${t.id}를 ${w.id}에게 맡겼습니다.${t.status === 'queued' ? ' 모든 계정이 한도라 풀리면 시작합니다.' : ''}`);
        } catch (e) {
          return fail(`작업 생성 실패: ${(e as Error).message}`);
        }
      }),
      tool('send_to_worker', '진행 중이거나 쉬고 있는 Worker에게 추가 지시를 보냅니다.', {
        worker_id: z.string(),
        message: z.string(),
      }, async (a) => {
        try {
          workers.send(a.worker_id, 'dispatcher', a.message);
          return ok('보냈습니다.');
        } catch (e) {
          return fail((e as Error).message);
        }
      }),
      tool('stop_worker', 'Worker가 하던 일을 멈춥니다(세션은 남아 이어 맡길 수 있음).', { worker_id: z.string() }, async (a) => {
        await workers.stop(a.worker_id);
        return ok('멈췄습니다.');
      }),
      tool('request_decision', '사용자의 결정이 필요한 것을 결정 대기함에 올립니다. 답은 나중에 "[결정 응답]" 메시지로 옵니다.', {
        question: z.string(),
        options: z.array(z.string()).min(2).max(4),
        context: z.string().optional(),
      }, async (a) => {
        createDecision({
          source: 'dispatcher', workerId: null, taskId: null, title: a.question, detail: a.context ?? '', code: null,
          options: a.options.map((o) => ({ label: o })), questionKey: null,
        });
        return ok('결정 대기함에 올렸습니다. 사용자에게 같은 질문을 다시 하지 마세요.');
      }),
      tool('remember', '사용자의 선호, 원칙, 저장소 특성, 중요한 결정을 IDE 메모리에 남깁니다. 나중에 대신 답할 근거가 됩니다.', {
        scope: z.enum(['preference', 'repo', 'decision', 'note']),
        text: z.string(),
        repo: z.string().optional(),
      }, async (a) => {
        const f = remember(a.scope, a.text, a.repo);
        return ok(`${f}에 남겼습니다.`);
      }),
      tool('recall', 'IDE 메모리에서 관련 내용을 찾습니다.', { query: z.string() }, async (a) => {
        const hits = searchMemory(a.query, 10);
        return ok(hits.length ? hits.map((h) => `${h.path}:${h.line} ${h.text}`).join('\n') : '관련 메모리가 없습니다.');
      }),
      tool('task_detail', '작업 하나의 지시, 상태, 결과를 봅니다.', { task_id: z.string() }, async (a) => {
        const t = store.task(a.task_id);
        if (!t) return fail('없는 작업입니다.');
        return ok(JSON.stringify({ ...t, seenCommentIds: undefined }, null, 2));
      }),
    ],
  });
}

function systemPrompt() {
  const repos = store.data.repos.map(repoLine).join('\n') || '(없음)';
  return [
    '당신은 Oh My Agent IDE의 Dispatcher입니다. 사용자는 한 화면에서 일을 말하고, 결정과 결과만 봅니다. 한국어로 답합니다.',
    '',
    '역할',
    '1. 요청을 작업 단위로 나눠 create_task로 Worker에게 맡깁니다. 직접 코드를 고치거나 긴 조사를 하지 않습니다. 저장소를 잠깐 읽어 배정을 판단하는 정도는 괜찮습니다.',
    '2. 이미 관련 맥락을 가진 Worker(같은 저장소, 이어지는 작업, 같은 PR)가 있으면 새로 만들지 말고 그 Worker에게 맡깁니다. 진행 중인 일에 대한 추가 지시는 send_to_worker, 새 작업이면 create_task에 worker_id를 줍니다. 판단 전에 list_workers를 확인하세요.',
    '3. 저장소는 사용자가 @이름으로 지정하면 그 저장소, 아니면 설명을 보고 고릅니다. 애매하면 request_decision으로 묻습니다. "등록해줘" 같은 요청은 register_repo.',
    '4. 모델은 기본 opus. 아키텍처 설계나 큰 구조 변경처럼 깊은 설계가 필요한 작업만 fable을 씁니다.',
    '5. 사용자 결정이 필요한 것은 request_decision으로 결정 대기함에 올립니다. 요청 자체를 이해하지 못했을 때만 대화로 짧게 되묻습니다.',
    '6. 사용자가 밝힌 선호, 원칙, 저장소 특성은 remember로 남깁니다. 판단 근거가 필요하면 recall로 찾습니다.',
    '7. 답은 짧게, 무엇을 누구에게 맡겼는지 한두 문장으로 씁니다. 목록이나 제목을 남발하지 않습니다.',
    '',
    '메시지 앞에 "[Worker 소식]"이 붙어 오면 지난 메시지 이후 Worker에게 일어난 일입니다. 사용자의 요청과 관련 있는 것만 반영하고, 따로 보고하지 않아도 됩니다.',
    '"[결정 응답]"은 사용자가 결정 대기함에서 답한 내용입니다. 그에 맞춰 후속 조치를 하세요.',
    '',
    `오늘: ${today()}`,
    '',
    '등록된 저장소',
    repos,
    '',
    'IDE 메모리 요약',
    memoryDigest(5000) || '(비어 있음)',
  ].join('\n');
}

class Dispatcher {
  session: AgentSession | null = null;
  statusText = '';

  get busy() { return !!this.session?.busy; }

  private open(): AgentSession | null {
    const d = store.data.dispatcher;
    const freshDay = d.date !== today();
    if (this.session && !this.session.closed && !freshDay) return this.session;
    if (this.session) this.session.close();
    const cur = accounts.get(d.accountId);
    const acc = cur && !accounts.isLimited(cur) ? cur : accounts.pick();
    if (!acc) return null;
    if (freshDay) {
      d.sessionId = null;
      d.date = today();
      d.contextTokens = 0;
    }
    const s = new AgentSession({
      label: 'Dispatcher',
      model: loadSettings().dispatcherModel,
      cwd: paths().home,
      systemAppend: systemPrompt(),
      accountId: acc.id,
      resume: d.sessionId,
      mcpServers: { board: ideServer() },
      tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      additionalDirectories: [paths().repos],
      effort: 'medium',
      canUseTool: async (_t, input) => ({ behavior: 'allow', updatedInput: input }),
    }, {
      onInit: (sid) => { d.sessionId = sid; store.changed(); },
      onAccount: (id) => { d.accountId = id; store.changed(); },
      onText: (text) => { store.chat('dispatcher', text); },
      onTool: (_n, summary) => { this.statusText = summary; store.changed(); },
      onContext: (t) => { d.contextTokens = t; store.changed(); },
      onStatus: (st, text) => {
        if (st === 'error') store.chat('error', `Dispatcher 오류: ${text}`);
        if (st !== 'busy') this.statusText = '';
        store.changed();
      },
      onLimited: () => store.chat('error', '모든 계정이 사용량 한도에 걸렸어요. 한도가 풀리면 다시 보내 주세요.'),
    });
    this.session = s;
    store.changed();
    return s;
  }

  /** 사용자가 대화창에 쓴 메시지 */
  send(text: string) {
    store.chat('user', text);
    const s = this.open();
    if (!s) {
      store.chat('error', accounts.list().length ? '모든 계정이 사용량 한도에 걸렸어요. 한도가 풀리면 다시 보내 주세요.' : '설정에서 계정을 먼저 등록해 주세요.');
      return;
    }
    const updates = store.takeUpdates();
    const prefix = updates.length ? `[Worker 소식]\n${updates.map((u) => `- ${u}`).join('\n')}\n\n` : '';
    s.send(prefix + text);
    store.changed();
  }

  /** 결정 대기함에서 Dispatcher가 올린 질문에 답했을 때 */
  decisionAnswered(question: string, answer: string) {
    const s = this.open();
    if (!s) return;
    s.send(`[결정 응답] 질문: ${question}\n답: ${answer}`);
  }

  async stop() {
    await this.session?.interrupt();
  }

  close() {
    this.session?.close();
    this.session = null;
  }

  /** 저장소 목록이나 메모리가 크게 바뀐 뒤, 다음 메시지부터 새 시스템 프롬프트를 쓰게 한다. */
  refreshContext() {
    if (this.session && !this.session.busy) {
      this.session.close();
      this.session = null;
    }
  }
}

export const dispatcher = new Dispatcher();
