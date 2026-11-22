// What the app needs on this computer before a task can succeed, checked at launch and shown in Settings (decision 131).

export type CheckId = 'git' | 'gh' | 'ghAuth' | 'account' | 'codex' | 'home';

export interface Check {
  id: CheckId;
  /** ghAuth only: the host that is, or is not, signed in. */
  host?: string;
  ok: boolean;
  /** What was found (a version, the folder), or what is wrong, in the tool's own words. */
  detail: string;
  /** The program itself was not found, as opposed to found but failing (not signed in, broken install). */
  missing?: boolean;
  /** The command that fixes it on this computer's OS, when one does (set by the main process). */
  cmd?: string;
}

export interface PreflightPlan {
  /** GitHub hosts whose sign-in is checked: github.com, and the company host when one is set. */
  hosts: string[];
  /** A ChatGPT account or model is in use, so the Codex CLI is needed. */
  codex: boolean;
  /** Agents run on real accounts (false in fake agent mode). */
  account: boolean;
}

/** Which checks apply, from the settings in use. */
export function preflightPlan(s: { githubHost: string; models: readonly string[]; providers: readonly string[]; fake: boolean }): PreflightPlan {
  const company = s.githubHost.trim().toLowerCase();
  const hosts = ['github.com', ...(company && company !== 'github.com' ? [company] : [])];
  const codex = !s.fake && (s.providers.includes('chatgpt') || s.models.some((m) => !!m && !/^claude/i.test(m)));
  return { hosts, codex, account: !s.fake };
}

const INSTALL: Partial<Record<CheckId, Partial<Record<string, string>>>> = {
  git: { darwin: 'xcode-select --install', win32: 'winget install --id Git.Git -e' },
  gh: { darwin: 'brew install gh', win32: 'winget install --id GitHub.cli -e' },
  codex: { darwin: 'npm install -g @openai/codex', win32: 'npm install -g @openai/codex', linux: 'npm install -g @openai/codex' },
};

/** The command that fixes a failed check on `platform`, when one command does: an install command for a missing tool, a sign-in otherwise. */
export function fixCommand(c: Pick<Check, 'id' | 'host' | 'missing'>, platform = ''): string | null {
  if (c.missing) return INSTALL[c.id]?.[platform] ?? null;
  if (c.id === 'ghAuth') return `gh auth login --hostname ${c.host ?? 'github.com'}`;
  if (c.id === 'codex') return 'codex login';
  return null;
}

export interface ToolRun { code: number; stdout: string; stderr: string; missing?: boolean }

const firstLine = (s: string) => s.trim().split('\n')[0]?.trim() ?? '';

/** A `<tool> --version` result as a check. A missing tool names the PATH that was searched. */
export function toolCheck(id: CheckId, r: ToolRun, searched: string): Check {
  if (r.code === 0) return { id, ok: true, detail: firstLine(r.stdout) };
  if (r.missing) return { id, ok: false, missing: true, detail: `not found in PATH: ${searched}` };
  return { id, ok: false, detail: firstLine(r.stderr || r.stdout) };
}

/**
 * gh: is it there (`gh --version`), then is it signed in on each host (`gh auth status`).
 * Without gh there is no sign-in to look at, so one failure says it, not three.
 */
export async function ghChecks(exec: (args: string[], host?: string) => Promise<ToolRun>, hosts: readonly string[], searched: string): Promise<Check[]> {
  const gh = toolCheck('gh', await exec(['--version']), searched);
  if (!gh.ok) return [gh];
  const out: Check[] = [gh];
  for (const host of hosts) {
    const r = await exec(['auth', 'status', '--hostname', host], host);
    out.push({ id: 'ghAuth', host, ok: r.code === 0, detail: r.code === 0 ? host : firstLine(r.stderr || r.stdout) });
  }
  return out;
}

/** Failed checks first, in the order they are run; the rest after. */
export function failedFirst(checks: readonly Check[]): Check[] {
  return [...checks.filter((c) => !c.ok), ...checks.filter((c) => c.ok)];
}

export const failedCount = (checks: readonly Check[]) => checks.filter((c) => !c.ok).length;
