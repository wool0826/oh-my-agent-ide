import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DECISION_SOUNDS, DONE_SOUNDS, DONE_SOUND_DEFAULT, NOTES, cleanDoneSound } from '../src/shared/sounds';
import { tr, type Key } from '../src/shared/i18n';

const tune = (name: keyof typeof NOTES) => JSON.stringify(NOTES[name].map((n) => [n.freq, n.at]));

test('a task end has a sound of its own, unlike any a decision can pick', () => {
  assert.equal(DONE_SOUND_DEFAULT, 'soft');
  assert.ok(!DECISION_SOUNDS.includes('soft'));
  for (const d of DECISION_SOUNDS) if (d in NOTES) assert.notEqual(tune(d as keyof typeof NOTES), tune('soft'), d);
  // It falls where the decision chime rises.
  const [a, b] = NOTES.soft;
  assert.ok(b.at > a.at && b.freq < a.freq);
});

test('the task-end sound can be silenced or changed, and a stored value that is not one of them falls back', () => {
  assert.ok(DONE_SOUNDS.includes('none'));
  assert.ok(!DONE_SOUNDS.includes('custom'));
  for (const v of DONE_SOUNDS) assert.equal(cleanDoneSound(v), v);
  assert.equal(cleanDoneSound('custom'), 'soft');
  assert.equal(cleanDoneSound(undefined), 'soft');
  assert.equal(cleanDoneSound(42), 'soft');
});

test('every sound on offer has a name in both languages and notes unless it is silence or a file', () => {
  for (const s of new Set([...DECISION_SOUNDS, ...DONE_SOUNDS])) {
    for (const l of ['en', 'ko'] as const) assert.notEqual(tr(l, `sound.${s}` as Key), `sound.${s}`);
    if (s !== 'none' && s !== 'custom') assert.ok(NOTES[s as keyof typeof NOTES].length > 0, s);
  }
});
