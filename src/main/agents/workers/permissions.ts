import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { isAttached, readPath } from '../../attachments';
import { ask } from '../../decisions';
import { t } from '../../i18n';
import { loadSettings } from '../../settings';
import { store } from '../../store';
import { nowIso, oneLine } from '../../util';
import type { CodexApproval, CodexDecision } from '../codexSession';
import { connectorToolLabel } from '../connectors';
import { ALWAYS_ASK_PREFIX, alwaysAskRule } from '../permissions';
import { summarizeTool } from '../session';
import type { WorkerManager } from '../workers';
import { permissionPurpose, permissionReason } from '../../../shared/askWhy';
import { type GrantScope, answerLabel, grantScope, hasGrant, permissionOptions, withGrant, withoutGrant } from '../../../shared/grants';
import { workerDecisions } from '../../../shared/inbox';
import { withPermission } from '../../../shared/retro';
import { shellOf } from '../../../shared/shellWords';
import { setStatus } from '../../../shared/taskStatus';
import { ALLOW, ALLOW_TASK, DENY, GRANT_USED, type Task, type Worker, type WorkerStatus } from '../../../shared/types';
import { reviewPlan } from './plans';
import { answerQuestions } from './questions';

/** An action an allow-for-this-task rule let through, kept with the task's permission decisions. */
function grantUsed(task: Task, code: string) {
  task.permissions = withPermission(task.permissions, { at: nowIso(), answeredAt: null, code, answer: GRANT_USED });
}

/** The user took back an "Allow for this task": that kind of action is asked about again. */
export function revokeGrant(m: WorkerManager, taskId: string, key: string) {
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
export function taskScope(m: WorkerManager, task: Task | null, tool: string, input: unknown): GrantScope | null {
  if (!task || alwaysAskRule(tool, input, loadSettings().askOff)) return null;
  return grantScope(tool, input);
}

/** A command or a file change a Codex Worker needs a yes for: the same decision card a Claude Worker's permission gets. */
export function codexApproval(m: WorkerManager, w: Worker) {
  return async (req: CodexApproval, signal?: AbortSignal): Promise<CodexDecision> => {
    const task = m.currentTask(w);
    const prev = awaitDecision(m, w, task);
    // Codex names the shell it starts; a PowerShell line is read as PowerShell reads it.
    const tool = req.kind === 'command' ? (req.shell === 'powershell' ? 'PowerShell' : 'Bash') : 'Edit';
    const input = req.kind === 'command' ? { command: req.command } : { file_path: req.files.join(', ') };
    const code = (req.kind === 'command' ? `$ ${req.command}` : req.files.join('\n')).slice(0, 1200);
    // One file names a folder; several files are asked about each time.
    const scope = taskScope(m, task, tool, req.kind === 'command' ? input : req.files.length === 1 ? { file_path: req.files[0] } : {});
    if (task && scope && hasGrant(task, scope.key)) {
      grantUsed(task, code);
      decided(m, w, task, prev);
      store.log(w.id, 'event', t('log.grantUsed', { what: scope.label }));
      return 'accept';
    }
    try {
      const ans = await ask({
        source: 'permission', workerId: w.id, taskId: task?.id ?? null,
        title: req.kind === 'command' ? t('perm.bash') : t('perm.files'),
        detail: '',
        code,
        options: permissionOptions(scope),
        questionKey: null,
        reason: permissionReason(t, { who: w.id, task, tool, input, rule: alwaysAskRule(tool, input, loadSettings().askOff), decisionReason: req.reason }),
        purpose: permissionPurpose(t, { steps: task?.steps, said: m.said.get(w.id), input }),
      }, signal);
      store.log(w.id, 'user', `${oneLine(code, 140)} → ${answerLabel(t, ans)}`);
      if (ans === ALLOW_TASK && task && scope) task.grants = withGrant(task.grants, scope);
      return ans === ALLOW || ans === ALLOW_TASK ? 'accept' : 'decline';
    } catch {
      return 'decline';
    } finally {
      decided(m, w, task, prev);
    }
  };
}

/** The Worker asks the user something: it and its task wait. Returns the status to go back to. */
export function awaitDecision(m: WorkerManager, w: Worker, task: Task | null): WorkerStatus {
  const prev = w.status;
  w.status = 'waiting';
  if (task) setStatus(task, 'waiting');
  store.changed();
  return prev;
}

/** A decision was answered or withdrawn: back to work, unless another one of this Worker's is still open. */
export function decided(m: WorkerManager, w: Worker, task: Task | null, prev: WorkerStatus) {
  if (!workerDecisions(store.data.decisions, w.id).length) {
    if (w.status === 'waiting') w.status = prev === 'waiting' ? 'running' : prev;
    if (task && task.status === 'waiting') setStatus(task, 'running');
  }
  store.changed();
}

export function permissionHandler(m: WorkerManager, w: Worker): CanUseTool {
  return async (toolName, input, opts) => {
    if (toolName === 'AskUserQuestion') return answerQuestions(m, w, input, opts.signal);
    if (toolName === 'ExitPlanMode') return reviewPlan(m, w, input, opts.signal);
    // The app's own tools (recall, tell_dispatcher) change nothing in the worktree; in plan mode too.
    if (toolName.startsWith('mcp__oma__')) return { behavior: 'allow', updatedInput: input };
    // Files the user attached may be read without asking.
    const rp = readPath(toolName, input);
    if (rp && isAttached(rp)) return { behavior: 'allow', updatedInput: input };
    const task = m.currentTask(w);
    // Allowed for this task already: the same kind of action goes ahead, with a line in the conversation.
    const scope = taskScope(m, task, toolName, input);
    if (task && scope && hasGrant(task, scope.key)) {
      grantUsed(task, summarizeTool(toolName, input, 1200));
      store.log(w.id, 'event', t('log.grantUsed', { what: scope.label }));
      store.changed();
      return { behavior: 'allow', updatedInput: input };
    }
    const prev = awaitDecision(m, w, task);
    try {
      // The always-ask hook's reason is ours (the rule says it better); any other is Claude Code's own.
      const cc = opts.decisionReason?.startsWith(ALWAYS_ASK_PREFIX) ? null : opts.decisionReason;
      const ans = await ask({
        source: 'permission', workerId: w.id, taskId: task?.id ?? null,
        title: shellOf(toolName) ? t('perm.bash') : t('perm.tool', { tool: connectorToolLabel(toolName) ?? toolName.replace(/^mcp__\w+__/, '') }),
        detail: '',
        code: summarizeTool(toolName, input, 1200),
        options: permissionOptions(scope),
        questionKey: null,
        reason: permissionReason(t, { who: w.id, task, tool: toolName, input, rule: alwaysAskRule(toolName, input, loadSettings().askOff), blockedPath: opts.blockedPath, decisionReason: cc, impact: opts.description }),
        purpose: permissionPurpose(t, { steps: task?.steps, said: m.said.get(w.id), input }),
      }, opts.signal);
      store.log(w.id, 'user', `${summarizeTool(toolName, input)} → ${answerLabel(t, ans)}`);
      if (ans === ALLOW_TASK && task && scope) task.grants = withGrant(task.grants, scope);
      if (ans === ALLOW || ans === ALLOW_TASK) return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: ans === DENY ? 'The user denied this action. Find another way, or skip it if it is not needed.' : `The user denied this and said: ${ans}` };
    } catch {
      return { behavior: 'deny', message: 'The request was cancelled.' };
    } finally {
      decided(m, w, task, prev);
    }
  };
}
