import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchPrOwned, canHavePr, clearForeignPr, clearForeignPrs, ownsPr, pickTaskPr, prCandidates, prInRepo, remoteRepo } from '../src/shared/prOwner';
import { pickBranchPr } from '../src/shared/queue';
import { prsToWatch } from '../src/shared/prs';
import type { Repo, Task } from '../src/shared/types';

const REPO: Repo = { name: 'oh-my-agent-ide', url: 'https://github.com/wool0826/oh-my-agent-ide.git', path: 'C:/r', description: '', defaultBranch: 'main', addedAt: '' };
const OWN = 'https://github.com/wool0826/oh-my-agent-ide/pull/205';
const FOREIGN = 'https://github.com/electron/electron/pull/51989';

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id, title: `title ${id}`, prompt: '', kind: 'code', repo: REPO.name, workerId: 'W-01', status: 'running',
    branch: `agent/${id.toLowerCase()}`, prUrl: null, prState: null, summary: null, files: [],
    createdAt: '', updatedAt: '', finishedAt: null, reviewSyncedAt: null, seenCommentIds: [], afterTaskId: null,
    ...patch,
  };
}

test('prOwner: remote URLs in https, scp and ssh form name the same repository', () => {
  const want = { host: 'github.com', owner: 'wool0826', repo: 'oh-my-agent-ide' };
  assert.deepEqual(remoteRepo('https://github.com/wool0826/oh-my-agent-ide.git'), want);
  assert.deepEqual(remoteRepo('https://user@github.com/Wool0826/oh-my-agent-ide/'), want);
  assert.deepEqual(remoteRepo('git@github.com:wool0826/oh-my-agent-ide.git'), want);
  assert.deepEqual(remoteRepo('ssh://git@github.com:22/wool0826/oh-my-agent-ide'), want);
  assert.equal(remoteRepo(''), null);
  assert.equal(remoteRepo('C:/local/folder'), null);
});

test('prOwner: a PR belongs to a repository only with the same host, owner and name', () => {
  assert.equal(prInRepo(OWN, REPO.url), true);
  assert.equal(prInRepo('https://github.com/WOOL0826/Oh-My-Agent-IDE/pull/1/files', REPO.url), true);
  assert.equal(prInRepo(FOREIGN, REPO.url), false);
  assert.equal(prInRepo('https://github.com/wool0826/other/pull/1', REPO.url), false);
  assert.equal(prInRepo('https://ghe.example.com/wool0826/oh-my-agent-ide/pull/1', REPO.url), false);
});

test('prOwner: a foreign PR on the RESULT or PR line is not the task\'s PR', () => {
  const text = `RESULT: root cause is upstream (${FOREIGN})\nPR: ${FOREIGN}\nLINK: https://claude.ai/artifact/x`;
  assert.equal(pickTaskPr(prCandidates(text), task('T-1'), REPO), null);
});

test('prOwner: with a foreign URL first and the repository\'s second, the repository\'s is taken', () => {
  assert.equal(pickTaskPr(prCandidates(`PR: ${FOREIGN} ${OWN}`), task('T-1'), REPO), OWN);
  assert.equal(pickTaskPr(prCandidates(`RESULT: fixed, like ${FOREIGN}\nPR: ${OWN}`), task('T-1'), REPO), OWN);
});

test('prOwner: PR lines come before URLs in the rest of the report', () => {
  const other = 'https://github.com/wool0826/oh-my-agent-ide/pull/9';
  assert.deepEqual(prCandidates(`Follows ${other}.\nPR: ${OWN}`), [OWN, other]);
});

test('prOwner: a task without a branch, a non-code task or a local repository has no PR', () => {
  assert.equal(pickTaskPr([OWN], task('T-1', { kind: 'other', branch: null }), REPO), null);
  assert.equal(pickTaskPr([OWN], task('T-1', { branch: null }), REPO), null);
  assert.equal(pickTaskPr([OWN], task('T-1'), { ...REPO, local: true }), null);
  assert.equal(pickTaskPr([OWN], task('T-1'), null), null);
  assert.equal(canHavePr(task('T-1'), REPO), true);
});

