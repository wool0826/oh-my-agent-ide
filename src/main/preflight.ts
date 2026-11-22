// Runs the checks of shared/preflight.ts on this computer (decision 131).

import fs from 'node:fs';
import path from 'node:path';
import { loadSettings } from './settings';
import { accounts } from './accounts';
import { paths } from './paths';
import { ghEnv } from './repos';
import { run } from './util';
import { fakeMode } from './fake';
import { fixCommand, ghChecks, preflightPlan, toolCheck, type Check } from '../shared/preflight';

let last: Check[] | null = null;

/** The result of the last run, for the state every window gets. Null until the first run ends. */
export const lastPreflight = () => last;

export async function runPreflight(): Promise<Check[]> {
  const s = loadSettings();
  const plan = preflightPlan({ githubHost: s.githubHost, models: [s.dispatcherModel, s.workerModel, s.designModel], providers: accounts.list().map((a) => a.provider), fake: fakeMode() });
  const out: Check[] = [];

  // process.env.PATH already holds the login shell's PATH and the common tool folders (main/toolpath.ts).
  const searched = process.env.PATH ?? '';
  out.push(toolCheck('git', await run('git', ['--version'], { timeoutMs: 15_000 }), searched));

  out.push(...await ghChecks((args, host) => run('gh', args, host ? { env: { ...ghEnv(), GH_HOST: host }, timeoutMs: 30_000 } : { timeoutMs: 15_000 }), plan.hosts, searched));

  if (plan.account) out.push({ id: 'account', ok: accounts.list().length > 0, detail: String(accounts.list().length) });

  if (plan.codex) {
    out.push(toolCheck('codex', await run('codex', ['--version'], { timeoutMs: 15_000 }), searched));
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

  for (const c of out) if (!c.ok) c.cmd = fixCommand(c, process.platform) ?? undefined;
  last = out;
  return out;
}
