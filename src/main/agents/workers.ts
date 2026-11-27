import path from 'node:path';
import { AgentSession, type SessionEvents } from './session';
import { connectorAllowedTools } from './connectors';
import { CodexSession } from './codexSession';
import { codexClient } from '../codex/client';
import { providerOf } from '../../shared/models';
import { alwaysAskHook } from './permissions';
import { REMIND_AFTER, stepsReminder, stepsReminderHook } from './stepsReminder';
import { REVIEWER, reviewerAgent } from './selfReview';
import { accounts } from '../accounts';
import { store } from '../store';
import { userRulesSection } from '../claudeContext';
import { paths } from '../paths';
import { loadSettings, claudeHelperModel } from '../settings';
import { cachedModels } from '../models';
import { modelLabel as labelFor } from '../../shared/models';
import { ensureWorktree, ghEnv } from '../repos';
import { t } from '../i18n';
import { ensureDir, nowIso, oneLine } from '../util';
import { artifactCommentLine } from '../../shared/artifactComment';
import type { Task, Worker } from '../../shared/types';
import { currentTask, openTask } from '../../shared/currentTask';
import { FakeSession } from './fakeSession';
import { fakeMode } from '../fake';
import { addSpend, hasSpend } from '../../shared/spend';
import { COMPACT_AT, kTokens } from '../../shared/context';
import { WORKER_COMPACT } from '../../shared/compactInstructions';
import { needsPlan, workerPrompt } from './workerPrompt';
import { SHELL_OUTPUT_CHARS, type TellKind, UNUSED_TOOLS, WORKER_ENV } from './workerText';
import { workerCodexTools, workerMemoryDir, workerTools, type StepsOp } from './workerTools';
import * as archive from './workers/archive';
import * as cancel from './workers/cancel';
import * as messages from './workers/messages';
import * as permissions from './workers/permissions';
import * as plans from './workers/plans';
import * as queue from './workers/queue';
import * as questions from './workers/questions';
import * as results from './workers/results';

// The Workers: their state, their sessions and the methods the rest of the app calls. What happens on each kind of
// event is in the area files under workers/ (permissions, questions, plans, results, queue, messages, cancel,
// archive); each takes this manager as its first argument and calls the public methods back through it.

/** A Worker's session: Claude Code, or Codex for a ChatGPT model. The owner uses what the two have in common. */
export type WorkerSession = AgentSession | CodexSession | FakeSession;
export type FeedbackKind = 'review' | 'ci' | 'conflict';

export class WorkerManager {
  // What the area files keep between calls, per Worker or per task. Only they and this class change it.
  sessions = new Map<string, WorkerSession>();
  /** What each Worker said last in its current turn: a permission card's purpose line comes from it (askWhy.ts). */
  said = new Map<string, string>();
  /** Review fixes, CI fixes and follow-ups on finished tasks get different result-card wording. */
  reviewing = new Set<string>();
  /** Workers whose files were put back to a checkpoint since their last message. */
  restored = new Set<string>();
  /** The latest read of each Worker's changed files (recordChanged): an older read finishing later is dropped. */
  changedSeq = new Map<string, number>();
  ciFixing = new Set<string>();
  followups = new Set<string>();
  /** Plan-first tasks whose Worker was reminded to present its plan, until it presents one. */
  planNudged = new Set<string>();
  /** Tool calls per task made without progress steps, for the one-time reminder (see stepsReminder). */
  stepless = new Map<string, number>();
  /** Plan-first tasks whose Worker was already sent back once for leaving out the WHAT / HOW / OUTPUT lines. */
  summaryAsked = new Set<string>();
  /** Workers with no open task that the Dispatcher wrote to: what their turn says goes back to it. */
  replyOwed = new Set<string>();
  /** Workers sent a Dispatcher question that no turn of theirs has ended on yet. */
  questioned = new Set<string>();
  /** Requests that started a Dispatcher turn, per task (or Worker, with no task open). */
  requestWakes = new Map<string, number>();
  /** Workers the user stopped whose turn has not ended yet: that turn's error is the Stop, not a failure. */
  stopping = new Map<string, 'user' | 'dispatcher'>();
  /** Tasks whose stall reminder went out, so a second stall flags the Worker instead of reminding it again. */
  stallNudged = new Set<string>();
  /** Tasks whose Worker was told once that a turn ended without RESULT; another such turn may finish them. */
  resultReminded = new Set<string>();
  /** Tasks finished without a PR whose branch GitHub was already asked about (queue.ts followUp). */
  branchChecked = new Set<string>();
  /** Tasks cancelled while this Worker's session had them, per Worker; it hears it with its next message. */
  notes = new Map<string, string[]>();
  /** Archived Workers whose worktree is being made again; a second call waits for the same one. */
  unarchiving = new Map<string, Promise<void>>();
  /** Messages that came while a usage limit held every account, per Worker; sent when the first limit resets. */
  held = new Map<string, string[]>();
  /** PR feedback for a finished task that came while its Worker was on another one, per Worker, oldest first. */
  feedback = new Map<string, { taskId: string; body: string; kind: FeedbackKind }[]>();
  /** Tasks that waited unassigned and are being given a Worker now (its worktree is made): each holds a slot meanwhile. */
  binding = new Set<string>();

