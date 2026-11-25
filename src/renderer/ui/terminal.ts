// The side terminal (shared/terminal.ts, main/terminal.ts): a floating panel at the chat's left where lines run as
// "!" lines do, without the chat. Enter runs, ↑ / ↓ go through what was run, Esc hides it; the corner resizes it.
import { clampTermSize, keyTermSize, pushHistory, TERM_DEF, TERM_EMPTY, TERM_MIN, type TermRun, type TermView } from '../../shared/terminal';
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
  if (el.id === 'tm-rz-h' || el.id === 'tm-rz-w') { edgeKeys(e, el.dataset.edge as 'w' | 'h'); return; }
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
  ariaSize();
  try { localStorage.setItem(SIZE_KEY, JSON.stringify(size)); } catch { /* not kept */ }
}

/** The handles' values: each says the size in its own direction. */
function ariaSize() {
  const s = clampTermSize(size.w, size.h, room());
  const max = room();
  for (const [id, now, min, top] of [['#tm-rz-h', s.h, TERM_MIN.h, max.h], ['#tm-rz-w', s.w, TERM_MIN.w, max.w]] as const) {
    const h = $(id);
    h.setAttribute('aria-valuenow', String(now));
    h.setAttribute('aria-valuemin', String(min));
    h.setAttribute('aria-valuemax', String(Math.max(min, Math.round(top))));
  }
}

/**
 * The handles on the top and right edges and the top-right corner between them: the panel sits at the bottom left,
 * so it grows up and to the right.
 */
function bindEdges() {
  const panel = $('#tm');
  const handles = (edge: string | undefined) => (edge === 'both' ? ['#tm-rz-h', '#tm-rz-w'] : [`#tm-rz-${edge}`]).map((id) => $(id));
  panel.querySelectorAll<HTMLElement>('.edge-rz').forEach((grip) => {
    const edge = grip.dataset.edge;
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, w: panel.offsetWidth, h: panel.offsetHeight };
      panel.classList.add('sizing');
      for (const h of handles(edge)) h.classList.add('active');
      const move = (m: PointerEvent) => {
        size = { w: edge === 'h' ? start.w : start.w + (m.clientX - start.x), h: edge === 'w' ? start.h : start.h - (m.clientY - start.y) };
        applySize();
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        grip.removeEventListener('lostpointercapture', up);
        if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
        panel.classList.remove('sizing');
        for (const h of handles(edge)) h.classList.remove('active');
        saveSize();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
      grip.addEventListener('lostpointercapture', up);
    });
    // Double click: back to the first size.
    grip.addEventListener('dblclick', () => { size = { ...TERM_DEF }; applySize(); saveSize(); });
    if (grip.getAttribute('role') === 'separator') grip.addEventListener('focus', ariaSize);
  });
}

/** Arrows on an edge's handle: ↑ ↓ taller / shorter on the top one, → ← wider / narrower on the side one; Shift by more. */
function edgeKeys(e: KeyboardEvent, edge: 'w' | 'h') {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const next = keyTermSize(edge, e.key, e.shiftKey, size, room());
  if (!next) return;
  e.preventDefault();
  e.stopPropagation();
  size = next;
  applySize();
  saveSize();
}

export function bindTerm() {
  $('#tm').addEventListener('keydown', keys);
  $('#tm-form').addEventListener('submit', (e) => { e.preventDefault(); void runTerm(); });
  const input = $<HTMLTextAreaElement>('#tm-input');
  input.addEventListener('input', () => { fitInput(input); term.at = term.history.length; });
  bindEdges();
  window.addEventListener('resize', () => { if (term.open) { applySize(); ariaSize(); } });
  $('#tm-thread').addEventListener('scroll', () => {
    const th = $('#tm-thread');
    stick = th.scrollHeight - th.scrollTop - th.clientHeight < 24;
  });
}

function headHtml(r: TermRun) {
  const where = r.repo || t('shell.home');
  const pill = r.running ? `<span class="pill blue"><i class="sh-spin" aria-hidden="true"></i>${t('shell.running')}</span>`
    : r.stopped ? `<span class="pill gray">${t('shell.stopped')}</span>`
    : `<span class="pill ${r.code === 0 ? 'green' : 'red'}">${t('shell.exit', { n: r.code ?? '?' })}</span>`;
  const time = r.running ? `<time data-start="${esc(r.startedAt)}">${shellClock(Date.now() - Date.parse(r.startedAt))}</time>` : `<time>${shellTook(r.ms)}</time>`;
  const stop = r.running ? `<button type="button" class="btn tm-stop" data-action="tm-stop" data-id="${esc(r.id)}" aria-label="${esc(t('shell.stopAria', { cmd: r.cmd }))}">${t('shell.stop')}</button>` : '';
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
    let pre = n.querySelector<HTMLElement>('.tm-out');
    if (out && !pre) { pre = document.createElement('pre'); pre.className = 'tm-out'; n.append(pre); }
    if (pre && pre.textContent !== out) { if (out) pre.textContent = out; else pre.remove(); }
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
  patchRuns(th, term.view.runs);
  if (stick) th.scrollTop = th.scrollHeight;
}

/** The time on running lines goes on by itself. */
setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>('#tm-thread .tm-run.live time[data-start]')) {
    el.textContent = shellClock(Date.now() - Date.parse(el.dataset.start!));
  }
}, 1000);
