import type { PrChecks, Task } from '../shared/types';

/**
 * PR checks from `gh pr view --json statusCheckRollup,mergeable,reviewDecision`:
 * merge readiness for the UI, and which failed CI runs to hand to the Worker.
 * No app state here, so tests can import it.
 */

/** One rollup entry: a check run (GitHub Actions or another app) or a commit status. */
export interface RollupItem {
  __typename?: string;
  name?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
  detailsUrl?: string;
  startedAt?: string;
  context?: string;
  state?: string;
  targetUrl?: string;
}

export interface Check {
  name: string;
  /** The same buckets as `gh pr checks`. */
  bucket: 'pass' | 'fail' | 'pending' | 'skip';
  /** A failure a code change may fix (not cancelled, not waiting for someone's approval). */
  fixable: boolean;
  url: string;
  /** The GitHub Actions run behind the check; null for external CI. */
  run: { repo: string; id: string } | null;
}

const FAIL = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'CANCELLED', 'ACTION_REQUIRED']);
const NOT_FIXABLE = new Set(['CANCELLED', 'ACTION_REQUIRED']);

/** The run in a GitHub Actions details URL, e.g. https://github.com/o/r/actions/runs/123/job/456. */
export function actionsRun(url: string) {
  const m = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/);
  return m ? { repo: `${m[1]}/${m[2]}/${m[3]}`, id: m[4] } : null;
}

const isStatus = (it: RollupItem) => (it.__typename ? it.__typename === 'StatusContext' : it.context != null);

export function parseChecks(rollup: RollupItem[] | null | undefined): Check[] {
  // A re-run leaves the older check run with the same name behind; keep the latest.
  const latest = new Map<string, RollupItem>();
  for (const it of rollup ?? []) {
    const key = isStatus(it) ? `s:${it.context}` : `c:${it.workflowName ?? ''}/${it.name ?? ''}`;
    const prev = latest.get(key);
    if (!prev || (it.startedAt ?? '') >= (prev.startedAt ?? '')) latest.set(key, it);
  }
  return [...latest.values()].map((it) => {
    const status = isStatus(it);
    const state = (status ? it.state : it.status === 'COMPLETED' ? it.conclusion : it.status) ?? '';
    const bucket = state === 'SUCCESS' ? 'pass' : state === 'SKIPPED' || state === 'NEUTRAL' ? 'skip' : FAIL.has(state) ? 'fail' : 'pending';
    const url = (status ? it.targetUrl : it.detailsUrl) ?? '';
    const name = status ? it.context || '?' : [it.workflowName, it.name].filter(Boolean).join(' / ') || '?';
    return { name, bucket, fixable: bucket === 'fail' && !NOT_FIXABLE.has(state), url, run: status ? null : actionsRun(url) };
  });
}

export function readiness(checks: Check[], mergeable?: string, reviewDecision?: string): PrChecks {
  const live = checks.filter((c) => c.bucket !== 'skip');
  const failed = live.filter((c) => c.bucket === 'fail');
  const ci = !live.length ? 'none' : failed.length ? 'failing' : live.some((c) => c.bucket === 'pending') ? 'pending' : 'passing';
  const review = reviewDecision === 'APPROVED' ? 'approved' : reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : reviewDecision === 'REVIEW_REQUIRED' ? 'required' : null;
  return { ci, failed: failed.map((c) => c.name), conflicts: mergeable === 'CONFLICTING', review };
}

/** What marks a failure as handled: the Actions run ID, or the external check on this commit. */
export function ciKey(c: Check, headSha: string) {
  return c.run ? `run:${c.run.id}` : `ext:${headSha.slice(0, 12)}:${c.name}`;
}

/**
 * Failed checks to hand to the Worker: not handled yet, and with their Actions run finished
 * (its failed log is readable only then). Other checks still running don't hold them back.
 */