  list() { return store.data.workers; }

  /** The Worker did something: its idle clock starts again. */
  touch(w: Worker) {
    w.lastActiveAt = nowIso();
    store.changed();
  }

  /**
   * Background work its session still runs for its open task: subagents, and shells such as a test run or a build.
   * Each starts a turn by itself when it ends, so the Worker is still at work, not idle.
   */
  private pending(w: Worker) {
    const s = this.sessions.get(w.id);
    if (!s || this.currentTask(w)?.status !== 'running') return { agents: 0, shells: 0 };
    return { agents: s.background, shells: s.shells };
  }

  /** What a Worker waiting on background work shows, or null when it waits on none. */
  private pendingText(w: Worker, p = this.pending(w)) {
    if (p.agents > 0) return t('st.subagents', { n: p.agents });
    if (p.shells > 0) return t('st.shells', { n: p.shells });
    return null;
  }

  /** Its open task (shared/currentTask.ts, the rule the window draws it with), or null. */
  currentTask(w: Worker): Task | null {
    return openTask(w, (id) => store.task(id));
  }

  async create(opts: { title: string; repo: string | null; model: string }): Promise<Worker> {
    const id = store.nextWorkerId();
    let cwd: string;
    const repo = opts.repo ? store.repo(opts.repo) : null;
    if (opts.repo && !repo) throw new Error(t('err.noRepo', { name: opts.repo }));
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
    store.handout(t('ev.workerCreated', { id: w.id, repo: repo ? repo.name : t('general'), model: modelLabel(w.model) }));
    return w;
  }

