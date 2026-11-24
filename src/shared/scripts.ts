// Saved shell scripts (T-0063): a named command the user keeps in the right sidebar and runs with its Run button. A
// run is the same as a "!" line from the chat (main/shell.ts): it runs as the user, in the IDE home or a registered
// repository, its block is in the chat and its end goes to the Dispatcher. Nothing runs one but that button.

import type { ShellScript } from './types';

export const SCRIPT_NAME_MAX = 60;
/** A script is a few lines, not a program kept in the IDE. */
export const SCRIPT_CMD_MAX = 4000;

export interface ScriptInput { name: string; cmd: string; repo: string }

/**
 * What is stored for the user's fields: the name on one line, the command with its line ends normalized and no
 * blank lines around it, and the folder ('' for the IDE home). An error key when the name or the command is empty.
 */
export function cleanScript(input: Partial<Record<keyof ScriptInput, unknown>>): { ok: true; value: ScriptInput } | { ok: false; error: 'script.err.name' | 'script.err.cmd' } {
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, SCRIPT_NAME_MAX);
  const cmd = String(input.cmd ?? '').replace(/\r\n?/g, '\n').replace(/^\s*\n|\s+$/g, '').slice(0, SCRIPT_CMD_MAX);
  const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
  if (!name) return { ok: false, error: 'script.err.name' };
  if (!cmd.trim()) return { ok: false, error: 'script.err.cmd' };
  return { ok: true, value: { name, cmd, repo } };
}

/** The sidebar lists them by name, as the user finds them. */
export function sortScripts(list: readonly ShellScript[]): ShellScript[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.createdAt.localeCompare(b.createdAt));
}
