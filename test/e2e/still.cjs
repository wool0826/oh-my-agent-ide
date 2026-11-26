// Loaded into the app's main process for the screen comparison (test/e2e/visual.e2e.mjs) with NODE_OPTIONS=--require.
//
// - A clock that almost stands still: Date starts at OMA_E2E_CLOCK and moves a millisecond per real second, so the
//   times the app gives tasks and messages read the same on every run. Timers do not use Date and keep real time.
// - The window is shown, without taking the focus, far off the screen: a window that is never shown draws a frame
//   only now and then, and a picture of it can wait for one for many seconds.
const start = Date.parse(process.env.OMA_E2E_CLOCK ?? '');
if (!Number.isNaN(start)) {
  const Real = Date;
  const began = Real.now();
  const now = () => start + Math.floor((Real.now() - began) / 1000);
  class FixedDate extends Real {
    constructor(...a) { if (a.length) super(...a); else super(now()); }
    static now() { return now(); }
  }
  globalThis.Date = FixedDate;
}

// Only in the app itself: the programs it starts with ELECTRON_RUN_AS_NODE (the gh stand-in) get NODE_OPTIONS too.
if (process.env.OMA_E2E_OFFSCREEN && process.type === 'browser') {
  // Electron's own module answers to the name only once the app's script starts.
  setImmediate(() => {
    require('electron').app.on('browser-window-created', (_e, win) => {
      win.setPosition(-20000, 0);
      if (!win.isVisible()) win.showInactive();
    });
  });
}