  /** Open a session on a picked account if none is open. Null when a usage limit holds every account. */
  ensureSession(w: Worker): WorkerSession | null {
    const existing = this.sessions.get(w.id);
    if (existing && !existing.closed) return existing.ready() ? existing : null;
    // Fake agent mode: a scripted session with the Worker's real permission, question and plan handler. No account.
    if (fakeMode()) {
      const fake = new FakeSession({ label: w.id, model: w.model, cwd: w.cwd, accountId: null, resume: w.sessionId, steps: (op) => this.steps(w, op), canUseTool: permissions.permissionHandler(this, w), permissionMode: needsPlan(this.currentTask(w)) ? 'plan' : 'auto' }, this.sessionEvents(w));
      this.sessions.set(w.id, fake);
      return fake;
    }
    // The Worker's model decides whose agent runs it, and so which accounts can carry it.
    const provider = providerOf(w.model, cachedModels().models);
    const own = accounts.get(w.accountId);
    const acc = own && own.provider === provider && accounts.isFree(own.id) ? own : accounts.pick(undefined, provider);
    if (!acc) return null;
    const memDir = workerMemoryDir(w);
    const events = this.sessionEvents(w);
    // Codex has no tool hooks: the steps reminder is added to the turn in progress instead (Claude: stepsReminderHook).
    const codexEvents: SessionEvents = {
      ...events,
      onTool: (name, summary) => {
        events.onTool?.(name, summary);
        const task = this.currentTask(w);
        const text = stepsReminder(this.stepless, task, name);
        const cs = this.sessions.get(w.id);
        // Not delivered: the next tool call tries again.
        if (text && task && cs instanceof CodexSession) void cs.steer(text).then((ok) => { if (!ok) this.stepless.set(task.id, REMIND_AFTER - 1); });
      },
    };
    const s: WorkerSession = provider === 'chatgpt' ? new CodexSession({
      label: w.id,
      model: w.model,
      cwd: w.cwd,
      instructions: workerPrompt(w, true) + (loadSettings().claudeRules ? userRulesSection() : ''),
      accountId: acc.id,
      resume: w.sessionId,
      spent: w.sessionSpend,
      effort: loadSettings().workerEffort,
      tools: workerCodexTools(loadSettings().claudeMemory ? memDir : null, (kind, text) => this.fromWorker(w, kind, text), (op) => this.steps(w, op)),
      // Files in the worktree are the Worker's to change; anything past it (the network for a push, other folders) is asked.
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approve: permissions.codexApproval(this, w),
    }, codexEvents, codexClient()) : new AgentSession({
      label: w.id,
      model: w.model,
      cwd: w.cwd,
      systemAppend: workerPrompt(w) + (loadSettings().claudeRules ? userRulesSection() : ''),
      // One auto-memory per repository, shared with the user's own Claude Code sessions there (not one per worktree).
      // Off in Settings: no Claude Code auto-memory at all, rather than a separate one per worktree.
      settings: { ...(loadSettings().claudeMemory ? { autoMemoryDirectory: memDir } : { autoMemoryEnabled: false }), bashOutputMaxChars: SHELL_OUTPUT_CHARS },
      mcpServers: { oma: workerTools(loadSettings().claudeMemory ? memDir : null, (kind, text) => this.fromWorker(w, kind, text), (op) => this.steps(w, op)) },
      disallowedTools: UNUSED_TOOLS,
      env: WORKER_ENV,
      connectors: loadSettings().claudeConnectors,
      allowedTools: connectorAllowedTools(loadSettings().claudeConnectors, loadSettings().artifactAutoReply),
      // Not when its task has finished: it is compacted before its next task instead (startTask, WORKER_TASK_COMPACT).
      compactAt: () => (this.currentTask(w) ? COMPACT_AT : Infinity),
      compactInstructions: WORKER_COMPACT,
      accountId: acc.id,
      resume: w.sessionId,
      spent: w.sessionSpend,
      settingSources: w.repo ? ['project', 'local'] : [],
      effort: loadSettings().workerEffort,
      permissionMode: needsPlan(this.currentTask(w)) ? 'plan' : 'auto',
      canUseTool: permissions.permissionHandler(this, w),
      hooks: { PreToolUse: [alwaysAskHook()], PostToolUse: [stepsReminderHook((tool) => stepsReminder(this.stepless, this.currentTask(w), tool))] },
      // Registered even with self-review off, so turning it on reaches sessions that are already open.
      // Its model is read when the session starts, like the Worker's own.
      agents: { [REVIEWER]: reviewerAgent(claudeHelperModel()) },
    }, events);
    this.sessions.set(w.id, s);
    return s;
  }

