import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { AgentSession } from './session';
import { workers, modelLabel } from './workers';
import { accounts } from '../accounts';
import { store } from '../store';
import { createDecision } from '../decisions';
import { remember, searchMemory, memoryDigest } from '../memory';
import { memoryDirFor, searchClaudeMemory, userRulesSection } from '../claudeContext';
import { registerRepo } from '../repos';
import { paths } from '../paths';
import { loadSettings } from '../settings';
import { attachmentBlock, registerAttachments } from '../attachments';
import { limitResetText, t, langName } from '../i18n';
import { nowIso, oneLine, today } from '../util';
import { EFFORTS, type Effort, type Task } from '../../shared/types';
import { hasSpend } from '../../shared/spend';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/** Spend is shown and recorded only; nothing is held back because of it. */
const SPEND_NOTE = 'API-equivalent estimate at list prices, summed over every turn including subagents. The accounts are subscriptions, so this is not what is billed. Use it to compare tasks, not to hold work back.';

function repoLine(r: { name: string; description: string; defaultBranch: string; url: string }) {
  return `- ${r.name}: ${r.description || '(no description)'} [default branch ${r.defaultBranch}] ${r.url}`;
}

function workerLine(id: string) {
  const w = store.worker(id)!;
  const tasks = w.taskIds.map((x) => store.task(x)).filter(Boolean) as Task[];
  const last = tasks[tasks.length - 1];
  const idleDays = Math.floor((Date.now() - Date.parse(w.lastActiveAt)) / 86400_000);
  return `- ${w.id} [${w.status}] ${w.repo ?? 'general'}, ${modelLabel(w.model)}, context ${Math.round(w.contextTokens / 1000)}K` +
    `${idleDays ? `, last active ${idleDays} day(s) ago` : ''}\n  Tasks: ${tasks.map((x) => `${x.id} ${x.title} (${x.status}${x.prUrl ? ` ${x.prUrl}` : ''}${x.prState === 'MERGED' ? ' merged' : ''})`).join('; ') || 'none'}` +
    `${last?.summary ? `\n  Latest result: ${oneLine(last.summary, 160)}` : ''}`;
}

/** Create a task and hand it to a Worker. Used by the Dispatcher tool and by UI buttons. */
export async function createTask(a: { title: string; prompt: string; kind: 'code' | 'other'; repo?: string; worker_id?: string; model?: 'opus' | 'fable'; after_task_id?: string; effort?: Effort; plan_first?: boolean }) {
  if (a.kind === 'code' && !a.repo) throw new Error('Code tasks need a repo. Check list_repos.');
  if (a.repo && !store.repo(a.repo)) throw new Error(`Repository is not registered: ${a.repo}`);
  let after: string | null = null;
  if (a.after_task_id) {
    const dep = store.task(a.after_task_id);
    if (!dep) throw new Error(`No such task: ${a.after_task_id}`);
    if (!dep.prUrl && dep.status !== 'running' && dep.status !== 'waiting' && dep.status !== 'queued' && dep.status !== 'blocked') {
      throw new Error(`${dep.id} has no PR and is not in progress, so there is nothing to wait for.`);
    }
    if (dep.prState !== 'MERGED') after = dep.id;
  }
  const s = loadSettings();
  const model = a.model === 'fable' ? s.designModel : s.workerModel;
  const task: Task = {
    id: store.nextTaskId(), title: a.title, prompt: a.prompt, kind: a.kind,
    repo: a.repo ? store.repo(a.repo)?.name ?? null : null,
    workerId: null, status: 'queued', branch: null, prUrl: null, prState: null, summary: null, files: [],
    createdAt: nowIso(), updatedAt: nowIso(), startedAt: null, finishedAt: null, reviewSyncedAt: null, seenCommentIds: [],
    afterTaskId: after, mergedAt: null,
    effort: s.effortPerTask && a.effort ? a.effort : null,
    planFirst: !!a.plan_first,
  };
  store.data.tasks.push(task);
  store.changed();
  const worker = await workers.assign(task, a.worker_id ?? null, model);
  return { task, worker };
}

