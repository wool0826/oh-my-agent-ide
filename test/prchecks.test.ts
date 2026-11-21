import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CI_FIXES, actionsRun, checksToFix, ciFixBody, ciKey, failedLogTail, parseChecks, planCiFix, readiness, type RollupItem } from '../src/main/prchecks';

const RUN = 'https://github.com/o/r/actions/runs';
const job = (name: string, conclusion: string, run: number, extra: Partial<RollupItem> = {}): RollupItem => ({
  __typename: 'CheckRun', name, workflowName: 'CI', status: 'COMPLETED', conclusion,
  detailsUrl: `${RUN}/${run}/job/${run * 10}`, startedAt: '2026-11-21T09:00:00Z', ...extra,
});
const status = (context: string, state: string, targetUrl = `https://ci.example.com/${context}`): RollupItem => ({
  __typename: 'StatusContext', context, state, targetUrl, startedAt: '2026-11-21T09:00:00Z',
});

test('prchecks: an Actions details URL gives its run; other URLs give none', () => {
  assert.deepEqual(actionsRun(`${RUN}/123/job/456`), { repo: 'github.com/o/r', id: '123' });
  assert.deepEqual(actionsRun('https://ghe.corp/team/app/actions/runs/9'), { repo: 'ghe.corp/team/app', id: '9' });
  assert.equal(actionsRun('https://app.circleci.com/pipelines/1'), null);
});

test('prchecks: check runs and commit statuses fall into gh buckets', () => {
  const checks = parseChecks([
    job('build', 'SUCCESS', 1),
    job('lint', 'SKIPPED', 1),
    job('test', 'FAILURE', 1),
    job('e2e', '', 2, { status: 'IN_PROGRESS' }),
    job('deploy', 'CANCELLED', 3),
    status('ci/circleci', 'ERROR'),
  ]);
  const by = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.equal(by['CI / build'].bucket, 'pass');
  assert.equal(by['CI / lint'].bucket, 'skip');
  assert.equal(by['CI / test'].bucket, 'fail');
  assert.equal(by['CI / test'].fixable, true);
  assert.deepEqual(by['CI / test'].run, { repo: 'github.com/o/r', id: '1' });
  assert.equal(by['CI / e2e'].bucket, 'pending');
  assert.equal(by['CI / deploy'].bucket, 'fail');
  assert.equal(by['CI / deploy'].fixable, false, 'a cancelled run is not something code fixes');
  assert.equal(by['ci/circleci'].bucket, 'fail');
  assert.equal(by['ci/circleci'].run, null);
  assert.equal(by['ci/circleci'].url, 'https://ci.example.com/ci/circleci');
});

test('prchecks: a re-run replaces the older check with the same name', () => {
  const checks = parseChecks([
    job('test', 'FAILURE', 1, { startedAt: '2026-11-21T09:00:00Z' }),
    job('test', 'SUCCESS', 2, { startedAt: '2026-11-21T09:30:00Z' }),
  ]);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].bucket, 'pass');
});

test('prchecks: readiness sums up CI, conflicts and review', () => {
  assert.deepEqual(readiness(parseChecks([]), 'MERGEABLE', ''), { ci: 'none', failed: [], conflicts: false, review: null });
  assert.equal(readiness(parseChecks([job('lint', 'SKIPPED', 1)])).ci, 'none');
  assert.equal(readiness(parseChecks([job('build', 'SUCCESS', 1)])).ci, 'passing');
  assert.equal(readiness(parseChecks([job('build', 'SUCCESS', 1), job('e2e', '', 2, { status: 'QUEUED' })])).ci, 'pending');
  const r = readiness(parseChecks([job('test', 'FAILURE', 1), job('e2e', '', 2, { status: 'QUEUED' })]), 'CONFLICTING', 'CHANGES_REQUESTED');
  assert.deepEqual(r, { ci: 'failing', failed: ['CI / test'], conflicts: true, review: 'changes' });
  assert.equal(readiness([], 'UNKNOWN', 'APPROVED').review, 'approved');
  assert.equal(readiness([], 'UNKNOWN', 'REVIEW_REQUIRED').review, 'required');
  assert.equal(readiness([], 'UNKNOWN', 'APPROVED').conflicts, false);
});

test('prchecks: a failure waits until its own run finishes, not for other checks', () => {
  const checks = parseChecks([
    job('test', 'FAILURE', 1),
    job('e2e', '', 1, { status: 'IN_PROGRESS' }),
    job('lint', 'FAILURE', 2),
    job('slow', '', 3, { status: 'IN_PROGRESS' }),
    status('ci/external', 'FAILURE'),
  ]);
  assert.deepEqual(checksToFix(checks, [], 'abc').map((c) => c.name), ['CI / lint', 'ci/external']);
});

