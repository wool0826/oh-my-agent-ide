// The side terminal: a tab of the dock under the chat (ui/dock.ts). The user's own shells, a tab each (ui/xterm.ts,
// main/pty.ts); in the line mode (OMA_PTY=0, or node-pty not loading) lines run as "!" lines do, without the chat
// (shared/terminal.ts, main/terminal.ts): Enter runs, ↑ / ↓ go through what was run. Esc puts the dock away.
import { pushHistory, TERM_EMPTY, type TermRun, type TermView } from '../../shared/terminal';
import { shellClock, shellTook } from '../../shared/shell';
import { $, esc, isMac, S, sym, t, toast, tryCall, ui } from './core';
import { openPop, pop } from './controls';
import { setTip } from './tip';
import { dock, onDock, setDock } from './dock';
import { cwdButton, outHtml } from './shell';
import { bindPty, focusPty, newTab, pty, ptyOn, renderPty } from './xterm';

const REPO_KEY = 'oma.termRepo';

export const term = {
  /** Its tab shows in the dock. */
  get open() { return dock.tab === 'tm'; },
  view: { ...TERM_EMPTY } as TermView,
  history: [] as string[],
  /** Where ↑ / ↓ is in the history; history.length is the line being typed. */
  at: 0,
  /** What was typed before ↑, back on ↓ past the newest. */
  draft: '',
  key: '',
};

/** Follow the output while the view is at its end. */
let stick = true;

/** The folder picked is still a registered repository; else the IDE home. */
function repoNow(): string {
  const r = localStorage.getItem(REPO_KEY) ?? '';
  return r && S?.repos.some((x) => x.name === r) ? r : '';
}

export function openTerm() {
  setDock('tm');
  renderTerm();
  if (!ptyOn()) { $<HTMLTextAreaElement>('#tm-input').focus(); return; }
  // The first tab opens with the terminal.
  if (pty.view.tabs.length || pty.opening) focusPty(); else void newTermTab();
}

/** A tab in the folder picked; the line mode when the real terminal turns out to be off. */
export async function newTermTab() {
  if (await newTab(repoNow()) || ptyOn() || !term.open) return;
  $<HTMLTextAreaElement>('#tm-input').focus();
}

/** The last tab closed puts the dock away first, so it never shows empty. */
/** Puts the dock away; the runs stay. */
export function hideTerm(focusChat = true) {
  if (!term.open) return;
  setDock(null);
  if (focusChat) $<HTMLTextAreaElement>('#chat-input').focus();
}

export function toggleTerm() {
  if (term.open) hideTerm(); else openTerm();
}

export function setTermView(v: TermView) {
  term.view = v;
  renderTerm();
}

export async function runTerm() {
  const input = $<HTMLTextAreaElement>('#tm-input');
  const line = input.value.trim();
  if (!line) return;
  const r = await tryCall('term:run', line, repoNow() || null);
  if (!r.ok) { toast(r.error, true); return; }
  term.history = pushHistory(term.history, line);
  term.at = term.history.length;
  term.draft = '';
  input.value = '';
  fitInput(input);
  // A new run is followed to the end.
  stick = true;
}

export function pickTermFolder(owner: HTMLElement) {
  const items = [{ value: '', label: t('shell.home') }, ...(S?.repos ?? []).map((r) => ({ value: r.name, label: r.name, sub: r.path }))];
  openPop(owner, items, repoNow(), (v) => {
    localStorage.setItem(REPO_KEY, v);
    term.key = '';
    renderTerm();
    // A shell runs where it started: a folder picked opens a new tab there.
    if (ptyOn()) void newTermTab(); else $<HTMLTextAreaElement>('#tm-input').focus();
  }, 200);
}

/** ↑ / ↓ on the first / last line of the input go through the history. */
function recall(input: HTMLTextAreaElement, dir: -1 | 1): boolean {
  const before = input.value.slice(0, input.selectionStart);
  const after = input.value.slice(input.selectionEnd);
  if (dir < 0 ? before.includes('\n') : after.includes('\n')) return false;
  const next = term.at + dir;
  if (next < 0 || next > term.history.length) return false;
  if (term.at === term.history.length) term.draft = input.value;
  term.at = next;
  input.value = next === term.history.length ? term.draft : term.history[next];
  input.setSelectionRange(input.value.length, input.value.length);
  fitInput(input);
  return true;
}

function keys(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return;
  const el = e.target as HTMLElement;
  if (e.key === 'Escape' && !pop.el) { e.preventDefault(); e.stopPropagation(); hideTerm(); return; }
  if (el.id !== 'tm-input') return;
  const input = el as HTMLTextAreaElement;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void runTerm(); return; }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    if (recall(input, e.key === 'ArrowUp' ? -1 : 1)) e.preventDefault();
    return;
  }
  // Ctrl+L clears, as in a terminal.
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyL') { e.preventDefault(); void tryCall('term:clear'); }
}

function fitInput(input: HTMLTextAreaElement) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}

export function bindTerm() {
  // Esc anywhere in the dock while this tab shows: on its header too.
  $('#dock').addEventListener('keydown', (e) => { if (term.open) keys(e); });
  $('#tm-form').addEventListener('submit', (e) => { e.preventDefault(); void runTerm(); });
  const input = $<HTMLTextAreaElement>('#tm-input');
  input.addEventListener('input', () => { fitInput(input); term.at = term.history.length; });
  onDock(renderTerm);
  // The last tab gone (exit): the dock goes away, and the chat gets the keys if the terminal had them.
  bindPty({ render: renderTerm, empty: () => hideTerm($('#dock').contains(document.activeElement)) });
  $('#tm-thread').addEventListener('scroll', () => {
    const th = $('#tm-thread');
    stick = th.scrollHeight - th.scrollTop - th.clientHeight < 24;
  });
}

