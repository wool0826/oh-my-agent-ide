// What the app needs on this computer before a task can succeed, checked at launch and shown in Settings (decision 131).

export type CheckId = 'git' | 'gh' | 'ghAuth' | 'account' | 'codex' | 'home';

export interface Check {
  id: CheckId;
  /** ghAuth only: the host that is, or is not, signed in. */
  host?: string;
  ok: boolean;
  /** What was found (a version, the folder), or what is wrong, in the tool's own words. */
  detail: string;
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

/** The command that fixes a failed check, when one command does. */
export function fixCommand(c: Pick<Check, 'id' | 'host'>): string | null {
  if (c.id === 'ghAuth') return `gh auth login --hostname ${c.host ?? 'github.com'}`;
  if (c.id === 'codex') return 'codex login';
  return null;
}

/** Failed checks first, in the order they are run; the rest after. */
export function failedFirst(checks: readonly Check[]): Check[] {
  return [...checks.filter((c) => !c.ok), ...checks.filter((c) => c.ok)];
}

export const failedCount = (checks: readonly Check[]) => checks.filter((c) => !c.ok).length;
