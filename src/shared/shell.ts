// A line run from the chat with "!" (T-0053 item 2): the user's own command, in their own shell, in the IDE home
// or a registered repository. The output shows in the chat, and when the run ends its end goes to the Dispatcher.
import { appendOutput } from './runOutput';
import type { ShellRun } from './types';

/** What the app keeps of a run's output while it runs: its end, cut at a line start. */
export const SHELL_MAX = 2_000_000;
/** Lines kept on the chat item, and handed to the Dispatcher. */
export const SHELL_KEEP = 200;
/** The most of the output the Dispatcher gets, in characters (its end). */
export const HANDOVER_MAX = 8000;
/** Lines shown while the block is folded. */
export const SHELL_FOLDED = 12;

/** The command in a composer line that starts with "!", or null for a message. */
export function shellCommand(text: string): string | null {
  return text.startsWith('!') ? text.slice(1).trim() : null;
}

/** The output with a chunk added: without terminal codes, its end kept to SHELL_MAX. */
export function addOutput(out: string, chunk: string, max = SHELL_MAX): string {
  return appendOutput(out, chunk, max);
}

/** The last `n` lines, without the trailing line break. */
export function tailLines(out: string, n = SHELL_KEEP): string {
  const lines = out.replace(/\n+$/, '').split('\n');
  return lines.slice(-n).join('\n');
}

/** How many lines the output has. */
export function lineCount(out: string): number {
  const s = out.replace(/\n+$/, '');
  return s ? s.split('\n').length : 0;
}

/** "12.4s", "2m 05s". */
export function shellTook(ms: number): string {
  if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** "0:07", "12:30": the time a run has taken so far. */
export function shellClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * What the Dispatcher is told when a run ends: the command, where, the exit code and time, then the end of the
 * output (its last lines, cut to HANDOVER_MAX characters from a line start).
 */
export function handOver(r: Pick<ShellRun, 'cmd' | 'repo' | 'code' | 'ms' | 'out' | 'lines'>, home = 'the IDE home'): string {
  let body = tailLines(r.out, SHELL_KEEP);
  if (body.length > HANDOVER_MAX) {
    const cut = body.slice(-HANDOVER_MAX);
    const nl = cut.indexOf('\n');
    body = nl >= 0 ? cut.slice(nl + 1) : cut;
  }
  const shown = lineCount(body);
  const head = `[Shell run] The user ran \`${r.cmd}\` in ${r.repo || home}: exit ${r.code ?? '?'}, ${shellTook(r.ms)}.`;
  if (!body) return `${head} No output.`;
  const note = shown < r.lines ? `Last ${shown} of ${r.lines} lines:` : 'Output:';
  return `${head} ${note}\n${body}`;
}
