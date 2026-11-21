import { loadSettings } from './settings';
import { tr, type Key } from '../shared/i18n';

/** Translate with the language chosen in settings. */
export function t(key: Key, vars?: Record<string, string | number>) {
  return tr(loadSettings().language, key, vars);
}

/** A time for chat and log lines in the UI language: the time today, else the date and time. */
export function whenText(ms: number) {
  const loc = loadSettings().language === 'ko' ? 'ko-KR' : 'en-US';
  const d = new Date(ms);
  const time = d.toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(loc, { month: 'short', day: 'numeric' })} ${time}`;
}

/** When the usage limit holding every account resets, for messages. */
export function limitResetText(at: number | null) {
  return whenText(at ?? Date.now() + 30 * 60_000);
}

/** Name of the UI language, for telling agents which language to write in. */
export function langName() {
  return loadSettings().language === 'ko' ? 'Korean' : 'English';
}
