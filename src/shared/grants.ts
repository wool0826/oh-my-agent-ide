// "Allow for this task": one yes covers the same kind of action until the task ends (decision 119).
// What counts as the same kind is decided here, narrowly, so a yes to one thing is never a yes to another.

/** The always-ask rules, by their label key. Each can be switched off in Settings; order is the order shown. */
export const ASK_RULES = [
  'ask.forcePush', 'ask.pushMain', 'ask.merge', 'ask.drop', 'ask.delete', 'ask.prodDb',
  'ask.k8s', 'ask.infra', 'ask.deploy', 'ask.repoDelete', 'ask.rmHome',
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
 * a shell line that chains commands, substitutes one, or redirects, where the first word says little about what runs.
 */
export function grantScope(tool: string, input: unknown): GrantScope | null {
  const v = (input ?? {}) as Record<string, unknown>;
  if (tool === 'Bash') {
    const cmd = String(v.command ?? '').trim();
    if (!cmd || /[;&|<>`\n]|\$\(/.test(cmd)) return null;
    const words = cmd.split(/\s+/);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    const prog = (words[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '');
    if (!/^[\w.+-]+$/.test(prog)) return null;
    const sub = SUBCOMMANDS.has(prog.toLowerCase()) && /^[a-z][\w:-]*$/i.test(words[1] ?? '') ? ` ${words[1]}` : '';
    const name = `${prog}${sub}`;
    return { key: `bash:${name.toLowerCase()}`, label: name };
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
