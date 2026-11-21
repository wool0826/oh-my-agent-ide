import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REVIEWER, SELF_REVIEW_SKILL, SELF_REVIEW_SKIP, reviewerAgent, selfReviewLine } from '../src/main/agents/selfReview';

const plugin = path.join(process.cwd(), 'resources', 'plugin');

test('self-review: off adds nothing to the task message', () => {
  assert.equal(selfReviewLine(false, 'main'), null);
});

test('self-review: on names the skill, the base and the skip limits', () => {
  const line = selfReviewLine(true, 'develop')!;
  assert.match(line, /before `gh pr create`/);
  assert.ok(line.includes(`\`${SELF_REVIEW_SKILL}\``));
  assert.ok(line.includes('`origin/develop`'));
  assert.ok(line.includes(`at most ${SELF_REVIEW_SKIP.lines} changed lines in at most ${SELF_REVIEW_SKIP.files} files`));
  assert.match(line, /PR body/);
});

test('self-review: the skill the line names ships in the plugin and starts the reviewer', () => {
  const pluginName = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).name;
  const skill = fs.readFileSync(path.join(plugin, 'skills', 'self-review', 'SKILL.md'), 'utf8');
  const name = skill.match(/^name:\s*(\S+)/m)?.[1];
  assert.equal(`${pluginName}:${name}`, SELF_REVIEW_SKILL);
  assert.ok(skill.includes(`\`${REVIEWER}\``));
});

test('self-review: the reviewer is read-only and runs on the given model', () => {
  const a = reviewerAgent('claude-sonnet-5-5');
  assert.equal(a.model, 'claude-sonnet-5-5');
  for (const t of ['Edit', 'Write', 'NotebookEdit', 'Agent']) assert.ok(!a.tools!.includes(t), t);
  assert.match(a.prompt, /read-only/);
  assert.match(a.prompt, /No findings\./);
});
