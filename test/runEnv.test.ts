import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBasePort, portCandidates, portStep, psPrelude, runEnv, workerNumber, workerPort } from '../src/shared/runEnv';

test('runEnv: the base port field takes nothing or a port between 1024 and 65000', () => {
  assert.equal(parseBasePort(''), null);
  assert.equal(parseBasePort(' 3000 '), 3000);
  assert.equal(parseBasePort('80'), 'bad');
  assert.equal(parseBasePort('65001'), 'bad');
  assert.equal(parseBasePort('30a0'), 'bad');
  assert.equal(parseBasePort('3000.5'), 'bad');
});

test('runEnv: a step outside 1, 10 and 100 falls back to 10', () => {
  assert.equal(portStep({}), 10);
  assert.equal(portStep({ portStep: 100 }), 100);
  assert.equal(portStep({ portStep: 7 }), 10);
});

test('runEnv: each Worker gets the base port plus its number of steps', () => {
  assert.equal(workerNumber('W-02'), 2);
  assert.equal(workerNumber('worker'), 1);
  assert.equal(workerPort({ basePort: 3000 }, 'W-01'), 3000);
  assert.equal(workerPort({ basePort: 3000 }, 'W-02'), 3010);
  assert.equal(workerPort({ basePort: 3000, portStep: 1 }, 'W-22'), 3021);
  assert.equal(workerPort({}, 'W-02'), null);
});

test('runEnv: a high Worker number wraps around below 65000', () => {
  const p = workerPort({ basePort: 60000, portStep: 100 }, 'W-90')!;
  assert.ok(p >= 60000 && p <= 65000, String(p));
  assert.equal(workerPort({ basePort: 65000, portStep: 100 }, 'W-05'), 65000);
});

test('runEnv: a taken port moves up one at a time', () => {
  assert.deepEqual(portCandidates(3010, 3), [3010, 3011, 3012]);
  assert.deepEqual(portCandidates(65534, 5), [65534, 65535]);
});

test('runEnv: the run gets PORT only when the repository sets a base port', () => {
  const env = runEnv({ repoPath: 'D:\\repo', workerId: 'W-02', worktree: 'D:\\wt\\W-02', port: 3010 });
  assert.deepEqual(env, [['PORT', '3010'], ['WORKTREE_NAME', 'W-02'], ['ROOT_PATH', 'D:\\repo'], ['WORKTREE_PATH', 'D:\\wt\\W-02']]);
  assert.deepEqual(runEnv({ repoPath: 'r', workerId: 'W-1', worktree: 'w', port: null }).map(([k]) => k), ['WORKTREE_NAME', 'ROOT_PATH', 'WORKTREE_PATH']);
});

test('runEnv: PowerShell gets the variables as its own', () => {
  assert.equal(psPrelude(['PORT', 'ROOT_PATH']), '$PORT = $env:PORT; $ROOT_PATH = $env:ROOT_PATH; ');
  assert.equal(psPrelude(['A;B']), '');
});
