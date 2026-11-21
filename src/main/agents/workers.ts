import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, tool, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { AgentSession, summarizeTool } from './session';
import { alwaysAskHook, ALWAYS_ASK_PREFIX } from './permissions';
import { REVIEWER, reviewerAgent, selfReviewLine } from './selfReview';
import { adviseOnQuestion } from './advisor';
import { accounts } from '../accounts';
import { store } from '../store';
import { ask } from '../decisions';
import { remember, searchMemory } from '../memory';
import { memoryDirFor, searchClaudeMemory, userRulesSection } from '../claudeContext';
import { paths } from '../paths';
import { loadSettings } from '../settings';
import { cachedModels } from '../models';
import { modelLabel as labelFor } from '../../shared/models';
import { ensureWorktree, removeWorktree, ghEnv } from '../repos';
import { dropBranch, holdsWork, inspectBranch, worktreeClean } from '../gitwork';
import { worktreeDiff } from '../gitdiff';
import { notifyInfo } from '../notify';
import { isAttached, readPath } from '../attachments';
import { t, langName, limitResetText } from '../i18n';
import { log } from '../log';
import { ensureDir, nowIso, oneLine, uid } from '../util';
import { ALLOW, DENY, type Task, type Worker } from '../../shared/types';
import { cancelSet, describeCancel, isQueued, statusAfterCancel, type CancelReport } from '../../shared/queue';
import { planFallback, planSummary } from '../../shared/plan';
import type { Key } from '../../shared/i18n';
import { addSpend, hasSpend, spendVars } from '../../shared/spend';
import { kTokens } from '../../shared/context';

const RESUME_MSG = 'The app restarted and interrupted your work. Continue the task where you left off.';
const LIMIT_RESET_MSG = 'The usage limit has reset. Continue the task where you left off.';

const planNudge = (task: Task) =>
  `[Plan needed] Your turn ended without a plan for ${task.id}. This task is plan-first, so it is not finished until the user approves a plan. Finish investigating and present your plan with ExitPlanMode now; if the user must decide something first, ask with AskUserQuestion. If you were told to hold, reply in one line and stop.`;

/** The task message may say to plan only or to wait for approval; this is that approval. */
const planApproved = (task: Task) =>
  `[Plan approved] The user approved your plan for ${task.id}. That is the go-ahead this task was waiting for, even where the task message says to plan only: carry out the plan now in this session${task.kind === 'code' && task.branch ? ` on branch ${task.branch}` : ''}, and report the finished work as usual${task.kind === 'code' ? ', with the PR' : ''}. Do not stop at the plan.`;

/** The user approves from these three lines; the full plan stays folded under them. */
const planSummaryRule = () =>
  `Start the plan with exactly three lines, one sentence each in ${langName()}: "WHAT: " what you will do, "HOW: " how you will do it, "OUTPUT: " what the user gets when it is done. Put the details below them.`;

