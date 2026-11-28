import { dialog } from 'electron';
import { handle, type IpcContext } from './handle';
import { store } from '../store';
import { registerRepo, removeRepo, updateRepo, listIssues, cancelAddRepo } from '../repos';
import { dispatcher } from '../agents/dispatcher';
import { workers } from '../agents/workers';
import { runs } from '../runs';
import { automations } from '../automations';
import { pollAutomationEvents } from '../prmonitor';
import { listJiraIssues, setJiraToken } from '../jira';
import type { AutoTrigger } from '../../shared/types';

/** Repositories, their issues and Jira's, and automations. */
export function registerRepoIpc(ctx: IpcContext) {
  handle('repo:issues', (name: string) => listIssues(name));
  handle('jira:issues', () => listJiraIssues());
  handle('jira:token', (token: string) => { setJiraToken(String(token ?? '')); ctx.pushState(); });
  // A new or changed event automation takes note of what is on GitHub now, so only what comes after sets it off.
  handle('auto:add', (prompt: string, trigger: AutoTrigger, maxPerDay?: number | null) => { automations.add({ prompt, trigger, maxPerDay }); void pollAutomationEvents(); });
  handle('auto:update', (id: string, prompt: string, trigger: AutoTrigger, maxPerDay?: number | null) => { automations.update(id, { prompt, trigger, maxPerDay }); void pollAutomationEvents(); });
  handle('auto:run', (id: string) => { automations.runNow(id); });
  handle('auto:toggle', (id: string, on: boolean) => automations.setEnabled(id, on));
  handle('auto:remove', (id: string) => { automations.remove(id); });
  handle('repo:add', (url: string, name?: string, description?: string) => registerRepo({ url, name, description }).then((r) => { dispatcher.refreshContext(); return r; }));
  handle('repo:addCancel', () => cancelAddRepo());
  // Refused while one of its tasks is open; its Workers are archived and their worktrees removed first.
  handle('repo:remove', async (name: string) => {
    workers.checkRetire(name); // refused before anything is stopped
    for (const w of store.data.workers) if (w.repo === name) runs.stop(w.id);
    const kept = await workers.retireRepo(name);
    removeRepo(name);
    dispatcher.refreshContext();
    return kept;
  });
  handle('repo:update', (name: string, description: string, setup?: string, run?: string) => { updateRepo(name, { description, ...(setup === undefined ? {} : { setup: setup.trim() }), ...(run === undefined ? {} : { run: run.trim() }) }); dispatcher.refreshContext(); });
  handle('repo:pickFolder', async () => {
    const r = await dialog.showOpenDialog(ctx.win()!, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
}
