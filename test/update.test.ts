import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, parseVersion, updateFrom } from '../src/shared/update';

test('versions compare by number, not by text', () => {
  assert.equal(isNewer('v0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.4.1', '0.4.0'), true);
  assert.equal(isNewer('0.4.0', '0.4.0'), false);
  assert.equal(isNewer('0.3.9', '0.4.0'), false);
  assert.equal(isNewer('1.0.0-beta', '0.4.0'), false);
  assert.deepEqual(parseVersion(' v1.2.3 '), [1, 2, 3]);
});

test('an update is offered only for a newer, published release on GitHub', () => {
  const rel = { tag_name: 'v0.5.0', html_url: 'https://github.com/wool0826/oh-my-agent-ide/releases/tag/v0.5.0' };
  assert.deepEqual(updateFrom(rel, '0.4.0'), { version: '0.5.0', url: rel.html_url });
  assert.equal(updateFrom(rel, '0.5.0'), null);
  assert.equal(updateFrom({ ...rel, draft: true }, '0.4.0'), null);
  assert.equal(updateFrom({ ...rel, prerelease: true }, '0.4.0'), null);
  assert.equal(updateFrom({ ...rel, html_url: 'https://example.com/x' }, '0.4.0'), null);
  assert.equal(updateFrom({ message: 'Not Found' }, '0.4.0'), null);
  assert.equal(updateFrom(null, '0.4.0'), null);
});