test('prchecks: handled runs are keyed by run ID, external checks by commit', () => {
  const [a, ext] = parseChecks([job('test', 'FAILURE', 7), status('ci/external', 'FAILURE')]);
  assert.equal(ciKey(a, 'deadbeefdeadbeef00'), 'run:7');
  assert.equal(ciKey(ext, 'deadbeefdeadbeef00'), 'ext:deadbeefdead:ci/external');
  assert.deepEqual(checksToFix([a, ext], ['run:7', 'ext:deadbeefdead:ci/external'], 'deadbeefdeadbeef00'), []);
  assert.equal(checksToFix([ext], ['ext:deadbeefdead:ci/external'], 'cafebabecafebabe').length, 1, 'a new commit is a new failure');
});

test('prchecks: a run is handled once, and after the cap the user is asked', () => {
  const task: { seenCiRuns?: string[]; ciFixAttempts?: number } = {};
  const actions: string[] = [];
  for (let run = 1; run <= MAX_CI_FIXES + 2; run++) {
    const checks = parseChecks([job('test', 'FAILURE', run)]);
    const plan = planCiFix(task, checks, `sha${run}`);
    assert.ok(plan);
    actions.push(plan.action);
    if (plan.action === 'fix') task.ciFixAttempts = (task.ciFixAttempts ?? 0) + 1;
    assert.equal(planCiFix(task, checks, `sha${run}`), null, 'the same run never comes back');
  }
  assert.deepEqual(actions, [...Array(MAX_CI_FIXES).fill('fix'), 'ask', 'ask']);
  assert.deepEqual(task.seenCiRuns, ['run:1', 'run:2', 'run:3', 'run:4', 'run:5']);
});

test('prchecks: the failed log keeps the end of each job, without timestamps or colors', () => {
  const lines = [
    '﻿build\tSet up job\t2026-11-21T09:00:00.1234567Z Starting',
    ...Array.from({ length: 50 }, (_, i) => `build\tRun tests\t2026-11-21T09:00:01.0000000Z \x1b[31mline ${i}\x1b[0m`),
    'build\tRun tests\t2026-11-21T09:00:02.0000000Z ##[error]Process completed with exit code 1.',
    'lint\tRun eslint\t2026-11-21T09:00:03.0000000Z src/a.ts: error no-unused-vars',
    'lint\tRun eslint\t2026-11-21T09:00:03.0000000Z ',
  ].join('\r\n');
  const tail = failedLogTail(lines, 40);
  const out = tail.split('\n');
  assert.equal(out[0], '--- build / Run tests ---');
  assert.ok(!tail.includes('Starting'), 'the start of a long job is cut');
  assert.ok(tail.includes('line 49\n##[error]Process completed with exit code 1.'));
  assert.ok(!/\x1b|2026-11-21T/.test(tail));
  assert.ok(tail.endsWith('--- lint / Run eslint ---\nsrc/a.ts: error no-unused-vars'));
  assert.equal(out.filter((l) => l.startsWith('line ')).length, 19);
});

test('prchecks: a very long log keeps its last characters from a line start', () => {
  const log = Array.from({ length: 40 }, (_, i) => `j\ts\t${'x'.repeat(98)}${String(i).padStart(2, '0')}`).join('\n');
  const tail = failedLogTail(log, 80, 1000);
  assert.ok(tail.startsWith('--- j ---\n…\n'));
  assert.ok(tail.length <= 1012);
  assert.ok(tail.endsWith('39'));
  assert.ok(tail.split('\n').slice(2).every((l) => l.length === 100));
});

test('prchecks: one long job does not push the other failed jobs out', () => {
  const long = Array.from({ length: 80 }, (_, i) => `build\tRun tests\t${'x'.repeat(200)} ${i}`);
  const tail = failedLogTail([...long, 'lint\tRun eslint\tlint error'].join('\n'), 80, 6000);
  assert.ok(tail.length <= 6100);
  assert.ok(tail.startsWith('--- build ---\n…\n'));
  assert.ok(tail.includes(`${'x'.repeat(200)} 79\n--- lint`));
  assert.ok(tail.endsWith('--- lint / Run eslint ---\nlint error'));
});

test('prchecks: the Worker gets Actions logs, and only links for external CI', () => {
  const failed = parseChecks([job('test', 'FAILURE', 5), job('lint', 'FAILURE', 6), status('buildkite', 'FAILURE', 'https://buildkite.com/b/1')]);
  const body = ciFixBody(failed, new Map([['5', 'boom\nuses ``` fences'], ['6', null]]));
  assert.ok(body.startsWith('Failed checks:\n- CI / test: https://github.com/o/r/actions/runs/5/job/50\n'));
  assert.ok(body.includes('- buildkite (external CI: its log is not read here; open the link): https://buildkite.com/b/1'));
  assert.ok(body.includes('End of the failed log of run 5 (full log: `gh run view 5 -R github.com/o/r --log-failed`):\n````\nboom\nuses ``` fences\n````'));
  assert.ok(body.includes('Could not read the failed log of run 6. Try `gh run view 6 -R github.com/o/r --log-failed` or open the link.'));
  assert.equal(body.match(/failed log of run/g)?.length, 2, 'external CI gets no log section');
});
