import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendOutput, lastLines, localUrl } from '../src/shared/runOutput';

test('output loses its terminal codes and keeps its end from a line start', () => {
  assert.equal(appendOutput('', '\u001b[32mready\u001b[0m in 120ms\r\n'), 'ready in 120ms\n');
  const out = appendOutput('first line\nsecond line\n', 'third line\n', 20);
  assert.equal(out, 'third line\n');
});

test('the first local address is the one to open', () => {
  assert.equal(localUrl('  Local:   http://localhost:5173/\n  Network: http://192.168.0.4:5173/'), 'http://localhost:5173/');
  assert.equal(localUrl('Listening on http://0.0.0.0:3000.'), 'http://localhost:3000');
  assert.equal(localUrl('server at http://127.0.0.1:8080/app, ready'), 'http://127.0.0.1:8080/app');
  assert.equal(localUrl('Docs: https://example.com/guide'), null);
  assert.equal(localUrl(''), null);
});

test('the view shows the last lines', () => {
  assert.equal(lastLines('a\nb\nc\nd\n', 2), 'c\nd');
});
