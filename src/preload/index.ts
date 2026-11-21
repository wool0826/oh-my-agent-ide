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
  onDecisionAlert: (fn: () => void) => ipcRenderer.on('decision-alert', () => fn()),
  /** Back or Forward from an app command (mouse side buttons, Back keys). */
  onNav: (fn: (dir: 'back' | 'forward') => void) => ipcRenderer.on('nav', (_e, dir) => fn(dir)),
  /** Absolute path of a dropped file or folder. */
  pathForFile: (f: File) => webUtils.getPathForFile(f),
});
