// UI text in English (default) and Korean. Shared by the main process and the renderer.
// Placeholders look like {name}. The strings live by area in ./i18n/: add a string beside the keys of its screen or
// group there, in both `en` and `ko`.

import type { Lang } from './types';
import * as common from './i18n/common';
import * as sidebar from './i18n/sidebar';
import * as chat from './i18n/chat';
import * as inspector from './i18n/inspector';
import * as workers from './i18n/workers';
import * as repos from './i18n/repos';
import * as memory from './i18n/memory';
import * as settings from './i18n/settings';

/** Each area's dictionaries. A key belongs to one area only (test/i18n.test.ts checks it). */
export const areas = { common, sidebar, chat, inspector, workers, repos, memory, settings };

const en = { ...common.en, ...sidebar.en, ...chat.en, ...inspector.en, ...workers.en, ...repos.en, ...memory.en, ...settings.en };

export type Key = keyof typeof en;

const ko: Record<Key, string> = { ...common.ko, ...sidebar.ko, ...chat.ko, ...inspector.ko, ...workers.ko, ...repos.ko, ...memory.ko, ...settings.ko };

const dicts: Record<Lang, Record<Key, string>> = { en, ko };

export function tr(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  const s = dicts[lang]?.[key] ?? en[key] ?? key;
  if (!vars) return s;
  // `{n}` is a value; `{n|task|tasks}` is the first word when that value is 1 and the second otherwise.
  return s.replace(/\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g, (m, k, one, many) => (!(k in vars) ? m : one === undefined ? String(vars[k]) : Number(vars[k]) === 1 ? one : many));
}