  /** What a Worker's session reports, whichever agent runs it. */
  private sessionEvents(w: Worker): SessionEvents {
    return {
      onInit: (sid) => { w.sessionId = sid; store.changed(); },
      onAccount: (id) => { w.accountId = id; store.changed(); },
      onText: (text) => {
        store.log(w.id, 'worker', text);
        if (text.trim()) this.said.set(w.id, text);
        w.statusText = oneLine(text, 140);
        this.touch(w);
      },
      onTool: (_name, summary) => { w.statusText = summary; store.changed(); },
      onArtifactComment: (e) => store.log(w.id, 'event', artifactCommentLine(t, e)),
      onContext: (n) => { w.contextTokens = n; },
      onSpend: (turn, session) => {
        w.sessionSpend = session;
        // A turn outside any open task (a message to an idle Worker) counts toward its latest task.
        const task = currentTask(w, (id) => store.task(id));
        if (task && hasSpend(turn)) task.spend = addSpend(task.spend, turn);
        store.changed();
      },
      onStatus: (st, text) => {
        // The turn the user stopped ends in an error: the Worker is idle, not in error.
        const stopped = st !== 'busy' && this.stopping.has(w.id);
        // A turn starts or ends: what the Worker said before belongs to another turn.
        this.said.delete(w.id);
        // A compaction ends before the session goes idle; one cut short by an error or a closed session ends here.
        if (st !== 'busy') w.compactingSince = null;
        if (st === 'busy') {
          if (w.status !== 'waiting') w.status = 'running';
          w.stalledAt = null;
        } else if (st === 'idle' && !stopped && this.pendingText(w)) {
          // The turn ended to wait for background subagents or shells (a long test run or build), and each one starts
          // a turn by itself when it ends: the Worker is still at work on its task, not idle (T-0046, T-0064).
          w.status = 'running';
          w.statusText = this.pendingText(w)!;
        } else if (st === 'idle' || stopped) {
          w.status = 'idle';
          if (stopped) {
            w.statusText = '';
            // A session that died after the stop never ended its turn: its task is stopped all the same.
            const task = this.currentTask(w);
            if (st !== 'idle' && task && task.status !== 'queued') results.fail(this, w, task, text);
            this.stopping.delete(w.id);
          }
        } else {
          w.status = 'error';
          w.statusText = text;
          store.log(w.id, 'event', t('log.error', { msg: text }));
          // A failed turn has settled its task already (onTurnEnd). A task still in progress here lost its session
          // (the process died or never launched), so it failed too: a Worker in error has nothing in progress.
          // A queued task never ran on this session; it stays for when the limit resets.
          const task = this.currentTask(w);
          if (task && task.status !== 'queued') results.fail(this, w, task, text);
        }
        this.touch(w);
        if (st === 'idle') this.fillSlots();
      },
      onTurnEnd: (r) => {
        void results.recordChanged(this, w);
        // With more input queued, the turn that follows settles the task.
        if (r.internal || r.queued) return;
        results.turnEnded(this, w, r.text, r.isError, !!r.background);
      },
      // Between turns: the last background task settled without a turn of its own starting (yet), so the Worker is idle.
      onBackground: () => {
        if (this.sessions.get(w.id)?.busy || w.status !== 'running') return;
        const text = this.pendingText(w);
        // Shells coming and going are not activity: they must not restart the wait before the stall reminder.
        if (text) { w.statusText = text; return store.changed(); }
        w.status = 'idle';
        w.statusText = '';
        this.touch(w);
      },
      // A task message that waited for a compaction goes out when the limit resets.
      onLimited: (held) => {
        if (held?.length) this.held.set(w.id, [...(this.held.get(w.id) ?? []), ...held]);
        queue.pause(this, w, this.currentTask(w));
      },
      // Messages sent while a stopped turn was ending: its task is stopped now, so they go out as new messages do
      // (a follow-up reopens it, or waits for a slot).
      onResend: (texts) => texts.forEach((m) => messages.post(this, w, m)),
      // Shown in the Worker's conversation. A failed compaction leaves the task alone (it is retried later).
      onCompact: (e) => {
        w.compactingSince = e.phase === 'start' ? nowIso() : null;
        if (e.phase === 'start') {
          w.statusText = t('st.compacting');
          store.log(w.id, 'event', t('log.compacting', { a: kTokens(e.tokens) }));
        } else {
          if (w.statusText === t('st.compacting')) w.statusText = '';
          store.log(w.id, 'event', e.phase === 'done' ? t('log.compacted', { a: kTokens(e.from), b: kTokens(e.to) }) : t('log.compactFailed', { msg: oneLine(e.error, 200) }));
        }
        store.changed();
      },
    };
  }

