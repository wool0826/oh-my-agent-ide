// Runs the checks of shared/preflight.ts on this computer (decision 131).

import fs from 'node:fs';
import path from 'node:path';
import { loadSettings } from './settings';
import { accounts } from './accounts';
import { paths } from './paths';
import { ghEnv } from './repos';
import { run } from './util';
import { fakeMode } from './fake';
import { preflightPlan, type Check } from '../shared/preflight';

const firstLine = (s: string) => s.trim().split('\n')[0]?.trim() ?? '';
let last: Check[] | null = null;

/** The result of the last run, for the state every window gets. Null until the first run ends. */
export const lastPreflight = () => last;

export async function runPreflight(): Promise<Check[]> {
  const s = loadSettings();
  const plan = preflightPlan({ githubHost: s.githubHost, models: [s.dispatcherModel, s.workerModel, s.designModel], providers: accounts.list().map((a) => a.provider), fake: fakeMode() });
  const out: Check[] = [];

  const git = await run('git', ['--version'], { timeoutMs: 15_000 });
  out.push({ id: 'git', ok: git.code === 0, detail: git.code === 0 ? firstLine(git.stdout) : firstLine(git.stderr) });

  const gh = await run('gh', ['--version'], { timeoutMs: 15_000 });
  out.push({ id: 'gh', ok: gh.code === 0, detail: gh.code === 0 ? firstLine(gh.stdout) : firstLine(gh.stderr) });
  // Without gh there is no sign-in to look at: one failure says it, not three.
  if (gh.code === 0) {
    for (const host of plan.hosts) {
      const r = await run('gh', ['auth', 'status', '--hostname', host], { env: { ...ghEnv(), GH_HOST: host }, timeoutMs: 30_000 });
      out.push({ id: 'ghAuth', host, ok: r.code === 0, detail: r.code === 0 ? host : firstLine(r.stderr || r.stdout) });
    }
  }

  if (plan.account) out.push({ id: 'account', ok: accounts.list().length > 0, detail: String(accounts.list().length) });

  if (plan.codex) {
    const r = await run('codex', ['--version'], { timeoutMs: 15_000 });
    out.push({ id: 'codex', ok: r.code === 0, detail: r.code === 0 ? firstLine(r.stdout) : firstLine(r.stderr) });
  }

  const home = paths().home;
  let writable = true;
  let why = home;
  try {
    const probe = path.join(paths().data, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
  } catch (e) {
    writable = false;
    why = (e as Error).message;
  }
  out.push({ id: 'home', ok: writable, detail: why });

  last = out;
  return out;
}