function workerPrompt(w: Worker) {
  const s = loadSettings();
  return [
    `You are Worker ${w.id} in Oh My Agent IDE. The Dispatcher assigns your tasks; the user only sees results and the decisions that truly need them. Write all progress messages and reports in ${langName()}.`,
    '',
    'Task messages start with "[Task T-xxxx]". Messages starting with "[Dispatcher]", "[User message]", "[Review comments]" or "[CI failure]" are further instructions for the work in progress.',
    'A message may end with an "[Attached files]" list of paths the user dropped in. Read them directly from those paths when relevant.',
    '',
    'Code tasks:',
    '- The current folder is a git worktree of the repository. Create the branch named in the task message from the default branch and work there.',
    "- Follow the repository's CLAUDE.md and conventions. Run the tests and linters and make them pass.",
    `- When done, commit, push, and open a ready-for-review PR (not a draft) with \`gh pr create\`. Do not request reviewers.${s.githubHost ? ` GH_HOST is set to ${s.githubHost}.` : ''}`,
    `- Write the PR title and body in the language the repository's recent PRs use; if there is no clear convention, use ${langName()}. The body lists what changed and which tests you ran.`,
    '- Do not comment on or merge PRs.',
    '- On "[Review comments]" or "[CI failure]", fix them on the same branch and push.',
    '',
    'Non-code tasks (research, documents, reports):',
    '- Create the output folder named in the task message and save results there as files (usually markdown).',
    '',
    'Memory:',
    "- Before choices the user may care about (naming, style, libraries, scope), search the user's preferences and past decisions with the recall tool.",
    ...(s.claudeMemory
      ? ["- Your Claude Code auto-memory folder is shared by every Worker on this repository and by the user's own Claude Code sessions in it. Save only durable facts about the repository or the user's preferences there; never task progress or anything specific to this branch. Update an existing memory instead of adding a duplicate."]
      : []),
    '',
    'Questions:',
    '- Use AskUserQuestion only when the user really must decide. Make minor choices yourself and mention them in the final report.',
    '',
    'Start your final message with these lines:',
    'RESULT: one-line summary',
    'PR: PR URL (if any)',
    'FILE: absolute path of a result file (one line per file)',
    'Then a short explanation below.',
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
  /** Review fixes, CI fixes and follow-ups on finished tasks get different result-card wording. */
  private reviewing = new Set<string>();
  private ciFixing = new Set<string>();
  private followups = new Set<string>();
  /** Plan-first tasks whose Worker was reminded to present its plan, until it presents one. */
  private planNudged = new Set<string>();
  /** Plan-first tasks whose Worker was already sent back once for leaving out the WHAT / HOW / OUTPUT lines. */
  private summaryAsked = new Set<string>();

  /**
   * A follow-up for a task that finished (or failed) less than 3 days ago reopens that task,
   * so the Worker shows as running on it and its next report settles it.
   */
  private reopenLast(w: Worker) {
    if (this.currentTask(w)) return;
    const last = w.taskIds.length ? store.task(w.taskIds[w.taskIds.length - 1]) : null;
    if (!last || (last.status !== 'done' && last.status !== 'pr_open' && last.status !== 'failed')) return;
    // A failed task never got finishedAt; it failed when it was last updated.
    const at = last.finishedAt ?? (last.status === 'failed' ? last.updatedAt : null);
    if (!at || Date.now() - Date.parse(at) > 3 * 86400_000) return;
    if (last.prState === 'MERGED' || last.prState === 'CLOSED') return;
    // A task that failed before finishing just continues; its report is not a follow-up.
    if (last.finishedAt) this.followups.add(last.id);
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
    store.chat('event', t('ev.workerCreated', { id: w.id, repo: repo ? repo.name : t('general'), model: modelLabel(w.model) }));
    return w;
  }

  /** Open a session on a picked account if none is open. Null when a usage limit holds every account. */
  ensureSession(w: Worker): AgentSession | null {
    const existing = this.sessions.get(w.id);
    if (existing && !existing.closed) return existing.ready() ? existing : null;
    const acc = accounts.isFree(w.accountId) ? accounts.get(w.accountId) : accounts.pick();
    if (!acc) return null;
    const memDir = workerMemoryDir(w);
    const s = new AgentSession({
      label: w.id,
      model: w.model,
      cwd: w.cwd,
      systemAppend: workerPrompt(w) + (loadSettings().claudeRules ? userRulesSection() : ''),
      // One auto-memory per repository, shared with the user's own Claude Code sessions there (not one per worktree).
      // Off in Settings: no Claude Code auto-memory at all, rather than a separate one per worktree.
      settings: loadSettings().claudeMemory ? { autoMemoryDirectory: memDir } : { autoMemoryEnabled: false },
      mcpServers: { oma: memoryTools(loadSettings().claudeMemory ? memDir : null) },
      accountId: acc.id,
      resume: w.sessionId,
      spent: w.sessionSpend,
      settingSources: w.repo ? ['project', 'local'] : [],
      effort: loadSettings().workerEffort,
      permissionMode: needsPlan(this.currentTask(w)) ? 'plan' : 'auto',
      canUseTool: this.permissionHandler(w),
      hooks: { PreToolUse: [alwaysAskHook()] },
      // Registered even with self-review off, so turning it on reaches sessions that are already open.
      // Its model is read when the session starts, like the Worker's own.
      agents: { [REVIEWER]: reviewerAgent(loadSettings().dispatcherModel) },
    }, {
      onInit: (sid) => { w.sessionId = sid; store.changed(); },
      onAccount: (id) => { w.accountId = id; store.changed(); },
      onText: (text) => {
        store.log(w.id, 'worker', text);
        w.statusText = oneLine(text, 140);
        this.touch(w);
      },
      onTool: (_name, summary) => { w.statusText = summary; store.changed(); },
      onContext: (n) => { w.contextTokens = n; },
      onSpend: (turn, session) => {
        w.sessionSpend = session;
        // A turn outside any open task (a message to an idle Worker) counts toward its latest task.
        const task = this.currentTask(w) ?? (w.taskIds.length ? store.task(w.taskIds[w.taskIds.length - 1]) : null);
        if (task && hasSpend(turn)) task.spend = addSpend(task.spend, turn);
        store.changed();
      },
      onStatus: (st, text) => {
        if (st === 'busy') { if (w.status !== 'waiting') w.status = 'running'; }
        else if (st === 'idle') { w.status = 'idle'; }
        else {
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
      },
      onTurnEnd: (r) => {
        // With more input queued, the turn that follows settles the task.
        if (r.internal || r.queued) return;
        const task = this.currentTask(w);
        if (!task) return;
        // A plan-first task is not done before its plan is approved.
        if (needsPlan(task) && !r.isError) return this.awaitPlan(w, task, r.text, !!r.background);
        this.finalize(w, task, r.text, r.isError);
      },
      onLimited: () => this.pause(w, this.currentTask(w)),
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
    });
    this.sessions.set(w.id, s);
    return s;
  }

  private permissionHandler(w: Worker): CanUseTool {
    return async (toolName, input, opts) => {
      if (toolName === 'AskUserQuestion') return this.answerQuestions(w, input, opts.signal);
      if (toolName === 'ExitPlanMode') return this.reviewPlan(w, input, opts.signal);
      // Files the user attached may be read without asking.
      const rp = readPath(toolName, input);
      if (rp && isAttached(rp)) return { behavior: 'allow', updatedInput: input };
      const task = this.currentTask(w);
      const prev = w.status;
      w.status = 'waiting';
      if (task) task.status = 'waiting';
      store.changed();
      try {
        const reason = (opts.decisionReason ?? '').replace(ALWAYS_ASK_PREFIX, '');
        const ans = await ask({
          source: 'permission', workerId: w.id, taskId: task?.id ?? null,
          title: toolName === 'Bash' ? t('perm.bash') : t('perm.tool', { tool: toolName.replace(/^mcp__\w+__/, '') }),
          detail: reason ? t('perm.reason', { reason }) : (opts.title ?? ''),
          code: summarizeTool(toolName, input, 1200),
          options: [{ label: ALLOW }, { label: DENY }],
          questionKey: null,
        }, opts.signal);
        store.log(w.id, 'user', `${summarizeTool(toolName, input)} → ${ans === ALLOW ? t('allow') : ans === DENY ? t('deny') : ans}`);
        if (ans === ALLOW) return { behavior: 'allow', updatedInput: input };
        return { behavior: 'deny', message: ans === DENY ? 'The user denied this action. Find another way, or skip it if it is not needed.' : `The user denied this and said: ${ans}` };
      } catch {
        return { behavior: 'deny', message: 'The request was cancelled.' };
      } finally {
        if (w.status === 'waiting') w.status = prev === 'waiting' ? 'running' : prev;
        if (task && task.status === 'waiting') task.status = 'running';
        store.changed();
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
    const prev = w.status;
    w.status = 'waiting';
    if (task) task.status = 'waiting';
    store.changed();
    try {
      const ans = await ask({
        source: 'plan', workerId: w.id, taskId: task?.id ?? null,
        title: t('plan.title'), detail: task?.title ?? w.title, code: plan || null, summary,
        options: [{ label: ALLOW }], questionKey: null,
      }, signal);
      if (ans === ALLOW) {
        const s = this.sessions.get(w.id);
        if (s) s.cfg.permissionMode = 'auto';
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
      if (w.status === 'waiting') w.status = prev === 'waiting' ? 'running' : prev;
      if (task && task.status === 'waiting') task.status = 'running';
      store.changed();
    }
  }

  async diff(workerId: string) {
    const w = store.worker(workerId);
    const repo = w?.repo ? store.repo(w.repo) : null;
    if (!w || !repo) return null;
    return worktreeDiff(repo.defaultBranch, w.cwd);
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
      const prev = w.status;
      w.status = 'waiting';
      if (task) task.status = 'waiting';
      store.changed();
      try {
        const ans = await ask({
          source: 'question', workerId: w.id, taskId: task?.id ?? null,
          title: q.question, detail: task ? task.title : w.title, code: null,
          options: (q.options ?? []).map((o: any) => ({ label: String(o.label), description: o.description ? String(o.description) : undefined })),
          questionKey: q.question,
        }, signal);
        answers[q.question] = ans;
        store.log(w.id, 'user', `${t('log.answer')}: ${ans}`);
      } catch {
        answers[q.question] = '(The user did not answer. Decide sensibly, proceed, and mention it in your report.)';
      } finally {
        if (w.status === 'waiting') w.status = prev === 'waiting' ? 'running' : prev;
        if (task && task.status === 'waiting') task.status = 'running';
        store.changed();
      }
    }
    return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
  }

  private fail(w: Worker, task: Task, text: string) {
    task.status = 'failed';
    task.updatedAt = nowIso();
    task.summary = oneLine(text || t('err.stopped'), 200);
    store.chat('error', t('ev.failed', { id: w.id, title: task.title, msg: task.summary }), task.id);
    store.pushUpdate(`${w.id} ${task.id} "${task.title}" failed: ${task.summary}`);
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
    store.pushUpdate(`${w.id} ${task.id} "${task.title}" is still planning: its turn ended without a plan to approve ("${oneLine(text, 160)}"). The task stays open; send_to_worker if it needs instructions.`);
    store.changed();
  }

  private finalize(w: Worker, task: Task, text: string, isError: boolean) {
    if (isError) return this.fail(w, task, text);
    const { summary, prUrl, files } = parseResult(text, w.cwd);
    task.updatedAt = nowIso();
    const wasReview = this.reviewing.delete(task.id);
    const wasCi = this.ciFixing.delete(task.id);
    const wasFollowup = this.followups.delete(task.id);
    const firstFinish = !task.finishedAt;
    task.summary = summary;
    task.prUrl = prUrl ?? task.prUrl;
    task.files = files.length ? files : task.files;
    task.status = task.prUrl ? 'pr_open' : 'done';
    task.prState = task.prUrl ? (task.prState ?? 'OPEN') : null;
    task.finishedAt = nowIso();
    if (task.prUrl && !task.reviewSyncedAt) task.reviewSyncedAt = nowIso();
    const label = wasReview ? t('res.reviewLabel') : wasCi ? t('res.ciFixLabel') : wasFollowup ? t('res.followupLabel') : t('res.doneLabel');
    store.chat('result', wasReview ? t('res.review', { s: summary }) : wasCi ? t('res.ciFix', { s: summary }) : wasFollowup ? t('res.followup', { s: summary }) : summary, task.id);
    store.pushUpdate(`${w.id} ${task.id} "${task.title}" ${wasReview ? 'review fixed' : wasCi ? 'CI fixed' : wasFollowup ? 'follow-up done' : 'done'}: ${summary}${task.prUrl ? ` (PR ${task.prUrl})` : ''}${task.files.length ? `, ${task.files.length} file(s)` : ''}`);
    if (firstFinish) remember('task', `${task.id} ${task.title} (${w.id}${w.repo ? `, ${w.repo}` : ''}) ${summary}${task.prUrl ? ` ${task.prUrl}` : ''}${hasSpend(task.spend) ? ` · ${t('spend.memo', spendVars(task.spend))}` : ''}`);
    notifyInfo(`${w.id} ${label}`, `${task.title}: ${summary}`);
    store.changed();
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
    for (const task of store.data.tasks) {
      if (task.status !== 'blocked' || task.afterTaskId !== doneTask.id || !task.workerId) continue;
      const w = store.worker(task.workerId);
      if (!w) continue;
      if (!merged) {
        task.status = 'cancelled';
        task.updatedAt = nowIso();
        store.chat('error', t('ev.blockedCancelled', { title: task.title, dep: doneTask.title }), task.id);
        store.log(w.id, 'event', t('log.blockedCancelled'));
        store.pushUpdate(`${task.id} "${task.title}" cancelled: ${doneTask.id} PR was closed without merging`);
        continue;
      }
      task.status = 'running';
      task.updatedAt = nowIso();
      w.title = task.title;
      store.chat('event', t('ev.blockedStarted', { id: w.id, title: task.title, dep: doneTask.title }));
      store.log(w.id, 'event', t('log.blockedStarted', { id: doneTask.id }));
      this.dispatch(w, task);
    }
    store.changed();
  }

  private taskMessage(w: Worker, task: Task) {
    const repo = task.repo ? store.repo(task.repo) : null;
    const head = [`[Task ${task.id}] ${task.title}`];
    if (task.kind === 'code' && repo) {
      head.push(`Repository: ${repo.name} (default branch ${repo.defaultBranch})`);
      head.push(`Branch: ${task.branch}. Start with \`git fetch origin\` then \`git switch -c ${task.branch} origin/${repo.defaultBranch}\`. If you are already on that branch, continue there.`);
      const review = selfReviewLine(loadSettings().selfReview, repo.defaultBranch);
      if (review) head.push(review);
    } else {
      head.push(`Output folder: ${path.join(w.cwd, task.id)}`);
    }
    if (needsPlan(task)) head.push(`Plan first: you are in plan mode (read-only). Investigate, then present your plan with ExitPlanMode. ${planSummaryRule()} The user approves it before you change anything; if they ask for changes, revise and present it again. Once it is approved, carry out the plan in this session and report the finished work.`);
    if (task.afterTaskId) {
      const dep = store.task(task.afterTaskId);
      if (dep?.prUrl) head.push(`This task builds on ${dep.prUrl}, which has been merged into the default branch.`);
    }
    return `${head.join('\n')}\n\n${task.prompt}`;
  }

  private dispatch(w: Worker, task: Task) {
    const s = this.ensureSession(w);
    if (!s) return this.pause(w, task);
    this.startTask(w, s, task);
  }

  /** Send the task message, with the task's effort and plan mode in place first; `after` follows it. */
  private startTask(w: Worker, s: AgentSession, task: Task, after: string[] = []) {
    task.startedAt = nowIso();
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
    if (task) { task.status = 'queued'; task.updatedAt = nowIso(); }
    const time = limitResetText(accounts.nextFreeAt());
    w.status = 'idle';
    w.statusText = t('st.limitUntil', { time });
    store.log(w.id, 'event', t('log.limitWait', { time }));
    store.changed();
  }

  /**
   * Send to a Worker whose session is open. Messages held while a usage limit lasted go first.
   * A task the limit paused runs again: it starts if the Worker never got it, and is told to continue
   * when there is nothing else to send. Otherwise a follow-up may reopen the last task (reopenLast).
   */
  private deliver(w: Worker, s: AgentSession, msgs: string[], task = this.currentTask(w)) {
    const out = [...(this.held.get(w.id) ?? []), ...msgs];
    const paused = task?.status === 'queued';
    if (paused || this.held.has(w.id)) {
      this.held.delete(w.id);
      w.statusText = '';
      store.log(w.id, 'event', t('log.limitCleared'));
    }
    if (task && paused) {
      task.status = 'running';
      task.updatedAt = nowIso();
      if (!taskStarted(w, task)) {
        this.startTask(w, s, task, out);
        return this.touch(w);
      }
      if (!out.length) out.push(LIMIT_RESET_MSG);
    }
    this.reopenLast(w);
    out.forEach((m, i) => s.send(i ? m : this.withNotes(w, m)));
    this.touch(w);
  }

  /** The task's own effort when per-task effort is on, otherwise the Worker default. */
  effortFor(task: Task | null) {
    const st = loadSettings();
    return (st.effortPerTask && task?.effort) || st.workerEffort;
  }

  send(workerId: string, from: 'user' | 'dispatcher', text: string) {
    const w = store.worker(workerId);
    if (!w) throw new Error(t('err.noWorker', { id: workerId }));
    if (w.status === 'archived') void this.unarchive(w);
    store.log(w.id, from, text);
    if (from === 'user') store.pushUpdate(`The user wrote to ${w.id} directly: ${oneLine(text, 200)}`);
    const msg = `${from === 'user' ? '[User message]' : '[Dispatcher]'} ${text}`;
    const s = this.ensureSession(w);
    if (!s) return this.hold(w, msg);
    this.deliver(w, s, [msg]);
  }

  /** New review comments on a PR, or its failed CI checks. */
  sendReview(task: Task, body: string, kind: 'review' | 'ci' = 'review') {
    const w = task.workerId ? store.worker(task.workerId) : null;
    if (!w) return;
    if (w.status === 'archived') void this.unarchive(w);
    task.status = 'running';
    task.updatedAt = nowIso();
    (kind === 'ci' ? this.ciFixing : this.reviewing).add(task.id);
    store.log(w.id, 'event', t(kind === 'ci' ? 'log.ciFix' : 'log.review'));
    const msg = kind === 'ci'
      ? `[CI failure] Checks failed on ${task.prUrl}. Fix them on the same branch (${task.branch}), push, and report what you changed. If a failure does not come from this branch (a flaky test, CI setup, a missing secret), do not change unrelated code; say so in the report.\n\n${body}`
      : `[Review comments] New comments on ${task.prUrl}. Address them on the same branch (${task.branch}), push, and report what you changed. If you leave a comment unaddressed, say why in the report.\n\n${body}`;
    const s = this.ensureSession(w);
    if (!s) {
      task.status = 'queued';
      return this.hold(w, msg);
    }
    this.deliver(w, s, [msg], task);
  }

  async stop(workerId: string) {
    await this.sessions.get(workerId)?.interrupt();
  }

  /** The task's turn is under way in its session: that is running work, which only Stop interrupts. */
  private inProgress(task: Task) {
    const w = task.workerId ? store.worker(task.workerId) : null;
    return !!w && !!this.sessions.get(w.id)?.busy && this.currentTask(w)?.id === task.id;
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
    const { picked, followers } = cancelSet(store.data.tasks, ids);
    // Every status changes before the first await, so a usage limit resetting meanwhile starts none of them.
    const reports = [...picked.map((x) => this.markCancelled(x, null)), ...followers.map((x) => this.markCancelled(x, x.afterTaskId ?? null))];
    if (!reports.length) return reports;
    this.announce(reports, all);
    store.changed();
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
    if (by === 'user') store.pushUpdate(`The user cancelled queued work: ${reports.map(describeCancel).join('; ')}`);
    store.changed();
    return reports;
  }

  private markCancelled(task: Task, followerOf: string | null): CancelReport {
    const wasQueued = task.status === 'queued';
    task.status = statusAfterCancel(task);
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
      store.log(w.id, 'event', task.status !== 'cancelled' ? t('log.queueDropped') : followerOf ? t('log.cancelledAfter', { id: followerOf }) : t('log.cancelled'));
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
    const b = await inspectBranch(repo.path, wt, repo.defaultBranch, task.branch);
    if (holdsWork(b)) {
      r.kept = { branch: task.branch, commits: b.commits, dirty: b.dirty, path: wt ?? repo.path };
      store.log(w.id, 'event', t('log.cancelKept', { branch: task.branch }));
      return;
    }
    // A Worker busy in the worktree stays on its branch; that branch is the cancelled one only in odd states.
    if (b.checkedOut && this.working(w)) return;
    await dropBranch(repo.path, wt, repo.defaultBranch, task.branch, b, ghEnv());
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
    const ids = this.notes.get(w.id);
    if (!ids?.length) return msg;
    this.notes.delete(w.id);
    return `[Cancelled] The user cancelled ${ids.join(', ')} while it was waiting; do not continue it. The app deleted its branch unless it held commits or uncommitted changes, and may have moved this worktree back to the default branch.\n\n${msg}`;
  }

  async archive(workerId: string) {
    const w = store.worker(workerId);
    if (!w) return;
    this.sessions.get(w.id)?.close();
    this.sessions.delete(w.id);
    w.status = 'archived';
    w.statusText = '';
    const keep = w.taskIds.some((id) => { const x = store.task(id); return x?.status === 'pr_open' || x?.status === 'blocked'; });
    const repo = w.repo ? store.repo(w.repo) : null;
    if (repo && !keep && fs.existsSync(w.cwd)) await removeWorktree(repo, w.cwd).catch(() => {});
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
      if (w.taskIds.some((id) => { const x = store.task(id); return x?.status === 'pr_open' || x?.status === 'blocked'; })) continue;
      log.info(`auto-archive ${w.id}`);
      void this.archive(w.id);
    }
  }

  /** Messages that came while a usage limit held every account, per Worker; sent when the first limit resets. */
  private held = new Map<string, string[]>();

  private hold(w: Worker, msg: string) {
    this.held.set(w.id, [...(this.held.get(w.id) ?? []), msg]);
    // Its task cannot go on before the limit resets either (the session is gone), so it waits in the queue.
    const task = this.currentTask(w);
    if (task?.status === 'running') { task.status = 'queued'; task.updatedAt = nowIso(); }
    const time = limitResetText(accounts.nextFreeAt());
    w.statusText = t('st.limitUntil', { time });
    store.log(w.id, 'event', t('log.limitHeld', { time }));
    store.changed();
  }

  /** A usage limit reset (or an account was added): continue paused tasks and send held messages. */
  retryQueued() {
    for (const task of store.data.tasks) {
      if (task.status !== 'queued' || !task.workerId) continue;
      const w = store.worker(task.workerId);
      const s = w && this.ensureSession(w);
      if (w && s) this.deliver(w, s, [], task);
    }
    for (const id of [...this.held.keys()]) {
      const w = store.worker(id);
      if (!w) { this.held.delete(id); continue; }
      const s = this.ensureSession(w);
      if (s) this.deliver(w, s, []);
    }
  }

  /**
   * On app start no session is left. A Worker that was busy continues its task. A Worker that ended in an error
   * gets its unfinished task failed, as a session error does now (state saved before that rule could disagree).
   * Paused tasks start right away when their limit reset while the app was closed.
   */
  resumeAfterRestart() {
    for (const w of store.data.workers) {
      if (w.status === 'archived') continue;
      const task = this.currentTask(w);
      const inProgress = task && (task.status === 'running' || task.status === 'waiting');
      if (w.status === 'error') {
        if (inProgress) this.fail(w, task, w.statusText);
        continue;
      }
      const busy = w.status === 'running' || w.status === 'waiting' || w.status === 'starting';
      w.status = 'idle';
      // A Worker saved as busy on a paused task (an older version left them so) was really running it.
      if (!task || (!inProgress && !busy)) continue;
      const s = this.ensureSession(w);
      if (!s) { this.pause(w, task); continue; }
      task.status = 'running';
      task.updatedAt = nowIso();
      store.log(w.id, 'event', t('log.restarted'));
      if (taskStarted(w, task)) s.send(RESUME_MSG);
      else this.startTask(w, s, task);
    }
    store.changed();
    this.retryQueued();
  }

  closeAll() {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  ghEnv() { return ghEnv(); }
}

/** Claude Code memory of the repository's main checkout; Workers without a repository share the IDE home's. */
function workerMemoryDir(w: Worker) {
  const repo = w.repo ? store.repo(w.repo) : null;
  return memoryDirFor(repo ? repo.path : paths().home);
}

/** Read-only memory search for Workers: IDE memory plus the shared Claude Code memory. */
function memoryTools(memDir: string | null) {
  return createSdkMcpServer({
    name: 'oma',
    version: '0.2.0',
    alwaysLoad: true,
    tools: [
      tool('recall', "Search the user's memory: preferences, repository notes, past decisions and finished tasks (IDE memory), and the Claude Code memory shared for this repository.", { query: z.string() }, async (a) => {
        const ide = searchMemory(a.query, 8).map((h) => `[ide] ${h.path}:${h.line} ${h.text}`);
        const cc = memDir ? searchClaudeMemory(a.query, [memDir], 8).map((h) => `[claude] ${h.file}:${h.line} ${h.text}`) : [];
        const lines = [...ide, ...cc];
        return { content: [{ type: 'text' as const, text: lines.length ? lines.join('\n') : 'Nothing relevant in memory.' }] };
      }),
    ],
  });
}

function needsPlan(task: Task | null) {
  return !!task?.planFirst && !task.planApproved;
}

/** Whether the task message reached the Worker. Tasks saved before startedAt existed count once the Worker has a session. */
function taskStarted(w: Worker, task: Task) {
  return task.startedAt === undefined ? !!w.sessionId : !!task.startedAt;
}

export function modelLabel(m: string) {
  return labelFor(m, cachedModels().models);
}

export const workers = new WorkerManager();
