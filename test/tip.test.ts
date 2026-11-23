import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TIP_DELAY, tipAriaKey, tipDescribes, tipJoin, tipPlace, tipRepeats, tipWait } from '../src/shared/tip';

const box = (left: number, top: number, width = 24, height = 24) => ({ left, top, width, height });

test('the tooltip sits centred above its control, 6 away', () => {
  const p = tipPlace(box(400, 300), 100, 20, 1000, 700, false);
  assert.deepEqual(p, { left: 362, top: 274, below: false });
});

test('in the toolbar it sits below', () => {
  const p = tipPlace(box(400, 10), 100, 20, 1000, 700, true);
  assert.deepEqual(p, { left: 362, top: 40, below: true });
});

test('it goes to the other side when the wanted one has no room', () => {
  assert.equal(tipPlace(box(400, 10), 100, 20, 1000, 700, false).below, true);
  assert.equal(tipPlace(box(400, 670), 100, 20, 1000, 700, true).below, false);
});

test('it stays 8 inside the window', () => {
  assert.equal(tipPlace(box(0, 300), 100, 20, 1000, 700, false).left, 8);
  assert.equal(tipPlace(box(990, 300, 10), 100, 20, 1000, 700, false).left, 892);
  // Wider than the window: the left edge wins.
  assert.equal(tipPlace(box(100, 300), 400, 20, 300, 700, false).left, 8);
  // No room on either side: it is still inside.
  const p = tipPlace(box(100, 10, 24, 30), 100, 40, 300, 60, false);
  assert.ok(p.top >= 8);
});

test('hover waits, focus and a neighbouring tooltip do not', () => {
  assert.equal(tipWait(false, 10_000, 0), TIP_DELAY);
  assert.equal(tipWait(true, 10_000, 0), 0);
  assert.equal(tipWait(false, 10_000, 9_800), 0);
  assert.equal(tipWait(false, 10_000, 9_600), TIP_DELAY);
});

test('a tip that repeats the visible text is not shown', () => {
  assert.equal(tipRepeats('Inbox', 'Inbox\n3'), true);
  assert.equal(tipRepeats('C:/repo/src/a.ts', 'a.ts'), false);
  assert.equal(tipRepeats('Stop', ''), false);
});

test('cut text comes first and nothing is said twice', () => {
  assert.equal(tipJoin(['A long title'], ''), 'A long title');
  assert.equal(tipJoin(['A long title', 'A long title', 'second line'], 'Step 1 of 2'), 'A long title\nsecond line\nStep 1 of 2');
  assert.equal(tipJoin(['a.ts'], 'C:/repo/src/a.ts'), 'C:/repo/src/a.ts');
  assert.equal(tipJoin([], ''), '');
});

test('a tip describes its control unless it is the name or the text', () => {
  assert.equal(tipDescribes('Collapse the sidebar', 'Collapse the sidebar', ''), false);
  assert.equal(tipDescribes('npm 10.2', null, 'OK'), true);
  assert.equal(tipDescribes('Hello', null, ' Hello '), false);
});

test('a shortcut is written for a screen reader as aria-keyshortcuts wants it', () => {
  assert.equal(tipAriaKey('Ctrl+B'), 'Control+B');
  assert.equal(tipAriaKey('Ctrl+Alt+B'), 'Control+Alt+B');
  assert.equal(tipAriaKey('⌘K'), 'Meta+K');
  assert.equal(tipAriaKey('⌥⌘B'), 'Alt+Meta+B');
});

test('the renderer has no native title tooltip left', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|html)$/.test(name)) files.push(p);
    }
  };
  walk(join(process.cwd(), 'src', 'renderer'));
  const found: string[] = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      // An attribute in markup or a template, or the property set from code. `<title>` and `x.title` reads are fine.
      if (/[\s"'`]title=["$]|\.title\s*=[^=]|data-i18n-title/.test(line)) found.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
});