function boardServer() {
  return createSdkMcpServer({
    // 'ide' is reserved by Claude Code for IDE integration and its tools get filtered out.
    name: 'board',
    version: '0.2.0',
    // Always visible (not deferred behind tool search). Cloning can take long, so the timeout is generous.
    alwaysLoad: true,
    timeout: 45 * 60_000,
    tools: [
      tool('list_repos', 'List registered repositories and their descriptions.', {}, async () => {
        const rs = store.data.repos;
        return ok(rs.length ? rs.map(repoLine).join('\n') : 'No repositories are registered.');
      }),
      tool('register_repo', 'Clone and register a repository. url is a git URL, "org/name" (company GitHub), or an existing local folder.', {
        url: z.string(),
        name: z.string().optional().describe('Short name. Derived from the URL if omitted.'),
        description: z.string().optional().describe('What the repository is responsible for. Used to route tasks.'),
      }, async (a) => {
        try {
          store.chat('event', t('ev.cloning', { name: a.name ?? a.url }));
          const r = await registerRepo(a);
          store.chat('event', t('ev.registered', { name: r.name, path: r.path }));
          return ok(`Registered: ${repoLine(r)}\nPath: ${r.path}`);
        } catch (e) {
          return fail(`Registration failed: ${(e as Error).message}`);
        }
      }),
      tool('list_workers', 'List Workers, their status and past tasks. Check for a Worker with relevant context before assigning new work.', {
        include_archived: z.boolean().optional(),
      }, async (a) => {
        const ws = store.data.workers.filter((w) => a.include_archived || w.status !== 'archived');
        return ok(ws.length ? ws.map((w) => workerLine(w.id)).join('\n') : 'No Workers.');
      }),
      tool('create_task', 'Create a task and hand it to a Worker. With worker_id that Worker continues (reusing context); otherwise a new Worker is created. With after_task_id the task waits until that task\'s PR is merged, then starts automatically.', {
        title: z.string().describe('Short task name'),
        prompt: z.string().describe('Instructions for the Worker: background, desired result, definition of done. Include any attached file paths.'),
        kind: z.enum(['code', 'other']).describe('code: change a repository and open a PR. other: research, documents, reports'),
        repo: z.string().optional().describe('Repository name for code tasks'),
        worker_id: z.string().optional(),
        model: z.enum(['opus', 'fable']).optional().describe('Default opus. fable only for deep design work'),
        after_task_id: z.string().optional().describe('Start only after this task\'s PR is merged (e.g. a follow-up that needs the merged change)'),
        effort: z.enum(EFFORTS as [Effort, ...Effort[]]).optional().describe('Reasoning effort for this task. Omit for the default. low for trivial edits or lookups, xhigh or max for hard debugging, tricky concurrency, or design.'),
        plan_first: z.boolean().optional().describe('The Worker investigates read-only and proposes a plan; the user approves it in the decision inbox before any change. Use when the user asks to see a plan first, or the change is large, risky, or ambiguous.'),
      }, async (a) => {
        try {
          const { task, worker: w } = await createTask(a);
          store.chat('event', task.status === 'blocked'
            ? t('ev.assignedAfter', { id: w.id, title: task.title, dep: task.afterTaskId ?? '' })
            : t(a.worker_id ? 'ev.assignedCont' : 'ev.assigned', { id: w.id, title: task.title }));
          return ok(`${task.id} assigned to ${w.id}.${task.status === 'queued' ? ' Every account is held by a usage limit; it starts when the first one resets.' : ''}${task.status === 'blocked' ? ` It starts when ${task.afterTaskId}'s PR is merged.` : ''}`);
        } catch (e) {
          return fail(`Could not create the task: ${(e as Error).message}`);
        }
      }),
      tool('send_to_worker', 'Send further instructions to a running or idle Worker.', {
        worker_id: z.string(),
        message: z.string(),
      }, async (a) => {
        try {
          workers.send(a.worker_id, 'dispatcher', a.message);
          return ok('Sent.');
        } catch (e) {
          return fail((e as Error).message);
        }
      }),
      tool('stop_worker', 'Stop what a Worker is doing (the session stays, so it can continue later).', { worker_id: z.string() }, async (a) => {
        await workers.stop(a.worker_id);
        return ok('Stopped.');
      }),
      tool('request_decision', 'Put something the user must decide into the decision inbox. The answer arrives later as a "[Decision answer]" message.', {
        question: z.string(),
        options: z.array(z.string()).min(2).max(4),
        context: z.string().optional(),
      }, async (a) => {
        createDecision({
          source: 'dispatcher', workerId: null, taskId: null, title: a.question, detail: a.context ?? '', code: null,
          options: a.options.map((o) => ({ label: o })), questionKey: null,
        });
        return ok('Posted to the decision inbox. Do not ask the user the same question again.');
      }),
      tool('remember', "Save the user's preferences, principles, repository traits, or important decisions to IDE memory. These become the basis for answering on the user's behalf.", {
        scope: z.enum(['preference', 'repo', 'decision', 'note']),
        text: z.string(),
        repo: z.string().optional(),
      }, async (a) => ok(`Saved to ${remember(a.scope, a.text, a.repo)}.`)),
      tool('recall', 'Search IDE memory and the Claude Code memory kept for registered repositories.', { query: z.string() }, async (a) => {
        const ide = searchMemory(a.query, 10).map((h) => `[ide] ${h.path}:${h.line} ${h.text}`);
        const dirs = loadSettings().claudeMemory ? [memoryDirFor(paths().home), ...store.data.repos.map((r) => memoryDirFor(r.path))] : [];
        const cc = searchClaudeMemory(a.query, dirs, 8).map((h) => `[claude] ${h.file}:${h.line} ${h.text}`);
        const lines = [...ide, ...cc];
        return ok(lines.length ? lines.join('\n') : 'Nothing relevant in memory.');
      }),
      tool('task_detail', 'Show one task\'s instructions, status, result and spend.', { task_id: z.string() }, async (a) => {
        const task = store.task(a.task_id);
        if (!task) return fail('No such task.');
        const spend = task.spend ? { ...task.spend, note: SPEND_NOTE } : undefined;
        return ok(JSON.stringify({ ...task, seenCommentIds: undefined, spend }, null, 2));
      }),
    ],
  });
}

function systemPrompt() {
  const repos = store.data.repos.map(repoLine).join('\n') || '(none)';
  return [
    `You are the Dispatcher of Oh My Agent IDE. The user states work in one window and sees only decisions and results. Reply in ${langName()}.`,
    '',
    'Role',
    '1. Split requests into tasks and hand them to Workers with create_task. Do not edit code or do long research yourself; a quick look at a repository to route work is fine.',
    '2. If a Worker already has the relevant context (same repo, continuing work, same PR), use it instead of creating a new one: send_to_worker for more instructions on work in progress, create_task with worker_id for a new task. Check list_workers first.',
    '3. If the user names a repo with @name, use it; otherwise pick by description. If unclear, ask with request_decision. Requests like "register this" use register_repo.',
    '4. Model: opus by default; fable only for deep design work such as architecture or large structural changes.',
    '5. Put anything the user must decide into the decision inbox with request_decision. Ask back in chat only when you cannot understand the request.',
    '6. Save preferences, principles and repository traits the user states with remember. Use recall when you need a basis for a judgment.',
    `7. ${loadSettings().effortPerTask ? `Set effort on create_task only when a task clearly needs more or less than the default (${loadSettings().workerEffort}).` : 'Do not set effort on create_task; the user fixed it in settings.'}`,
    '8. When work depends on a change that is still in an open PR, create it with after_task_id so it starts automatically after the merge. Use plan_first when the user wants to review the approach first (for example plan first or show me the plan) or a code change is large, risky or open to several designs; small, clear changes do not need it.',
    '9. If the message ends with "[Attached files]", pass those absolute paths to the Worker in the task prompt. You may Read them to decide routing.',
    '10. Keep replies short: one or two sentences on what you gave to whom. Avoid lists and headings.',
    '',
    'A message prefixed with "[Worker updates]" lists what happened to Workers since your last turn. Use what is relevant to the user\'s request; no need to report it separately.',
    '"[Decision answer]" is the user\'s answer from the decision inbox. Follow up accordingly.',
    '',
    `Today: ${today()}`,
    '',
    'Registered repositories',
    repos,
    '',
    'IDE memory digest',
    memoryDigest(5000) || '(empty)',
  ].join('\n') + (loadSettings().claudeRules ? userRulesSection() : '');
}

class Dispatcher {
  session: AgentSession | null = null;
  statusText = '';
  /** Context size when the user asked to compact; null when no compaction was requested. */
  private compactingFrom: number | null = null;
  /** Messages that came while every account was held by a usage limit; sent when the first one resets. */
  private held: string[] = [];
  /** A turn a usage limit cut off; continued when the first limit resets. */
  private cutOff = false;

  get busy() { return !!this.session?.busy; }

  private open(): AgentSession | null {
    const d = store.data.dispatcher;
    const freshDay = d.date !== today();
    if (this.session && !this.session.closed && !freshDay) return this.session.ready() ? this.session : null;
    if (this.session) this.session.close();
    const acc = accounts.isFree(d.accountId) ? accounts.get(d.accountId) : accounts.pick();
    if (!acc) return null;
    if (freshDay) {
      d.sessionId = null;
      d.sessionSpend = null;
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
      spent: d.sessionSpend,
      mcpServers: { board: boardServer() },
      tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      additionalDirectories: [paths().repos],
      effort: loadSettings().dispatcherEffort,
      // The Dispatcher only has read-only tools, including for attached files.
      canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
    }, {
      onInit: (sid) => { d.sessionId = sid; store.changed(); },
      onAccount: (id) => { d.accountId = id; store.changed(); },
      onText: (text) => { store.chat('dispatcher', text); },
      onTool: (_n, summary) => { this.statusText = summary; store.changed(); },
      onContext: (n) => { d.contextTokens = n; store.changed(); },
      onSpend: (turn, session) => {
        d.sessionSpend = session;
        if (hasSpend(turn)) store.dispatcherSpent(turn);
        else store.changed();
      },
      onTurnEnd: (r) => {
        if (!r.internal || this.compactingFrom === null) return;
        const from = this.compactingFrom;
        this.compactingFrom = null;
        this.statusText = '';
        const kb = (n: number) => `${Math.round(n / 1000)}K`;
        store.chat(r.isError ? 'error' : 'event', r.isError ? t('ev.compactFailed') : t('ev.compacted', { a: kb(from), b: kb(d.contextTokens) }));
      },
      onStatus: (st, text) => {
        if (st === 'error') store.chat('error', t('err.dispatcher', { msg: text }));
        if (st !== 'busy') this.statusText = '';
        store.changed();
      },
      onLimited: () => {
        this.cutOff = true;
        store.chat('event', t('ev.limitPaused', { time: limitResetText(accounts.nextFreeAt()) }));
      },
    });
    this.session = s;
    store.changed();
    return s;
  }

  /** A message the user typed in the chat, with optional attached file paths. */
  send(text: string, files: string[] = []) {
    const attached = registerAttachments(files);
    const full = text + attachmentBlock(attached);
    store.chat('user', full);
    const s = this.open();
    if (!s) {
      if (!accounts.list().length) { store.chat('error', t('err.noAccount')); return; }
      this.held.push(full);
      store.chat('event', t('ev.limitHeld', { time: limitResetText(accounts.nextFreeAt()) }));
      store.changed();
      return;
    }
    this.deliver(s, [full]);
  }

  /** The user answered a question the Dispatcher posted. */
  decisionAnswered(question: string, answer: string) {
    const msg = `[Decision answer] Question: ${question}\nAnswer: ${answer}`;
    const s = this.open();
    if (!s) { this.held.push(msg); return; }
    this.deliver(s, [msg]);
  }

  /** A usage limit reset: continue the cut-off turn and send what was held, if an account is free now. */
  retryHeld() {
    if (!this.held.length && !this.cutOff) return;
    const s = this.open();
    if (!s) return;
    store.chat('event', t('log.limitCleared'));
    this.deliver(s, []);
  }

  /** Send messages in one turn, after Worker updates and anything a usage limit held back. */
  private deliver(s: AgentSession, msgs: string[]) {
    const parts = this.cutOff ? ['[Usage limit reset] Your last turn was cut off by a usage limit. Continue where you left off.'] : [];
    parts.push(...this.held, ...msgs);
    this.held = [];
    this.cutOff = false;
    const updates = store.takeUpdates();
    const prefix = updates.length ? `[Worker updates]\n${updates.map((u) => `- ${u}`).join('\n')}\n\n` : '';
    s.send(prefix + parts.join('\n\n'));
    store.changed();
  }

  async stop() {
    await this.session?.interrupt();
  }

  /** The user asked to compact the conversation now. */
  compact() {
    if (this.busy) throw new Error(t('err.dispatcherBusy'));
    const d = store.data.dispatcher;
    // A new day starts a new session anyway; nothing to compact.
    if (!d.sessionId || d.date !== today()) return;
    const s = this.open();
    if (!s) throw new Error(accounts.list().length ? t('err.limitUntil', { time: limitResetText(accounts.nextFreeAt()) }) : t('err.noAccount'));
    this.compactingFrom = d.contextTokens;
    this.statusText = t('st.compacting');
    s.compact();
    store.changed();
  }

  /** The user asked for a fresh conversation. The chat on screen stays; the Dispatcher forgets it. */
  clear() {
    if (this.busy) throw new Error(t('err.dispatcherBusy'));
    this.session?.close();
    this.session = null;
    const d = store.data.dispatcher;
    d.sessionId = null;
    d.sessionSpend = null;
    d.contextTokens = 0;
    d.date = today();
    store.chat('event', t('ev.dispatcherCleared'));
    store.changed();
  }

  close() {
    this.session?.close();
    this.session = null;
  }

  /** After repos, memory or language change, use a fresh system prompt from the next message. */
  refreshContext() {
    if (this.session && !this.session.busy) {
      this.session.close();
      this.session = null;
    }
  }
}

export const dispatcher = new Dispatcher();
