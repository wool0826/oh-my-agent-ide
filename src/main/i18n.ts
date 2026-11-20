import { loadSettings } from './settings';
import { tr, type Key } from '../shared/i18n';

/** Translate with the language chosen in settings. */
export function t(key: Key, vars?: Record<string, string | number>) {
  return tr(loadSettings().language, key, vars);
}

/** Name of the UI language, for telling agents which language to write in. */
export function langName() {
  return loadSettings().language === 'ko' ? 'Korean' : 'English';
}
