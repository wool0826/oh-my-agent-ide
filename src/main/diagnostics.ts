// Gathers the diagnostics report and saves it where the user chooses (decision 132).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { loadSettings, settingsView } from './settings';
import { accounts } from './accounts';
import { store } from './store';
import { automations } from './automations';
import { paths } from './paths';
import { fakeMode } from './fake';
import { lastPreflight, runPreflight } from './preflight';
import { diagnosticsText, tailLines } from '../shared/diagnostics';

const LOG_LINES = 400;

const tally = (list: { status: string }[]) => list.reduce<Record<string, number>>((m, x) => { m[x.status] = (m[x.status] ?? 0) + 1; return m; }, {});

/** What names the user or their company, and what stands in for it in the report. */
function hidden() {
  const s = loadSettings();
  const host = (v: string) => { try { return new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`).hostname; } catch { return ''; } };
  let user = '';
  try { user = os.userInfo().username; } catch { /* unknown */ }
  const gh = s.githubHost.trim();
  return [
    { text: gh && gh.toLowerCase() !== 'github.com' ? gh : '', as: '<company-github>' },
    { text: s.jiraUrl.trim() ? host(s.jiraUrl.trim()) : '', as: '<jira>' },
    { text: s.jiraEmail, as: '<email>' },
    { text: s.memoryRemote, as: '<memory-remote>' },
    { text: user, as: '<user>' },
  ];
}

/** The report as text. Tokens never enter it: settings come from the view the window gets, and the text is redacted again. */
export async function diagnostics(): Promise<string> {
  const checks = lastPreflight() ?? await runPreflight();
  let log = '';
  try { log = tailLines(fs.readFileSync(paths().appLog, 'utf8'), LOG_LINES); } catch { /* no log yet */ }
  return diagnosticsText({
    app: { version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron ?? '', node: process.versions.node, fake: fakeMode() },
    settings: settingsView() as unknown as Record<string, unknown>,
    accounts: accounts.list().map((a) => ({ label: a.label, kind: a.kind, provider: a.provider, plan: a.plan, limited: accounts.isLimited(a), lastError: a.lastError })),
    checks,
    counts: {
      workers: tally(store.data.workers), tasks: tally(store.data.tasks),
      decisionsPending: store.data.decisions.filter((d) => d.status === 'pending').length,
      repos: store.data.repos.length, automations: automations.list().length,
    },
    log,
    hide: hidden(),
    now: new Date().toISOString(),
  });
}

/** Asks where to save the report and writes it. Null when the user cancels. */
export async function exportDiagnostics(win: BrowserWindow | null): Promise<string | null> {
  const name = `oh-my-agent-ide-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`;
  const opts = { defaultPath: path.join(app.getPath('downloads'), name), filters: [{ name: 'Text', extensions: ['txt'] }] };
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, await diagnostics(), 'utf8');
  return r.filePath;
}
