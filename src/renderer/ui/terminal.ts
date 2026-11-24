// The side terminal (shared/terminal.ts, main/terminal.ts): a floating panel at the chat's left where lines run as
// "!" lines do, without the chat. Enter runs, ↑ / ↓ go through what was run, Esc hides it; the corner resizes it.
import { clampTermSize, pushHistory, TERM_DEF, TERM_EMPTY, type TermRun, type TermView } from '../../shared/terminal';
import { shellClock, shellTook } from '../../shared/shell';
import { $, esc, isMac, S, sym, t, toast, tryCall } from './core';
import { openPop, pop } from './controls';
import { setTip } from './tip';

const SIZE_KEY = 'oma.termSize';
const REPO_KEY = 'oma.termRepo';

export const term = {
  open: false,
  view: { ...TERM_EMPTY } as TermView,
  history: [] as string[],
  /** Where ↑ / ↓ is in the history; history.length is the line being typed. */
  at: 0,
  /** What was typed before ↑, back on ↓ past the newest. */
  draft: '',
  key: '',
};

function readSize() {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null') as { w?: number; h?: number } | null;
    return { w: Number(v?.w ?? TERM_DEF.w), h: Number(v?.h ?? TERM_DEF.h) };
  } catch { return { ...TERM_DEF }; }
}
let size = readSize();
/** Follow the output while the view is at its end. */
let stick = true;

/** The folder picked is still a registered repository; else the IDE home. */
function repoNow(): string {
  const r = localStorage.getItem(REPO_KEY) ?? '';
  return r && S?.repos.some((x) => x.name === r) ? r : '';
}

export function openTerm() {
  term.open = true;
  renderTerm();
  $<HTMLTextAreaElement>('#tm-input').focus();
}

export function hideTerm(focusChat = true) {
  if (!term.open) return;
  term.open = false;
  renderTerm();
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
    $<HTMLTextAreaElement>('#tm-input').focus();
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
  if (el.id === 'tm-grip') { gripKeys(e); return; }
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

/** The room the panel has: the chat's column, above the composer. */
function room() {
  const main = $('#tm').parentElement!;
  const composer = document.getElementById('chat-form');
  return { w: main.clientWidth - 32, h: main.clientHeight - (composer?.offsetHeight ?? 0) - 48 };
}

function applySize() {
  const panel = $('#tm');
  const s = clampTermSize(size.w, size.h, room());
  panel.style.width = `${s.w}px`;
  panel.style.height = `${s.h}px`;
}

function saveSize() {
  size = clampTermSize(size.w, size.h, room());
  try { localStorage.setItem(SIZE_KEY, JSON.stringify(size)); } catch { /* not kept */ }
}

/** The grip on the top right corner: the panel sits at the bottom left, so it grows up and to the right. */
function bindGrip() {
  const grip = $('#tm-grip');
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, w: $('#tm').offsetWidth, h: $('#tm').offsetHeight };
    const move = (m: PointerEvent) => {
      size = { w: start.w + (m.clientX - start.x), h: start.h - (m.clientY - start.y) };
      applySize();
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      saveSize();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  // Double click: back to the first size.
  grip.addEventListener('dblclick', () => { size = { ...TERM_DEF }; applySize(); saveSize(); });
}

/** Arrows resize from the keyboard: → / ← wider / narrower, ↑ / ↓ taller / shorter; with Shift by more. */
function gripKeys(e: KeyboardEvent) {
  const step = e.shiftKey ? 64 : 16;
  const d = { ArrowRight: [step, 0], ArrowLeft: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
  if (!d) return;
  e.preventDefault();
  const s = clampTermSize(size.w, size.h, room());
  size = { w: s.w + d[0], h: s.h + d[1] };
  applySize();
  saveSize();
}

export function bindTerm() {
  $('#tm').addEventListener('keydown', keys);
  $('#tm-form').addEventListener('submit', (e) => { e.preventDefault(); void runTerm(); });
  const input = $<HTMLTextAreaElement>('#tm-input');
  input.addEventListener('input', () => { fitInput(input); term.at = term.history.length; });
  bindGrip();
  window.addEventListener('resize', () => { if (term.open) applySize(); });
  $('#tm-thread').addEventListener('scroll', () => {
    const th = $('#tm-thread');
    stick = th.scrollHeight - th.scrollTop - th.clientHeight < 24;
  });
}

function runHtml(r: TermRun) {
  const where = r.repo || t('shell.home');
  const pill = r.running ? `<span class="pill blue"><i class="sh-spin" aria-hidden="true"></i>${t('shell.running')}</span>`
    : r.stopped ? `<span class="pill gray">${t('shell.stopped')}</span>`
    : `<span class="pill ${r.code === 0 ? 'green' : 'red'}">${t('shell.exit', { n: r.code ?? '?' })}</span>`;
  const time = r.running ? `<time data-start="${esc(r.startedAt)}">${shellClock(Date.now() - Date.parse(r.startedAt))}</time>` : `<time>${shellTook(r.ms)}</time>`;
  const stop = r.running ? `<button type="button" class="btn tm-stop" data-action="tm-stop" data-id="${esc(r.id)}" aria-label="${esc(t('shell.stopAria', { cmd: r.cmd }))}">${t('shell.stop')}</button>` : '';
  const out = r.out.replace(/\n+$/, '');
  return `<div class="tm-run${r.running ? ' live' : ''}" data-id="${esc(r.id)}"><div class="tm-cmd"><span class="tm-ps" aria-hidden="true">$</span><code>${esc(r.cmd)}</code><span class="tm-in">${esc(where)}</span>${pill}${time}${stop}</div>${out ? `<pre class="tm-out">${esc(out)}</pre>` : ''}</div>`;
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
  const composer = document.getElementById('chat-form');
  if (composer) panel.style.bottom = `${composer.offsetHeight + 24}px`;
  applySize();
  const repo = repoNow();
  const where = repo || t('shell.home');
  const key = JSON.stringify([term.view, where, t('term.title')]);
  if (key === term.key) return;
  term.key = key;
  const cwd = $('#tm-cwd');
  cwd.innerHTML = `${t('shell.in', { where: `<b>${esc(where)}</b>` })}<svg class="chev" aria-hidden="true"><use href="#s-chev"/></svg>`;
  cwd.setAttribute('aria-label', t('shell.folderAria', { where }));
  const th = $('#tm-thread');
  th.innerHTML = term.view.runs.length ? term.view.runs.map(runHtml).join('') : `<p class="tm-empty">${t('term.empty')}</p>`;
  if (stick) th.scrollTop = th.scrollHeight;
}

/** The time on running lines goes on by itself. */
setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>('#tm-thread .tm-run.live time[data-start]')) {
    el.textContent = shellClock(Date.now() - Date.parse(el.dataset.start!));
  }
}, 1000);
