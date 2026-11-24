import { store } from './store';
import { shell } from './shell';
import { t } from './i18n';
import { loadSettings } from './settings';
import { nowIso, uid } from './util';
import { cleanScript, type ScriptInput } from '../shared/scripts';
import type { ShellScript } from '../shared/types';

/** Saved shell scripts (shared/scripts.ts), kept with the rest of the state. */
function clean(input: Partial<ScriptInput>) {
  const r = cleanScript(input ?? {});
  if (!r.ok) throw new Error(t(r.error));
  if (r.value.repo && !store.repo(r.value.repo)) throw new Error(t('shell.err.noRepo', { name: r.value.repo }));
  return r.value;
}

export function addScript(input: Partial<ScriptInput>): string {
  const v = clean(input);
  const at = nowIso();
  const s: ShellScript = { id: uid(), ...v, createdAt: at, updatedAt: at, lastRunAt: null };
  (store.data.scripts ??= []).push(s);
  store.changed();
  return s.id;
}

export function updateScript(id: string, input: Partial<ScriptInput>) {
  const s = store.data.scripts?.find((x) => x.id === id);
  if (!s) throw new Error(t('script.err.gone'));
  const v = clean(input);
  if (v.name !== s.name || v.cmd !== s.cmd || v.repo !== s.repo) Object.assign(s, v, { updatedAt: nowIso() });
  store.changed();
}

export function removeScript(id: string) {
  if (!store.data.scripts?.some((x) => x.id === id)) return;
  store.data.scripts = store.data.scripts.filter((x) => x.id !== id);
  store.changed();
}

/**
 * Runs a saved script as it is stored, never a command the window sends with it: what runs is what the card shows.
 * Returns the chat item of the run.
 */
export function runScript(id: string): string {
  const s = store.data.scripts?.find((x) => x.id === id);
  if (!s) throw new Error(t('script.err.gone'));
  const chatId = shell.run(s.cmd, s.repo || null, { script: s.name, ask: loadSettings().shellAsk });
  s.lastRunAt = nowIso();
  store.changed();
  return chatId;
}
