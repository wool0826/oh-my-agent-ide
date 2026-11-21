// Why a decision needs the user, in one or two short sentences: what is asked (who, which task, which action),
// then why it is not decided without them and what it risks. The decision card, the sidebar row and the
// OS notification all show it. Built from rules; the only agent-written parts are text the agents already
// produce: a Bash call's own description, the advisor's reason it did not answer, and the Dispatcher's `why`.

import type { Key } from './i18n';
import type { DecisionReason, Task } from './types';

/** Translate in the UI language: `t` in the main process, `tr` with a fixed language in tests. */
export type Say = (key: Key, vars?: Record<string, string | number>) => string;

type TaskRef = Pick<Task, 'id' | 'title'> & Partial<Pick<Task, 'kind' | 'repo'>>;

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** `T-0031 "Title"`, short enough for a notification. */
export function taskRef(task: Pick<Task, 'id' | 'title'>): string {
  return `${task.id} "${clip(task.title, 60)}"`;
}

/** The last two parts of a path, which say enough about which file it is. */
function shortPath(p: string) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/') || String(p);
}

function host(url: string) {
  try { return new URL(url).host || url; } catch { return clip(url, 60); }
}

/** What a tool call does, as a short phrase that fits "{who} wants to {action}". */
export function toolAction(say: Say, tool: string, input: any): string {
  const i = input ?? {};
  switch (tool) {
    case 'Bash': {
      const cmd = clip(String(i.command ?? ''), 80);
      // Claude Code's Bash tool takes the model's own one-line description of the command.
      const desc = typeof i.description === 'string' ? clip(i.description, 80) : '';
      return desc ? say('why.act.bashDesc', { cmd, desc }) : say('why.act.bash', { cmd });
    }
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
      return say('why.act.edit', { path: shortPath(i.file_path ?? i.notebook_path ?? '') });
    case 'Read': case 'Glob': case 'Grep':
      return say('why.act.read', { path: shortPath(i.file_path ?? i.path ?? i.pattern ?? '') });
    case 'WebFetch': return say('why.act.fetch', { host: host(String(i.url ?? '')) });
    case 'WebSearch': return say('why.act.search', { q: clip(String(i.query ?? ''), 60) });
  }
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return say('why.act.mcp', { tool: mcp[2], server: mcp[1] });
  return say('why.act.tool', { tool });
}

/** Risk sentence for each always-ask rule (src/main/agents/permissions.ts), by the rule's label key. */
const RISK: Partial<Record<Key, Key>> = {
  'ask.forcePush': 'risk.forcePush',
  'ask.pushMain': 'risk.pushMain',
  'ask.drop': 'risk.drop',
  'ask.delete': 'risk.delete',
  'ask.prodDb': 'risk.prodDb',
  'ask.k8s': 'risk.k8s',
  'ask.infra': 'risk.infra',
  'ask.deploy': 'risk.deploy',
  'ask.merge': 'risk.merge',
  'ask.repoDelete': 'risk.repoDelete',
  'ask.rmHome': 'risk.rmHome',
};

/**
 * A Worker's tool call that needs approval. In order of what explains it best: an always-ask rule (with its risk),
 * a path outside the Worker's folders, Claude Code's own reason, or auto mode being unsure.
 */
export function permissionReason(say: Say, a: {
  who: string; task: TaskRef | null; tool: string; input: unknown;
  rule?: Key | null; blockedPath?: string | null; decisionReason?: string | null;
}): DecisionReason {
  const action = toolAction(say, a.tool, a.input);
  const what = a.task ? say('why.permWhat', { who: a.who, action, task: taskRef(a.task) }) : say('why.permWhatNoTask', { who: a.who, action });
  const risk = a.rule ? RISK[a.rule] : undefined;
  let why: string;
  if (a.rule) why = say('why.rule', { rule: say(a.rule), risk: risk ? say(risk) : '' }).trim();
  else if (a.blockedPath) why = say('why.blocked', { path: shortPath(a.blockedPath) });
  else if (a.decisionReason?.trim()) why = say('why.auto', { reason: clip(a.decisionReason, 160) });
  else why = say('why.unsure');
  return { what, why };
}

/** A plan-first task's plan, waiting for approval before anything changes. */
export function planReason(say: Say, a: { who: string; task: TaskRef | null }): DecisionReason {
  const what = a.task ? say('why.planWhat', { who: a.who, task: taskRef(a.task) }) : say('why.planWhatNoTask', { who: a.who });
  const why = a.task?.kind === 'code' && a.task.repo ? say('why.planCode', { repo: a.task.repo }) : say('why.planOther');
  return { what, why };
}

/** A Worker's question the advisor did not answer; its reason, when it gave one, says why. */
export function questionReason(say: Say, a: { who: string; task: TaskRef | null; advisor?: string | null }): DecisionReason {
  const what = a.task ? say('why.questionWhat', { who: a.who, task: taskRef(a.task) }) : say('why.questionWhatNoTask', { who: a.who });
  const basis = a.advisor?.trim();
  return { what, why: basis ? say('why.questionAdvisor', { basis: clip(basis, 200) }) : say('why.questionNoMemory') };
}

/** A question the Dispatcher put in the inbox, with the reason it gave. */
export function dispatcherReason(say: Say, why?: string | null): DecisionReason {
  return { what: say('why.dispatcherWhat'), why: why?.trim() ? clip(why, 200) : say('why.dispatcherDefault') };
}

/** CI still fails after the automatic fixes: keep fixing or leave it to the user. */
export function ciReason(say: Say, a: { who: string; task: TaskRef; prNum: string; fixes: number; names: string }): DecisionReason {
  return {
    what: say('why.ciWhat', { num: a.prNum, task: taskRef(a.task), n: a.fixes, names: clip(a.names, 120) }),
    why: say('why.ci', { who: a.who }),
  };
}

/** Both sentences, for a notification or a tooltip. */
export function reasonText(r: DecisionReason): string {
  return `${r.what} ${r.why}`;
}
