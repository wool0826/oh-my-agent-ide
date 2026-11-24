// A side question (shared/side.ts, main/side.ts): a floating panel over the chat with its own thread, model, folder
// and context meter. Nothing in it reaches the Dispatcher unless "Send to the Dispatcher" puts it on the composer.
import { CONTEXT_WINDOW } from '../../shared/context';
import { clampSideSize, keySideSize, parseSideSize, sideSizeText, type SideRoom, type SideSize } from '../../shared/sideSize';
import { lastAnswer, sideModel, sideReply, SIDE_EMPTY, type SideView } from '../../shared/side';
import { openPop, pop } from './controls';
import type { ModelList } from '../../shared/types';
import { $, call, esc, isMac, k, lang, md, modelLabel, renderReply, ring, S, sym, t, toast, tryCall, ui } from './core';
import { setTip } from './tip';

export const sq = {
  /** The panel is showing; when not, the thread stays behind the composer button until Close. */
  open: false,
  view: { ...SIDE_EMPTY } as SideView,
  /** Picked before the first question; afterwards the session's own. */
  model: null as string | null,
  repo: null as string | null,
  key: '',
};

const model = () => sq.view.model ?? sq.model ?? sideModel(ui.models.models);
const repo = () => (sq.view.model ? sq.view.repo : sq.repo);
const started = () => sq.view.items.length > 0 || sq.view.busy;

export function openSide() {
  sq.open = true;
  renderSide();
  $<HTMLTextAreaElement>('#sq-input').focus();
  // The model picker lists what the accounts can use: the saved list, read once.
  if (!ui.models.models.length) void call<ModelList>('models:list', 'cached').then((r) => { if (r?.models.length && !ui.models.models.length) { ui.models = r; renderSide(); } });
}

/** Minimise: the thread stays, behind the composer button with its count. */
export function minimiseSide(focusChat = true) {
  if (!sq.open) return;
  sq.open = false;
  renderSide();
  if (focusChat) $<HTMLTextAreaElement>('#chat-input').focus();
}

export function toggleSide() {
  if (sq.open) minimiseSide(); else openSide();
}

/** Close: the session ends and its thread is forgotten. */
export async function closeSide() {
  sq.open = false;
  sq.model = null;
  sq.repo = null;
  $<HTMLTextAreaElement>('#sq-input').value = '';
  renderSide();
  await call('side:reset');
  $<HTMLTextAreaElement>('#chat-input').focus();
}

export function setSideView(v: SideView) {
  sq.view = v;
  renderSide();
}

export async function sendSide() {
  const input = $<HTMLTextAreaElement>('#sq-input');
  const text = input.value.trim();
  if (!text) {
    if (sq.view.busy) await call('side:stop');
    return;
  }
  const r = await tryCall('side:send', text, model(), repo());
  if (!r.ok) { toast(r.error, true); return; }
  input.value = '';
  fitInput(input);
  renderSide();
}

export function pickSideModel(owner: HTMLElement) {
  if (started()) return;
  const list = ui.models.models.filter((m) => (m.provider ?? 'claude') === 'claude');
  const items = (list.length ? list : [{ id: model(), name: modelLabel(model()) }]).map((m) => ({ value: m.id, label: modelLabel(m.id) }));
  openPop(owner, items, model(), (v) => { sq.model = v; renderSide(); });
}

export function pickSideFolder(owner: HTMLElement) {
  if (started()) return;
  const items = [{ value: '', label: t('sq.noFolder') }, ...(S?.repos ?? []).map((r) => ({ value: r.name, label: r.name, sub: r.path }))];
  openPop(owner, items, repo() ?? '', (v) => { sq.repo = v || null; renderSide(); });
}

/** "Send to the Dispatcher": the answer as a quote chip on the main composer. It goes with the next message sent there. */
export function sideToDispatcher() {
  const answer = lastAnswer(sq.view.items);
  if (!answer) return;
  ui.reply.chat = sideReply(answer);
  renderReply('chat');
  minimiseSide();
}

