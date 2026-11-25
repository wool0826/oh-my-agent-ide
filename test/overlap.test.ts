import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOverlaps, overlapLine, overlapNote, pathMeets, promptPaths } from '../src/shared/overlap';
import type { Task } from '../src/shared/types';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, title: `Title ${id}`, prompt: '', kind: 'code', repo: 'app', workerId: 'W-01', status: 'running', branch: `agent/${id.toLowerCase()}`,
    prUrl: null, prState: null, summary: null, files: [], createdAt: '', updatedAt: '', finishedAt: null, reviewSyncedAt: null,
    seenCommentIds: [], ...over,
  };
}

test('overlap: a prompt names repository paths and bare file names', () => {
  const paths = promptPaths('Touch `src/shared/i18n.ts`, styles.css and (gitwork.ts). See src\\main\\agents\\workers.ts:120.');
  assert.deepEqual(paths, ['src/shared/i18n.ts', 'styles.css', 'gitwork.ts', 'src/main/agents/workers.ts']);
});

test('overlap: URLs, absolute paths, versions and folders are not file paths', () => {
  const paths = promptPaths('See https://github.com/o/r/pull/176 and C:\\Users\\me\\plan.md, release 0.7.0 on W-04, in src/main or ../up.ts. Keep .gitignore');
  assert.deepEqual(paths, ['.gitignore']);
});

test('overlap: a named path meets a changed file at a folder boundary', () => {
  assert.equal(pathMeets('src/shared/i18n.ts', 'src/shared/i18n.ts'), true);
  assert.equal(pathMeets('i18n.ts', 'src/shared/i18n.ts'), true);
  assert.equal(pathMeets('shared/i18n.ts', 'src/shared/i18n.ts'), true);
  assert.equal(pathMeets('n.ts', 'src/shared/i18n.ts'), false);
  assert.equal(pathMeets('main/i18n.ts', 'src/shared/i18n.ts'), false);
});

test('overlap: tasks in progress on the same repository that change a named file are found', () => {
  const tasks = [
    task('T-0001', { changedFiles: ['src/shared/i18n.ts', 'src/main/x.ts'] }),
    task('T-0002', { status: 'pr_open', prState: 'OPEN', changedFiles: ['src/renderer/styles.css', 'src/shared/i18n.ts'] }),
    task('T-0003', { changedFiles: ['README.md'] }),
  ];
  const got = findOverlaps({ repo: 'app', paths: ['src/shared/i18n.ts', 'styles.css'] }, tasks);
  assert.deepEqual(got, [
    { taskId: 'T-0002', files: ['src/renderer/styles.css', 'src/shared/i18n.ts'] },
    { taskId: 'T-0001', files: ['src/shared/i18n.ts'] },
  ]);
});

test('overlap: finished, merged, other-repository and unknown work is left out', () => {
  const files = ['src/a.ts'];
  const tasks = [
    task('T-0001', { status: 'done', changedFiles: files }),
    task('T-0002', { status: 'pr_open', prState: 'MERGED', changedFiles: files }),
    task('T-0003', { repo: 'other', changedFiles: files }),
    task('T-0004', { changedFiles: null }),
    task('T-0005', { status: 'cancelled', changedFiles: files }),
  ];
  assert.deepEqual(findOverlaps({ repo: 'app', paths: ['src/a.ts'] }, tasks), []);
});

test('overlap: the task itself, its after_task_id and its comparison twin need no mention', () => {
  const files = ['src/a.ts'];
  const tasks = [
    task('T-0001', { changedFiles: files }),
    task('T-0002', { changedFiles: files }),
    task('T-0003', { changedFiles: files, compare: { group: 'g' } }),
  ];
  assert.deepEqual(findOverlaps({ id: 'T-0001', repo: 'app', paths: ['a.ts'], after: 'T-0002', compareGroup: 'g' }, tasks), []);
});

test('overlap: lockfiles and a prompt with no paths give no overlap', () => {
  const tasks = [task('T-0001', { changedFiles: ['package-lock.json', 'src/a.ts'] })];
  assert.deepEqual(findOverlaps({ repo: 'app', paths: ['package-lock.json'] }, tasks), []);
  assert.deepEqual(findOverlaps({ repo: 'app', paths: [] }, tasks), []);
  assert.deepEqual(findOverlaps({ repo: null, paths: ['src/a.ts'] }, tasks), []);
});

test('overlap: the note names the task, its files and the after_task_id to use', () => {
  const tasks = [task('T-0001', { workerId: 'W-03', changedFiles: ['src/shared/i18n.ts'] })];
  const note = overlapNote({ id: 'T-0009', status: 'running', workerId: 'W-05' }, [{ taskId: 'T-0001', files: ['src/shared/i18n.ts'] }], tasks);
  assert.equal(note, ' Overlap: T-0001 "Title T-0001" (W-03, running) already changes src/shared/i18n.ts. If T-0009 must build on that work, stop_worker W-05 and create it again with after_task_id "T-0001"; otherwise tell both Workers which files they share.');
  assert.match(overlapNote({ id: 'T-0009', status: 'queued', workerId: 'W-05' }, [{ taskId: 'T-0001', files: ['a.ts'] }], tasks), /cancel_task it and create/);
  assert.equal(overlapNote({ id: 'T-0009', status: 'running', workerId: 'W-05' }, [], tasks), '');
});

test('overlap: the Workers view line lists file names and hides once the task is finished', () => {
  const files = ['a/1.ts', 'a/2.ts', 'a/3.ts', 'a/4.ts', 'a/5.ts', 'a/6.ts', 'a/7.ts'];
  const t = task('T-0009', { overlaps: [{ taskId: 'T-0001', files }, { taskId: 'T-0002', files: ['src/b.css'] }] });
  assert.equal(overlapLine(t), 'T-0001 1.ts, 2.ts, 3.ts, 4.ts, 5.ts +2 · T-0002 b.css');
  assert.equal(overlapLine({ ...t, status: 'done' }), '');
  assert.equal(overlapLine(task('T-0010')), '');
});
