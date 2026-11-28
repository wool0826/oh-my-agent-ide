import { store } from './store';
import { log } from './log';
import { nowIso, uid } from './util';
import { t } from './i18n';
import { atLimit, autoTitle, automationMessage, clampPerDay, countRun, editedAutomation, eventContext, isDue, matchesEvent, nextRun, normalizeTrigger, type AutoEvent } from '../shared/automations';
import type { Automation, AutoTrigger, Task } from '../shared/types';

type Input = { prompt: string; title?: string; trigger: AutoTrigger; maxPerDay?: number | null };

/**
 * Automations hand the Dispatcher a message by themselves: on a schedule, or on a GitHub event (prmonitor.ts reads
 * them). The message goes in like one the user typed, so tasks are made, routed and queued the way they always are.
 * A scheduled one whose time passed while the app was closed runs once at the next start. One at its limit for the
 * day skips what sets it off until the next day.
 */
class Automations {
  private timer: NodeJS.Timeout | null = null;
  private send: (text: string) => string | void = () => undefined;

  list(): Automation[] {
    return (store.data.automations ??= []);
  }

  /** `send` hands a message to the Dispatcher and gives back its chat message's id. */
  start(send: (text: string) => string | void) {
    this.send = send;
    this.timer ??= setInterval(() => this.tick(), 30_000);
    setTimeout(() => this.tick(), 5_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  add(input: Input): Automation {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error(t('auto.err.empty'));
    const trigger = normalize(input.trigger);
    const a: Automation = {
      id: uid(), title: input.title?.trim() || autoTitle(prompt), prompt, trigger, enabled: true,
      lastRunAt: null, nextRunAt: nextRun(trigger, new Date())?.toISOString() ?? null, createdAt: nowIso(),
      maxPerDay: clampPerDay(input.maxPerDay),
    };
    this.list().push(a);
    store.changed();
    return a;
  }

  /** Change what an automation asks for, when it runs or its limit (shared/automations.ts, editedAutomation). */
  update(id: string, input: Input): Automation {
    const list = this.list();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(t('err.noItem'));
    if (!input.prompt?.trim()) throw new Error(t('auto.err.empty'));
    const max = input.maxPerDay === undefined ? list[i].maxPerDay ?? null : clampPerDay(input.maxPerDay);
    Object.assign(list[i], editedAutomation(list[i], input.prompt, normalize(input.trigger), new Date(), max));
    store.changed();
    return list[i];
  }

  setEnabled(id: string, enabled: boolean) {
    const a = this.list().find((x) => x.id === id);
    if (!a) return;
    a.enabled = enabled;
    // Switched back on: from now, not for the runs it missed while off.
    if (enabled) a.nextRunAt = nextRun(a.trigger, new Date())?.toISOString() ?? null;
    store.changed();
  }

  remove(id: string): boolean {
    const list = this.list();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    store.changed();
    return true;
  }

  /** "Run now" from its card: at once, on or off, and counted toward today's limit like any run. */
  runNow(id: string) {
    const a = this.list().find((x) => x.id === id);
    if (!a) throw new Error(t('err.noItem'));
    this.fire(a, '', new Date(), false);
  }

  /** A task's PR was merged: every automation waiting for that fires, told which PR it was. */
  onMerged(task: Pick<Task, 'title' | 'prUrl' | 'repo'>, base?: string) {
    const repo = task.repo ?? '';
    this.onEvent({ kind: 'merged', repo, id: task.prUrl ?? '', branch: base ?? store.repo(repo)?.defaultBranch, title: task.title, url: task.prUrl ?? undefined });
  }

  /** Something happened on GitHub: every automation switched on and waiting for it fires, under its limit. */
  onEvent(ev: AutoEvent, now = new Date()) {
    for (const a of this.list()) {
      if (!a.enabled || !matchesEvent(a.trigger, ev)) continue;
      if (atLimit(a, now)) { log.info('automation at its limit for today', a.title); continue; }
      this.fire(a, eventContext(ev), now);
    }
  }

  /** Fires what is due at `now` (the end-to-end tests pass a later time instead of waiting for it). */
  tick(now = new Date()) {
    for (const a of this.list()) {
      if (!isDue(a, now)) continue;
      if (atLimit(a, now)) {
        // Its time came at the limit: skipped, and the next one is worked out from now.
        a.nextRunAt = nextRun(a.trigger, now)?.toISOString() ?? null;
        store.changed();
        continue;
      }
      this.fire(a, '', now);
    }
  }

  private fire(a: Automation, context = '', now = new Date(), schedule = true) {
    a.lastRunAt = nowIso();
    a.runs = countRun(a, now);
    if (schedule) a.nextRunAt = nextRun(a.trigger, now)?.toISOString() ?? null;
    log.info('automation fired', a.title);
    store.changed();
    try {
      const id = this.send(automationMessage(a, context));
      if (id) { a.lastRunChatId = id; store.changed(); }
    } catch (e) { log.warn('automation failed to send', (e as Error).message); }
  }
}

function normalize(trigger: AutoTrigger): AutoTrigger {
  const n = normalizeTrigger(trigger ?? { kind: 'merged' });
  if ('error' in n) throw new Error(t(`auto.${n.error}`));
  return n;
}

export const automations = new Automations();
