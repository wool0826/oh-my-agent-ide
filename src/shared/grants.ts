// "Allow for this task": one yes covers the same kind of action until the task ends (decision 119).
// What counts as the same kind is decided here, narrowly, so a yes to one thing is never a yes to another.

import { readShell, shellOf } from './shellWords';

/** The always-ask rules, by their label key. Each can be switched off in Settings; order is the order shown. */
export const ASK_RULES = [
  'ask.forcePush', 'ask.pushMain', 'ask.merge', 'ask.drop', 'ask.delete', 'ask.prodDb',
  'ask.k8s', 'ask.infra', 'ask.deploy', 'ask.repoDelete', 'ask.apiDelete', 'ask.rmHome', 'ask.unread',
] as const;
export type AskRule = (typeof ASK_RULES)[number];

/** Keeps only known rule keys, so a hand-edited settings file cannot hold anything else. */
export function cleanAskOff(v: unknown): AskRule[] {
  return Array.isArray(v) ? ASK_RULES.filter((r) => v.includes(r)) : [];
}

export interface GrantScope {
  /** Two actions with the same key are the same kind. */
  key: string;
  /** What the yes covers, in a few words for the button's tooltip. */
  label: string;
}

/** Programs whose first argument is a subcommand: `git commit` and `git push` are different kinds. */
const SUBCOMMANDS = new Set(['git', 'gh', 'npm', 'pnpm', 'yarn', 'npx', 'docker', 'cargo', 'go', 'pip', 'pip3', 'dotnet', 'kubectl', 'helm', 'terraform', 'gradle', 'mvn', 'make', 'bun', 'deno', 'uv', 'poetry']);
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read']);

const dirOf = (p: string) => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '') || p;

/**
 * The kind of a tool call, or null when it cannot be named safely and so is asked about every time:
 * a shell line that chains commands, substitutes one, redirects, or hands its command to something else as text
 * (`bash -c`, `sudo`, `iex`, `Start-Process`), where the first word says little about what runs.
 * A shell command's kind is its program and subcommand as shellWords.ts reads them, in Bash and PowerShell alike:
 * `git -C repo status` and `& git.exe status` are both `git status`.
 */
export function grantScope(tool: string, input: unknown): GrantScope | null {
  const v = (input ?? {}) as Record<string, unknown>;
  // Every shell tool the same way: the command's leading words, never the whole tool.
  const shell = shellOf(tool);
  if (shell) {
    const c = readShell(String(v.command ?? ''), shell).single;
    if (!c || !/^[\w.+-]*[a-z][\w.+-]*$/i.test(c.name)) return null;
    const sub = SUBCOMMANDS.has(c.prog) && /^[a-z][\w:-]*$/i.test(c.args[0] ?? '') ? ` ${c.args[0]}` : '';
    const name = `${c.name}${sub}`;
    return { key: `${shell}:${name.toLowerCase()}`, label: name };
  }
  if (FILE_TOOLS.has(tool)) {
    const file = String(v.file_path ?? v.notebook_path ?? '');
    if (!file) return null;
    const dir = dirOf(file);
    return { key: `${tool}:${dir.toLowerCase()}`, label: `${tool} · ${dir}` };
  }
  const name = tool.replace(/^mcp__\w+?__/, '');
  return { key: `tool:${tool}`, label: name };
}

/** A kind of action allowed for a task, kept on the task so it outlasts a restart. */
export type Grant = GrantScope;

export function hasGrant(task: { grants?: Grant[] | null } | null, key: string): boolean {
  return !!task?.grants?.some((g) => g.key === key);
}

/** The task's grants with this one added; the same kind is kept once. */
export function withGrant(grants: readonly Grant[] | null | undefined, g: Grant): Grant[] {
  return [...(grants ?? []).filter((x) => x.key !== g.key), { key: g.key, label: g.label }];
}

export function withoutGrant(grants: readonly Grant[] | null | undefined, key: string): Grant[] {
  return (grants ?? []).filter((x) => x.key !== key);
}
