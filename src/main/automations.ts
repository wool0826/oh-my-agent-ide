import { store } from './store';
import { log } from './log';
import { nowIso, uid } from './util';
import { t } from './i18n';
import { autoTitle, automationMessage, editedAutomation, isDue, nextRun, parseTime } from '../shared/automations';
import type { Automation, AutoTrigger, Task } from '../shared/types';

/**
 * Automations hand the Dispatcher a message by themselves: every day at a time, or when a PR is merged.
 * The message goes in like one the user typed, so tasks are made, routed and queued the way they always are.
 * A daily one whose time passed while the app was closed runs once at the next start.
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

  add(input: { prompt: string; title?: string; trigger: AutoTrigger }): Automation {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error(t('auto.err.empty'));
    const trigger = normalize(input.trigger);
    const a: Automation = {
      id: uid(), title: input.title?.trim() || autoTitle(prompt), prompt, trigger, enabled: true,
      lastRunAt: null, nextRunAt: nextRun(trigger, new Date())?.toISOString() ?? null, createdAt: nowIso(),
    };
    this.list().push(a);
    store.changed();
    return a;
  }

  /** Change what an automation asks for or when it runs (shared/automations.ts, editedAutomation). */
  update(id: string, input: { prompt: string; trigger: AutoTrigger }): Automation {
    const list = this.list();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(t('err.noItem'));
    if (!input.prompt?.trim()) throw new Error(t('auto.err.empty'));
    Object.assign(list[i], editedAutomation(list[i], input.prompt, normalize(input.trigger), new Date()));
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

  /** A task's PR was merged: every automation waiting for that fires, told which PR it was. */
  onMerged(task: Pick<Task, 'title' | 'prUrl' | 'repo'>) {
    for (const a of this.list()) {
      if (!a.enabled || a.trigger.kind !== 'merged') continue;
      this.fire(a, `PR ${task.prUrl ?? ''} ("${task.title}"${task.repo ? `, repository ${task.repo}` : ''}) was merged.`);
    }
  }

  private tick() {
    const now = new Date();
    for (const a of this.list()) if (isDue(a, now)) this.fire(a);
  }

  private fire(a: Automation, context = '') {
    a.lastRunAt = nowIso();
    a.nextRunAt = nextRun(a.trigger, new Date())?.toISOString() ?? null;
    log.info('automation fired', a.title);
    store.changed();
    try {
      const id = this.send(automationMessage(a, context));
      if (id) { a.lastRunChatId = id; store.changed(); }
    } catch (e) { log.warn('automation failed to send', (e as Error).message); }
  }
}

function normalize(trigger: AutoTrigger): AutoTrigger {
  if (trigger.kind === 'merged') return { kind: 'merged' };
  const time = parseTime(trigger.time);
  if (!time) throw new Error(t('auto.badTime'));
  return { kind: 'daily', time, weekdays: !!trigger.weekdays };
}

export const automations = new Automations();
