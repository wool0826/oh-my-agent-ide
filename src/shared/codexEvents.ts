// What Codex (app-server) reports, turned into what the app shows and counts.
// Shapes follow the protocol Codex 0.167 generates with `codex app-server generate-ts`; only the fields used are typed.

import type { Shell } from './shellWords';
import type { Spend } from './spend';

export interface CodexItem {
  type: string;
  id?: string;
  text?: string;
  command?: string;
  changes?: { path: string; kind?: unknown }[];
  server?: string;
  tool?: string;
  query?: string;
}

export interface CodexUsage {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
}

export interface CodexRateWindow { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
export interface CodexRateLimits {
  primary?: CodexRateWindow | null;
  secondary?: CodexRateWindow | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

/**
 * The command as the model meant it: Codex reports it wrapped in the shell it starts
 * (`"…\powershell.exe" -Command 'git status'`, `bash -lc "git status"`).
 */
export function plainCommand(command: string): string {
  const m = /^"?[^"']*?(?:powershell|pwsh|bash|zsh|sh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?(?:-Command|-lc|-c)\s+(['"])([\s\S]*)\1$/i.exec(command.trim());
  return m ? m[2] : command.trim();
}

/** The shell that wrapper starts, so the command inside is read the way it will run (shellWords.ts). Bash when there is none. */
export function commandShell(command: string): Shell {
  return /^(?:"[^"]*(?:powershell|pwsh)(?:\.exe)?"|[^"'\s]*(?:powershell|pwsh)(?:\.exe)?)\s/i.test(command.trim()) ? 'powershell' : 'bash';
}

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** The tool line for an item Codex started, in the words the app uses for Claude's tools; null when it is not a tool. */
export function itemTool(item: CodexItem, max = 140): { name: string; summary: string } | null {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'Bash', summary: `$ ${plainCommand(String(item.command ?? '')).slice(0, max)}` };
    case 'fileChange': {
      const files = (item.changes ?? []).map((c) => base(c.path));
      const shown = files.slice(0, 3).join(', ');
      return { name: 'Edit', summary: `Edit ${shown}${files.length > 3 ? ` +${files.length - 3}` : ''}`.trim() };
    }
    case 'mcpToolCall':
      return { name: `${item.server ?? 'mcp'}.${item.tool ?? ''}`, summary: item.tool ?? '' };
    case 'dynamicToolCall':
      return { name: item.tool ?? 'tool', summary: item.tool ?? 'tool' };
    case 'webSearch':
      return { name: 'WebSearch', summary: `WebSearch ${String(item.query ?? '').slice(0, max)}`.trim() };
    default:
      return null;
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * A thread's running token totals as the app's Spend. Codex gives no price, so the cost stays 0.
 * Its input count includes the cached tokens; the app keeps them apart.
 */
export function usageSpend(total: CodexUsage | null | undefined): Spend {
  const cached = num(total?.cachedInputTokens);
  return {
    costUsd: 0,
    input: Math.max(0, num(total?.inputTokens) - cached),
    output: num(total?.outputTokens),
    cacheRead: cached,
    cacheWrite: num(total?.cacheWriteInputTokens),
  };
}

/** A turn that failed because the plan's allowance is used up (not a passing throttle, which Codex retries itself). */
export function isUsageLimit(info: unknown): boolean {
  return info === 'usageLimitExceeded' || info === 'sessionBudgetExceeded';
}

/** One usage window as the toolbar's rings read it. */
export interface UsageWindowView { utilization: number; minutes: number | null; resetsAt: string | null }

/**
 * The account's usage windows, shortest first. A plan reports one or two (a free plan: one 30-day window;
 * paid plans: a 5-hour one and a weekly one).
 */
export function limitWindows(rl: CodexRateLimits | null | undefined): UsageWindowView[] {
  return [rl?.primary, rl?.secondary]
    .filter((w): w is CodexRateWindow => !!w && typeof w.usedPercent === 'number')
    .map((w) => ({
      utilization: Math.max(0, Math.min(100, Math.round(w.usedPercent))),
      minutes: w.windowDurationMins ?? null,
      resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
    }))
    .sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
}
