import { contextBridge, ipcRenderer } from 'electron';

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
  onBlink: (fn: () => void) => ipcRenderer.on('blink', () => fn()),
});
