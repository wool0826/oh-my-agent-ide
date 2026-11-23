// A stand-in for a Claude Code or Codex session that follows a script instead of a model (decision 127).
// With OMA_FAKE_AGENT=1 every agent in the app is one of these: no account is used, nothing is sent anywhere,
// and the app's own paths (permissions, questions, plans, results, slots) run exactly as they do for a real agent.

import fs from 'node:fs';
import path from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { FAKE_DEFAULT_REPORT, fakeReport, parseFakeScript, type FakeStep } from '../../shared/fakeScript';
import type { StepsFn } from './workerTools';
import type { SessionEvents } from './session';
import { run } from '../util';

export interface FakeSessionConfig {
  label: string;
  model: string;
  cwd: string;
  accountId: string | null;
  resume: string | null;
  /** The owner's real permission, question and plan handler: the script's asks go through it. */
  canUseTool?: CanUseTool;
  permissionMode?: string;
  /** Dispatcher only: creates a task the way its create_task tool does, and says what happened. */
  createTask?: (a: { title: string; prompt: string; kind: 'code' | 'other'; repo?: string; bundle?: string }) => Promise<string>;
  /** Worker only: its set_steps and step_done tools. */
  steps?: StepsFn;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export class FakeSession {
  cfg: FakeSessionConfig;
  ev: SessionEvents;
  sessionId: string | null;
  contextTokens = 0;
  busy = false;
  closed = false;
  background = 0;
  private queue: string[] = [];
  private abort: AbortController | null = null;

  constructor(cfg: FakeSessionConfig, ev: SessionEvents) {
    this.cfg = cfg;
    this.ev = ev;
    this.sessionId = cfg.resume;
  }

  get accountId() { return this.cfg.accountId; }
  ready() { return true; }

  start() {
    if (!this.sessionId) this.sessionId = `fake-${this.cfg.label}-${Date.now().toString(36)}`;
    this.ev.onInit?.(this.sessionId);
    this.ev.onAccount?.(this.cfg.accountId);
  }

  send(text: string) {
    if (this.closed) return;
    this.queue.push(text);
    if (!this.busy) void this.drain();
  }

  compact() { /* nothing to compact */ }
  setEffort() { /* no model */ }
  async setMode(mode: string) { this.cfg.permissionMode = mode; }
  async interrupt() { this.abort?.abort(); }
  async supportedModels() { return null; }

  close() {
    this.closed = true;
    this.queue = [];
    this.abort?.abort();
  }

  private async drain() {
    this.busy = true;
    this.ev.onStatus?.('busy', '');
    while (this.queue.length && !this.closed) {
      const text = this.queue.shift()!;
      const r = await this.turn(text);
      if (this.closed) break;
      this.ev.onTurnEnd?.({ text: r.text, isError: r.isError, internal: false, queued: this.queue.length > 0 });
    }
    this.busy = false;
    if (!this.closed) this.ev.onStatus?.('idle', '');
  }

  /** One turn: the message's steps in order, then its report as the turn's last message. */
  private async turn(message: string): Promise<{ text: string; isError: boolean }> {
    const steps = parseFakeScript(message);
    this.abort = new AbortController();
    const signal = this.abort.signal;
    for (const step of steps) {
      if (signal.aborted) return { text: 'Interrupted.', isError: true };
      try {
        const failed = await this.step(step, signal);
        if (failed) return { text: failed, isError: true };
      } catch (e) {
        return { text: (e as Error).message, isError: true };
      }
    }
    if (signal.aborted) return { text: 'Interrupted.', isError: true };
    // A Worker's turn always ends in a report, so its task settles; the Dispatcher only says what its script says.
    const report = fakeReport(steps) || (this.cfg.createTask ? '' : FAKE_DEFAULT_REPORT);
    if (report) this.ev.onText?.(report);
    return { text: report, isError: false };
  }

  /** Runs a step. Returns the error text when the step ends the turn in failure. */
  private async step(s: FakeStep, signal: AbortSignal): Promise<string | null> {
    const ask = this.cfg.canUseTool;
    const opts = { signal, suggestions: [], toolUseID: `fake-${Date.now().toString(36)}` } as unknown as Parameters<CanUseTool>[2];
    switch (s.do) {
      case 'say': this.ev.onText?.(s.text); return null;
      case 'tool': this.ev.onTool?.(s.name, s.summary); return null;
      case 'wait': await sleep(s.ms, signal); return null;
      case 'tokens': this.contextTokens = s.n; this.ev.onContext?.(s.n); return null;
      case 'steps': this.cfg.steps?.({ kind: 'set', steps: s.steps }); return null;
      case 'step': this.cfg.steps?.({ kind: 'done', step: s.n }); return null;
      case 'permission': {
        this.ev.onTool?.('Bash', `$ ${s.command}`);
        const r = ask ? await ask('Bash', { command: s.command }, opts) : null;
        this.ev.onText?.(!r || r.behavior === 'allow' ? `Ran: ${s.command}` : `Not allowed: ${s.command}`);
        return null;
      }
      case 'ask': {
        if (!ask) return null;
        const input = { questions: [{ question: s.question, header: 'Fake', multiSelect: false, options: s.options.map((label) => ({ label, description: '' })) }] };
        const r = await ask('AskUserQuestion', input, opts);
        const answers = r?.behavior === 'allow' ? (r.updatedInput as { answers?: Record<string, string> } | undefined)?.answers : null;
        this.ev.onText?.(`Answer: ${answers ? Object.values(answers).join(', ') : r?.behavior === 'deny' ? r.message : ''}`);
        return null;
      }
      case 'plan': {
        if (!ask) return null;
        const r = await ask('ExitPlanMode', { plan: s.plan }, opts);
        this.ev.onText?.(r?.behavior === 'deny' ? `Plan sent back: ${r.message}` : 'Plan approved.');
        return null;
      }
      case 'write': {
        const file = path.resolve(this.cfg.cwd, s.file);
        // The script stays inside its working folder, as a Worker's sandbox would keep it.
        if (path.relative(this.cfg.cwd, file).startsWith('..')) return `Outside the working folder: ${s.file}`;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, s.content.endsWith('\n') ? s.content : `${s.content}\n`);
        this.ev.onTool?.('Write', s.file);
        return null;
      }
      case 'commit': {
        this.ev.onTool?.('Bash', `$ git commit -m "${s.message}"`);
        await run('git', ['add', '-A'], { cwd: this.cfg.cwd });
        const r = await run('git', ['-c', 'user.name=Fake Agent', '-c', 'user.email=fake@example.invalid', 'commit', '-m', s.message], { cwd: this.cfg.cwd });
        return r.code === 0 ? null : `git commit failed: ${r.stderr.trim().split('\n')[0]}`;
      }
      case 'task': {
        if (!this.cfg.createTask) return null;
        const said = await this.cfg.createTask({ title: s.title, prompt: s.prompt || s.title, kind: s.repo ? 'code' : 'other', repo: s.repo ?? undefined, bundle: s.bundle ?? undefined });
        this.ev.onText?.(said);
        return null;
      }
      case 'fail': return s.message;
      default: return null; // report steps: gathered at the end of the turn
    }
  }
}
