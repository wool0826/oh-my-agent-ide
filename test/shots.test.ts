import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstPick, isImagePath, isLocalPath, pickShot, setView, shotOf, shotPath, shotSets, shotUrl } from '../src/shared/shots';

test('shots: image files are told apart from the rest by their extension', () => {
  for (const p of ['a.png', 'B.PNG', 'c.jpg', 'd.jpeg', 'e.gif', 'f.webp', ' g.png ']) assert.equal(isImagePath(p), true, p);
  for (const p of ['report.md', 'shot.png.txt', 'png', 'shots/', 'x.svg']) assert.equal(isImagePath(p), false, p);
});

test('shots: the before or after word in the file name gives the role, and the rest of the name the screen', () => {
  assert.deepEqual(shotOf('C:\\tmp\\settings-before.png'), { path: 'C:\\tmp\\settings-before.png', role: 'before', screen: 'settings', width: null, theme: null });
  assert.equal(shotOf('/tmp/chatBefore.png').role, 'before');
  assert.equal(shotOf('/tmp/after.png').screen, '');
  // Part of a longer word is not the role.
  assert.equal(shotOf('/tmp/afterglow.png').role, null);
  assert.equal(shotOf('/tmp/beforehand.png').role, null);
  // The word in a folder name does not count.
  assert.equal(shotOf('/tmp/before/inbox.png').role, null);
});

test('shots: wide/narrow and dark/light in the name are parts of the shot, not of its screen', () => {
  assert.deepEqual(shotOf('/tmp/result_card_after_dark.png'), { path: '/tmp/result_card_after_dark.png', role: 'after', screen: 'result-card', width: null, theme: 'dark' });
  const s = shotOf('C:\\T-0136\\before-inbox-narrow-light.png');
  assert.deepEqual([s.role, s.screen, s.width, s.theme], ['before', 'inbox', 'narrow', 'light']);
  assert.equal(shotOf('/tmp/darkness.png').theme, null);
});

const EIGHT = ['before', 'after'].flatMap((r) => ['wide', 'narrow'].flatMap((w) => ['dark', 'light'].map((t) => `C:\\T-0136\\${r}-inbox-${w}-${t}.png`)));

test('shots: the 8 shots of one screen are one set with a before/after pair and width and theme switches', () => {
  const { sets, rest } = shotSets(EIGHT);
  assert.equal(rest.length, 0);
  assert.equal(sets.length, 1);
  const [set] = sets;
  assert.equal(set.screen, 'inbox');
  assert.deepEqual(set.roles, ['before', 'after']);
  assert.deepEqual(set.axes, { width: ['wide', 'narrow'], theme: ['dark', 'light'] });
  const v = setView(set, firstPick(set));
  assert.deepEqual(v.cols.map((c) => [c.role, c.shot?.path.split('\\').pop()]), [['before', 'before-inbox-wide-dark.png'], ['after', 'after-inbox-wide-dark.png']]);
  assert.equal(v.hidden, 6);
  const n = setView(set, { width: 'narrow', theme: 'light' });
  assert.deepEqual(n.cols.map((c) => c.shot?.path.split('\\').pop()), ['before-inbox-narrow-light.png', 'after-inbox-narrow-light.png']);
});

test('shots: one image is a set of one, with no switches', () => {
  const { sets } = shotSets(['/r/usage-narrow.png']);
  assert.equal(sets.length, 1);
  assert.deepEqual([sets[0].roles, sets[0].axes, sets[0].shots.length], [[], {}, 1]);
  const v = setView(sets[0], firstPick(sets[0]));
  assert.deepEqual([v.cols.length, v.cols[0].role, v.cols[0].shot?.path, v.hidden], [1, null, '/r/usage-narrow.png', 0]);
});

test('shots: a before/after pair is one set with two columns and no switches', () => {
  const { sets } = shotSets(['/r/settings-after.png', '/r/settings-before.png']);
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].axes, {});
  assert.deepEqual(setView(sets[0], {}).cols.map((c) => c.shot?.path), ['/r/settings-before.png', '/r/settings-after.png']);
});

test('shots: images and other files mixed: the pair is a set, the rest stay files in the report\'s order', () => {
  const { sets, rest } = shotSets(['/r/report.md', '/r/queue-after.png', '/r/preflight.log', '/r/queue-before.png', 'rel/queue-after.png']);
  assert.deepEqual(sets.map((s) => s.shots.map((x) => x.path)), [['/r/queue-before.png', '/r/queue-after.png']]);
  assert.deepEqual(rest, ['/r/report.md', '/r/preflight.log', 'rel/queue-after.png']);
});

test('shots: screens keep the report\'s order, each screen\'s before ahead of its after', () => {
  const { sets } = shotSets(['/r/inbox-after.png', '/r/chat-after.png', '/r/inbox-before.png', '/r/chat-before.png']);
  assert.deepEqual(sets.map((s) => s.shots.map((x) => x.path)), [['/r/inbox-before.png', '/r/inbox-after.png'], ['/r/chat-before.png', '/r/chat-after.png']]);
});

test('shots: images without any of the words are a set each, and a path named twice is shown once', () => {
  const { sets, rest } = shotSets(['/r/b.png', '/r/a.png', '/r/b.png', ' ', '/r/a-before.png']);
  assert.deepEqual(sets.map((s) => s.shots.map((x) => x.path)), [['/r/b.png'], ['/r/a.png'], ['/r/a-before.png']]);
  assert.deepEqual(rest, []);
});

test('shots: a missing shot takes the closest one: a name without the part is half a match', () => {
  const { sets } = shotSets(['/r/card-before.png', '/r/card-after-dark.png', '/r/card-after-light.png']);
  const [set] = sets;
  assert.deepEqual(set.axes, { theme: ['dark', 'light'] });
  assert.equal(pickShot(set, 'before', { theme: 'light' })?.path, '/r/card-before.png');
  assert.equal(pickShot(set, 'after', { theme: 'light' })?.path, '/r/card-after-light.png');
  assert.equal(pickShot(set, null, {}), null);
});

test('shots: a shot without a role in a set with roles gets a column of its own', () => {
  const { sets } = shotSets(['/r/card-before-dark.png', '/r/card-after-dark.png', '/r/card-dark.png']);
  assert.deepEqual(setView(sets[0], {}).cols.map((c) => c.role), ['before', 'after', null]);
});

test('shots: only a local path from the root is shown; a relative or network one stays a file link', () => {
  for (const p of ['C:\\a\\b-after.png', 'd:/a/b.png', '/home/me/a.png']) assert.equal(rejected(p), false, p);
  for (const p of ['shots/a-before.png', '.\\a.png', '\\\\host\\share\\a.png', '//host/share/a.png', 'C:a.png', '/tmp/../etc/a.png', 'C:\\x\\..\\a.png']) assert.equal(rejected(p), true, p);
  assert.equal(shotPath(shotUrl('\\\\host\\share\\a.png')), null);
  assert.equal(shotPath(shotUrl('/tmp/../a.png')), null);
});

function rejected(p: string) {
  const { sets, rest } = shotSets([p]);
  assert.equal(isLocalPath(p), sets.length === 1, p);
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
