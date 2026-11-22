import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { AgentSession, type SessionEvents } from './session';
import { CodexSession } from './codexSession';
import { codexToolsFrom, type SdkToolDef } from './codexTools';
import { codexClient } from '../codex/client';
import { cachedModels } from '../models';
import { providerOf } from '../../shared/models';
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
import { EFFORTS, type Effort, type Task, type Worker } from '../../shared/types';
import { hasSpend } from '../../shared/spend';
import { sharedMemoDigest } from '../../shared/memos';
import { describeCancel } from '../../shared/queue';
import { slotsUsed, waitsForSlot } from '../../shared/slots';
import { kTokens } from '../../shared/context';
import { dispatcherReason } from '../../shared/askWhy';
import { describePick, pickWorker, reuseBlock } from '../../shared/routing';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/** Spend is shown and recorded only; nothing is held back because of it. */
const SPEND_NOTE = 'API-equivalent estimate at list prices, summed over every turn including subagents. The accounts are subscriptions, so this is not what is billed. Use it to compare tasks, not to hold work back.';

function repoLine(r: { name: string; description: string; defaultBranch: string; url: string }) {
  return `- ${r.name}: ${r.description || '(no description)'} [default branch ${r.defaultBranch}] ${r.url}`;
}

/** A task's status for the Dispatcher; a queued one says what it waits for. */
function statusLine(x: Task) {
  if (x.status !== 'queued') return x.status;
  return waitsForSlot(x) ? 'queued for a free Worker slot' : 'queued until a usage limit resets';
}

