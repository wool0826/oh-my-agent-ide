// "Sleep when done": the user arms it once, and the computer sleeps after a short countdown once no work is left.
// The arm lives in memory only (off on every start) and disarms itself on sleep or cancel. Main wires it to the
// store, the Dispatcher and the OS call (src/main/sleep.ts).
import { WORKING } from './awake';
import type { PrChecks, TaskStatus } from './types';

/** Seconds between the last work ending and the sleep, with the countdown shown and cancelable. */
export const SLEEP_SECONDS = 60;

/** Task states that are still going: in a turn, waiting for an answer, in the queue (a slot or a usage limit) or behind another PR. */
const OPEN_TASK = new Set<TaskStatus>(['running', 'waiting', 'queued', 'blocked']);

export interface SleepInput {
  tasks: { id: string; status: TaskStatus; prState?: 'OPEN' | 'MERGED' | 'CLOSED' | null; prChecks?: PrChecks | null; waitingOn?: 'dispatcher' | null }[];
  workers: { id: string; status: string }[];
  decisions: { id: string; status: string }[];
  mergeQueue: { taskId: string }[];
  dispatcherBusy: boolean;
  /** Worker news waits for a Dispatcher turn of its own (a report not yet handled, or held by a usage limit). */
  dispatcherDue?: boolean;
  /** The user's shell runs still going whose result goes to the Dispatcher. */
  shellAsking: number;
}

/**
 * What still holds the sleep, as a short reason for the log, or null when nothing does. Failed, stopped, cancelled
 * and done tasks never hold it. An open PR holds it while its checks run or are not known yet, or while it waits on
 * the Dispatcher; one that only waits for a person's review or merge does not, or it would hold the sleep forever.
 */
export function busyReason(s: SleepInput): string | null {
  if (s.dispatcherBusy) return 'Dispatcher in a turn';
  if (s.dispatcherDue) return 'news waiting for a Dispatcher turn';
  const d = s.decisions.find((x) => x.status === 'pending');
  if (d) return `decision ${d.id} pending`;
  for (const t of s.tasks) {
    if (OPEN_TASK.has(t.status)) return `${t.id} ${t.status}`;
    if (t.status !== 'pr_open' || t.prState === 'MERGED' || t.prState === 'CLOSED') continue;
    if (t.waitingOn === 'dispatcher') return `${t.id} waits on the Dispatcher`;
    if (!t.prChecks || t.prChecks.ci === 'pending') return `${t.id} CI pending`;
  }
  const q = s.mergeQueue[0];
  if (q) return `${q.taskId} in the merge queue`;
  const w = s.workers.find((x) => WORKING.has(x.status));
  if (w) return `${w.id} ${w.status}`;
  if (s.shellAsking > 0) return 'shell run';
  return null;
}

export interface SleepView {
  armed: boolean;
  /** When the countdown ends (ms since the epoch), or null while work holds it or it is not armed. */
  until: number | null;
}

export interface SleepDeps {
  /** Puts the computer to sleep. */
  sleep(): void;
  /** Lets go of what keeps the computer awake (shared/awake.ts); called just before `sleep`. */
  release(): void;
  log(msg: string): void;
  /** The countdown began. */
  notify?(): void;
  seconds?: number;
}

/**
 * The arm and its countdown. `sync` is called whenever the work changes and once a second during a countdown;
 * it returns true when the view changed. New work stops a countdown but keeps the arm, and a fresh countdown
 * starts once that work is done.
 */
export function sleepArm(deps: SleepDeps) {
  const span = (deps.seconds ?? SLEEP_SECONDS) * 1000;
  let armed = false;
  let until: number | null = null;
  const sync = (s: SleepInput, now: number): boolean => {
    if (!armed) return false;
    const why = busyReason(s);
    if (why) {
      if (until === null) return false;
      until = null;
      deps.log(`countdown stopped: ${why}`);
      return true;
    }
    if (until === null) {
      until = now + span;
      deps.log(`countdown started (${span / 1000} s), no work left`);
      deps.notify?.();
      return true;
    }
    if (now < until) return false;
    armed = false;
    until = null;
    deps.log('sleeping: all work finished');
    deps.release();
    deps.sleep();
    return true;
  };
  return {
    arm(by: string, s: SleepInput, now: number): boolean {
      if (armed) return false;
      armed = true;
      deps.log(`armed by ${by}${busyReason(s) ? `, waiting for: ${busyReason(s)}` : ''}`);
      sync(s, now);
      return true;
    },
    disarm(by: string): boolean {
      if (!armed) return false;
      armed = false;
      until = null;
      deps.log(`disarmed by ${by}`);
      return true;
    },
    sync,
    view(): SleepView { return { armed, until }; },
  };
}

/** What is left of a countdown as "m:ss", never below 0:00. */
export function countdownText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The OS command that puts the computer to sleep (not hibernate) on each platform. */
export function sleepCommand(platform: string): { file: string; args: string[] } | null {
  // rundll32 powrprof.dll,SetSuspendState passes junk arguments and hibernates when hibernation is on, so the
  // API is called directly with bHibernate = false: sleep on any computer, without turning hibernation off.
  if (platform === 'win32') {
    const ps = "Add-Type -Namespace OMA -Name Power -MemberDefinition '[DllImport(\"powrprof.dll\")] public static extern bool SetSuspendState(bool h, bool f, bool d);'; [void][OMA.Power]::SetSuspendState($false, $false, $false)";
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', ps] };
  }
  if (platform === 'darwin') return { file: 'pmset', args: ['sleepnow'] };
  if (platform === 'linux') return { file: 'systemctl', args: ['suspend'] };
  return null;
}
