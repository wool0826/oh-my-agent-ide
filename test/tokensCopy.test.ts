import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// The app loads src/renderer/tokens.css; the design system generates docs/design-system/tokens/tokens.css.
// A token added to one and not the other is how the two drifted apart before.
test('tokens: the file the app loads is the generated one under a header comment', () => {
  const app = read('src/renderer/tokens.css');
  const generated = read('docs/design-system/tokens/tokens.css');
  assert.ok(app.startsWith('/*'), 'the copy opens with its header comment');
  const end = app.indexOf('*/\n\n');
  assert.ok(end > 0, 'a blank line follows the header comment');
  assert.equal(app.slice(end + 4), generated);
});
