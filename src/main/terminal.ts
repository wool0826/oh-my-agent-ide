import { newRun, shellCwd, startLine, type Running } from './shell';
import { t } from './i18n';
import { uid } from './util';
import { TERM_EMPTY, trimRuns, type TermRun, type TermView } from '../shared/terminal';

/**
 * The side terminal (shared/terminal.ts): lines run as "!" lines are (main/shell.ts), kept here in memory and pushed
 * to the window on their own channel. Nothing goes into the chat or to the Dispatcher.
 */
class Terminal {
  /** The runs themselves, changed in place while they go; the window gets copies (emit). */
  private runs: TermRun[] = [];
  private view: TermView = { ...TERM_EMPTY };
  private live = new Map<string, Running>();
  private listeners: ((v: TermView) => void)[] = [];
  private timer: NodeJS.Timeout | null = null;

  state(): TermView { return this.view; }
  onChange(fn: (v: TermView) => void) { this.listeners.push(fn); }

  /** Starts `cmd` in `repo` ('' or null for the IDE home). Returns the run's id. */
  run(cmd: string, repo: string | null): string {
    const line = cmd.trim();
    if (!line) throw new Error(t('term.err.empty'));
    const where = shellCwd(repo);
    const run: TermRun = { id: uid(), ...newRun(line, where.repo), sent: 'off' };
    this.live.set(run.id, startLine(run, where.cwd, () => this.emitSoon(), () => { this.live.delete(run.id); this.emit(); }));
    this.runs = trimRuns([...this.runs, run]);
    this.emit();
    return run.id;
  }

  stop(id: string) {
    this.live.get(id)?.stop();
    this.emit();
  }

  stopAll() {
    for (const r of this.live.values()) r.stop();
  }

  /** Clear: the finished runs go; those still going stay. */
  clear() {
    this.runs = this.runs.filter((r) => r.running);
    this.emit();
  }

  /** Output comes in bursts: the window gets it at most a few times a second. */
  private emitSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.emit(); }, 150);
  }

  private emit() {
    this.view = { runs: this.runs.map((r) => ({ ...r })) };
    for (const fn of this.listeners) fn(this.view);
  }
}

export const terminal = new Terminal();
