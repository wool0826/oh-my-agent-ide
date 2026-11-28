import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstPick, isImagePath, isLocalPath, orderShots, pickShot, setView, shotOf, shotPath, shotSets, shotTags, shotUrl } from '../src/shared/shots';

test('shots: image files are told apart from the rest by their extension', () => {
  for (const p of ['a.png', 'B.PNG', 'c.jpg', 'd.jpeg', 'D.JPEG', 'e.gif', 'f.webp', ' g.png ', 'h.bmp', 'i.avif', 'j.jfif', 'k.Png']) assert.equal(isImagePath(p), true, p);
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
  assert.deepEqual(set.axes, { width: ['wide', 'narrow'], theme: ['light', 'dark'] });
  const v = setView(set, firstPick(set));
  assert.deepEqual(v.cols.map((c) => [c.role, c.shot?.path.split('\\').pop()]), [['before', 'before-inbox-wide-light.png'], ['after', 'after-inbox-wide-light.png']]);
  assert.equal(v.hidden, 6);
  const n = setView(set, { width: 'narrow', theme: 'dark' });
  assert.deepEqual(n.cols.map((c) => c.shot?.path.split('\\').pop()), ['before-inbox-narrow-dark.png', 'after-inbox-narrow-dark.png']);
});

const names = (shots: { path: string }[]) => shots.map((x) => x.path.split(/[\\/]/).pop());
const ORDER = ['before-inbox-wide-light.png', 'after-inbox-wide-light.png', 'before-inbox-narrow-light.png', 'after-inbox-narrow-light.png',
  'before-inbox-wide-dark.png', 'after-inbox-wide-dark.png', 'before-inbox-narrow-dark.png', 'after-inbox-narrow-dark.png'];

test('shots: the 8 shots of one screen are shown pair by pair, light pairs first, each before right ahead of its after', () => {
  assert.deepEqual(names(shotSets(EIGHT).sets[0].shots), ORDER);
});

test('shots: the pair order does not depend on the order the report names the shots in', () => {
  // Every before first, then every after: the order that showed before, before, after, after.
  const byRole = [...EIGHT.filter((p) => p.includes('\\before')), ...EIGHT.filter((p) => p.includes('\\after'))];
  for (const files of [EIGHT, byRole, [...EIGHT].reverse(), [EIGHT[7], EIGHT[0], EIGHT[5], EIGHT[2], EIGHT[3], EIGHT[6], EIGHT[1], EIGHT[4]]]) {
    assert.deepEqual(names(shotSets(files).sets[0].shots), ORDER);
  }
});

test('shots: before light, after light, then before dark, after dark, whatever the case of the name', () => {
  const files = ['/r/card-before-dark.png', '/r/card-before-light.png', '/r/card-after-dark.png', '/r/card-after-light.png'];
  assert.deepEqual(names(shotSets(files).sets[0].shots), ['card-before-light.png', 'card-after-light.png', 'card-before-dark.png', 'card-after-dark.png']);
  const upper = ['C:\\s\\CardBefore_Dark.PNG', 'C:\\s\\CardAfter_Dark.PNG', 'C:\\s\\CardBefore_Light.PNG', 'C:\\s\\CardAfter_Light.PNG'];
  assert.deepEqual(names(shotSets(upper).sets[0].shots), ['CardBefore_Light.PNG', 'CardAfter_Light.PNG', 'CardBefore_Dark.PNG', 'CardAfter_Dark.PNG']);
});

test('shots: a shot without a partner follows the pairs, in the order it came', () => {
  const { shots, pairs } = orderShots(['/r/c-dark.png', '/r/c-after-narrow.png', '/r/c-before-dark.png', '/r/c-before-light.png', '/r/c-after-dark.png'].map(shotOf));
  assert.equal(pairs, 1);
  assert.deepEqual(names(shots), ['c-before-dark.png', 'c-after-dark.png', 'c-dark.png', 'c-after-narrow.png', 'c-before-light.png']);
});

test('shots: a second before of the same variant has no after left and follows the pairs', () => {
  const { shots, pairs } = orderShots(['/r/c-before-light.png', '/r/c-before-light.jpg', '/r/c-after-light.png'].map(shotOf));
  assert.equal(pairs, 1);
  assert.deepEqual(names(shots), ['c-before-light.png', 'c-after-light.png', 'c-before-light.jpg']);
});

test('shots: a name with no theme or width pairs with its own kind and comes after the themed pairs', () => {
  const { shots } = orderShots(['/r/c-before.png', '/r/c-after.png', '/r/c-after-dark.png', '/r/c-before-dark.png', '/r/c-light.png'].map(shotOf));
  assert.deepEqual(names(shots), ['c-before-dark.png', 'c-after-dark.png', 'c-before.png', 'c-after.png', 'c-light.png']);
});

