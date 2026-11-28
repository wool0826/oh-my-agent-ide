import { contextBridge, ipcRenderer, webUtils } from 'electron';

async function call(channel: string, ...args: unknown[]) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

contextBridge.exposeInMainWorld('ide', {
  platform: process.platform,
  call,
  onState: (fn: (s: unknown) => void) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onWorkerLog: (fn: (id: string, item: unknown) => void) => ipcRenderer.on('workerLog', (_e, id, item) => fn(id, item)),
  onDecisionAlert: (fn: (loud: boolean) => void) => ipcRenderer.on('decision-alert', (_e, loud) => fn(loud !== false)),
  /** The side question's thread changed (main/side.ts). */
  onSideState: (fn: (v: unknown) => void) => ipcRenderer.on('side-state', (_e, v) => fn(v)),
  /** The side terminal's runs changed (main/terminal.ts). */
  onTermState: (fn: (v: unknown) => void) => ipcRenderer.on('term-state', (_e, v) => fn(v)),
  /** The real terminal's tabs changed, and the output of one (main/pty.ts); `end` is where that piece ends in all of it. */
  onPtyState: (fn: (v: unknown) => void) => ipcRenderer.on('pty-state', (_e, v) => fn(v)),
  onPtyData: (fn: (id: string, d: string, end: number) => void) => ipcRenderer.on('pty-data', (_e, id, d, end) => fn(String(id), String(d), Number(end))),
  /** Keys typed, a new size and output drawn: sent without waiting for an answer, on these channels only. */
  ptySend: (what: 'write' | 'resize' | 'drawn', ...args: unknown[]) => { if (what === 'write' || what === 'resize' || what === 'drawn') ipcRenderer.send(`pty:${what}`, ...args); },
  onDoneAlert: (fn: () => void) => ipcRenderer.on('done-alert', () => fn()),
  onOpenResult: (fn: (taskId: string) => void) => ipcRenderer.on('open-result', (_e, id) => fn(String(id))),
  /** A usage warning's OS notification was clicked: the usage popover opens. */
  onUsageOpen: (fn: () => void) => ipcRenderer.on('usage-open', () => fn()),
  /** Back or Forward from an app command (mouse side buttons, Back keys). */
  onNav: (fn: (dir: 'back' | 'forward') => void) => ipcRenderer.on('nav', (_e, dir) => fn(dir)),
  /** The window entered or left full screen. */
  onFullScreen: (fn: (on: boolean) => void) => ipcRenderer.on('fullscreen', (_e, on) => fn(on === true)),
  /** Absolute path of a dropped file or folder. */
  pathForFile: (f: File) => webUtils.getPathForFile(f),
});