  /**
   * The user's (or the Dispatcher's) Stop. A turn under way is interrupted, with what was sent after it, and its
   * task shows as stopped, not failed. With no turn under way, an open task (one that waits for the Dispatcher) is
   * stopped at once and gives its slot back. Says which it was.
   */
  async stop(workerId: string, by: 'user' | 'dispatcher'): Promise<'interrupted' | 'stopped' | 'idle'> {
    const s = this.sessions.get(workerId);
    if (s?.busy) {
      this.stopping.set(workerId, by);
      await s.interrupt();
      return 'interrupted';
    }
    const w = store.worker(workerId);
    const task = w ? this.currentTask(w) : null;
    if (!w || !task || (task.status !== 'running' && task.status !== 'waiting')) return 'idle';
    // Its turn ended to wait for background subagents or shells: they go with their process, or one would start a turn
    // on the stopped task when it ends. The next message resumes the same conversation in a new process.
    if (s && s.background + s.shells > 0) {
      s.close();
      this.sessions.delete(w.id);
      this.said.delete(w.id);
      w.compactingSince = null;
    }
    // Idle first: failing the task frees the slot, and fillSlots may hand this Worker held feedback or queued work.
    w.status = 'idle';
    w.statusText = '';
    this.stopping.set(w.id, by);
    results.fail(this, w, task, '');
    this.stopping.delete(w.id);
    this.touch(w);
    return 'stopped';
  }

  closeAll() {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  ghEnv() { return ghEnv(); }

  // The rest of the app calls these; the work is done in the area files.
  revokeGrant(taskId: string, key: string) { return permissions.revokeGrant(this, taskId, key); }
  fromWorker(w: Worker, kind: TellKind, text: string, spoken?: boolean): string { return questions.fromWorker(this, w, kind, text, spoken); }
  ask(workerId: string, text: string) { return questions.askWorker(this, workerId, text); }
  steps(w: Worker, op: StepsOp): string { return plans.steps(this, w, op); }
  checkpoints(workerId: string) { return results.checkpoints(this, workerId); }
  restore(workerId: string, ref: string) { return results.restore(this, workerId, ref); }
  diff(workerId: string) { return results.diff(this, workerId); }
  assign(task: Task, workerId: string | null, model: string): Promise<Worker> { return queue.assign(this, task, workerId, model); }
  enqueue(task: Task, how: 'blocked' | 'slot' | 'limit') { return queue.enqueue(this, task, how); }
  slotFree() { return queue.slotFree(this); }
  accountFree(model: string) { return queue.accountFree(model); }
  onPrSettled(doneTask: Task, merged: boolean) { return queue.onPrSettled(this, doneTask, merged); }
  sweepWaiting(now?: number) { return queue.sweepWaiting(this, now); }
  sweepStalled(now?: number) { return queue.sweepStalled(this, now); }
  fillSlots() { return queue.fillSlots(this); }
  retryQueued() { return queue.retryQueued(this); }
  resumeAfterRestart() { return queue.resumeAfterRestart(this); }
  effortFor(task: Task | null) { return queue.effortFor(this, task); }
  send(workerId: string, from: 'user' | 'dispatcher', text: string) { return messages.send(this, workerId, from, text); }
  sendReview(task: Task, body: string, kind?: FeedbackKind) { return messages.sendReview(this, task, body, kind); }
  cancelTask(id: string, by: 'user' | 'dispatcher') { return cancel.cancelTask(this, id, by); }
  clearQueue(by: 'user' | 'dispatcher') { return cancel.clearQueue(this, by); }
  inUse(workerId: string) { return archive.inUse(this, workerId); }
  archive(workerId: string): Promise<{ kept: 'task' | 'dirty' | null }> { return archive.archive(this, workerId); }
  checkArchive(workerId: string) { return archive.checkArchive(this, workerId); }
  checkRetire(name: string) { return archive.checkRetire(this, name); }
  retireRepo(name: string): Promise<string[]> { return archive.retireRepo(this, name); }
  unarchive(w: Worker): Promise<void> { return archive.unarchive(this, w); }
  autoArchive() { return archive.autoArchive(this); }
}

export function modelLabel(m: string) {
  return labelFor(m, cachedModels().models);
}

export const workers = new WorkerManager();
