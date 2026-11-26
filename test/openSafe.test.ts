import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opensSafely } from '../src/shared/openSafe';
import { recapChat } from '../src/shared/recap';

test('only folders and documents open with their program; programs, scripts and shortcuts are revealed (L9)', () => {
  for (const p of ['C:\\w\\report.md', '/w/shot.PNG', '/w/data.json', '/w/page.html', 'C:\\w\\doc.pdf']) assert.ok(opensSafely(p, false), p);
  for (const p of ['C:\\w\\setup.exe', 'C:\\w\\run.bat', 'C:\\w\\run.cmd', '/w/x.ps1', '/w/tool.js', '/w/a.sh', 'C:\\w\\l.lnk', '/w/Makefile', '/w/.env']) assert.ok(!opensSafely(p, false), p);
  assert.ok(opensSafely('C:\\w\\folder.exe', true));
  // A Windows path is split at its backslashes too: a file named only '.md' is a dotfile, not a document.
  assert.ok(!opensSafely('C:\\w\\.md', false));
});

test('recapChat: what the user and the Dispatcher said, oldest first, clipped and within the limit (M6)', () => {
  const at = (m: number) => `2026-11-21T10:${String(m).padStart(2, '0')}:00.000Z`;
  const chat = [
    { kind: 'user' as const, text: 'First   request\nwith lines', ts: at(1) },
    { kind: 'event' as const, text: 'Gave it to W-1', ts: at(2) },
    { kind: 'dispatcher' as const, text: 'x'.repeat(500), ts: at(3) },
    { kind: 'user' as const, text: 'Second', ts: at(4) },
  ];
  const r = recapChat(chat);
  const lines = r.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('- User (2026-11-21 10:01): First'));
  assert.ok(lines[1].startsWith('- You (2026-11-21 10:03): xxx'));
  assert.equal(lines[2], '- User (2026-11-21 10:04): Second');
  assert.ok(r.includes('First request with lines'));
  assert.ok(r.split('\n')[1].endsWith('…'));
  assert.equal(recapChat(chat, 60), '- User (2026-11-21 10:04): Second');
  assert.equal(recapChat([]), '');
});
