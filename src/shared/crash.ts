// What the app does after an error nothing caught and after its window's page dies (T-0098, decision 201), and the
// marker that tells the next start the last run did not end by quitting.

/** Two uncaught exceptions this close together mean the process is no longer in a state to trust. */
export const REPEAT_MS = 60_000;
/** A relaunch less than this after the last one would only crash again: the app quits instead. */
export const RELAUNCH_GUARD_MS = 5 * 60_000;
/** The window's page dying this many times within RENDERER_MS stops the reopening. */
export const RENDERER_LIMIT = 3;
export const RENDERER_MS = 60_000;

/** The argument a crash relaunch passes to the next run: when it happened, in ms. */
export const RELAUNCHED_ARG = '--relaunched-at=';

export type FaultKind = 'rejection' | 'exception';
export type FaultAction = 'continue' | 'relaunch' | 'quit';

const within = (times: number[], now: number, ms: number) => times.filter((t) => now - t >= 0 && now - t < ms).length;

/**
 * After an error nothing caught, the state is saved at once in every case; then:
 * - an unhandled rejection: keep running (one failed promise leaves the rest of the app as it was);
 * - an uncaught exception: keep running the first time; a second one within REPEAT_MS saves and relaunches;
 * - a repeat that comes less than RELAUNCH_GUARD_MS after a crash relaunch saves and quits, so a crash loop ends.
 * `earlier` holds the times of this run's earlier uncaught exceptions; `relaunchedAt` is when the last crash
 * relaunch happened (null when this run was not started by one).
 */
export function faultAction(kind: FaultKind, earlier: number[], now: number, relaunchedAt: number | null): FaultAction {
  if (kind === 'rejection') return 'continue';
  if (!within(earlier, now, REPEAT_MS)) return 'continue';
  if (relaunchedAt != null && now - relaunchedAt >= 0 && now - relaunchedAt < RELAUNCH_GUARD_MS) return 'quit';
  return 'relaunch';
}

/** After the window's page dies: load it again, or stop when it died RENDERER_LIMIT times within RENDERER_MS. */
export function rendererAction(earlier: number[], now: number): 'reload' | 'give-up' {
  return within(earlier, now, RENDERER_MS) + 1 >= RENDERER_LIMIT ? 'give-up' : 'reload';
}

/** Whether a page that went away died, rather than closed with its window or the app. */
export function rendererDied(reason: string, closing: boolean): boolean {
  return !closing && reason !== 'clean-exit';
}

/** When the crash relaunch that started this run happened, from the run's arguments. */
export function relaunchedAt(argv: string[]): number | null {
  const a = argv.find((x) => x.startsWith(RELAUNCHED_ARG));
  const n = a ? Number(a.slice(RELAUNCHED_ARG.length)) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The arguments for a crash relaunch: this run's own, with its relaunch time replaced by `now`. */
export function relaunchArgs(argv: string[], now: number): string[] {
  return [...argv.filter((x) => !x.startsWith(RELAUNCHED_ARG)), `${RELAUNCHED_ARG}${now}`];
}

/** The marker a run leaves while it runs and removes when it quits. */
export interface RunMarker {
  pid: number;
  startedAt: string;
  version: string;
  /** Set when the run saved and left after an uncaught exception. */
  crash?: { at: string; message: string };
}

export function markerText(m: RunMarker): string {
  return `${JSON.stringify(m, null, 2)}\n`;
}

/**
 * The run a marker found at start describes: null when there is none (the last run quit). A marker that cannot be
 * read still says the last run ended without quitting, so it reads as one with nothing known.
 */
export function previousRun(text: string | null): RunMarker | null {
  if (text == null) return null;
  try {
    const o = JSON.parse(text.replace(/^\uFEFF/, '')) as Partial<RunMarker>;
    if (o && typeof o === 'object') {
      return {
        pid: typeof o.pid === 'number' ? o.pid : 0,
        startedAt: typeof o.startedAt === 'string' ? o.startedAt : '',
        version: typeof o.version === 'string' ? o.version : '',
        ...(o.crash && typeof o.crash.message === 'string' ? { crash: { at: String(o.crash.at ?? ''), message: o.crash.message } } : {}),
      };
    }
  } catch { /* a marker cut off mid-write */ }
  return { pid: 0, startedAt: '', version: '' };
}

/** One entry of the crash log: the time, what kind of error, and its stack (or its text). */
export function crashEntry(kind: FaultKind | 'renderer' | 'child', what: unknown, now: Date): string {
  const body = what instanceof Error ? (what.stack ?? `${what.name}: ${what.message}`) : typeof what === 'string' ? what : safeJson(what);
  return `${now.toISOString()} ${kind} ${body}\n`;
}

function safeJson(v: unknown) {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

/** The first line of an error, for a dialog or the marker. */
export function faultMessage(what: unknown): string {
  const s = what instanceof Error ? `${what.name}: ${what.message}` : typeof what === 'string' ? what : safeJson(what);
  return s.split('\n')[0].slice(0, 300);
}