test('prOwner: a listed PR from a fork or another head branch is not the task\'s', () => {
  const t = task('T-1');
  assert.equal(branchPrOwned({ url: OWN, state: 'OPEN', headRefName: 'agent/t-1', isCrossRepository: false }, t, REPO), true);
  assert.equal(branchPrOwned({ url: OWN, state: 'OPEN', headRefName: 'agent/t-1', isCrossRepository: true }, t, REPO), false);
  assert.equal(branchPrOwned({ url: OWN, state: 'OPEN', headRefName: 'agent/t-2' }, t, REPO), false);
  assert.equal(branchPrOwned({ url: FOREIGN, state: 'OPEN', headRefName: 'agent/t-1' }, t, REPO), false);
  const fork = { url: 'https://github.com/wool0826/oh-my-agent-ide/pull/300', state: 'OPEN', headRefName: 'agent/t-1', isCrossRepository: true };
  const mine = { url: OWN, state: 'MERGED', headRefName: 'agent/t-1', isCrossRepository: false };
  assert.deepEqual(pickBranchPr([fork, mine], (p) => branchPrOwned(p, t, REPO)), { url: OWN, state: 'MERGED' });
});

test('prOwner: discovery on a branch with no PR finds none', () => {
  assert.equal(pickBranchPr([], (p) => branchPrOwned(p, task('T-1'), REPO)), null);
});

test('prOwner: the stored T-0143 shape is done again, without its PR, and leaves PRs in review', () => {
  const t = task('T-0143', {
    kind: 'other', branch: null, status: 'pr_open', prUrl: FOREIGN, prState: 'OPEN', finishedAt: '2026-11-26T15:35:03.611Z',
    summary: 's', files: ['C:/a.html'], links: ['https://claude.ai/artifact/A9'], seenCommentIds: ['c:1'],
    prChecks: { ci: 'pending', failed: [], conflicts: false, review: 'changes' },
  });
  assert.equal(prsToWatch([t]).length, 1);
  assert.equal(ownsPr(t, REPO), false);
  assert.deepEqual(clearForeignPrs([t, task('T-2', { status: 'pr_open', prUrl: OWN, prState: 'OPEN' })], [REPO]), ['T-0143']);
  assert.equal(t.status, 'done');
  assert.equal(t.prUrl, null);
  assert.equal(t.prState, null);
  assert.equal(t.prChecks, null);
  assert.deepEqual(t.links, ['https://claude.ai/artifact/A9', FOREIGN]);
  assert.equal(t.summary, 's');
  assert.deepEqual(t.files, ['C:/a.html']);
  assert.equal(t.finishedAt, '2026-11-26T15:35:03.611Z');
  assert.equal(prsToWatch([t]).length, 0);
});

test('prOwner: a task of a repository no longer listed, or a merged own PR, keeps its PR', () => {
  const gone = task('T-1', { repo: 'removed', status: 'done', prUrl: FOREIGN, prState: 'MERGED' });
  const merged = task('T-2', { status: 'done', prUrl: OWN, prState: 'MERGED' });
  assert.deepEqual(clearForeignPrs([gone, merged], [REPO]), []);
  assert.equal(gone.prUrl, FOREIGN);
  assert.equal(merged.prUrl, OWN);
  assert.equal(clearForeignPr(merged, REPO), false);
});

test('prOwner: a foreign PR on a task that failed keeps the failed status', () => {
  const t = task('T-1', { status: 'failed', prUrl: FOREIGN, prState: 'OPEN' });
  assert.equal(clearForeignPr(t, REPO), true);
  assert.equal(t.status, 'failed');
  assert.equal(t.prUrl, null);
});