test('shots: screens with a pair come first; images without one follow in the report\'s order', () => {
  const { sets } = shotSets(['/r/logo.png', '/r/menu-before.png', '/r/inbox-before.png', '/r/zz.png', '/r/inbox-after.png']);
  assert.deepEqual(sets.map((s) => names(s.shots)), [['inbox-before.png', 'inbox-after.png'], ['logo.png'], ['menu-before.png'], ['zz.png']]);
});

test('shots: one image is a set of one, with no switches', () => {
  const { sets } = shotSets(['/r/usage-narrow.png']);
  assert.equal(sets.length, 1);
  assert.deepEqual([sets[0].roles, sets[0].axes, sets[0].shots.length], [[], {}, 1]);
  const v = setView(sets[0], firstPick(sets[0]));
  assert.deepEqual([v.cols.length, names(v.extras), v.hidden], [0, ['usage-narrow.png'], 0]);
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
  assert.deepEqual(set.axes, { theme: ['light', 'dark'] });
  assert.equal(pickShot(set, 'before', { theme: 'light' })?.path, '/r/card-before.png');
  assert.equal(pickShot(set, 'after', { theme: 'light' })?.path, '/r/card-after-light.png');
  assert.equal(pickShot(set, null, {}), null);
});

test('shots: a shot without a role in a set with roles is shown after the pair, not as a third column', () => {
  const { sets } = shotSets(['/r/card-before-dark.png', '/r/card-after-dark.png', '/r/card-dark.png']);
  const v = setView(sets[0], {});
  assert.deepEqual(v.cols.map((c) => c.role), ['before', 'after']);
  assert.deepEqual([names(v.extras), v.hidden], [['card-dark.png'], 0]);
});

test('shots: the switches come from the before/after shots only, never from a shot shown on its own', () => {
  const { sets } = shotSets(['/r/card-before-wide.png', '/r/card-after-wide.png', '/r/card-narrow.png']);
  assert.deepEqual(sets[0].axes, {});
  assert.deepEqual(names(setView(sets[0], firstPick(sets[0])).extras), ['card-narrow.png']);
});

// The screenshots T-0181 reported (T-0187): its "changes" screen showed a third image beside its pair and two images
// of other screens squeezed after it.
const T0181 = ['app\\worker-head-dark-before.png', 'app\\worker-head-dark-after.png', 'app12\\export-head-dark-before.png', 'app12\\export-head-dark-after.png',
  'app12\\publish-dark.png', 'app10\\changes-dark-before.png', 'app10\\changes-dark-after.png', 'app10\\changes-split-light.png', 'app10\\changes-narrow-dark.png']
  .map((f) => `C:\\Temp\\t0181\\${f}`);

test('shots: T-0181: three pairs, the narrow shot of the changes screen on a row after its pair, and the two lone shots as screens of their own', () => {
  const { sets, rest } = shotSets(T0181);
  assert.deepEqual(rest, []);
  const views = sets.map((set) => {
    const v = setView(set, firstPick(set));
    return [set.screen, v.cols.map((c) => c.shot && names([c.shot])[0]), v.extras.map((x) => [names([x])[0], shotTags(x).join(' ')]), v.hidden];
  });
  assert.deepEqual(views, [
    ['worker-head', ['worker-head-dark-before.png', 'worker-head-dark-after.png'], [], 0],
    ['export-head', ['export-head-dark-before.png', 'export-head-dark-after.png'], [], 0],
    ['changes', ['changes-dark-before.png', 'changes-dark-after.png'], [['changes-narrow-dark.png', 'narrow dark']], 0],
    ['publish', [], [['publish-dark.png', 'dark']], 0],
    ['changes-split', [], [['changes-split-light.png', 'light']], 0],
  ]);
  // No set has a switch: every shot is in sight.
  assert.deepEqual(sets.map((s) => s.axes), [{}, {}, {}, {}, {}]);
});

test('shots: T-0181: the opened view steps through the shots set by set, each before right ahead of its after', () => {
  assert.deepEqual(names(shotSets(T0181).sets.flatMap((s) => s.shots)), ['worker-head-dark-before.png', 'worker-head-dark-after.png',
    'export-head-dark-before.png', 'export-head-dark-after.png', 'changes-dark-before.png', 'changes-dark-after.png', 'changes-narrow-dark.png',
    'publish-dark.png', 'changes-split-light.png']);
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

test('shots: names made only of the part words are one untitled pair', () => {
  const { sets, rest } = shotSets(['/r/after.png', '/r/before.png']);
  assert.deepEqual(rest, []);
  assert.deepEqual(sets.map((s) => [s.screen, s.roles, s.shots.map((x) => x.path)]), [['', ['before', 'after'], ['/r/before.png', '/r/after.png']]]);
});
