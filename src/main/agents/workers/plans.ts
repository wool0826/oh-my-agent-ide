import { ask } from '../../decisions';
import { t } from '../../i18n';
import { store } from '../../store';
import { nowIso, oneLine } from '../../util';
import { AgentSession } from '../session';
import { planApproved, planNudge, planSummaryRule } from '../workerText';
import type { StepsOp } from '../workerTools';
import type { WorkerManager } from '../workers';
import { planReason } from '../../../shared/askWhy';
import { planFallback, planSummary } from '../../../shared/plan';
import { markDone, mergeProgress, progressNote, setSteps, stepView, stepsLine } from '../../../shared/steps';
import { ALLOW, DENY, type Task, type Worker } from '../../../shared/types';
import { awaitDecision, decided } from './permissions';

/** The Worker finished planning: the user approves the plan or says what to change. */
export async function reviewPlan(m: WorkerManager, w: Worker, input: Record<string, unknown>, signal: AbortSignal) {
  const task = m.currentTask(w);
  if (task) m.planNudged.delete(task.id);
  const plan = String(input.plan ?? '').trim();
  let summary = planSummary(plan);
  if (!summary) {
    // Sent back once to add the lines, before the user sees it; a second plan without them is taken as it is.
    const key = task?.id ?? w.id;
    if (!m.summaryAsked.has(key)) {
      m.summaryAsked.add(key);
      store.log(w.id, 'event', t('log.planNoSummary'));
      return { behavior: 'deny' as const, message: `The plan is missing its summary lines. ${planSummaryRule()} Add them at the top, keep the rest of the plan, and present it again with ExitPlanMode.` };
    }
    summary = planFallback(plan);
  }
  store.log(w.id, 'worker', plan ? `${t('log.plan')}\n\n${plan}` : t('log.plan'));
  const prev = awaitDecision(m, w, task);
  try {
    const ans = await ask({
      source: 'plan', workerId: w.id, taskId: task?.id ?? null,
      title: t('plan.title'), detail: task?.title ?? w.title, code: plan || null, summary,
      options: [{ label: ALLOW }], questionKey: null, reason: planReason(t, { who: w.id, task }),
    }, signal);
    if (ans === ALLOW) {
      const s = m.sessions.get(w.id);
      if (s instanceof AgentSession) s.cfg.permissionMode = 'auto';
      store.log(w.id, 'user', t('log.planApproved'));
      if (task) {
        task.planApproved = true;
        m.summaryAsked.delete(task.id);
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
    decided(m, w, task, prev);
  }
}

/**
 * A plan-first turn ended with no approved plan, so the task stays open. When background subagents are still running,
 * the session goes on by itself once they report. Otherwise the Worker is reminded once to present its plan;
 * after that the task waits for the user or the Dispatcher, who are told.
 */
export function awaitPlan(m: WorkerManager, w: Worker, task: Task, text: string, background: boolean) {
  task.updatedAt = nowIso();
  if (background) return store.changed();
  const s = m.sessions.get(w.id);
  if (s && !s.closed && !m.planNudged.has(task.id)) {
    m.planNudged.add(task.id);
    store.log(w.id, 'event', t('log.planNudge'));
    s.send(planNudge(task));
    return m.touch(w);
  }
  store.chat('event', t('ev.planMissing', { id: w.id, title: task.title }), task.id);
  store.pushUpdate(`${w.id} ${task.id} "${task.title}" is still planning: its turn ended without a plan to approve ("${oneLine(text, 160)}"). The task stays open; send_to_worker if it needs instructions.`, true);
  store.changed();
}

/**
 * set_steps and step_done: the planned steps of the Worker's open task. A finished step reaches the Dispatcher as
 * an update for its next turn, not a turn of its own; a newer one for the same task takes the older one's place.
 */
export function steps(m: WorkerManager, w: Worker, op: StepsOp): string {
  const task = m.currentTask(w);
  if (!task) return 'No task in progress: steps belong to a task.';
  const before = stepView(task);
  const err = op.kind === 'set' ? setSteps(task, op.steps) : markDone(task, op.step, nowIso());
  if (err) return err;
  m.stepless.delete(task.id);
  const steps = task.steps!;
  const v = stepView(task)!;
  if (op.kind === 'set') {
    store.log(w.id, 'event', t('log.steps', { list: steps.map((s, i) => `${i + 1}. ${s.title}`).join(', ') }), task.id);
  } else if (v.done !== before?.done) {
    const n = Number(op.step);
    store.log(w.id, 'event', t('log.stepDone', { n, done: v.done, total: v.total, title: steps[n - 1].title }), task.id);
    const prefix = `${w.id} (${task.id}) progress:`;
    mergeProgress(store.data.pendingUpdates, prefix, `${prefix} ${progressNote(steps, n)}`);
  }
  store.changed();
  return `${op.kind === 'set' ? `${steps.length} steps set. ` : ''}${stepsLine(steps)}`;
}