export async function sideToMemo() {
  const answer = lastAnswer(sq.view.items);
  if (!answer) return;
  const r = await tryCall('memo:add', answer);
  toast(r.ok ? t('sq.memoSaved') : r.error, !r.ok);
}

/** Keys in the panel: Enter asks (Shift+Enter is a new line), Esc minimises. */
function keys(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape' && !pop.el) { e.preventDefault(); e.stopPropagation(); minimiseSide(); return; }
  // Enter only asks: with nothing typed it does nothing, so a stray one never stops an answer (the button does).
  if (e.key === 'Enter' && !e.shiftKey && (e.target as HTMLElement).id === 'sq-input') { e.preventDefault(); if ((e.target as HTMLTextAreaElement).value.trim()) void sendSide(); }
}

function fitInput(input: HTMLTextAreaElement) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

/* ---------- size: drag the top or left edge or the top-left corner, or arrow keys on the corner ---------- */

const SIZE_KEY = 'oma.sqSize';
let size: SideSize = (() => { try { return parseSideSize(localStorage.getItem(SIZE_KEY)); } catch { return { w: null, h: null }; } })();

/** The room in the chat, as .sq's max-width and max-height in styles.css give it. */
function room(): SideRoom {
  const host = $('#sq').parentElement!;
  return { w: host.clientWidth - 32, h: host.clientHeight - 120 };
}

/** The size on the panel; CSS keeps it inside the chat when the window gets smaller (.sq, --sq-w and --sq-h). */
function applySize() {
  const panel = $('#sq');
  panel.style.setProperty('--sq-w', size.w == null ? '' : `${size.w}px`);
  panel.style.setProperty('--sq-h', size.h == null ? '' : `${size.h}px`);
}

function setSize(s: SideSize) {
  size = s;
  applySize();
  try { localStorage.setItem(SIZE_KEY, sideSizeText(s)); } catch { /* not kept */ }
}

function startResize(e: PointerEvent) {
  const grip = e.currentTarget as HTMLElement;
  if (e.button !== 0) return;
  // No text selection starts from the press.
  e.preventDefault();
  const panel = $('#sq');
  const edge = grip.dataset.edge;
  const r0 = panel.getBoundingClientRect();
  const x0 = e.clientX;
  const y0 = e.clientY;
  const r = room();
  const was = size;
  let moved = false;
  grip.setPointerCapture(e.pointerId);
  panel.classList.add('sizing');
  // The panel is held in the bottom-right corner, so going left or up makes it bigger.
  const move = (ev: PointerEvent) => {
    moved = true;
    size = clampSideSize({ w: edge === 'h' ? size.w : r0.width - (ev.clientX - x0), h: edge === 'w' ? size.h : r0.height - (ev.clientY - y0) }, r);
    applySize();
  };
  const end = (ev: PointerEvent) => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', end);
    grip.removeEventListener('pointercancel', end);
    grip.removeEventListener('lostpointercapture', end);
    if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    panel.classList.remove('sizing');
    // A press without a move (a click, a double-click) changes nothing; a cancelled drag goes back.
    if (ev.type === 'pointercancel') { size = was; applySize(); } else if (moved) setSize(size);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('lostpointercapture', end);
}

export function bindSide() {
  const panel = $('#sq');
  panel.addEventListener('keydown', keys);
  applySize();
  panel.querySelectorAll<HTMLElement>('[data-edge]').forEach((el) => {
    el.addEventListener('pointerdown', startResize);
    // A double-click goes back to the panel's own size.
    el.addEventListener('dblclick', () => setSize({ w: null, h: null }));
  });
  $('#sq-rz').addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const r = panel.getBoundingClientRect();
    const next = keySideSize(e.key, e.shiftKey, { w: r.width, h: r.height }, room());
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    setSize(next);
  });
  $('#sq-form').addEventListener('submit', (e) => { e.preventDefault(); void sendSide(); });
  const input = $<HTMLTextAreaElement>('#sq-input');
  input.addEventListener('input', () => { fitInput(input); sendButton(); });
}

