// Keeping the computer from sleeping while work runs: when to, and holding one blocker for it.
// The main process wires it to Electron's powerSaveBlocker ('prevent-app-suspension'), the same on macOS and Windows.

/** Worker states that mean work is going on: starting, in a turn, or waiting on a decision or an approval. */
const WORKING = new Set(['starting', 'running', 'waiting']);

/** Should the computer stay awake: the setting is on and a Worker works or the Dispatcher is in a turn. */
export function shouldStayAwake(s: { on: boolean; workers: { status: string }[]; dispatcherBusy: boolean }): boolean {
  return s.on && (s.dispatcherBusy || s.workers.some((w) => WORKING.has(w.status)));
}

/** What holds the computer awake: powerSaveBlocker's start and stop. */
export interface Blocker {
  start(): number;
  stop(id: number): void;
}

/** One blocker at most: `sync(true)` starts it once, `sync(false)` and `release()` stop it once. */
export function awakeHolder(blocker: Blocker) {
  let id: number | null = null;
  const release = () => {
    if (id === null) return;
    const held = id;
    id = null;
    blocker.stop(held);
  };
  return {
    sync(stay: boolean) {
      if (!stay) return release();
      if (id === null) id = blocker.start();
    },
    release,
    get held() { return id !== null; },
  };
}