export function checksToFix(checks: Check[], seen: string[], headSha: string): Check[] {
  const busyRuns = new Set(checks.filter((c) => c.bucket === 'pending' && c.run).map((c) => c.run!.id));
  return checks.filter((c) => c.fixable && !(c.run && busyRuns.has(c.run.id)) && !seen.includes(ciKey(c, headSha)));
}

/** Failed CI goes back to the Worker at most this many times per task; after that the user decides. */
export const MAX_CI_FIXES = 3;

/**
 * New failures to act on: send them to the Worker ("fix"), or ask the user once the task has used
 * its fixes ("ask"). Marks them handled on the task, so the same run never comes back.
 */
export function planCiFix(task: Pick<Task, 'seenCiRuns' | 'ciFixAttempts'>, checks: Check[], headSha: string) {
  const failed = checksToFix(checks, task.seenCiRuns ?? [], headSha);
  if (!failed.length) return null;
  task.seenCiRuns = [...new Set([...(task.seenCiRuns ?? []), ...failed.map((c) => ciKey(c, headSha))])].slice(-200);
  return { action: (task.ciFixAttempts ?? 0) >= MAX_CI_FIXES ? 'ask' as const : 'fix' as const, failed };
}

/** Each Actions run once. */
export function runsOf(checks: Check[]) {
  const runs = new Map<string, { repo: string; id: string }>();
  for (const c of checks) if (c.run) runs.set(c.run.id, c.run);
  return [...runs.values()];
}

/** The end of each failed job's log from `gh run view --log-failed`, without timestamps and color codes. */
export function failedLogTail(log: string, maxLines = 80, maxChars = 6000): string {
  const jobs = new Map<string, { step: string; text: string }[]>();
  for (const raw of log.split(/\r?\n/)) {
    const parts = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\ufeff/g, '').split('\t');
    const [job, step, text] = parts.length >= 3 ? [parts[0], parts[1], parts.slice(2).join('\t')] : ['', '', parts.join('\t')];
    const body = text.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/, '');
    if (!body.trim()) continue;
    if (!jobs.has(job)) jobs.set(job, []);
    // gh prints UNKNOWN STEP when it cannot match a line to a step.
    jobs.get(job)!.push({ step: step === 'UNKNOWN STEP' ? '' : step, text: body });
  }
  // Every failed job gets its share, so one long job doesn't push the others out.
  const perLines = Math.max(20, Math.floor(maxLines / Math.max(1, jobs.size)));
  const perChars = Math.floor(maxChars / Math.max(1, jobs.size));
  const out: string[] = [];
  for (const [job, lines] of jobs) {
    const part: string[] = [];
    let head = '';
    for (const l of lines.slice(-perLines)) {
      const h = [job, l.step].filter(Boolean).join(' / ');
      if (h && h !== head) part.push(`--- ${h} ---`);
      head = h;
      part.push(l.text);
    }
    let s = part.join('\n');
    if (s.length > perChars) {
      s = s.slice(-perChars);
      s = `${job ? `--- ${job} ---\n` : ''}…\n${s.slice(s.indexOf('\n') + 1)}`;
    }
    out.push(s);
  }
  return out.join('\n');
}

function fence(s: string) {
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}\n${s}\n${f}`;
}

/** The message body for the Worker: each failed check with its link, then the end of each Actions run's failed log. */
export function ciFixBody(failed: Check[], logs: Map<string, string | null>): string {
  const out = ['Failed checks:'];
  for (const c of failed) out.push(`- ${c.name}${c.run ? '' : ' (external CI: its log is not read here; open the link)'}: ${c.url || '(no link)'}`);
  for (const r of runsOf(failed)) {
    if (!logs.has(r.id)) continue;
    const tail = logs.get(r.id);
    const cmd = `\`gh run view ${r.id} -R ${r.repo} --log-failed\``;
    out.push('', tail ? `End of the failed log of run ${r.id} (full log: ${cmd}):` : `Could not read the failed log of run ${r.id}. Try ${cmd} or open the link.`);
    if (tail) out.push(fence(tail));
  }
  return out.join('\n');
}
