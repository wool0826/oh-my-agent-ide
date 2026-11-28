/* eslint-disable @typescript-eslint/no-explicit-any -- SDK message fields the SDK types leave out (rate_limit_info). */
// Exporting a Worker's work (item 12A): what main gathers for the Markdown (shared/exportMd.ts writes it), saving it
// as a .md file, and publishing it as a claude.ai artifact through a one-off session with the Artifact tool.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { store } from './store';
import { workers } from './agents/workers';
import { accounts } from './accounts';
import { artifactEnv, connectorSettings } from './agents/connectors';
import { claudeHelperModel } from './settings';
import { claudeExecutable } from './runtime';
import { fakeMode } from './fake';
import { e2eOpened, e2ePublish } from './ipc/e2e';
import { log } from './log';
import { hasSpend, spendOf } from '../shared/spend';
import { artifactUrl, PUBLISH_TOOLS, publishToolOk, type ExportSource } from '../shared/exportMd';

/** Everything an export of Worker `workerId` can hold. The whole conversation, up to this many lines. */
const LOG_LINES = 5000;

export async function exportSource(workerId: string): Promise<ExportSource | null> {
  const w = store.worker(String(workerId));
  if (!w) return null;
  const tasks = store.data.tasks.filter((x) => x.workerId === w.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const [page, diff] = await Promise.all([
    store.readLog(w.id, undefined, LOG_LINES),
    w.repo ? workers.diff(w.id).catch(() => null) : Promise.resolve(null),
  ]);
  return {
    worker: { id: w.id, title: w.title, repo: w.repo },
    tasks: tasks.map((x) => ({ id: x.id, title: x.title, branch: x.branch, prUrl: x.prUrl, prState: x.prState, prChecks: x.prChecks ?? null, summary: x.summary, files: x.files, links: x.links })),
    log: page.items,
    diff: diff?.files ?? [],
    home: os.homedir(),
  };
}

/** Asks where to save `md`, offering `name` in Downloads. The path it was saved to, or null when cancelled. */
export async function saveExport(win: BrowserWindow | null, name: string, md: string): Promise<string | null> {
  const file = path.basename(String(name)).replace(/[^\w.-]+/g, '-') || 'export.md';
  if (fakeMode()) { e2eOpened.push(['export:save', file]); return file; }
  const opts = { defaultPath: path.join(app.getPath('downloads'), file), filters: [{ name: 'Markdown', extensions: ['md'] }] };
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, String(md), 'utf8');
  return r.filePath;
}

export type PublishResult = { ok: true; url: string } | { ok: false; why: 'login' | 'failed'; msg?: string };

/** How long a publish may take before it counts as failed. */
const PUBLISH_MS = 5 * 60_000;
/** An image larger than this is left out of the upload. */
const SHOT_BYTES = 15 * 1024 * 1024;

/** The publish running now: one at a time, and closing the dialog stops it. */
let running: AbortController | null = null;

export function cancelPublish() {
  running?.abort();
  running = null;
}

/**
 * Publishes `md` as a private artifact. The Artifact tool needs a claude.ai login, so the claude.ai account signed in
 * with /login runs it; without one the answer is `login`. `shots` are images on this computer the page shows.
 */
export async function publishExport(md: string, title: string, shots: string[]): Promise<PublishResult> {
  if (fakeMode()) {
    e2eOpened.push(['export:publish', String(title)]);
    if (e2ePublish.delay) {
      const ac = new AbortController();
      cancelPublish();
      running = ac;
      await new Promise<void>((r) => { const t = setTimeout(r, e2ePublish.delay); ac.signal.addEventListener('abort', () => { clearTimeout(t); r(); }); });
      if (ac.signal.aborted) { e2eOpened.push(['export:cancelled', String(title)]); return { ok: false, why: 'failed', msg: 'cancelled' }; }
      if (running === ac) running = null;
    }
    return e2ePublish.why ? { ok: false, why: e2ePublish.why } : { ok: true, url: 'https://claude.ai/artifact/e2e-export' };
  }
  const acc = accounts.list().find((a) => a.kind === 'login' && a.provider === 'claude');
  if (!acc) return { ok: false, why: 'login' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-export-'));
  // Only absolute paths of image files that exist and are not huge (the names come from reports agents wrote).
  const images = shots.filter((f) => { try { return path.isAbsolute(f) && fs.statSync(f).isFile() && fs.statSync(f).size <= SHOT_BYTES; } catch { return false; } });
  fs.writeFileSync(path.join(dir, 'export.md'), String(md), 'utf8');
  images.forEach((f, i) => fs.copyFileSync(f, path.join(dir, `shot-${i + 1}${path.extname(f).toLowerCase()}`)));
  const prompt = [
    `Publish the Markdown in export.md (in the current folder) as a private claude.ai artifact titled "${String(title).replace(/"/g, "'")}".`,
    'Build one HTML page that shows that Markdown as it is: keep every word, heading, list, code and diff block; add nothing and leave nothing out. Values shown as a mask stay masked.',
    images.length ? `Publish these images in the current folder with the page and show them in its screenshots section, in this order: ${images.map((_f, i) => `shot-${i + 1}${path.extname(images[i]).toLowerCase()}`).join(', ')}.` : '',
    'Write the page in the current folder, publish it with the Artifact tool, then reply with only the artifact URL.',
  ].filter(Boolean).join('\n');
  const ac = new AbortController();
  cancelPublish();
  running = ac;
  const timer = setTimeout(() => ac.abort(), PUBLISH_MS);
  try {
    const q = query({
      prompt,
      options: {
        model: claudeHelperModel(),
        cwd: dir,
        env: artifactEnv(accounts.env(acc.id), true),
        tools: PUBLISH_TOOLS,
        settingSources: [],
        settings: connectorSettings(true),
        maxTurns: 20,
        persistSession: false,
        abortController: ac,
        pathToClaudeCodeExecutable: claudeExecutable(),
        // The exported text is not trusted: every call is checked to stay in this folder (shared/exportMd.ts).
        canUseTool: async (name, input) => (publishToolOk(name, input, dir)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: `Only files in ${dir} may be used.` }),
      },
    });
    for await (const m of q) {
      if (m.type === 'rate_limit_event') accounts.applyEvent(acc.id, (m as any).rate_limit_info);
      if (m.type !== 'result') continue;
      const spend = spendOf(m);
      if (hasSpend(spend)) store.dispatcherSpent(spend);
      const url = m.subtype === 'success' ? artifactUrl(m.result) : null;
      if (url) return { ok: true, url };
      log.warn('export publish gave no link', m.subtype === 'success' ? m.result.slice(0, 300) : m.subtype);
      return { ok: false, why: 'failed', msg: m.subtype === 'success' ? undefined : m.subtype };
    }
    return { ok: false, why: 'failed' };
  } catch (e) {
    log.warn('export publish failed', (e as Error).message);
    return { ok: false, why: 'failed', msg: ac.signal.aborted ? (running === ac ? 'timeout' : 'cancelled') : (e as Error).message };
  } finally {
    clearTimeout(timer);
    if (running === ac) running = null;
    fs.rm(dir, { recursive: true, force: true }, () => undefined);
  }
}
