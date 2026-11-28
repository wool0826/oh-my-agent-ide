import fs from 'node:fs';
import path from 'node:path';
import { run } from './util';
import type { DiffFile, DiffView } from '../shared/types';

/** Files changed on the worktree's branch against the default branch, committed or not, plus untracked files. */
export async function worktreeDiff(defaultBranch: string, dir: string, local = false): Promise<DiffView> {
  const view: DiffView = { base: defaultBranch, branch: '', files: [], truncated: false };
  if (!fs.existsSync(path.join(dir, '.git'))) return { ...view, error: 'missing' };
  view.branch = (await run('git', ['branch', '--show-current'], { cwd: dir })).stdout.trim();
  const mb = await run('git', ['merge-base', 'HEAD', local ? defaultBranch : `origin/${defaultBranch}`], { cwd: dir });
  const baseRef = mb.code === 0 ? mb.stdout.trim() : 'HEAD';
  const num = await run('git', ['diff', '--numstat', '-z', '-M', baseRef], { cwd: dir });
  const status = await run('git', ['diff', '--name-status', '-z', '-M', baseRef], { cwd: dir });
  const st = new Map<string, DiffFile['status']>();
  const sp = status.stdout.split('\0');
  for (let i = 0; i < sp.length - 1;) {
    const code = sp[i][0] as DiffFile['status'];
    if (code === 'R' || (code as string) === 'C') { st.set(sp[i + 2], 'R'); i += 3; } else { st.set(sp[i + 1], code); i += 2; }
  }
  const np = num.stdout.split('\0');
  for (let i = 0; i < np.length - 1;) {
    const [a, r, name] = np[i].split('\t');
    let file = name;
    i += 1;
    if (!name) { file = np[i + 1]; i += 2; }
    view.files.push({ path: file, added: Number(a) || 0, removed: Number(r) || 0, status: st.get(file) ?? 'M', patch: '' });
  }
  const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: dir })).stdout.split('\0').filter(Boolean);
  for (const f of untracked.slice(0, 200)) {
    let text = '';
    try {
      const buf = fs.readFileSync(path.join(dir, f));
      text = buf.length > 200_000 || buf.includes(0) ? '' : buf.toString('utf8');
    } catch { /* unreadable */ }
    const lines = text ? text.replace(/\n$/, '').split('\n') : [];
    view.files.push({ path: f, added: lines.length, removed: 0, status: '?', patch: lines.length ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}` : '' });
  }
  // One patch per file, capped so a huge change cannot freeze the window.
  let budget = 600_000;
  for (const f of view.files) {
    if (f.status === '?') { budget -= f.patch.length; if (budget < 0) { f.patch = ''; view.truncated = true; } continue; }
    if (budget <= 0) { view.truncated = true; continue; }
    const r = await run('git', ['diff', '--no-color', '--no-ext-diff', '-M', '-U3', baseRef, '--', f.path], { cwd: dir });
    const body = r.stdout.slice(r.stdout.indexOf('\n@@') + 1);
    f.patch = r.stdout.includes('\n@@') ? body.slice(0, budget) : '';
    budget -= body.length;
    if (budget < 0) view.truncated = true;
  }
  await Promise.all(view.files.map(async (f) => {
    try { f.bytes = (await fs.promises.stat(path.join(dir, f.path))).size; } catch { /* deleted */ }
  }));
  return view;
}
