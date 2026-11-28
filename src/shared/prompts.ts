// Saved prompts (decision 6A): a named text the user keeps in the Memos tab and puts into a composer with "/" and its
// command at the start of a line. A prompt may carry a preset (a repository, a model, plan first) that rides with the
// next message to the Dispatcher as chips over the text, and that main applies to the tasks that message creates.

import type { PromptPreset, SavedPrompt } from './types';

export const PROMPT_NAME_MAX = 60;
export const PROMPT_CMD_MAX = 32;
export const PROMPT_TEXT_MAX = 8000;

/** The commands the "/" list always has; a saved prompt cannot take their names. */
export const BUILTIN_COMMANDS = ['compact', 'new'] as const;
export type BuiltinCommand = (typeof BUILTIN_COMMANDS)[number];

export interface PromptInput { name: string; cmd: string; text: string; repo: string; model: string; planFirst: boolean }
export type PromptError = 'prompt.err.name' | 'prompt.err.cmd' | 'prompt.err.text' | 'prompt.err.taken';

/** A command as stored: without its "/", lower case, spaces as "-", letters, digits, "-" and "_" only. */
export function promptCmd(raw: string): string {
  return raw.trim().replace(/^\/+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, PROMPT_CMD_MAX);
}

/**
 * What is stored for the user's fields, or the key of what is wrong: no name, no command, no text, or a command a
 * built-in or another prompt (`others`, the one being changed left out) already has.
 */
export function cleanPrompt(input: Partial<Record<keyof PromptInput, unknown>>, others: readonly SavedPrompt[] = []): { ok: true; value: PromptInput } | { ok: false; error: PromptError } {
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, PROMPT_NAME_MAX);
  const cmd = promptCmd(String(input.cmd ?? ''));
  const text = String(input.text ?? '').replace(/\r\n?/g, '\n').replace(/^\s*\n|\s+$/g, '').slice(0, PROMPT_TEXT_MAX);
  if (!name) return { ok: false, error: 'prompt.err.name' };
  if (!cmd) return { ok: false, error: 'prompt.err.cmd' };
  if (!text.trim()) return { ok: false, error: 'prompt.err.text' };
  if ((BUILTIN_COMMANDS as readonly string[]).includes(cmd) || others.some((p) => p.cmd === cmd)) return { ok: false, error: 'prompt.err.taken' };
  const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  return { ok: true, value: { name, cmd, text, repo, model, planFirst: input.planFirst === true } };
}

/**
 * The "/" being typed at the caret: only at the start of a line, and only while what follows it has no space.
 * `start` is where the "/" is, `query` what follows it up to the caret.
 */
export function slashAt(value: string, caret: number): { start: number; query: string } | null {
  const start = value.lastIndexOf('\n', caret - 1) + 1;
  const m = /^\/([^\s/]*)$/.exec(value.slice(start, caret));
  return m ? { start, query: m[1] } : null;
}

/** The prompts for a query, in the order they were saved: those whose command starts with it, then the others that hold it. */
export function filterPrompts(list: readonly SavedPrompt[], query: string): SavedPrompt[] {
  const q = query.toLowerCase();
  if (!q) return [...list];
  const first = list.filter((p) => p.cmd.startsWith(q));
  const then = list.filter((p) => !p.cmd.startsWith(q) && (p.cmd.includes(q) || p.name.toLowerCase().includes(q)));
  return [...first, ...then];
}

/** The built-in commands whose name starts with the query. */
export function filterCommands(query: string): BuiltinCommand[] {
  const q = query.toLowerCase();
  return BUILTIN_COMMANDS.filter((c) => c.startsWith(q));
}

/** The composer's text once a prompt is put in place of the "/" being typed (`at`), and where the caret goes. */
export function insertPrompt(value: string, at: { start: number; query: string }, text: string): { value: string; caret: number } {
  const end = at.start + 1 + at.query.length;
  const next = value.slice(0, at.start) + text + value.slice(end);
  return { value: next, caret: at.start + text.length };
}

/** A prompt's preset, or null when it sets nothing. */
export function presetOf(p: Pick<PromptInput, 'repo' | 'model' | 'planFirst'>): PromptPreset | null {
  const preset = { repo: p.repo ?? '', model: p.model ?? '', planFirst: !!p.planFirst };
  return presetEmpty(preset) ? null : preset;
}

export const presetEmpty = (p: PromptPreset | null | undefined) => !p || (!p.repo && !p.model && !p.planFirst);

/** A preset sent from the window: only its known fields, a repository that is not registered left out. */
export function cleanPreset(raw: unknown, repoExists: (name: string) => boolean): PromptPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const repo = typeof r.repo === 'string' && repoExists(r.repo) ? r.repo : '';
  const model = typeof r.model === 'string' ? r.model.trim().slice(0, 100) : '';
  return presetOf({ repo, model, planFirst: r.planFirst === true });
}

/** The line the Dispatcher hears after the message, so it knows what the chips over the user's text set. */
export function presetNote(p: PromptPreset, modelName: string): string {
  const parts = [
    p.repo ? `repository ${p.repo}` : '',
    p.model ? `model ${modelName}` : '',
    p.planFirst ? 'plan first' : '',
  ].filter(Boolean);
  return `[Preset for the tasks of this message: ${parts.join('; ')}. The app applies it to create_task.]`;
}

/** The arguments of a task the Dispatcher creates for a message with a preset: the preset's model and plan first, and its repository when none is given. */
export function applyPreset<A extends { repo?: string; model_id?: string; plan_first?: boolean }>(args: A, p: PromptPreset | null): A {
  if (!p) return args;
  return {
    ...args,
    ...(p.repo && !args.repo ? { repo: p.repo } : {}),
    ...(p.model ? { model_id: p.model } : {}),
    ...(p.planFirst ? { plan_first: true } : {}),
  };
}
