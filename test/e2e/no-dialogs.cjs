// Loaded into the app's main process for every e2e launch with NODE_OPTIONS=--require (test/e2e/harness.mjs).
// An error box is a native window on the desktop of whoever runs the tests, and it holds the main process until
// someone clicks it: here its title and text go to stderr (the launch's electron.log) instead.
if (process.type === 'browser') {
  // Electron's own module answers to the name only once the app's script starts (see still.cjs).
  setImmediate(() => {
    const { dialog } = require('electron');
    dialog.showErrorBox = (title, content) => { process.stderr.write(`e2e: error box suppressed: ${title}\n${content}\n`); };
  });
}
