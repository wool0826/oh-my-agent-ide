// The built-in sounds as notes the renderer plays with Web Audio (decision 41), and which of them each alert can use.
// A decision and a task's end sound different by default (decision 152): a rising chime asks, a falling pair reports.
import type { SoundName } from './types';

/** One note: its pitch (Hz), when it starts and how long it rings (s), its loudness (0..1 of the volume) and wave. */
export interface Note { freq: number; at: number; dur: number; gain: number; wave?: 'sine' | 'triangle' }

export const NOTES: Record<'chime' | 'bell' | 'ping' | 'soft', Note[]> = {
  chime: [{ freq: 880, at: 0, dur: 0.5, gain: 1 }, { freq: 1318.5, at: 0.16, dur: 0.7, gain: 1 }],
  bell: [{ freq: 660, at: 0, dur: 1.4, gain: 1, wave: 'triangle' }, { freq: 1320, at: 0, dur: 0.9, gain: 0.35 }, { freq: 1980, at: 0, dur: 0.5, gain: 0.15 }],
  ping: [{ freq: 1568, at: 0, dur: 0.35, gain: 1 }],
  soft: [{ freq: 784, at: 0, dur: 0.35, gain: 0.8 }, { freq: 587.33, at: 0.13, dur: 0.6, gain: 0.8 }],
};

/** What a decision may sound like ("custom" is the chosen file). */
export const DECISION_SOUNDS: SoundName[] = ['chime', 'bell', 'ping', 'custom', 'none'];
/** What a task's end may sound like; "none" keeps it silent. */
export const DONE_SOUNDS: SoundName[] = ['soft', 'chime', 'bell', 'ping', 'none'];
export const DONE_SOUND_DEFAULT: SoundName = 'soft';

/** A stored task-end sound, or the default when it is not one of them. */
export function cleanDoneSound(v: unknown): SoundName {
  return DONE_SOUNDS.includes(v as SoundName) ? (v as SoundName) : DONE_SOUND_DEFAULT;
}