function sendButton() {
  const btn = $<HTMLButtonElement>('#sq-send');
  const stop = sq.view.busy && !$<HTMLTextAreaElement>('#sq-input').value.trim();
  const label = stop ? t('sq.stop') : t('send');
  if (btn.getAttribute('aria-label') === label) return;
  btn.classList.toggle('stop', stop);
  btn.innerHTML = sym(stop ? 's-stop' : 's-up');
  btn.setAttribute('aria-label', label);
  setTip(btn, label);
}

/** The composer button that opens the panel: pressed while it shows, with the thread's count while minimised. */
function renderButton() {
  const btn = $<HTMLButtonElement>('#chat-sq');
  const n = sq.view.items.filter((x) => x.role !== 'error').length;
  btn.classList.toggle('on', sq.open);
  btn.setAttribute('aria-pressed', String(sq.open));
  const label = n && !sq.open ? t('sq.buttonCount', { n }) : t('sq.title');
  btn.setAttribute('aria-label', label);
  setTip(btn, label, isMac ? '⌘J' : 'Ctrl+J');
  btn.innerHTML = `${sym('s-side-q')}${n && !sq.open ? `<i>${n}</i>` : ''}`;
}

export function renderSide() {
  renderButton();
  const panel = $('#sq');
  panel.hidden = !sq.open;
  if (!sq.open) return;
  // Above the composer, whatever its height.
  const composer = document.getElementById('chat-form');
  if (composer) panel.style.bottom = `${composer.offsetHeight + 24}px`;
  const v = sq.view;
  const key = JSON.stringify([v, model(), repo(), lang(), ui.models.models.length]);
  sendButton();
  if (key === sq.key) return;
  sq.key = key;
  const where = repo() ?? t('sq.noFolder');
  const fixed = started();
  const pick = (action: string, label: string, aria: string) => (fixed
    ? `<span>${esc(label)}</span>`
    : `<button type="button" class="sq-pick" data-action="${action}" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(aria)}">${esc(label)}<svg class="chev" aria-hidden="true"><use href="#s-chev"/></svg></button>`);
  const meta = `<div class="sq-m">Claude Code · ${pick('sq-model', modelLabel(model()), t('sq.modelAria', { model: modelLabel(model()) }))} · ${pick('sq-folder', where, t('sq.folderAria', { where }))}</div>`;
  const items = v.items.map((x) => (x.role === 'me' ? `<div class="bub me">${esc(x.text)}</div>`
    : x.role === 'ai' ? `<div class="bub wk md">${md(x.text)}</div>`
      : `<div class="sq-err" role="alert">${sym('s-alert', 'c-red')}<span>${esc(x.text)}</span></div>`)).join('');
  const busy = v.busy ? `<div class="sq-busy" role="status"><span class="sq-spin" aria-hidden="true"></span>${esc(v.status || t('sq.thinking'))}</div>` : '';
  const acts = !v.busy && lastAnswer(v.items) ? `<div class="sq-a"><button type="button" class="btn" data-action="sq-to-dispatcher">${t('sq.toDispatcher')}</button><button type="button" class="btn" data-action="sq-memo">${t('sq.toMemo')}</button></div>` : '';
  const thread = $('#sq-thread');
  const atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24;
  thread.innerHTML = `${meta}${items}${busy}${acts}`;
  if (atEnd || v.busy) thread.scrollTop = thread.scrollHeight;
  const ctx = v.contextTokens;
  $('#sq-ctx').innerHTML = `${ring(ctx / CONTEXT_WINDOW).replace('class="ring"', '')}${k(ctx)} / ${k(CONTEXT_WINDOW)}`;
  $('#sq-ctx').setAttribute('aria-label', t('sq.ctxAria', { n: k(ctx) }));
}