function headHtml(r: TermRun) {
  const where = r.repo || t('shell.home');
  const pill = r.running ? `<span class="pill" data-tone="accent"><i class="sh-spin" aria-hidden="true"></i>${t('shell.running')}</span>`
    : r.stopped ? `<span class="pill">${t('shell.stopped')}</span>`
    : `<span class="pill" data-tone="${r.code === 0 ? 'success' : 'danger'}">${t('shell.exit', { n: r.code ?? '?' })}</span>`;
  const time = r.running ? `<time data-start="${esc(r.startedAt)}">${shellClock(Date.now() - Date.parse(r.startedAt))}</time>` : `<time>${shellTook(r.ms)}</time>`;
  const stop = r.running ? `<button type="button" class="btn btn-sm tm-stop" data-action="tm-stop" data-id="${esc(r.id)}" aria-label="${esc(t('shell.stopAria', { cmd: r.cmd }))}">${t('shell.stop')}</button>` : '';
  return `<span class="tm-ps" aria-hidden="true">$</span><code>${esc(r.cmd)}</code><span class="tm-in">${esc(where)}</span>${pill}${time}${stop}`;
}

/**
 * Each run's node is kept and changed in place, by its id: output being read, selected or scrolled stays put, and
 * the log announces only what is new.
 */
function patchRuns(th: HTMLElement, runs: TermRun[]) {
  if (!runs.length) { th.innerHTML = `<p class="tm-empty">${t('term.empty')}</p>`; return; }
  th.querySelector('.tm-empty')?.remove();
  const nodes = new Map([...th.querySelectorAll<HTMLElement>('.tm-run')].map((n) => [n.dataset.id!, n]));
  const ids = new Set(runs.map((r) => r.id));
  for (const [id, n] of nodes) if (!ids.has(id)) n.remove();
  for (const r of runs) {
    let n = nodes.get(r.id);
    if (!n) {
      n = document.createElement('div');
      n.className = 'tm-run';
      n.dataset.id = r.id;
      n.innerHTML = '<div class="tm-cmd"></div>';
      th.append(n);
    }
    n.classList.toggle('live', r.running);
    // The header only when its state changed: a running time goes on by itself (the timer below).
    const headKey = JSON.stringify([r.running, r.stopped, r.code, r.ms, r.repo, t('shell.home')]);
    if (n.dataset.head !== headKey) { n.dataset.head = headKey; n.querySelector('.tm-cmd')!.innerHTML = headHtml(r); }
    const out = r.out.replace(/\n+$/, '');
    // stderr in the danger colour, each stretch of it folded to its first line (G2): the same as a "!" run.
    const html = out ? outHtml(r.id, out, r.err) : '';
    let pre = n.querySelector<HTMLElement>('.tm-out');
    if (html && !pre) { pre = document.createElement('pre'); pre.className = 'tm-out'; n.append(pre); }
    if (pre && pre.dataset.html !== html) { if (html) { pre.innerHTML = html; pre.dataset.html = html; } else pre.remove(); }
  }
}

/** The composer button: pressed while the panel shows, with how many runs are going while it is hidden. */
function renderButton() {
  const btn = $<HTMLButtonElement>('#chat-tm');
  const n = term.view.runs.filter((r) => r.running).length;
  btn.classList.toggle('on', term.open);
  btn.setAttribute('aria-pressed', String(term.open));
  const label = n && !term.open ? t('term.buttonCount', { n }) : t('term.title');
  btn.setAttribute('aria-label', label);
  setTip(btn, label, isMac ? '⌃`' : 'Ctrl+`');
  btn.innerHTML = `${sym('s-term')}${n && !term.open ? `<i>${n}</i>` : ''}`;
}

export function renderTerm() {
  renderButton();
  const panel = $('#tm');
  panel.hidden = !term.open;
  if (!term.open) return;
  const on = ptyOn();
  $('#tm-x').hidden = !on;
  $('#tm-tabs').hidden = !on;
  $('#tm-new').hidden = !on;
  $('#tm-thread').hidden = on;
  $('#tm-form').hidden = on;
  // node-pty did not load: a warning, its reason in the log (turned off on purpose: none).
  $('#tm-off').hidden = on || !pty.view.reason;
  const repo = repoNow();
  const where = repo || t('shell.home');
  const slot = $('#tm-cwd-slot');
  const cwd = cwdButton('tm-cwd', where, 'tm-cwd');
  if (slot.dataset.html !== cwd) { slot.dataset.html = cwd; slot.innerHTML = cwd; }
  if (on) { renderPty(); return; }
  const key = JSON.stringify([term.view, where, t('term.title'), [...ui.errOpen]]);
  if (key === term.key) return;
  term.key = key;
  const th = $('#tm-thread');
  patchRuns(th, term.view.runs);
  if (stick) th.scrollTop = th.scrollHeight;
}

/** The time on running lines goes on by itself. */
setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>('#tm-thread .tm-run.live time[data-start]')) {
    el.textContent = shellClock(Date.now() - Date.parse(el.dataset.start!));
  }
}, 1000);