/** Worker news that starts a Dispatcher turn is gathered this long, so several items make one turn. */
const WAKE_DELAY_MS = 3000;
/** Turns in a row that the Dispatcher started by itself and acted in (wrote to a Worker, created a task), with no word from the user in between. */
const MAX_AUTO_TURNS = 8;
/** Messages and questions to one Worker in those turns. */
const MAX_AUTO_SENDS = 3;
/** The whole reply of an automatic turn with nothing to say; it is not shown. */
const NOOP_RE = /^[\s`*"'.]*NOOP[\s`*"'.!]*$/i;
const AUTO_NOTE = '[Automatic turn] No message from the user: the Worker updates above started this turn. Judge them, tell the user only what they should know, and act only where needed. If there is nothing to say or do, reply with exactly NOOP.';

/** Local time of something a Worker said, for the Dispatcher: HH:MM, with the date when it was not today. */
function clock(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? time : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}

function workerLine(id: string) {
  const w = store.worker(id)!;
  const tasks = w.taskIds.map((x) => store.task(x)).filter(Boolean) as Task[];
  const last = tasks[tasks.length - 1];
  const idleDays = Math.floor((Date.now() - Date.parse(w.lastActiveAt)) / 86400_000);
  return `- ${w.id} [${w.status}] ${w.repo ?? 'general'}, ${modelLabel(w.model)}, context ${Math.round(w.contextTokens / 1000)}K` +
    `${idleDays ? `, last active ${idleDays} day(s) ago` : ''}${w.statusText ? `\n  Now: ${oneLine(w.statusText, 120)}` : ''}` +
    `\n  Tasks: ${tasks.map((x) => `${x.id} ${x.title} (${statusLine(x)}${x.prUrl ? ` ${x.prUrl}` : ''}${x.prState === 'MERGED' ? ' merged' : ''})`).join('; ') || 'none'}` +
    `${last?.summary ? `\n  Latest result: ${oneLine(last.summary, 160)}` : ''}` +
    `${w.ask ? `\n  Has not answered your question yet (asked ${clock(w.ask.at)}): ${oneLine(w.ask.text, 200)}` : ''}` +
    `${w.request ? `\n  Waits for your answer (since ${clock(w.request.at)}): ${oneLine(w.request.text, 300)}` : ''}` +
    `\n  New work: ${reuseBlock(w, store.data.tasks) ?? 'can take it'}`;
}

/**
 * What read_worker shows: the Worker's line, then the latest messages of its conversation, long ones cut so a look
 * stays cheap. Null when there is no such Worker.
 */
export function readWorker(id: string, last = 10) {
  const w = store.worker(id);
  if (!w) return null;
  const { items, total } = store.readLog(w.id, undefined, last);
  const cut = (s: string) => (s.length > 1500 ? `${s.slice(0, 1500)}… (${s.length - 1500} more characters cut)` : s);
  return `${workerLine(w.id)}\n\nConversation (latest ${items.length} of ${total} messages, oldest first)\n` +
    (items.map((i) => `[${clock(i.ts)} ${i.from}] ${cut(i.text.trim())}`).join('\n\n') || '(empty)');
}

/** What the Dispatcher is told when a message or question could not go to the Worker right away. */
function heldNote(how: 'slot' | 'limit', w: Worker) {
  const cur = workers.currentTask(w);
  return how === 'slot'
    ? `Held: ${cur?.id ?? 'its task'} waits for a free Worker slot, and the message goes out when it starts.`
    : 'Held: a usage limit holds every account, and the message goes out when the first one resets.';
}

/** The chat line for a task just handed to a Worker: started, waiting for a merge, or waiting for a free slot. */
export function assignedEvent(task: Task, w: Worker, continuing: boolean) {
  if (task.status === 'blocked') return t('ev.assignedAfter', { id: w.id, title: task.title, dep: task.afterTaskId ?? '' });
  if (waitsForSlot(task)) return t('ev.assignedSlot', { id: w.id, title: task.title, n: slotsUsed(store.data.tasks), max: loadSettings().maxWorkers });
  return t(continuing ? 'ev.assignedCont' : 'ev.assigned', { id: w.id, title: task.title });
}

/** Create a task and hand it to a Worker. Used by the Dispatcher tool and by UI buttons. */
export async function createTask(a: { title: string; prompt: string; kind: 'code' | 'other'; repo?: string; worker_id?: string; new_worker?: boolean; model?: 'opus' | 'fable'; after_task_id?: string; effort?: Effort; plan_first?: boolean }) {
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
  // No Worker named: reuse the idle one that best knows this code; a new Worker only when none fits.
  const reuse = a.worker_id || a.new_worker ? null : pickWorker(store.data.workers, store.data.tasks, task, model);
  const worker = await workers.assign(task, a.worker_id ?? reuse?.worker.id ?? null, model);
  return { task, worker, reused: reuse ? describePick(reuse, task.repo) : null };
}

function boardServer(d: Dispatcher) {
  return createSdkMcpServer({
    // 'ide' is reserved by Claude Code for IDE integration and its tools get filtered out.
    name: 'board',
    version: '0.2.0',
    // Always visible (not deferred behind tool search). Cloning can take long, so the timeout is generous.
    alwaysLoad: true,
    timeout: 45 * 60_000,
    tools: boardTools(d),
  });
}

/** The Dispatcher's tools, the same list whether it runs on Claude Code (an MCP server) or on Codex (dynamic tools). */
function boardTools(d: Dispatcher) {
  return [
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
      tool('create_task', 'Create a task and hand it to a Worker. Without worker_id it goes to the idle Worker that best knows the code (same repository, related past tasks, room in its context, same model), and a new Worker is created only when none fits; the result says which. With worker_id that Worker continues with its context. With after_task_id the task waits until that task\'s PR is merged, then starts automatically; if that task finishes without a PR it starts then, and if it fails or its PR is closed unmerged the waiting task is cancelled and you are told.', {
        title: z.string().describe('Short task name'),
        prompt: z.string().describe('Instructions for the Worker: background, desired result, definition of done. Include any attached file paths.'),
        kind: z.enum(['code', 'other']).describe('code: change a repository and open a PR. other: research, documents, reports'),
        repo: z.string().optional().describe('Repository name for code tasks'),
        worker_id: z.string().optional(),
        new_worker: z.boolean().optional().describe('Always start a new Worker, even if an idle one knows the code. Only when the user asks for a fresh Worker.'),
        model: z.enum(['opus', 'fable']).optional().describe('Default opus. fable only for deep design work'),
        after_task_id: z.string().optional().describe('Start only after this task\'s PR is merged (e.g. a follow-up that needs the merged change)'),
        effort: z.enum(EFFORTS as [Effort, ...Effort[]]).optional().describe('Reasoning effort for this task. Omit for the default. medium for mechanical work (resolving conflicts, renames, small or CI fixes), low for trivial edits or lookups, xhigh or max for hard debugging, tricky concurrency, or design.'),
        plan_first: z.boolean().optional().describe('The Worker investigates read-only and proposes a plan; the user approves it in the decision inbox before any change, and the same Worker then carries it out. Use when the user asks to see a plan first, or the change is large, risky, or ambiguous. Write the prompt for the whole job, not "plan only".'),
      }, async (a) => {
        try {
          const { task, worker: w, reused } = await createTask(a);
          d.acted();
          store.chat('event', assignedEvent(task, w, !!a.worker_id || !!reused));
          const wait = waitsForSlot(task)
            ? ` All ${loadSettings().maxWorkers} Worker slots are in use; it waits in the queue and starts by itself when one frees up.`
            : task.status === 'queued' ? ' Every account is held by a usage limit; it starts when the first one resets.'
            : task.status === 'blocked' ? ` It starts when ${task.afterTaskId}'s PR is merged.` : '';
          const how = reused ? ` Reused ${w.id}: ${reused}.` : a.worker_id ? '' : ` ${w.id} is a new Worker: no idle Worker${task.repo ? ` on ${task.repo}` : ''} fit (busy, near compaction, or none yet).`;
          return ok(`${task.id} assigned to ${w.id}.${how}${wait}`);
        } catch (e) {
          return fail(`Could not create the task: ${(e as Error).message}`);
        }
      }),
      tool('send_to_worker', 'Send further instructions to a running or idle Worker. It is also how you answer what a Worker asked you for. To get an answer from a Worker, use ask_worker instead.', {
        worker_id: z.string(),
        message: z.string(),
      }, async (a) => {
        try {
          const w = store.worker(a.worker_id);
          const no = w && d.mayWrite(w.id);
          if (no) return fail(no);
          const how = workers.send(a.worker_id, 'dispatcher', a.message);
          return ok(how === 'sent' ? 'Sent.' : heldNote(how, w!));
        } catch (e) {
          return fail((e as Error).message);
        }
      }),
      tool('ask_worker', 'Ask a Worker a question: what it found, where it stands, why it chose something. It answers from its own context without stopping its work, and no task is opened or reopened for it. The answer is not in this tool\'s result: it arrives by itself in a "[Worker updates]" message, which starts a turn of yours. Check read_worker first; what the Worker already said needs no question.', {
        worker_id: z.string(),
        question: z.string().describe('Complete on its own: say what you need back and why.'),
      }, async (a) => {
        try {
          const w = store.worker(a.worker_id);
          const no = w && d.mayWrite(w.id);
          if (no) return fail(no);
          const how = workers.ask(a.worker_id, a.question);
          const later = 'The answer arrives by itself in a "[Worker updates]" message. Tell the user in one line that you asked, and end your turn; do not ask again or check for it.';
          if (how !== 'sent') return ok(`${heldNote(how, w!)} ${later}`);
          return ok(w!.status === 'waiting'
            ? `Asked. ${w!.id} is waiting for the user to decide something, so it reads the question after that. ${later}`
            : `Asked. ${later}`);
        } catch (e) {
          return fail((e as Error).message);
        }
      }),
      tool('read_worker', "Read a Worker's side without disturbing it: its status, what it is doing now, what is unanswered between you, and the latest messages of its conversation (what it was told and what it said). Costs the Worker nothing, so look here before asking it.", {
        worker_id: z.string(),
        last: z.number().int().min(1).max(40).optional().describe('How many of the latest messages to show. Default 10.'),
      }, async (a) => {
        const view = readWorker(a.worker_id, a.last);
        return view ? ok(view) : fail(t('err.noWorker', { id: a.worker_id }));
      }),
      tool('stop_worker', 'Stop what a Worker is doing (the session stays, so it can continue later).', { worker_id: z.string() }, async (a) => {
        await workers.stop(a.worker_id, 'dispatcher');
        return ok('Stopped.');
      }),
      tool('cancel_task', 'Cancel a task that is waiting to start: queued (waiting for a free Worker slot, or paused until a usage limit resets) or blocked (waiting for another task\'s PR to merge). It will not start. Tasks waiting on it with after_task_id are cancelled too. Its branch is deleted (and its Worker archived if it has nothing else) unless the branch holds commits or uncommitted changes. If it has an open PR, only the queued review, CI or follow-up work is dropped and the PR stays. Running work is not affected; use stop_worker for that.', {
        task_id: z.string(),
      }, async (a) => {
        try {
          const rs = await workers.cancelTask(a.task_id, 'dispatcher');
          return ok(rs.map(describeCancel).join('\n'));
        } catch (e) {
          return fail((e as Error).message);
        }
      }),
      tool('clear_queue', 'Cancel every queued or blocked task, as cancel_task does for each. Use it when the user asks to clear, reset or empty the queue. Running work is not affected.', {}, async () => {
        const rs = await workers.clearQueue('dispatcher');
        return ok(rs.length ? rs.map(describeCancel).join('\n') : 'The queue was already empty.');
      }),
      tool('request_decision', 'Put something the user must decide into the decision inbox. The answer arrives later as a "[Decision answer]" message.', {
        question: z.string(),
        options: z.array(z.string()).min(2).max(4),
        context: z.string().optional(),
        why: z.string().optional().describe(`One short sentence in ${langName()} on why the user must decide this: what depends on it and what each choice risks or changes. Shown on the card and in the notification.`),
      }, async (a) => {
        createDecision({
          source: 'dispatcher', workerId: null, taskId: null, title: a.question, detail: a.context ?? '', code: null,
          options: a.options.map((o) => ({ label: o })), questionKey: null, reason: dispatcherReason(t, a.why),
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
  ];
}

function systemPrompt() {
  const repos = store.data.repos.map(repoLine).join('\n') || '(none)';
  return [
    `You are the Dispatcher of Oh My Agent IDE. The user states work in one window and sees only decisions and results. Reply in ${langName()}.`,
    '',
    'Role',
    '1. Split requests into tasks and hand them to Workers with create_task. Do not edit code or do long research yourself; a quick look at a repository to route work is fine.',
    '2. Prefer Workers that already know the code. More instructions on work in progress go to its Worker with send_to_worker. For a new task, create_task without worker_id hands it to the idle Worker that best knows the repository (related past tasks, room left in its context) and creates a new Worker only when none fits. Give worker_id yourself to continue a specific thread of work (same PR, a follow-up); list_workers says under "New work" whether a Worker can take it, and do not pick one marked near compaction or busy. Use new_worker only when the user asks for a fresh Worker. Several independent tasks at once go to different Workers by themselves.',
    '3. If the user names a repo with @name, use it; otherwise pick by description. If unclear, ask with request_decision. Requests like "register this" use register_repo.',
    '4. Model: opus by default; fable only for deep design work such as architecture or large structural changes.',
    '5. Put anything the user must decide into the decision inbox with request_decision. Ask back in chat only when you cannot understand the request.',
    '6. Save preferences, principles and repository traits the user states with remember. Use recall when you need a basis for a judgment.',
    `7. ${loadSettings().effortPerTask ? `Effort on create_task: omit it for ordinary work (the default is ${loadSettings().workerEffort}). Set medium for mechanical work (resolving conflicts, renames, small fixes, CI fixes, routine follow-ups) and low for trivial edits or lookups; set xhigh or max only for design, hard debugging or tricky concurrency.` : 'Do not set effort on create_task; the user fixed it in settings.'}`,
    '8. When work depends on a change that is still in an open PR, create it with after_task_id so it starts automatically after the merge. Use plan_first when the user wants to review the approach first (for example plan first or show me the plan) or a code change is large, risky or open to several designs; small, clear changes do not need it.',
    '9. If the message ends with "[Attached files]", pass those absolute paths to the Worker in the task prompt. You may Read them to decide routing.',
    '10. Keep replies short: one or two sentences on what you gave to whom. Avoid lists and headings.',
    '11. To cancel work that has not started or is paused (queued or blocked), use cancel_task; when the user asks to clear or reset the queue, use clear_queue. If a branch was kept because it holds work, tell the user where it is. Running work is stopped with stop_worker instead.',
    '12. Only a set number of Workers run at once (Settings). A task queued for a free Worker slot starts by itself, the longest waiting first, when a running one finishes; do not cancel or re-create it for that.',
    '13. To learn something from a Worker, look with read_worker first (its status and what it said last). If the answer is not there, ask with ask_worker: the Worker answers from its own context without stopping its work, and no task is opened for it. The answer does not come in the same turn, so say in one line that you asked and end your turn. Do not ask again while a question is unanswered, and do not create a task just to get an answer.',
    '14. A Worker may ask you for something or report that it is blocked; you see it in "[Worker updates]". A task that stopped for you stays open and keeps its Worker slot until that Worker hears from you, so always finish with send_to_worker: the answer, or what you did about it (the task you created with create_task, what the user decided). If only the user can decide, ask with request_decision first and write to the Worker when the answer comes; do not write to it just to say it should wait.',
    '',
    'A message prefixed with "[Worker updates]" lists what happened to Workers since your last turn. With a message from the user, use what is relevant to the request; no need to report the rest.',
    '"[Automatic turn]" means nobody wrote to you: Worker news started this turn. Judge it. If the user should know (an answer you asked for, a problem, a result that changes what happens next), tell them in one to three sentences what it means for them, not a copy of it; every finished task already shows a result card. Act where needed: answer the Worker, create the next task, or ask the user with request_decision. If there is nothing to say or do, reply with exactly NOOP and nothing else.',
    '"[Decision answer]" is the user\'s answer from the decision inbox. Follow up accordingly.',
    'A user message that starts with "[Reply to NAME]" and a quoted line answers that one earlier message (yours, or a Worker\'s when NAME is its id): read the rest as being about the quoted message.',
    '',
    `Today: ${today()}`,
    '',
    'Registered repositories',
    repos,
    '',
    'IDE memory digest',
    memoryDigest(5000) || '(empty)',
    '',
    'Memos the user shares with you (their own notes: follow them as you would a stated preference)',
    sharedMemoDigest(store.data.memos ?? []) || '(none)',
  ].join('\n') + (loadSettings().claudeRules ? userRulesSection() : '');
}

class Dispatcher {
  session: AgentSession | CodexSession | null = null;
  statusText = '';
  /** Messages that came while every account was held by a usage limit; sent when the first one resets. */
  private held: string[] = [];
  /** A turn a usage limit cut off; continued when the first limit resets. */
  private cutOff = false;
  /** How long Worker news is gathered before it starts a turn. */
  wakeDelay = WAKE_DELAY_MS;
  private wakeTimer: NodeJS.Timeout | null = null;
  /** Worker news worth a turn waits for one. */
  private wakeDue = false;
  /** The turn in progress was started by Worker news, not by the user. */
  private auto = false;
  /** ...and in it the Dispatcher wrote to a Worker or created a task. */
  private autoActed = false;
  /** Such turns in a row since the user last spoke, and what they sent to each Worker. */
  private autoTurns = 0;
  private autoSends = new Map<string, number>();
  private autoPaused = false;

  get busy() { return !!this.session?.busy; }

  /** What the Dispatcher's session reports, whichever agent runs it. */
  private sessionEvents(): SessionEvents {
    const d = store.data.dispatcher;
    return {
      onInit: (sid) => { d.sessionId = sid; store.changed(); },
      onAccount: (id) => { d.accountId = id; store.changed(); },
      // An automatic turn with nothing to say answers NOOP, which is not shown.
      onText: (text) => { if (!(this.auto && NOOP_RE.test(text))) store.chat('dispatcher', text); },
      onTurnEnd: (r) => {
        // With more input queued, another turn follows.
        if (r.queued) return;
        if (!r.internal) {
          if (this.auto && this.autoActed) this.autoTurns += 1;
          this.auto = false;
          this.autoActed = false;
        }
        // News that came during the turn gets its own.
        if (this.wakeDue) this.wake();
      },
      onTool: (_n, summary) => { this.statusText = summary; store.changed(); },
      onContext: (n) => { d.contextTokens = n; store.changed(); },
      onSpend: (turn, session) => {
        d.sessionSpend = session;
        if (hasSpend(turn)) store.dispatcherSpent(turn);
        else store.changed();
      },
      // By hand, after a turn at 80% of the window, or by Claude Code mid-turn: all shown in the chat.
      onCompact: (e) => {
        if (e.phase === 'start') this.statusText = t('st.compacting');
        else {
          this.statusText = '';
          store.chat(e.phase === 'done' ? 'event' : 'error', e.phase === 'done' ? t('ev.compacted', { a: kTokens(e.from), b: kTokens(e.to) }) : t('ev.compactFailed', { msg: oneLine(e.error, 200) }));
        }
        store.changed();
      },
      onStatus: (st, text) => {
        if (st === 'error') {
          store.chat('error', t('err.dispatcher', { msg: text }));
          // A session that died mid-turn ends no turn, so an automatic one is over here.
          this.auto = false;
          this.autoActed = false;
        }
        if (st !== 'busy') this.statusText = '';
        store.changed();
      },
      onLimited: () => {
        this.cutOff = true;
        store.chat('event', t('ev.limitPaused', { time: limitResetText(accounts.nextFreeAt(this.provider)) }));
      },
    };
  }

  /** Whose agent runs the Dispatcher: follows the model chosen in Settings. */
  get provider() {
    return providerOf(loadSettings().dispatcherModel, cachedModels().models);
  }

  private open(): AgentSession | CodexSession | null {
    const d = store.data.dispatcher;
    const provider = this.provider;
    // A conversation cannot move between Claude Code and Codex: after the model changed sides, a new one starts.
    const switched = (d.provider ?? 'claude') !== provider;
    const freshDay = d.date !== today() || switched;
    if (this.session && !this.session.closed && !freshDay) return this.session.ready() ? this.session : null;
    if (this.session) this.session.close();
    const own = accounts.get(d.accountId);
    const acc = own && own.provider === provider && accounts.isFree(own.id) ? own : accounts.pick(undefined, provider);
    if (!acc) return null;
    d.provider = provider;
    if (freshDay) {
      d.sessionId = null;
      d.sessionSpend = null;
      d.date = today();
      d.contextTokens = 0;
    }
    const events = this.sessionEvents();
    const s = provider === 'chatgpt' ? new CodexSession({
      label: 'Dispatcher',
      model: loadSettings().dispatcherModel,
      cwd: paths().home,
      instructions: systemPrompt(),
      accountId: acc.id,
      resume: d.sessionId,
      spent: d.sessionSpend,
      effort: loadSettings().dispatcherEffort,
      tools: codexToolsFrom(boardTools(this) as unknown as SdkToolDef[]),
      // The Dispatcher reads and hands out work; it changes nothing itself, and has nobody to ask.
      sandbox: 'read-only',
      approvalPolicy: 'never',
    }, events, codexClient()) : new AgentSession({
      label: 'Dispatcher',
      model: loadSettings().dispatcherModel,
      cwd: paths().home,
      systemAppend: systemPrompt(),
      accountId: acc.id,
      resume: d.sessionId,
      spent: d.sessionSpend,
      mcpServers: { board: boardServer(this) },
      tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      additionalDirectories: [paths().repos],
      effort: loadSettings().dispatcherEffort,
      // The Dispatcher only has read-only tools, including for attached files.
      canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
    }, events);
    this.session = s;
    store.changed();
    return s;
  }

  /**
   * Worker news worth a turn of its own arrived (store 'wake'): an answer to a question, a request, a blocked or
   * failed task, a result. The Dispatcher starts a turn for it once the news has settled and it is free, so the
   * user hears what it means without having to ask.
   */
  wake() {
    this.wakeDue = true;
    if (this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.runWake();
    }, this.wakeDelay);
    this.wakeTimer.unref?.();
  }

  private runWake(): void {
    // Mid-turn: the end of the turn calls wake() again.
    if (!this.wakeDue || this.busy) return;
    // Held by a usage limit: the updates go along when it resets.
    if (this.held.length || this.cutOff) return this.retryHeld();
    if (!store.data.pendingUpdates.length) { this.wakeDue = false; return; }
    if (this.autoTurns >= MAX_AUTO_TURNS) {
      // The updates stay for the user's next message.
      this.wakeDue = false;
      if (!this.autoPaused) store.chat('event', t('ev.autoPaused', { n: MAX_AUTO_TURNS }));
      this.autoPaused = true;
      return;
    }
    const s = this.open();
    // No account is free: the news stays due, and retryHeld (run when a limit resets, and every two minutes) starts the turn.
    if (!s) return;
    this.auto = true;
    this.autoActed = false;
    this.deliver(s, [AUTO_NOTE]);
  }

  /**
   * The Dispatcher is about to write to a Worker. In turns it started by itself that is allowed only a few times
   * per Worker, so the two cannot keep answering each other with the user away. Returns why not, or null.
   */
  mayWrite(workerId: string): string | null {
    if (!this.auto) return null;
    const n = this.autoSends.get(workerId) ?? 0;
    if (n >= MAX_AUTO_SENDS) {
      return `Not sent: you have written to ${workerId} ${MAX_AUTO_SENDS} times since the user last spoke, and going back and forth without them stops here. Tell the user in a sentence or two where things stand and what you need from them, then end your turn.`;
    }
    this.autoSends.set(workerId, n + 1);
    this.autoActed = true;
    return null;
  }

  /** The turn in progress changed something by itself (created a task). */
  acted() {
    if (this.auto) this.autoActed = true;
  }

  /** The user spoke: what the Dispatcher may do by itself starts over. */
  private userSpoke() {
    this.auto = false;
    this.autoActed = false;
    this.autoTurns = 0;
    this.autoSends.clear();
    this.autoPaused = false;
  }

  /** A message the user typed in the chat, with optional attached file paths. */
  send(text: string, files: string[] = []) {
    const attached = registerAttachments(files);
    const full = text + attachmentBlock(attached);
    store.chat('user', full);
    this.userSpoke();
    const s = this.open();
    if (!s) {
      if (!accounts.list().length) { store.chat('error', t('err.noAccount')); return; }
      this.held.push(full);
      store.chat('event', t('ev.limitHeld', { time: limitResetText(accounts.nextFreeAt(this.provider)) }));
      store.changed();
      return;
    }
    this.deliver(s, [full]);
  }

  /** The user answered a question the Dispatcher posted. */
  decisionAnswered(question: string, answer: string) {
    const msg = `[Decision answer] Question: ${question}\nAnswer: ${answer}`;
    this.userSpoke();
    const s = this.open();
    if (!s) { this.held.push(msg); return; }
    this.deliver(s, [msg]);
  }

  /** A usage limit reset: continue the cut-off turn and send what was held, if an account is free now. */
  retryHeld(): void {
    // Nothing held: Worker news that could not start a turn during the limit starts one now.
    if (!this.held.length && !this.cutOff) return this.runWake();
    const s = this.open();
    if (!s) return;
    store.chat('event', t('log.limitCleared'));
    this.deliver(s, []);
  }

  /** Send messages in one turn, after Worker updates and anything a usage limit held back. */
  private deliver(s: AgentSession | CodexSession, msgs: string[]) {
    const parts = this.cutOff ? ['[Usage limit reset] Your last turn was cut off by a usage limit. Continue where you left off.'] : [];
    parts.push(...this.held, ...msgs);
    this.held = [];
    this.cutOff = false;
    // Every update goes with this message, so none is left to start a turn for.
    this.wakeDue = false;
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
    if (!s) throw new Error(accounts.list().length ? t('err.limitUntil', { time: limitResetText(accounts.nextFreeAt(this.provider)) }) : t('err.noAccount'));
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
