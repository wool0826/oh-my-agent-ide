// Model names for display. The list itself comes from the API (main/models.ts).

import type { ModelInfo, Provider } from './types';

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * Short model name, e.g. "Opus 5.5": the API's display name without "Claude", else read from the id
 * (claude-opus-5-5, claude-sonnet-4-20250514, claude-3-5-haiku-20241022).
 */
export function modelLabel(id: string, models?: readonly ModelInfo[]): string {
  const m = models?.find((x) => x.id === id);
  if (m) return m.name.replace(/^Claude\s+/i, '');
  const a = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (a) return `${cap(a[1])} ${a[2]}${a[3] ? `.${a[3]}` : ''}`;
  const b = id.match(/^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/);
  if (b) return `${cap(b[3])} ${b[1]}${b[2] ? `.${b[2]}` : ''}`;
  return id;
}

/** Whose agent runs a model: Claude Code for Claude models, Codex (a ChatGPT account) for everything else. */
export function providerOf(model: string, models?: readonly ModelInfo[]): Provider {
  const known = models?.find((x) => x.id === model)?.provider;
  if (known) return known;
  return /^claude/i.test(model) ? 'claude' : 'chatgpt';
}

/** Newest first, by the API's creation date. */
export function sortModels(list: ModelInfo[]): ModelInfo[] {
  return [...list].sort((x, y) => y.created.localeCompare(x.created) || x.id.localeCompare(y.id));
}
