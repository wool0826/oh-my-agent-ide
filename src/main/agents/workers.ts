/* eslint-disable @typescript-eslint/no-explicit-any -- AskUserQuestion input is whatever the model sent, read field by field. */
import fs from 'node:fs';
import path from 'node:path';
import { type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { AgentSession, summarizeTool, type SessionEvents } from './session';
import { connectorAllowedTools, connectorToolLabel } from './connectors';
import { CodexSession, type CodexApproval, type CodexDecision } from './codexSession';
import { codexClient } from '../codex/client';
import { providerOf } from '../../shared/models';
import { alwaysAskHook, alwaysAskRule, ALWAYS_ASK_PREFIX } from './permissions';
import { STEPS_TASK_LINE, stepsReminder, stepsReminderHook } from './stepsReminder';
import { REVIEWER, reviewerAgent, selfReviewLine } from './selfReview';
import { adviseOnQuestion } from './advisor';
import { accounts } from '../accounts';
import { store } from '../store';
import { ask } from '../decisions';
import { remember } from '../memory';
import { userRulesSection } from '../claudeContext';
import { paths } from '../paths';
import { loadSettings, claudeHelperModel } from '../settings';
import { cachedModels } from '../models';
import { modelLabel as labelFor } from '../../shared/models';
import { ensureWorktree, removeWorktree, ghEnv } from '../repos';
import { changedFiles, dropBranch, holdsWork, inspectBranch, worktreeClean } from '../gitwork';
import { worktreeDiff } from '../gitdiff';
import { listCheckpoints, restoreCheckpoint, saveCheckpoint } from '../checkpoints';
import { checkpointLabel } from '../../shared/checkpoints';
import { notifyTaskEnd } from '../notify';
import { isAttached, readPath } from '../attachments';
import { t, limitResetText } from '../i18n';
import { log } from '../log';
import { ensureDir, nowIso, oneLine, uid } from '../util';
import { artifactCommentLine } from '../../shared/artifactComment';
import { ALLOW, ALLOW_TASK, DENY, GRANT_USED, type Task, type TaskStatus, type Worker, type WorkerStatus } from '../../shared/types';
import { withPermission } from '../../shared/retro';
import { workerDecisions } from '../../shared/inbox';
import { afterDependency, cancelSet, describeCancel, holdsWorktree, isQueued, statusAfterCancel, type CancelReport } from '../../shared/queue';
import { planFallback, planSummary } from '../../shared/plan';
import { permissionPurpose, permissionReason, planReason, questionReason } from '../../shared/askWhy';
import { doneNotice } from '../../shared/notifyRules';
import { canStart, queueOrder, slotsUsed, waitStep, waitsForSlot } from '../../shared/slots';
import { isStalled } from '../../shared/stall';
import { grantScope, hasGrant, withGrant, withoutGrant, type GrantScope } from '../../shared/grants';
import { shellOf } from '../../shared/shellWords';
import { FakeSession } from './fakeSession';
import { fakeMode } from '../fake';
import type { Key } from '../../shared/i18n';
import { addSpend, hasSpend, spendVars } from '../../shared/spend';
import { COMPACT_AT, WORKER_TASK_COMPACT, kTokens } from '../../shared/context';
import { WORKER_COMPACT } from '../../shared/compactInstructions';
import { needsPlan, parseResult, taskStarted, workerPrompt } from './workerPrompt';
import { linkUrl } from '../../shared/linkify';
import { clip, GO_ON_MSG, LIMIT_RESET_MSG, MAX_REQUEST_WAKES, planApproved, planNudge, planSummaryRule, question, QUESTION_TAG, REPLY_NOTE, RESUME_MSG, SHELL_OUTPUT_CHARS, SLOT_FREE_MSG, stallMsg, TellKind, UNUSED_TOOLS, WORKER_ENV } from './workerText';
import { workerCodexTools, workerMemoryDir, workerTools, type StepsOp } from './workerTools';
import { markDone, mergeProgress, reopenSteps, setSteps, stepsLine, stepView } from '../../shared/steps';
import { isLocalRepo, localTaskLines } from '../../shared/localRepo';

/** A Worker's session: Claude Code, or Codex for a ChatGPT model. The owner uses what the two have in common. */
export type WorkerSession = AgentSession | CodexSession | FakeSession;
type FeedbackKind = 'review' | 'ci' | 'conflict';

/**
 * Set a task's status. Starting or ending a wait forgets the last one's timer and released slot, so two short waits
 * never add up to the time after which a waiting task gives its slot back. The new timer starts here, so the card's
 * slot clock shows from the start instead of after the next sweep (sweepWaiting starts one a task lacks).
 */
function setStatus(task: Task, status: TaskStatus, on: Task['waitingOn'] = null) {
  reopenSteps(task, status);
  if ((status === 'waiting') !== (task.status === 'waiting')) {
    task.waitingSince = status === 'waiting' ? new Date().toISOString() : null;
    task.slotReleased = false;
  }
  task.status = status;
  task.waitingOn = status === 'waiting' ? on : null;
}

/** An action an allow-for-this-task rule let through, kept with the task's permission decisions. */
function grantUsed(task: Task, code: string) {
  task.permissions = withPermission(task.permissions, { at: nowIso(), answeredAt: null, code, answer: GRANT_USED });
}

class WorkerManager {
  sessions = new Map<string, WorkerSession>();
  /** What each Worker said last in its current turn: a permission card's purpose line comes from it (askWhy.ts). */
  private said = new Map<string, string>();
  /** Review fixes, CI fixes and follow-ups on finished tasks get different result-card wording. */
  private reviewing = new Set<string>();
  /** Workers whose files were put back to a checkpoint since their last message. */
  private restored = new Set<string>();
  /** The latest read of each Worker's changed files (recordChanged): an older read finishing later is dropped. */
  private changedSeq = new Map<string, number>();
  private ciFixing = new Set<string>();
  private followups = new Set<string>();
  /** Plan-first tasks whose Worker was reminded to present its plan, until it presents one. */
  private planNudged = new Set<string>();
  /** Tool calls per task made without progress steps, for the one-time reminder (see stepsReminder). */
  private stepless = new Map<string, number>();
  /** Plan-first tasks whose Worker was already sent back once for leaving out the WHAT / HOW / OUTPUT lines. */
  private summaryAsked = new Set<string>();
  /** Workers with no open task that the Dispatcher wrote to: what their turn says goes back to it. */
  private replyOwed = new Set<string>();
  /** Workers sent a Dispatcher question that no turn of theirs has ended on yet. */
  private questioned = new Set<string>();
  /** Requests that started a Dispatcher turn, per task (or Worker, with no task open). */
  private requestWakes = new Map<string, number>();
  /** Workers the user stopped whose turn has not ended yet: that turn's error is the Stop, not a failure. */
  private stopping = new Map<string, 'user' | 'dispatcher'>();

  /**
   * A follow-up for a task that finished (or failed) less than 3 days ago reopens that task,
   * so the Worker shows as running on it and its next report settles it.
   */
  private reopenLast(w: Worker): Task | null {
    const last = this.reopenable(w);
    if (!last) return null;
    // A task that failed before finishing just continues; its report is not a follow-up.
    if (last.finishedAt) this.followups.add(last.id);
    setStatus(last, 'running');
    last.stopped = false;
    last.updatedAt = nowIso();
    return last;
  }

  /** The Worker's last task, when a follow-up would reopen it (reopenLast). */
  private reopenable(w: Worker): Task | null {
    if (this.currentTask(w)) return null;
    const last = w.taskIds.length ? store.task(w.taskIds[w.taskIds.length - 1]) : null;
    if (!last || (last.status !== 'done' && last.status !== 'pr_open' && last.status !== 'failed')) return null;
    // A failed task never got finishedAt; it failed when it was last updated.
    const at = last.finishedAt ?? (last.status === 'failed' ? last.updatedAt : null);
    if (!at || Date.now() - Date.parse(at) > 3 * 86400_000) return null;
    if (last.prState === 'MERGED' || last.prState === 'CLOSED') return null;
    return last;
  }

  list() { return store.data.workers; }

  private touch(w: Worker) {
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

  currentTask(w: Worker): Task | null {
    for (let i = w.taskIds.length - 1; i >= 0; i--) {
      const x = store.task(w.taskIds[i]);
      if (x && (x.status === 'running' || x.status === 'waiting' || x.status === 'queued')) return x;
    }
    return null;
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
      const fake = new FakeSession({ label: w.id, model: w.model, cwd: w.cwd, accountId: null, resume: w.sessionId, steps: (op) => this.steps(w, op), canUseTool: this.permissionHandler(w), permissionMode: needsPlan(this.currentTask(w)) ? 'plan' : 'auto' }, this.sessionEvents(w));
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
      approve: this.codexApproval(w),
    }, events, codexClient()) : new AgentSession({
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
      canUseTool: this.permissionHandler(w),
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
        const task = this.currentTask(w) ?? (w.taskIds.length ? store.task(w.taskIds[w.taskIds.length - 1]) : null);
        if (task && hasSpend(turn)) task.spend = addSpend(task.spend, turn);
        store.changed();
      },
      onStatus: (st, text) => {
        // The turn the user stopped ends in an error: the Worker is idle, not in error.
        const stopped = st !== 'busy' && this.stopping.has(w.id);
        // A turn starts or ends: what the Worker said before belongs to another turn.
        this.said.delete(w.id);
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
            if (st !== 'idle' && task && task.status !== 'queued') this.fail(w, task, text);
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
          if (task && task.status !== 'queued') this.fail(w, task, text);
        }
        this.touch(w);
        if (st === 'idle') this.fillSlots();
      },
      onTurnEnd: (r) => {
        void this.recordChanged(w);
        // With more input queued, the turn that follows settles the task.
        if (r.internal || r.queued) return;
        this.turnEnded(w, r.text, r.isError, !!r.background);
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
        this.pause(w, this.currentTask(w));
      },
      // Messages sent while a stopped turn was ending: its task is stopped now, so they go out as new messages do
      // (a follow-up reopens it, or waits for a slot).
      onResend: (texts) => texts.forEach((m) => this.post(w, m)),
      // Shown in the Worker's conversation. A failed compaction leaves the task alone (it is retried later).
      onCompact: (e) => {
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

  /** The user took back an "Allow for this task": that kind of action is asked about again. */
  revokeGrant(taskId: string, key: string) {
    const task = store.task(taskId);
    if (!task?.grants?.length) return;
    task.grants = withoutGrant(task.grants, key);
    if (task.workerId) store.log(task.workerId, 'event', t('log.grantRevoked'));
    store.changed();
  }

  /**
   * What "Allow for this task" would cover for this call, or null when it is not offered: an always-ask
   * rule is asked every time, and so is a call whose kind cannot be named.
   */
  private taskScope(task: Task | null, tool: string, input: unknown): GrantScope | null {
    if (!task || alwaysAskRule(tool, input, loadSettings().askOff)) return null;
    return grantScope(tool, input);
  }

  /** The permission's buttons: Allow and Deny, and "Allow for this task" with what it covers when offered. */
  private permOptions(scope: GrantScope | null) {
    return [{ label: ALLOW }, { label: DENY }, ...(scope ? [{ label: ALLOW_TASK, description: scope.label }] : [])];
  }

  private answerLabel(ans: string) {
    return ans === ALLOW ? t('allow') : ans === ALLOW_TASK ? t('allowTask') : ans === DENY ? t('deny') : ans;
  }

  /** A command or a file change a Codex Worker needs a yes for: the same decision card a Claude Worker's permission gets. */
  private codexApproval(w: Worker) {
    return async (req: CodexApproval, signal?: AbortSignal): Promise<CodexDecision> => {
      const task = this.currentTask(w);
      const prev = this.awaitDecision(w, task);
      // Codex names the shell it starts; a PowerShell line is read as PowerShell reads it.
      const tool = req.kind === 'command' ? (req.shell === 'powershell' ? 'PowerShell' : 'Bash') : 'Edit';
      const input = req.kind === 'command' ? { command: req.command } : { file_path: req.files.join(', ') };
      const code = (req.kind === 'command' ? `$ ${req.command}` : req.files.join('\n')).slice(0, 1200);
      // One file names a folder; several files are asked about each time.
      const scope = this.taskScope(task, tool, req.kind === 'command' ? input : req.files.length === 1 ? { file_path: req.files[0] } : {});
      if (task && scope && hasGrant(task, scope.key)) {
        grantUsed(task, code);
        this.decided(w, task, prev);
        store.log(w.id, 'event', t('log.grantUsed', { what: scope.label }));
        return 'accept';
      }
      try {
        const ans = await ask({
          source: 'permission', workerId: w.id, taskId: task?.id ?? null,
          title: req.kind === 'command' ? t('perm.bash') : t('perm.files'),
          detail: '',
          code,
          options: this.permOptions(scope),
          questionKey: null,
          reason: permissionReason(t, { who: w.id, task, tool, input, rule: alwaysAskRule(tool, input, loadSettings().askOff), decisionReason: req.reason }),
          purpose: permissionPurpose(t, { steps: task?.steps, said: this.said.get(w.id), input }),
        }, signal);
        store.log(w.id, 'user', `${oneLine(code, 140)} → ${this.answerLabel(ans)}`);
        if (ans === ALLOW_TASK && task && scope) task.grants = withGrant(task.grants, scope);
        return ans === ALLOW || ans === ALLOW_TASK ? 'accept' : 'decline';
      } catch {
        return 'decline';
      } finally {
        this.decided(w, task, prev);
      }
    };
  }

  /** The Worker asks the user something: it and its task wait. Returns the status to go back to. */
  private awaitDecision(w: Worker, task: Task | null): WorkerStatus {
    const prev = w.status;
    w.status = 'waiting';
    if (task) setStatus(task, 'waiting');
    store.changed();
    return prev;
  }

  /** A decision was answered or withdrawn: back to work, unless another one of this Worker's is still open. */
  private decided(w: Worker, task: Task | null, prev: WorkerStatus) {
    if (!workerDecisions(store.data.decisions, w.id).length) {
      if (w.status === 'waiting') w.status = prev === 'waiting' ? 'running' : prev;
      if (task && task.status === 'waiting') setStatus(task, 'running');
    }
    store.changed();
  }

  private permissionHandler(w: Worker): CanUseTool {
    return async (toolName, input, opts) => {
      if (toolName === 'AskUserQuestion') return this.answerQuestions(w, input, opts.signal);
      if (toolName === 'ExitPlanMode') return this.reviewPlan(w, input, opts.signal);
      // The app's own tools (recall, tell_dispatcher) change nothing in the worktree; in plan mode too.
      if (toolName.startsWith('mcp__oma__')) return { behavior: 'allow', updatedInput: input };
      // Files the user attached may be read without asking.
      const rp = readPath(toolName, input);
      if (rp && isAttached(rp)) return { behavior: 'allow', updatedInput: input };
      const task = this.currentTask(w);
      // Allowed for this task already: the same kind of action goes ahead, with a line in the conversation.
      const scope = this.taskScope(task, toolName, input);
      if (task && scope && hasGrant(task, scope.key)) {
        grantUsed(task, summarizeTool(toolName, input, 1200));
        store.log(w.id, 'event', t('log.grantUsed', { what: scope.label }));
        store.changed();
        return { behavior: 'allow', updatedInput: input };
      }
      const prev = this.awaitDecision(w, task);
      try {
        // The always-ask hook's reason is ours (the rule says it better); any other is Claude Code's own.
        const cc = opts.decisionReason?.startsWith(ALWAYS_ASK_PREFIX) ? null : opts.decisionReason;
        const ans = await ask({
          source: 'permission', workerId: w.id, taskId: task?.id ?? null,
          title: shellOf(toolName) ? t('perm.bash') : t('perm.tool', { tool: connectorToolLabel(toolName) ?? toolName.replace(/^mcp__\w+__/, '') }),
          detail: '',
          code: summarizeTool(toolName, input, 1200),
          options: this.permOptions(scope),
          questionKey: null,
          reason: permissionReason(t, { who: w.id, task, tool: toolName, input, rule: alwaysAskRule(toolName, input, loadSettings().askOff), blockedPath: opts.blockedPath, decisionReason: cc, impact: opts.description }),
          purpose: permissionPurpose(t, { steps: task?.steps, said: this.said.get(w.id), input }),
        }, opts.signal);
        store.log(w.id, 'user', `${summarizeTool(toolName, input)} → ${this.answerLabel(ans)}`);
        if (ans === ALLOW_TASK && task && scope) task.grants = withGrant(task.grants, scope);
        if (ans === ALLOW || ans === ALLOW_TASK) return { behavior: 'allow', updatedInput: input };
        return { behavior: 'deny', message: ans === DENY ? 'The user denied this action. Find another way, or skip it if it is not needed.' : `The user denied this and said: ${ans}` };
      } catch {
        return { behavior: 'deny', message: 'The request was cancelled.' };
      } finally {
        this.decided(w, task, prev);
      }
    };
  }

  /** The Worker finished planning: the user approves the plan or says what to change. */
  private async reviewPlan(w: Worker, input: Record<string, unknown>, signal: AbortSignal) {
    const task = this.currentTask(w);
    if (task) this.planNudged.delete(task.id);
    const plan = String(input.plan ?? '').trim();
    let summary = planSummary(plan);
    if (!summary) {
      // Sent back once to add the lines, before the user sees it; a second plan without them is taken as it is.
      const key = task?.id ?? w.id;
      if (!this.summaryAsked.has(key)) {
        this.summaryAsked.add(key);
        store.log(w.id, 'event', t('log.planNoSummary'));
        return { behavior: 'deny' as const, message: `The plan is missing its summary lines. ${planSummaryRule()} Add them at the top, keep the rest of the plan, and present it again with ExitPlanMode.` };
      }
      summary = planFallback(plan);
    }
    store.log(w.id, 'worker', plan ? `${t('log.plan')}\n\n${plan}` : t('log.plan'));
    const prev = this.awaitDecision(w, task);
    try {
      const ans = await ask({
        source: 'plan', workerId: w.id, taskId: task?.id ?? null,
        title: t('plan.title'), detail: task?.title ?? w.title, code: plan || null, summary,
        options: [{ label: ALLOW }], questionKey: null, reason: planReason(t, { who: w.id, task }),
      }, signal);
      if (ans === ALLOW) {
        const s = this.sessions.get(w.id);
        if (s instanceof AgentSession) s.cfg.permissionMode = 'auto';
        store.log(w.id, 'user', t('log.planApproved'));
        if (task) {
          task.planApproved = true;
          this.summaryAsked.delete(task.id);
          store.pushUpdate(`${w.id} ${task.id} "${task.title}": the user approved the plan; ${w.id} is carrying it out.`);
          // Sent mid-turn, it reaches the Worker in this turn right after the tool result.
          if (s && !s.closed) s.send(planApproved(task));
        }
        return { behavior: 'allow' as const, updatedInput: input, updatedPermissions: [{ type: 'setMode' as const, mode: 'auto' as const, destination: 'session' as const }] };
      }
      store.log(w.id, 'user', `${t('log.planRevise')}: ${ans === DENY ? t('deny') : ans}`);
      return {
        behavior: 'deny' as const,
        message: ans === DENY
          ? 'The user rejected this plan. Stay in plan mode and propose a different approach with ExitPlanMode, or ask what they want with AskUserQuestion.'
          : `The user wants the plan changed: ${ans}\nStay in plan mode, revise the plan, and present it again with ExitPlanMode.`,
      };
    } catch {
      return { behavior: 'deny' as const, message: 'The plan review was cancelled. Stay in plan mode and present the plan again with ExitPlanMode.' };
    } finally {
      this.decided(w, task, prev);
    }
  }

  /**
   * Save a repository Worker's files before it is handed something, named after it. Not waited for: git finishes
   * long before the agent's first edit, and a message must not wait on it. Equal states are saved once.
   */
  private checkpoint(w: Worker, about: string) {
    if (!w.repo) return;
    void saveCheckpoint(w.cwd, w.id, checkpointLabel(about)).catch((e) => log.warn('checkpoint failed', (e as Error).message));
  }

  checkpoints(workerId: string) {
    const w = store.worker(workerId);
    return w?.repo ? listCheckpoints(w.cwd, w.id) : Promise.resolve([]);
  }

  /** Put a Worker's files back to a checkpoint. Not while it works: the agent would be editing the same files. */
  async restore(workerId: string, ref: string) {
    const w = store.worker(workerId);
    if (!w?.repo) throw new Error(t('ckpt.err.none'));
    if (w.status === 'running' || w.status === 'starting') throw new Error(t('ckpt.err.busy'));
    await restoreCheckpoint(w.cwd, w.id, ref);
    store.log(w.id, 'event', t('log.restored'));
    // The agent still remembers the files as it left them: its next message says they changed under it.
    this.restored.add(w.id);
    store.changed();
  }

  async diff(workerId: string) {
    const w = store.worker(workerId);
    const repo = w?.repo ? store.repo(w.repo) : null;
    if (!w || !repo) return null;
    return worktreeDiff(repo.defaultBranch, w.cwd, isLocalRepo(repo));
  }

  /**
   * Record on the task whose branch the Worker's worktree has checked out which files that branch changes, so a new
   * task naming one of them is flagged (shared/overlap.ts). Read from git each time a turn ends; a later read wins.
   * Detached with the task in progress's branch never made (a fake Worker), the files are that task's, taken before
   * the turn settles it. Detached otherwise (mid-rebase, back at the base) nothing is recorded.
   */
  private async recordChanged(w: Worker) {
    const repo = w.repo ? store.repo(w.repo) : null;
    if (!repo) return;
    const seq = (this.changedSeq.get(w.id) ?? 0) + 1;
    this.changedSeq.set(w.id, seq);
    const cur = this.currentTask(w);
    const r = await changedFiles(w.cwd, repo.defaultBranch, isLocalRepo(repo), cur?.kind === 'code' ? cur.branch : null).catch(() => null);
    if (!r || this.changedSeq.get(w.id) !== seq) return;
    const task = r.branch ? w.taskIds.map((id) => store.task(id)).find((x) => x?.kind === 'code' && x.branch === r.branch)
      : cur?.kind === 'code' && !r.hintExists ? cur : null;
    if (!task || task.status === 'cancelled' || !store.task(task.id) || task.changedFiles?.join('\0') === r.files.join('\0')) return;
    task.changedFiles = r.files;
    store.changed();
  }

  private async answerQuestions(w: Worker, input: Record<string, unknown>, signal: AbortSignal) {
    const questions = (input.questions as any[]) ?? [];
    const answers: Record<string, string> = {};
    const task = this.currentTask(w);
    for (const q of questions) {
      const opts: string[] = (q.options ?? []).map((o: any) => String(o.label));
      store.log(w.id, 'worker', `${t('log.question')}: ${q.question}${opts.length ? `\n${t('log.options')}: ${opts.join(' / ')}` : ''}`);
      const verdict = await adviseOnQuestion({ workerId: w.id, taskTitle: task?.title ?? w.title, question: q.question, options: opts });
      if (verdict?.canAnswer) {
        answers[q.question] = verdict.answer;
        const aa = { id: uid(), workerId: w.id, question: q.question, answer: verdict.answer, basis: verdict.basis, createdAt: nowIso(), corrected: null, cleared: false };
        store.data.autoAnswers.push(aa);
        store.chat('auto', t('ev.autoAnswered', { id: w.id, q: q.question, a: verdict.answer, basis: verdict.basis }), aa.id);
        store.log(w.id, 'auto', t('log.autoAnswered', { a: verdict.answer, basis: verdict.basis }));
        continue;
      }
      const prev = this.awaitDecision(w, task);
      try {
        const ans = await ask({
          source: 'question', workerId: w.id, taskId: task?.id ?? null,
          title: q.question, detail: task ? task.title : w.title, code: null,
          options: (q.options ?? []).map((o: any) => ({ label: String(o.label), description: o.description ? String(o.description) : undefined })),
          questionKey: q.question,
          reason: questionReason(t, { who: w.id, task, advisor: verdict?.basis }),
        }, signal);
        answers[q.question] = ans;
        store.log(w.id, 'user', `${t('log.answer')}: ${ans}`);
      } catch {
        answers[q.question] = '(The user did not answer. Decide sensibly, proceed, and mention it in your report.)';
      } finally {
        this.decided(w, task, prev);
      }
    }
    return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
  }

  /**
   * A turn ended. What it said goes to the Dispatcher when the Dispatcher waits for it, and its open task (if any)
   * is finished only when the turn says so: not while subagents still run, and not while the Worker waits for the
   * Dispatcher.
   */
  private turnEnded(w: Worker, text: string, isError: boolean, background: boolean) {
    const task = this.currentTask(w);
    const owed = this.replyOwed.delete(w.id);
    const questioned = this.questioned.delete(w.id);
    const said = !isError && !!text.trim();
    // The turn that read a question closes it. An answer in plain text, without tell_dispatcher, still reaches the Dispatcher.
    if (said && w.ask) this.fromWorker(w, 'answer', text, true);
    else if (w.ask) this.unanswered(w, isError ? text : '', true);
    // A reply to instructions with no task to report on. It needs no turn of the Dispatcher's own.
    else if (said && owed && !task) store.pushUpdate(`${w.id} replied to your message: ${clip(text, 1000)}`);
    if (!task) return;
    // A plan-first task is not done before its plan is approved.
    if (needsPlan(task) && !isError) return this.awaitPlan(w, task, text, background);
    if (!isError) {
      const { reported, blocked } = parseResult(text, w.cwd);
      if (!reported) {
        // Subagents the turn started are still running; the session goes on by itself when they report.
        if (background) { task.updatedAt = nowIso(); return store.changed(); }
        if (blocked || w.request) return this.awaitDispatcher(w, task, blocked);
        // It stopped after a question (answered with the tool or in plain text), so the turn may have said nothing
        // about the task: it is told to go on, once.
        const s = this.sessions.get(w.id);
        if (questioned && s && !s.closed) {
          s.send(GO_ON_MSG);
          return this.touch(w);
        }
      }
    }
    this.finalize(w, task, text, isError);
  }

  /**
   * The turn ended with the task unfinished because the Worker needs the Dispatcher. The task stays open and keeps
   * its slot, like any task that waits for an answer, and goes on with the next message to the Worker.
   */
  private awaitDispatcher(w: Worker, task: Task, need: string | null) {
    setStatus(task, 'waiting', 'dispatcher');
    task.updatedAt = nowIso();
    // A BLOCKED report without a request is the request. One made earlier told the Dispatcher what is needed; now
    // it hears that the task stopped for it, in case it did something about the request without writing back.
    if (!w.request) this.raise(w, task, need ?? '', true);
    else store.pushUpdate(`${w.id} (${task.id} "${task.title}") stopped and waits for your reply to what it asked: ${oneLine(w.request.text, 300)}\n  ${REPLY_NOTE}`, this.wakesLeft(task.id));
    w.statusText = t('st.awaitDispatcher');
    store.changed();
  }

  /** Counts one more thing a Worker needs from the Dispatcher; past the cap for one task (or one Worker without a task) it starts no turn. */
  private wakesLeft(key: string) {
    const n = (this.requestWakes.get(key) ?? 0) + 1;
    this.requestWakes.set(key, n);
    return n <= MAX_REQUEST_WAKES;
  }

  /** A question got no answer: the turn that read it failed or was stopped, or the app restarted first. */
  private unanswered(w: Worker, why: string, wake: boolean) {
    const asked = w.ask?.text ?? '';
    w.ask = null;
    store.pushUpdate(`${w.id} did not answer your question "${oneLine(asked, 200)}"${why ? ` (${oneLine(why, 200)})` : ''}. Ask again if you still need the answer.`, wake);
  }

  /** Tell the Dispatcher what a Worker needs from it. Past the cap for one task, it waits for the Dispatcher's next turn. */
  private raise(w: Worker, task: Task | null, text: string, blocked = false) {
    const wake = this.wakesLeft(task?.id ?? w.id);
    w.request = { text, at: nowIso() };
    const about = task ? ` (${task.id} "${task.title}")` : '';
    store.chat('event', t(blocked ? 'ev.blocked' : 'ev.requested', { id: w.id, text: oneLine(text, 200) }), task?.id);
    store.pushUpdate(blocked
      ? `${w.id}${about} is blocked and waits for you: ${clip(text, 4000)}\n  ${REPLY_NOTE}`
      : `${w.id}${about} asks you: ${clip(text, 4000)}\n  Reply with send_to_worker: the answer, or what you did about it.`, wake);
  }

  /**
   * What a Worker tells the Dispatcher with tell_dispatcher. An answer to an open question and a request start
   * a Dispatcher turn; a note, or an answer nobody asked for, waits for its next one.
   * spoken: it was the text of the Worker's turn, which its conversation shows already. Returns the tool's reply.
   */
  fromWorker(w: Worker, kind: TellKind, text: string, spoken = false): string {
    const body = text.trim();
    if (!body) return 'Nothing was sent: the text is empty.';
    if (!spoken) store.log(w.id, 'worker', `${t('log.toDispatcher')}: ${body}`);
    const task = this.currentTask(w);
    if (kind === 'answer' && w.ask) {
      const asked = w.ask.text;
      w.ask = null;
      store.chat('event', t('ev.answered', { id: w.id, text: oneLine(body, 200) }));
      store.pushUpdate(`${w.id} answered your question "${oneLine(asked, 200)}": ${clip(body, 4000)}`, true);
      return 'Delivered to the Dispatcher. Go on with what you were doing.';
    }
    if (kind === 'request') {
      this.raise(w, task, body);
      return 'Delivered. The answer comes as a "[Dispatcher]" message. Go on with what does not depend on it; if nothing is left, end your turn with "BLOCKED: what you need".';
    }
    store.pushUpdate(`${w.id}${task ? ` (${task.id})` : ''} notes: ${clip(body, 1000)}`);
    return 'Noted. The Dispatcher reads it on its next turn.';
  }

  /**
   * set_steps and step_done: the planned steps of the Worker's open task. A finished step reaches the Dispatcher as
   * an update for its next turn, not a turn of its own; a newer one for the same task takes the older one's place.
   */
  steps(w: Worker, op: StepsOp): string {
    const task = this.currentTask(w);
    if (!task) return 'No task in progress: steps belong to a task.';
    const before = stepView(task);
    const err = op.kind === 'set' ? setSteps(task, op.steps) : markDone(task, op.step, nowIso());
    if (err) return err;
    this.stepless.delete(task.id);
    const steps = task.steps!;
    const v = stepView(task)!;
    if (op.kind === 'set') {
      store.log(w.id, 'event', t('log.steps', { list: steps.map((s, i) => `${i + 1}. ${s.title}`).join(', ') }));
    } else if (v.done !== before?.done) {
      const n = Number(op.step);
      store.log(w.id, 'event', t('log.stepDone', { n, done: v.done, total: v.total, title: steps[n - 1].title }));
      const prefix = `${w.id} (${task.id}) progress:`;
      mergeProgress(store.data.pendingUpdates, prefix, `${prefix} step ${n} done "${steps[n - 1].title}" (${v.done}/${v.total} done); ${v.allDone ? 'all steps done' : `next "${v.current}"`}.`);
    }
    store.changed();
    return `${op.kind === 'set' ? `${steps.length} steps set. ` : ''}${stepsLine(steps)}`;
  }

  private fail(w: Worker, task: Task, text: string) {
    const by = this.stopping.get(w.id);
    const stopped = !!by;
    setStatus(task, 'failed');
    task.stopped = stopped;
    task.updatedAt = nowIso();
    task.summary = stopped ? t(by === 'user' ? 'task.stoppedUser' : 'task.stoppedDispatcher') : oneLine(text || t('err.stopped'), 200);
    w.request = null;
    this.requestWakes.delete(task.id);
    if (stopped) {
      // A result, not an error: the user meant it. The Dispatcher hears it without a turn of its own.
      store.chat('result', t(by === 'user' ? 'ev.stopped' : 'ev.stoppedDispatcher', { id: w.id }), task.id);
      store.log(w.id, 'event', t(by === 'user' ? 'log.stopped' : 'log.stoppedDispatcher'));
      if (by === 'user') store.pushUpdate(`The user stopped ${w.id} on ${task.id} "${task.title}". The task is left unfinished; a message to ${w.id} continues it.`);
    } else {
      store.chat('error', t('ev.failed', { id: w.id, title: task.title, msg: task.summary }), task.id);
      store.pushUpdate(`${w.id} ${task.id} "${task.title}" failed: ${task.summary}`, true, task.id);
      const n = doneNotice(t, { who: w.id, title: task.title, summary: task.summary, ok: false, prUrl: task.prUrl });
      // Its own burst: a failure right after another end of this Worker is not swallowed.
      notifyTaskEnd(n.title, n.body, `${w.id}:failed`, task.id);
    }
    this.followUp(task);
    this.fillSlots();
  }

  /**
   * A plan-first turn ended with no approved plan, so the task stays open. When background subagents are still running,
   * the session goes on by itself once they report. Otherwise the Worker is reminded once to present its plan;
   * after that the task waits for the user or the Dispatcher, who are told.
   */
  private awaitPlan(w: Worker, task: Task, text: string, background: boolean) {
    task.updatedAt = nowIso();
    if (background) return store.changed();
    const s = this.sessions.get(w.id);
    if (s && !s.closed && !this.planNudged.has(task.id)) {
      this.planNudged.add(task.id);
      store.log(w.id, 'event', t('log.planNudge'));
      s.send(planNudge(task));
      return this.touch(w);
    }
    store.chat('event', t('ev.planMissing', { id: w.id, title: task.title }), task.id);
    store.pushUpdate(`${w.id} ${task.id} "${task.title}" is still planning: its turn ended without a plan to approve ("${oneLine(text, 160)}"). The task stays open; send_to_worker if it needs instructions.`, true);
    store.changed();
  }

  private finalize(w: Worker, task: Task, text: string, isError: boolean) {
    if (isError) return this.fail(w, task, text);
    const parsed = parseResult(text, w.cwd);
    const repo = task.repo ? store.repo(task.repo) : null;
    // A local-only repository has no PR: the result is the branch the work is on, which the user merges.
    const local = task.kind === 'code' && isLocalRepo(repo) && !!task.branch;
    const prUrl = local ? null : parsed.prUrl;
    const summary = local ? `${parsed.summary} ${t('res.localBranch', { branch: task.branch!, base: repo!.defaultBranch })}` : parsed.summary;
    const { files } = parsed;
    task.updatedAt = nowIso();
    const wasReview = this.reviewing.delete(task.id);
    const wasCi = this.ciFixing.delete(task.id);
    const wasFollowup = this.followups.delete(task.id);
    const firstFinish = !task.finishedAt;
    // Finished anyway: what it asked the Dispatcher for holds nothing up any more.
    w.request = null;
    this.requestWakes.delete(task.id);
    task.summary = summary;
    task.prUrl = prUrl ?? task.prUrl;
    task.files = files.length ? files : task.files;
    // Links add up over the task's turns, once each and without its own PR ("[title](url)" is matched by its URL).
    const own = prUrl ?? task.prUrl;
    if (parsed.links.length) {
      const byUrl = new Map<string, string>();
      for (const l of [...(task.links ?? []), ...parsed.links]) if (linkUrl(l) !== own) byUrl.set(linkUrl(l), l);
      task.links = [...byUrl.values()];
    }
    setStatus(task, task.prUrl ? 'pr_open' : 'done');
    task.stopped = false;
    task.prState = task.prUrl ? (task.prState ?? 'OPEN') : null;
    task.finishedAt = nowIso();
    if (task.prUrl && !task.reviewSyncedAt) task.reviewSyncedAt = nowIso();
    const label = wasReview ? t('res.reviewLabel') : wasCi ? t('res.ciFixLabel') : wasFollowup ? t('res.followupLabel') : t('res.doneLabel');
    store.chat('result', wasReview ? t('res.review', { s: summary }) : wasCi ? t('res.ciFix', { s: summary }) : wasFollowup ? t('res.followup', { s: summary }) : summary, task.id);
    store.pushUpdate(`${w.id} ${task.id} "${task.title}" ${wasReview ? 'review fixed' : wasCi ? 'CI fixed' : wasFollowup ? 'follow-up done' : 'done'}: ${summary}${task.prUrl ? ` (PR ${task.prUrl})` : ''}${task.files.length ? `, ${task.files.length} file(s)` : ''}${task.links?.length ? `. Links: ${task.links.join(' ')}` : ''}`, true, task.id);
    if (firstFinish) remember('task', `${task.id} ${task.title} (${w.id}${w.repo ? `, ${w.repo}` : ''}) ${summary}${task.prUrl ? ` ${task.prUrl}` : ''}${task.links?.length ? ` ${task.links.join(' ')}` : ''}${hasSpend(task.spend) ? ` · ${t('spend.memo', spendVars(task.spend))}` : ''}`);
    const n = doneNotice(t, { who: w.id, title: task.title, summary, ok: true, label, code: task.kind === 'code', prUrl: task.prUrl });
    notifyTaskEnd(n.title, n.body, w.id, task.id);
    this.followUp(task);
    store.changed();
    this.fillSlots();
  }

  /** Assign a task. With workerId, that Worker continues with its context. */
  async assign(task: Task, workerId: string | null, model: string): Promise<Worker> {
    let w = workerId ? store.worker(workerId) : null;
    if (workerId && !w) throw new Error(t('err.noWorker', { id: workerId }));
    if (w && w.repo !== task.repo && task.kind === 'code') throw new Error(t('err.wrongRepo', { id: w.id, has: w.repo ?? t('general'), want: task.repo ?? '' }));
    if (!w) w = await this.create({ title: task.title, repo: task.kind === 'code' ? task.repo : null, model });
    if (w.status === 'archived') await this.unarchive(w);
    task.workerId = w.id;
    if (task.kind === 'code') task.branch = `agent/${task.id.toLowerCase()}`;
    w.taskIds.push(task.id);
    task.updatedAt = nowIso();
    store.log(w.id, 'dispatcher', `[Task ${task.id}] ${task.title}\n\n${task.prompt}`);
    if (task.afterTaskId) {
      // Wait until that PR is merged; the PR monitor starts it.
      task.status = 'blocked';
      store.log(w.id, 'event', t('log.blocked', { id: task.afterTaskId }));
      store.changed();
      // It may have ended while this Worker was being set up.
      const dep = store.task(task.afterTaskId);
      if (afterDependency(dep) !== 'wait') this.settleAllBlocked();
      return w;
    }
    if (!this.hasSlot(w)) {
      this.waitForSlot(w, task);
      return w;
    }
    w.title = task.title;
    task.status = 'running';
    store.changed();
    this.dispatch(w, task);
    return w;
  }

  /** The PR that blocked tasks were waiting for was merged (or closed). */
  onPrSettled(doneTask: Task, merged: boolean) {
    this.settleBlocked(doneTask, merged ? 'start' : 'cancel');
  }

  /**
   * A task ended (or the app started): tasks waiting on it with after_task_id start or are cancelled, as
   * afterDependency says. Without this, a dependency that finished without a PR, or failed, would hold them forever.
   */
  private followUp(dep: Task) {
    const how = afterDependency(dep);
    if (how !== 'wait') this.settleBlocked(dep, how);
  }

  /** Every blocked task whose dependency already ended, as saved state may hold (one that ended before this check existed). */
  private settleAllBlocked() {
    const deps = new Set(store.data.tasks.filter((x) => x.status === 'blocked' && x.afterTaskId).map((x) => x.afterTaskId!));
    for (const id of deps) {
      const dep = store.task(id);
      if (dep) this.followUp(dep);
      else this.settleBlocked({ id, title: id } as Task, 'cancel');
    }
  }

  private settleBlocked(dep: Task, how: 'start' | 'cancel') {
    const waiting = store.data.tasks.filter((x) => x.status === 'blocked' && x.afterTaskId === dep.id && x.workerId && store.worker(x.workerId));
    if (!waiting.length) return;
    if (how === 'cancel') return this.cancelBlocked(dep, waiting);
    const merged = dep.prState === 'MERGED';
    for (const task of waiting) {
      const w = store.worker(task.workerId!)!;
      const slot = this.hasSlot(w);
      if (!merged) store.pushUpdate(`${task.id} "${task.title}" (${w.id}) waited for ${dep.id}, which finished without a PR; it ${slot ? 'started' : 'now waits for a free Worker slot'}.`);
      if (!slot) {
        store.log(w.id, 'event', t(merged ? 'log.blockedMerged' : 'log.blockedDone', { id: dep.id }));
        this.waitForSlot(w, task);
        continue;
      }
      task.status = 'running';
      task.updatedAt = nowIso();
      w.title = task.title;
      store.chat('event', t(merged ? 'ev.blockedStarted' : 'ev.blockedStartedDone', { id: w.id, title: task.title, dep: dep.title }));
      store.log(w.id, 'event', t(merged ? 'log.blockedStarted' : 'log.blockedStartedDone', { id: dep.id }));
      this.dispatch(w, task);
    }
    store.changed();
  }

  /**
   * What the blocked tasks build on never comes: they are cancelled, with the tasks waiting on them, like a
   * cancel from the queue. The Dispatcher hears why, so it can plan them again.
   */
  private cancelBlocked(dep: Task, waiting: Task[]) {
    const why = dep.prState === 'CLOSED' ? 'closed' : !store.task(dep.id) ? 'gone' : 'failed';
    const reports = this.cancelNow(waiting.map((x) => x.id), dep.id, why);
    if (!reports.length) return;
    for (const r of reports) {
      if (r.followerOf !== dep.id) continue;
      if (why === 'closed') store.chat('error', t('ev.blockedCancelled', { title: r.title, dep: dep.title }), r.id);
      else store.chat('event', t(why === 'gone' ? 'ev.cancelled' : 'ev.blockedFailed', { title: r.title, dep: dep.title }), r.id);
    }
    const reason = why === 'closed' ? 'had its PR closed without merging' : why === 'gone' ? 'no longer exists' : `ended as ${dep.status} with no PR to merge`;
    store.pushUpdate(`${dep.id}${why === 'gone' ? '' : ` "${dep.title}"`} ${reason}, so the tasks waiting for it were cancelled: ${reports.map(describeCancel).join('; ')}. If they are still wanted, create them again (with after_task_id once ${dep.id} or a replacement is in progress).`);
    store.changed();
    void this.tidyCancelled(reports);
  }

  private taskMessage(w: Worker, task: Task) {
    const repo = task.repo ? store.repo(task.repo) : null;
    const head = [`[Task ${task.id}] ${task.title}`];
    if (task.kind === 'code' && repo) {
      head.push(`Repository: ${repo.name} (default branch ${repo.defaultBranch})`);
      if (isLocalRepo(repo)) head.push(...localTaskLines(repo, task.branch!));
      else head.push(`Branch: ${task.branch}. Start with \`git fetch origin\` then \`git switch -c ${task.branch} origin/${repo.defaultBranch}\`. If you are already on that branch, continue there.`);
      const review = selfReviewLine(loadSettings().selfReview, repo.defaultBranch, isLocalRepo(repo));
      if (review) head.push(review);
    } else {
      head.push(`Output folder: ${path.join(w.cwd, task.id)}`);
    }
    if (needsPlan(task)) head.push(`Plan first: you are in plan mode (read-only). Investigate, then present your plan with ExitPlanMode. ${planSummaryRule()} The user approves it before you change anything; if they ask for changes, revise and present it again. Once it is approved, carry out the plan in this session and report the finished work.`);
    if (task.afterTaskId) {
      const dep = store.task(task.afterTaskId);
      if (dep?.prUrl && dep.prState === 'MERGED') head.push(`This task builds on ${dep.prUrl}, which has been merged into the default branch.`);
      else if (dep?.status === 'done') head.push(`This task waited for ${dep.id} "${dep.title}", which finished without a PR: ${dep.summary ?? ''}${dep.files.length ? ` Files: ${dep.files.join(', ')}` : ''}`);
      // A local-only repository's finished work is on its branch until the user merges it: build on that branch.
      if (dep?.status === 'done' && dep.branch && isLocalRepo(repo) && task.branch) head.push(`Its work is on branch ${dep.branch}, which may not be merged into ${repo!.defaultBranch} yet: unless it is, start your branch from it (\`git switch -c ${task.branch} ${dep.branch}\`) instead of ${repo!.defaultBranch}.`);
    }
    head.push(STEPS_TASK_LINE);
    return `${head.join('\n')}\n\n${task.prompt}`;
  }

  private dispatch(w: Worker, task: Task) {
    const s = this.ensureSession(w);
    if (!s) return this.pause(w, task);
    this.startTask(w, s, task);
  }

  /**
   * Send the task message, with the task's effort and plan mode in place first; `after` follows it.
   * A Worker with a large context from earlier tasks is compacted first; the message waits for that.
   */
  private startTask(w: Worker, s: WorkerSession, task: Task, after: string[] = []) {
    task.startedAt = nowIso();
    this.checkpoint(w, task.title);
    if ('compactFirst' in s) s.compactFirst(WORKER_TASK_COMPACT, w.contextTokens);
    s.setEffort(this.effortFor(task));
    // Plan mode must be in place before the task message arrives.
    void s.setMode(needsPlan(task) ? 'plan' : 'auto').then(() => {
      s.send(this.withNotes(w, this.taskMessage(w, task)));
      after.forEach((m) => s.send(m));
    });
    store.changed();
  }

  /** Every account is held by a usage limit: the task waits in the queue until the first one resets. */
  private pause(w: Worker, task: Task | null) {
    if (task) { task.status = 'queued'; task.queueReason = 'limit'; task.updatedAt = nowIso(); }
    const time = limitResetText(accounts.nextFreeAt(providerOf(w.model, cachedModels().models)));
    w.status = 'idle';
    w.statusText = t('st.limitUntil', { time });
    store.log(w.id, 'event', t('log.limitWait', { time }));
    store.changed();
  }

  /** Its Worker already holds a slot, or one is free (Settings > Models > Workers at once). */
  private hasSlot(w: Worker) {
    return canStart(store.data.tasks, w.id, loadSettings().maxWorkers);
  }

  /**
   * Every Worker slot is taken: the task waits in the queue, and `msg` (if any) waits with it.
   * A task already queued keeps its place; fillSlots starts the longest waiting first.
   */
  private waitForSlot(w: Worker, task: Task, msg?: string) {
    if (task.status !== 'queued') task.updatedAt = nowIso();
    task.status = 'queued';
    task.queueReason = 'slot';
    if (msg) this.held.set(w.id, [...(this.held.get(w.id) ?? []), msg]);
    w.statusText = t('st.slotUntil');
    store.log(w.id, 'event', t('log.slotWait', { n: slotsUsed(store.data.tasks), max: loadSettings().maxWorkers }));
    store.changed();
  }

  /**
   * Run every half minute: a task that has waited for an answer longer than the setting allows gives its slot
   * back, and the tasks queued for one start. The waiting Worker is not stopped and runs again when answered.
   */
  sweepWaiting(now = Date.now()) {
    const minutes = loadSettings().waitSlotMinutes;
    let changed = false;
    let released = false;
    for (const task of store.data.tasks) {
      const step = waitStep(task, now, minutes);
      if (!step) continue;
      changed = true;
      if (step === 'mark') task.waitingSince = new Date(now).toISOString();
      else if (step === 'clear') { task.waitingSince = null; task.slotReleased = false; }
      else {
        task.slotReleased = true;
        released = true;
        if (task.workerId) store.log(task.workerId, 'event', t('log.slotReleased', { n: minutes }));
      }
    }
    if (changed) store.changed();
    if (released) this.fillSlots();
  }

  /** Tasks whose stall reminder went out, so a second stall flags the Worker instead of reminding it again. */
  private stallNudged = new Set<string>();

  /**
   * Open tasks that nothing runs any more (shared/stall.ts): the Worker is reminded once to go on; if it stalls again,
   * it shows as stalled and the Dispatcher is told, rather than the Worker sitting idle without a word.
   */
  sweepStalled(now = Date.now()) {
    // A task that settled starts afresh if a follow-up reopens it.
    for (const id of this.stallNudged) if (store.task(id)?.status !== 'running') this.stallNudged.delete(id);
    for (const w of store.data.workers) {
      const task = this.currentTask(w);
      const s = this.sessions.get(w.id) ?? null;
      if (w.stalledAt) {
        // Its task ended or moved on another way (a Stop, a cancel, a reply that started no turn).
        if (!isStalled(w, task, s, now, 0)) { w.stalledAt = null; store.changed(); }
        continue;
      }
      if (!task || !isStalled(w, task, s, now)) continue;
      const min = Math.round((now - Date.parse(w.lastActiveAt)) / 60_000);
      if (s && !s.closed && !this.stallNudged.has(task.id)) {
        this.stallNudged.add(task.id);
        store.log(w.id, 'event', t('log.stallNudge', { min }));
        s.send(stallMsg(task.id, min, !!s.shells));
        this.touch(w);
        continue;
      }
      w.stalledAt = new Date(now).toISOString();
      // Shown as running while it waited on background shells; stalled is shown on an idle Worker.
      if (w.status === 'running') { w.status = 'idle'; w.statusText = ''; }
      store.log(w.id, 'event', t('log.stalled', { min }));
      store.pushUpdate(`${w.id} (${task.id} "${task.title}") looks stalled: its task is open, but its session has been idle for ${min} min with ${s?.shells ? `only ${s.shells} background command(s) left running (a server or a hung run?)` : 'nothing running'}${this.stallNudged.has(task.id) ? ', even after a reminder to go on' : ''}. send_to_worker to tell it how to go on, or stop it.`, true);
      store.changed();
    }
  }

  /**
   * A slot may be free: a task finished or failed, a session went idle, or the limit was raised.
   * Tasks waiting for one start, the longest waiting first. Running Workers are never stopped for a lower limit.
   */
  fillSlots() {
    for (const task of queueOrder(store.data.tasks, 'slot')) {
      const w = task.workerId ? store.worker(task.workerId) : null;
      if (!w || !waitsForSlot(task) || !this.hasSlot(w)) continue;
      // Its worktree is made again first; the queue is filled again once it is there.
      if (w.status === 'archived') {
        // Without its worktree the task cannot run: it fails once, rather than every time the queue is filled.
        void this.restoreWorker(w).then((err) => (err === null ? this.fillSlots() : this.fail(w, task, err)));
        continue;
      }
      const s = this.ensureSession(w);
      // A usage limit holds every account now: it waits for that instead.
      if (!s) { this.pause(w, task); continue; }
      if (!taskStarted(w, task)) w.title = task.title;
      this.deliver(w, s, [], task);
    }
    this.sendFeedback();
  }

  /**
   * Send to a Worker whose session is open. Messages held while a usage limit lasted, or while its task waited
   * for a slot, go first. A queued task runs again: it starts if the Worker never got it, and is told to continue
   * when there is nothing else to send. Otherwise a follow-up may reopen the last task (reopenLast);
   * a question from the Dispatcher is no follow-up and reopens nothing.
   */
  private deliver(w: Worker, s: WorkerSession, msgs: string[], task = this.currentTask(w)) {
    const out = [...(this.held.get(w.id) ?? []), ...msgs];
    this.checkpoint(w, out[0] ?? task?.title ?? '');
    const paused = task?.status === 'queued';
    const slot = !!task && waitsForSlot(task);
    if (paused || this.held.has(w.id)) {
      this.held.delete(w.id);
      w.statusText = '';
      store.log(w.id, 'event', t(slot ? 'log.slotFree' : 'log.limitCleared'));
    }
    if (task && paused) {
      task.status = 'running';
      task.queueReason = null;
      task.updatedAt = nowIso();
      if (!taskStarted(w, task)) {
        this.startTask(w, s, task, out);
        return this.touch(w);
      }
      if (!out.length) out.push(slot ? SLOT_FREE_MSG : LIMIT_RESET_MSG);
    }
    if (out.some((m) => !m.startsWith(QUESTION_TAG))) this.reopenLast(w);
    out.forEach((m, i) => s.send(i ? m : this.withNotes(w, m)));
    this.touch(w);
  }

  /** The task's own effort when per-task effort is on, otherwise the Worker default. */
  effortFor(task: Task | null) {
    const st = loadSettings();
    return (st.effortPerTask && task?.effort) || st.workerEffort;
  }

  /** Instructions for a Worker. Says where the message is now: sent, or held for a slot or a usage limit. */
  async send(workerId: string, from: 'user' | 'dispatcher', text: string) {
    const w = store.worker(workerId);
    if (!w) throw new Error(t('err.noWorker', { id: workerId }));
    if (w.status === 'archived') await this.unarchive(w);
    store.log(w.id, from, text);
    if (from === 'user') store.pushUpdate(`The user wrote to ${w.id} directly: ${oneLine(text, 200)}`);
    // From either one, it answers what the Worker asked the Dispatcher for: a task that waited for that goes on.
    if (w.request) {
      const cur = this.currentTask(w);
      w.request = null;
      // What it asks with no task open is counted per Worker, from one answer to the next.
      this.requestWakes.delete(w.id);
      if (cur?.status === 'waiting' && !this.sessions.get(w.id)?.busy) {
        setStatus(cur, 'running');
        cur.updatedAt = nowIso();
        w.statusText = '';
      }
    }
    const how = this.post(w, `${from === 'user' ? '[User message]' : '[Dispatcher]'} ${text}`);
    // With no task to report on, what the turn says goes back to the Dispatcher as an update.
    if (from === 'dispatcher' && how === 'sent' && !this.currentTask(w)) this.replyOwed.add(w.id);
    return how;
  }

  /**
   * The Dispatcher asks a Worker something. Unlike instructions, a question reopens no task, and the answer goes
   * back to the Dispatcher: by tell_dispatcher, mid-task too, or as the text of the turn. Says where the question is now.
   */
  async ask(workerId: string, text: string) {
    const w = store.worker(workerId);
    if (!w) throw new Error(t('err.noWorker', { id: workerId }));
    if (w.status === 'archived') await this.unarchive(w);
    store.log(w.id, 'dispatcher', `${t('log.question')}: ${text}`);
    store.chat('event', t('ev.asked', { id: w.id, text: oneLine(text, 200) }));
    // Questions asked before an answer came are answered together.
    w.ask = { text: w.ask ? `${w.ask.text}\n${text}` : text, at: w.ask?.at ?? nowIso() };
    this.questioned.add(w.id);
    return this.post(w, question(text));
  }

  /** Route a message to a Worker: now, or held until its task gets a slot or a usage limit resets. */
  private post(w: Worker, msg: string): 'sent' | 'slot' | 'limit' {
    // Its task waits for a slot: the message goes out when the task starts. Work in progress is never held for one.
    const cur = this.currentTask(w);
    // A follow-up that reopens the last task starts work like a new task does, so it needs a free slot as well.
    const reopens = !cur && !msg.startsWith(QUESTION_TAG) && !this.hasSlot(w) ? this.reopenLast(w) : null;
    if (reopens) {
      this.waitForSlot(w, reopens, msg);
      return 'slot';
    }
    if (cur && waitsForSlot(cur)) {
      this.held.set(w.id, [...(this.held.get(w.id) ?? []), msg]);
      store.log(w.id, 'event', t('log.slotHeld'));
      store.changed();
      return 'slot';
    }
    // Paused for a usage limit: going on needs a slot like any other resume.
    if (cur?.status === 'queued' && !this.hasSlot(w)) {
      this.waitForSlot(w, cur, msg);
      return 'slot';
    }
    const s = this.ensureSession(w);
    if (!s) {
      this.hold(w, msg);
      return 'limit';
    }
    this.deliver(w, s, [msg], cur);
    return 'sent';
  }

  /** New review comments on a PR, its failed CI checks, or a conflict with its base. */
  sendReview(task: Task, body: string, kind: FeedbackKind = 'review') {
    const w = task.workerId ? store.worker(task.workerId) : null;
    if (!w) return;
    // The Worker is on another task: the turn that handled this would settle that one. It waits until that is settled.
    const other = this.currentTask(w);
    if (other && other.id !== task.id) {
      const list = this.feedback.get(w.id) ?? [];
      if (list.some((f) => f.taskId === task.id && f.kind === kind && f.body === body)) return;
      this.feedback.set(w.id, [...list, { taskId: task.id, body, kind }]);
      store.log(w.id, 'event', t('log.feedbackHeld', { id: task.id, other: other.id }));
      return store.changed();
    }
    if (w.status === 'archived') {
      void this.restoreWorker(w).then((err) => {
        if (err === null) this.sendReview(task, body, kind);
        else store.pushUpdate(`${w.id} could not get its worktree back, so the ${kind === 'ci' ? 'CI failure' : kind === 'conflict' ? 'merge conflict' : 'review comments'} on ${task.id} "${task.title}" (${task.prUrl}) did not reach it.`, true);
      });
      return;
    }
    (kind === 'ci' ? this.ciFixing : this.reviewing).add(task.id);
    store.log(w.id, 'event', t(kind === 'ci' ? 'log.ciFix' : kind === 'conflict' ? 'log.conflictFix' : 'log.review'));
    const msg = kind === 'conflict'
      ? `[Merge conflict] ${task.prUrl} conflicts with its base branch and cannot be merged. Resolve it on the same branch (${task.branch}) and report what you resolved.\n\n${body}`
      : kind === 'ci'
      ? `[CI failure] Checks failed on ${task.prUrl}. Fix them on the same branch (${task.branch}), push, and report what you changed. If a failure does not come from this branch (a flaky test, CI setup, a missing secret), do not change unrelated code; say so in the report.\n\n${body}`
      : `[Review comments] New comments on ${task.prUrl}. Address them on the same branch (${task.branch}), push, and report what you changed. If you leave a comment unaddressed, say why in the report.\n\n${body}`;
    if (!this.hasSlot(w)) return this.waitForSlot(w, task, msg);
    task.status = 'running';
    task.updatedAt = nowIso();
    const s = this.ensureSession(w);
    if (!s) {
      task.status = 'queued';
      task.queueReason = 'limit';
      return this.hold(w, msg);
    }
    this.deliver(w, s, [msg], task);
  }

  /**
   * PR feedback held while its Worker was on another task (sendReview), sent once that task is settled.
   * All of one task's goes out together; another task's waits until that one is settled in turn.
   */
  private sendFeedback() {
    for (const [id, list] of [...this.feedback]) {
      const w = store.worker(id);
      if (!w) { this.feedback.delete(id); continue; }
      if (this.currentTask(w)) continue;
      const first = list[0].taskId;
      const rest = list.filter((f) => f.taskId !== first);
      if (rest.length) this.feedback.set(id, rest);
      else this.feedback.delete(id);
      const task = store.task(first);
      // Merged, closed or cancelled meanwhile: nothing is left to fix.
      if (task?.status !== 'pr_open') continue;
      for (const f of list) if (f.taskId === first) this.sendReview(task, f.body, f.kind);
    }
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
    }
    // Idle first: failing the task frees the slot, and fillSlots may hand this Worker held feedback or queued work.
    w.status = 'idle';
    w.statusText = '';
    this.stopping.set(w.id, by);
    this.fail(w, task, '');
    this.stopping.delete(w.id);
    this.touch(w);
    return 'stopped';
  }

  /** The task's turn is under way in its session: that is running work, which only Stop interrupts. */
  private inProgress(task: Task) {
    const w = task.workerId ? store.worker(task.workerId) : null;
    return !!w && !!this.sessions.get(w.id)?.busy && this.currentTask(w)?.id === task.id;
  }

  /** The Worker is using its worktree (see working()). */
  inUse(workerId: string) {
    const w = store.worker(workerId);
    return !!w && this.working(w);
  }

  /** The Worker is using its worktree: mid-turn, or one of its tasks is running. */
  private working(w: Worker) {
    return !!this.sessions.get(w.id)?.busy
      || w.taskIds.some((id) => { const x = store.task(id); return x?.status === 'running' || x?.status === 'waiting'; });
  }

  /** Cancel one task that is waiting to start (queued or blocked), with the tasks waiting on it. */
  cancelTask(id: string, by: 'user' | 'dispatcher') {
    const task = store.task(id);
    if (!task) throw new Error(t('err.noTask', { id }));
    if (!isQueued(task) || this.inProgress(task)) throw new Error(t('err.notQueued', { id: task.id, status: t(`task.${task.status}` as Key) }));
    return this.cancel([task.id], by, false);
  }

  /** Cancel every task waiting to start. Running work is left alone. */
  clearQueue(by: 'user' | 'dispatcher') {
    return this.cancel(store.data.tasks.filter((x) => isQueued(x) && !this.inProgress(x)).map((x) => x.id), by, true);
  }

  private async cancel(ids: string[], by: 'user' | 'dispatcher', all: boolean): Promise<CancelReport[]> {
    // Every status changes before the first await, so a usage limit resetting meanwhile starts none of them.
    const reports = this.cancelNow(ids);
    if (!reports.length) return reports;
    this.announce(reports, all);
    store.changed();
    await this.tidyCancelled(reports);
    if (by === 'user') store.pushUpdate(`The user cancelled queued work: ${reports.map(describeCancel).join('; ')}`);
    // A Worker left with nothing open takes the PR feedback that waited for it (after the branches are tidied).
    this.sendFeedback();
    store.changed();
    return reports;
  }

  /**
   * Mark these tasks and the tasks waiting on them cancelled, at once. `after` and `why`: they were cancelled because
   * the task they waited for ended that way (failed, or its PR was closed).
   */
  private cancelNow(ids: string[], after: string | null = null, why: 'closed' | 'failed' | 'gone' | null = null): CancelReport[] {
    const { picked, followers } = cancelSet(store.data.tasks, ids);
    return [...picked.map((x) => this.markCancelled(x, after, why)), ...followers.map((x) => this.markCancelled(x, x.afterTaskId ?? null))];
  }

  /** Delete the branches cancelled tasks left and archive Workers left with nothing, then say what was kept. */
  private async tidyCancelled(reports: CancelReport[]) {
    for (const r of reports) {
      try { await this.cleanUp(r); } catch (e) { log.warn(`cancel cleanup ${r.id}`, e); }
    }
    for (const id of new Set(reports.map((r) => r.workerId))) {
      if (!id || reports.some((r) => r.workerId === id && r.kept)) continue;
      try { await this.retireIfUnused(id); } catch (e) { log.warn(`cancel retire ${id}`, e); }
    }
    for (const r of reports) {
      if (!r.kept) continue;
      const vars = { title: r.title, branch: r.kept.branch, n: r.kept.commits, path: r.kept.path };
      store.chat('event', t(r.kept.dirty ? 'ev.cancelKeptChanges' : 'ev.cancelKeptCommits', vars));
    }
  }

  private markCancelled(task: Task, followerOf: string | null, why: 'closed' | 'failed' | 'gone' | null = null): CancelReport {
    const wasQueued = task.status === 'queued';
    task.status = statusAfterCancel(task);
    task.queueReason = null;
    task.updatedAt = nowIso();
    this.reviewing.delete(task.id);
    this.ciFixing.delete(task.id);
    this.followups.delete(task.id);
    const w = task.workerId ? store.worker(task.workerId) : null;
    if (w) {
      if (wasQueued) {
        // Messages held for the paused work go with it, and the "until the limit resets" status too.
        this.held.delete(w.id);
        if (!w.taskIds.some((id) => store.task(id)?.status === 'queued')) w.statusText = '';
        // Its session may have started on it: tell it before it hears anything else.
        if (taskStarted(w, task) && task.status === 'cancelled') this.notes.set(w.id, [...(this.notes.get(w.id) ?? []), task.id]);
      }
      const after = why === 'closed' ? t('log.blockedCancelled') : why === 'failed' ? t('log.blockedFailed', { id: followerOf ?? '' }) : followerOf ? t('log.cancelledAfter', { id: followerOf }) : t('log.cancelled');
      store.log(w.id, 'event', task.status !== 'cancelled' ? t('log.queueDropped') : after);
    }
    return { id: task.id, title: task.title, workerId: w?.id ?? null, status: task.status, followerOf, kept: null };
  }

  private announce(reports: CancelReport[], all: boolean) {
    const dropped = (r: CancelReport) => t(r.status === 'pr_open' ? 'ev.cancelDroppedPr' : 'ev.cancelDropped', { title: r.title });
    if (all) {
      store.chat('event', t('ev.queueCleared', { n: reports.length }));
      for (const r of reports) if (r.status !== 'cancelled') store.chat('event', dropped(r));
      return;
    }
    const [first, ...rest] = reports;
    store.chat('event', first.status === 'cancelled' ? t('ev.cancelled', { title: first.title }) : dropped(first));
    if (rest.length) store.chat('event', t('ev.cancelFollowers', { n: rest.length, titles: rest.map((r) => `"${r.title}"`).join(', ') }));
  }

  /** Delete the branch a cancelled task left, unless it holds commits or uncommitted changes. */
  private async cleanUp(r: CancelReport) {
    const task = store.task(r.id);
    const w = r.workerId ? store.worker(r.workerId) : null;
    // Dropped review, CI or follow-up work keeps the task's branch and PR.
    if (!task || !w || task.status !== 'cancelled' || task.kind !== 'code' || !task.branch) return;
    const repo = task.repo ? store.repo(task.repo) : null;
    if (!repo || w.repo !== repo.name) return;
    const wt = fs.existsSync(path.join(w.cwd, '.git')) ? w.cwd : null;
    const b = await inspectBranch(repo.path, wt, repo.defaultBranch, task.branch, isLocalRepo(repo));
    if (holdsWork(b)) {
      r.kept = { branch: task.branch, commits: b.commits, dirty: b.dirty, path: wt ?? repo.path };
      store.log(w.id, 'event', t('log.cancelKept', { branch: task.branch }));
      return;
    }
    // A Worker busy in the worktree stays on its branch; that branch is the cancelled one only in odd states.
    if (b.checkedOut && this.working(w)) return;
    await dropBranch(repo.path, wt, repo.defaultBranch, task.branch, b, ghEnv(), isLocalRepo(repo));
  }

  /**
   * A Worker left with only cancelled tasks is archived, which removes its worktree, but only when nothing in it is uncommitted.
   * An archived Worker kept its worktree for a task waiting on a merge (archive()); once none is left, it goes.
   */
  private async retireIfUnused(id: string) {
    const w = store.worker(id);
    if (!w || this.working(w)) return;
    const archived = w.status === 'archived';
    const hasWorktree = !!w.repo && fs.existsSync(path.join(w.cwd, '.git'));
    if (archived) {
      if (!hasWorktree || w.taskIds.some((x) => { const st = store.task(x)?.status; return st === 'pr_open' || st === 'blocked'; })) return;
    } else if (!w.taskIds.length || w.taskIds.some((x) => store.task(x)?.status !== 'cancelled')) return;
    if (hasWorktree && !(await worktreeClean(w.cwd))) return;
    await this.archive(w.id);
  }

  /** Tasks cancelled while this Worker's session had them, per Worker; it hears it with its next message. */
  private notes = new Map<string, string[]>();

  private withNotes(w: Worker, msg: string) {
    if (this.restored.delete(w.id)) msg = `[Files restored] The user put the files in your worktree back to an earlier checkpoint. What you remember of them may be out of date: read a file again before you edit it.\n\n${msg}`;
    const ids = this.notes.get(w.id);
    if (!ids?.length) return msg;
    this.notes.delete(w.id);
    return `[Cancelled] The user cancelled ${ids.join(', ')} while it was waiting; do not continue it. The app deleted its branch unless it held commits or uncommitted changes, and may have moved this worktree back to the default branch.\n\n${msg}`;
  }

  /**
   * Close a Worker's session and remove its worktree. A Worker at work is refused: its task would be left running
   * with nobody on it (Stop it first). The folder stays while a task still needs it (a PR, a queued or blocked task)
   * or while it holds uncommitted changes, which removing it would lose. Says which folder was kept and why.
   */
  async archive(workerId: string): Promise<{ kept: 'task' | 'dirty' | null }> {
    const w = store.worker(workerId);
    if (!w) return { kept: null };
    this.checkArchive(w.id);
    this.sessions.get(w.id)?.close();
    this.sessions.delete(w.id);
    this.said.delete(w.id);
    w.status = 'archived';
    w.statusText = '';
    let kept: 'task' | 'dirty' | null = w.taskIds.some((id) => holdsWorktree(store.task(id))) ? 'task' : null;
    const repo = w.repo ? store.repo(w.repo) : null;
    if (repo && !kept && fs.existsSync(w.cwd)) {
      if (fs.existsSync(path.join(w.cwd, '.git')) && !(await worktreeClean(w.cwd))) {
        kept = 'dirty';
        store.log(w.id, 'event', t('log.archiveKeptDirty'));
      } else await removeWorktree(repo, w.cwd).catch(() => {});
    }
    store.changed();
    return { kept };
  }

  /** Throws while the Worker is at work: archiving it would leave its task running with nobody on it. */
  checkArchive(workerId: string) {
    const w = store.worker(workerId);
    if (w && this.working(w)) throw new Error(t('err.archiveBusy', { id: w.id }));
  }

  /** Throws when the repository can't be removed yet: one of its tasks is open, or one of its Workers is mid-turn. */
  checkRetire(name: string) {
    const open = store.data.tasks.filter((x) => x.repo === name && (x.status === 'running' || x.status === 'waiting' || isQueued(x)));
    if (open.length) throw new Error(t('repo.err.busy', { ids: open.map((x) => x.id).join(', ') }));
    const busy = store.data.workers.find((w) => w.repo === name && this.working(w));
    if (busy) throw new Error(t('err.archiveBusy', { id: busy.id }));
  }

  /**
   * Before a repository is removed: refused while one of its tasks is open (running, waiting, queued or blocked),
   * since nothing could finish it. Its Workers are archived and their worktrees removed, also one kept for an open
   * PR, which nothing follows any more. A worktree with uncommitted changes is kept. Returns the Workers whose was.
   */
  async retireRepo(name: string): Promise<string[]> {
    this.checkRetire(name);
    const repo = store.repo(name);
    const ws = store.data.workers.filter((w) => w.repo === name);
    const kept: string[] = [];
    for (const w of ws) {
      if (w.status !== 'archived') await this.archive(w.id);
      if (!repo || !fs.existsSync(path.join(w.cwd, '.git'))) continue;
      if (await worktreeClean(w.cwd)) await removeWorktree(repo, w.cwd).catch(() => {});
      else kept.push(w.id);
    }
    return kept;
  }

  /** Archived Workers whose worktree is being made again; a second call waits for the same one. */
  private unarchiving = new Map<string, Promise<void>>();

  /** Bring an archived Worker back, its worktree first. Rejects when that fails; the Worker stays archived. */
  unarchive(w: Worker): Promise<void> {
    const busy = this.unarchiving.get(w.id);
    if (busy) return busy;
    const run = (async () => {
      const repo = w.repo ? store.repo(w.repo) : null;
      if (repo && !fs.existsSync(path.join(w.cwd, '.git'))) await ensureWorktree(repo, w.id);
      if (!repo) ensureDir(w.cwd);
      // Not over a status the Worker got meanwhile.
      if (w.status === 'archived') w.status = 'idle';
      this.touch(w);
    })().finally(() => this.unarchiving.delete(w.id));
    this.unarchiving.set(w.id, run);
    return run;
  }

  /** unarchive() for work the app hands on by itself: null, or why it failed (also said in the Worker's conversation). */
  private async restoreWorker(w: Worker): Promise<string | null> {
    try {
      await this.unarchive(w);
      return null;
    } catch (e) {
      const msg = oneLine((e as Error).message ?? String(e), 200);
      log.warn(`unarchive ${w.id} failed`, msg);
      const why = t('log.unarchiveFailed', { msg });
      store.log(w.id, 'event', why);
      store.changed();
      return why;
    }
  }

  /** Archive Workers idle for longer than the setting (0 = never). One with an open task is left alone; archive() keeps uncommitted work. */
  autoArchive() {
    const days = loadSettings().archiveDays;
    if (!(days > 0)) return;
    const cutoff = Date.now() - days * 24 * 3600_000;
    for (const w of store.data.workers) {
      if (w.status !== 'idle' && w.status !== 'error') continue;
      if (Date.parse(w.lastActiveAt) > cutoff) continue;
      if (this.working(w) || w.taskIds.some((id) => holdsWorktree(store.task(id)))) continue;
      log.info(`auto-archive ${w.id}`);
      this.archive(w.id).catch((e) => log.warn(`auto-archive ${w.id}`, e));
    }
  }

  /** Messages that came while a usage limit held every account, per Worker; sent when the first limit resets. */
  private held = new Map<string, string[]>();
  /** PR feedback for a finished task that came while its Worker was on another one, per Worker, oldest first. */
  private feedback = new Map<string, { taskId: string; body: string; kind: FeedbackKind }[]>();

  private hold(w: Worker, msg: string) {
    this.held.set(w.id, [...(this.held.get(w.id) ?? []), msg]);
    // Its task cannot go on before the limit resets either (the session is gone), so it waits in the queue.
    const task = this.currentTask(w);
    if (task?.status === 'running') { task.status = 'queued'; task.queueReason = 'limit'; task.updatedAt = nowIso(); }
    const time = limitResetText(accounts.nextFreeAt(providerOf(w.model, cachedModels().models)));
    w.statusText = t('st.limitUntil', { time });
    store.log(w.id, 'event', t('log.limitHeld', { time }));
    store.changed();
  }

  /**
   * A usage limit reset (or an account was added): continue paused tasks and send held messages.
   * Paused tasks had a slot, so they take free ones before tasks waiting for a slot; past the limit they wait too.
   */
  retryQueued() {
    for (const task of queueOrder(store.data.tasks, 'limit')) {
      const w = task.workerId ? store.worker(task.workerId) : null;
      const s = w && this.ensureSession(w);
      if (!w || !s) continue;
      if (this.hasSlot(w)) this.deliver(w, s, [], task);
      else this.waitForSlot(w, task);
    }
    for (const id of [...this.held.keys()]) {
      const w = store.worker(id);
      if (!w) { this.held.delete(id); continue; }
      // Held for a task that waits for a slot: they go out when it starts.
      const cur = this.currentTask(w);
      if (cur && waitsForSlot(cur)) continue;
      const s = this.ensureSession(w);
      if (s) this.deliver(w, s, []);
    }
    this.fillSlots();
  }

  /**
   * On app start no session is left. A Worker that was busy continues its task. A Worker that ended in an error
   * gets its unfinished task failed, as a session error does now (state saved before that rule could disagree).
   * Paused tasks start right away when their limit reset while the app was closed.
   * Interrupted work takes the free slots first, in Worker order; past the limit (lowered meanwhile) it waits for one.
   */
  resumeAfterRestart() {
    const resume: { w: Worker; task: Task }[] = [];
    const failed: { w: Worker; task: Task }[] = [];
    for (const w of store.data.workers) {
      const task = this.currentTask(w);
      const inProgress = task && (task.status === 'running' || task.status === 'waiting');
      // An older version archived Workers mid-task; nobody will finish that task, so it failed.
      if (w.status === 'archived') {
        if (inProgress) failed.push({ w, task });
        continue;
      }
      // The turn that would have answered is gone with the session, and so is a question that was held.
      if (w.ask) this.unanswered(w, 'the app restarted', false);
      if (w.status === 'error') {
        if (inProgress) failed.push({ w, task });
        continue;
      }
      const busy = w.status === 'running' || w.status === 'waiting' || w.status === 'starting';
      w.status = 'idle';
      // A Worker saved as busy on a paused task (an older version left them so) was really running it.
      if (!task || (!inProgress && !busy)) continue;
      // Its turn had ended and the task waits for the Dispatcher's answer: nothing was interrupted.
      if (w.request && task.status === 'waiting' && !busy) continue;
      resume.push({ w, task });
    }
    const settling = new Set([...resume, ...failed].map((r) => r.task));
    let free = loadSettings().maxWorkers - slotsUsed(store.data.tasks.filter((x) => !settling.has(x)));
    for (const { w, task } of resume) {
      if (free <= 0) { this.waitForSlot(w, task, taskStarted(w, task) ? RESUME_MSG : undefined); continue; }
      free -= 1;
      const s = this.ensureSession(w);
      if (!s) { this.pause(w, task); continue; }
      setStatus(task, 'running');
      task.updatedAt = nowIso();
      store.log(w.id, 'event', t('log.restarted'));
      if (taskStarted(w, task)) s.send(RESUME_MSG);
      else this.startTask(w, s, task);
    }
    // After the resumes, so the slots these free go to tasks that waited for one, oldest first.
    for (const { w, task } of failed) this.fail(w, task, w.statusText);
    this.settleAllBlocked();
    store.changed();
    this.retryQueued();
  }

  closeAll() {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  ghEnv() { return ghEnv(); }
}

export function modelLabel(m: string) {
  return labelFor(m, cachedModels().models);
}

export const workers = new WorkerManager();
