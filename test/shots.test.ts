import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isImagePath, isLocalPath, reportShots, shotOf, shotPath, shotUrl } from '../src/shared/shots';

test('shots: image files are told apart from the rest by their extension', () => {
  for (const p of ['a.png', 'B.PNG', 'c.jpg', 'd.jpeg', 'e.gif', 'f.webp', ' g.png ']) assert.equal(isImagePath(p), true, p);
  for (const p of ['report.md', 'shot.png.txt', 'png', 'shots/', 'x.svg']) assert.equal(isImagePath(p), false, p);
});

test('shots: the before or after word in the file name gives the role, and the rest of the name the screen', () => {
  assert.deepEqual(shotOf('C:\\tmp\\settings-before.png'), { path: 'C:\\tmp\\settings-before.png', role: 'before', screen: 'settings' });
  assert.deepEqual(shotOf('/tmp/result_card_after_dark.png'), { path: '/tmp/result_card_after_dark.png', role: 'after', screen: 'result-card-dark' });
  assert.equal(shotOf('/tmp/chatBefore.png').role, 'before');
  assert.equal(shotOf('/tmp/after.png').screen, '');
  // Part of a longer word is not the role.
  assert.equal(shotOf('/tmp/afterglow.png').role, null);
  assert.equal(shotOf('/tmp/beforehand.png').role, null);
  // The word in a folder name does not count.
  assert.equal(shotOf('/tmp/before/inbox.png').role, null);
});

test('shots: a report\'s images are split from its other files, each screen\'s before ahead of its after', () => {
  const { shots, rest } = reportShots(['/r/notes.md', '/r/inbox-after.png', '/r/chat-after.png', '/r/inbox-before.png', '/r/chat-before.png', '/r/out.json']);
  assert.deepEqual(rest, ['/r/notes.md', '/r/out.json']);
  assert.deepEqual(shots.map((s) => s.path), ['/r/inbox-before.png', '/r/inbox-after.png', '/r/chat-before.png', '/r/chat-after.png']);
});

test('shots: dark and light shots of a screen stay separate pairs', () => {
  const { shots } = reportShots(['/r/card-after-dark.png', '/r/card-after-light.png', '/r/card-before-light.png', '/r/card-before-dark.png']);
  assert.deepEqual(shots.map((s) => s.path), ['/r/card-before-dark.png', '/r/card-after-dark.png', '/r/card-before-light.png', '/r/card-after-light.png']);
});

test('shots: images without a role keep the report\'s order, and a path named twice is shown once', () => {
  const { shots, rest } = reportShots(['/r/b.png', '/r/a.png', '/r/b.png', ' ', '/r/a-before.png']);
  assert.deepEqual(shots.map((s) => [s.path, s.role]), [['/r/b.png', null], ['/r/a.png', null], ['/r/a-before.png', 'before']]);
  assert.deepEqual(rest, []);
});

test('shots: only a local path from the root is shown; a relative or network one stays a file link', () => {
  for (const p of ['C:\\a\\b-after.png', 'd:/a/b.png', '/home/me/a.png']) assert.equal(rejected(p), false, p);
  for (const p of ['shots/a-before.png', '.\\a.png', '\\\\host\\share\\a.png', '//host/share/a.png', 'C:a.png', '/tmp/../etc/a.png', 'C:\\x\\..\\a.png']) assert.equal(rejected(p), true, p);
  assert.equal(shotPath(shotUrl('\\\\host\\share\\a.png')), null);
  assert.equal(shotPath(shotUrl('/tmp/../a.png')), null);
});

function rejected(p: string) {
  const { shots, rest } = reportShots([p]);
  assert.equal(isLocalPath(p), shots.length === 1, p);
  return rest.length === 1;
}

test('shots: the window address of an image file reads back to the same path', () => {
  for (const p of ['C:\\Users\\me\\AppData\\Local\\Temp\\chat before #1.png', '/home/me/shots/ä-after.png']) {
    const u = shotUrl(p);
    assert.match(u, /^oma-shot:\/\/file\//);
    assert.equal(shotPath(u), p);
  }
});

test('shots: an address that is not a reported image reads as nothing', () => {
  assert.equal(shotPath(shotUrl('C:\\Windows\\win.ini')), null);
  assert.equal(shotPath('oma-shot://other/' + encodeURIComponent('/a.png')), null);
  assert.equal(shotPath('file:///a.png'), null);
  assert.equal(shotPath('oma-shot://file/%E0%A4%A.png'), null);
  assert.equal(shotPath('not a url'), null);
});
