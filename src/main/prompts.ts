import { store } from './store';
import { t } from './i18n';
import { nowIso, uid } from './util';
import { cleanPrompt, type PromptInput } from '../shared/prompts';
import type { SavedPrompt } from '../shared/types';

/** Saved prompts (shared/prompts.ts), kept with the rest of the state. `id`: the one being changed, left out of the taken commands. */
function clean(input: Partial<PromptInput>, id?: string) {
  const others = (store.data.prompts ?? []).filter((p) => p.id !== id);
  const r = cleanPrompt(input ?? {}, others);
  if (!r.ok) throw new Error(t(r.error));
  // A repository removed since the prompt was saved does not keep the user from changing its name or text.
  const kept = id && store.data.prompts?.find((p) => p.id === id)?.repo === r.value.repo;
  if (r.value.repo && !kept && !store.repo(r.value.repo)) throw new Error(t('shell.err.noRepo', { name: r.value.repo }));
  return r.value;
}

export function addPrompt(input: Partial<PromptInput>): string {
  const v = clean(input);
  const at = nowIso();
  const p: SavedPrompt = { id: uid(), ...v, createdAt: at, updatedAt: at };
  (store.data.prompts ??= []).push(p);
  store.changed();
  return p.id;
}

export function updatePrompt(id: string, input: Partial<PromptInput>) {
  const p = store.data.prompts?.find((x) => x.id === id);
  if (!p) throw new Error(t('prompt.err.gone'));
  const v = clean(input, id);
  const same = (Object.keys(v) as (keyof PromptInput)[]).every((k) => v[k] === p[k]);
  if (!same) Object.assign(p, v, { updatedAt: nowIso() });
  store.changed();
}

export function removePrompt(id: string) {
  if (!store.data.prompts?.some((x) => x.id === id)) return;
  store.data.prompts = store.data.prompts.filter((x) => x.id !== id);
  store.changed();
}
