/**
 * The thread panel (T-0076, design C of T-0074): a report's or a Dispatcher message's whole thread, in the right
 * sidebar's place beside the chat, with a composer of its own. The chat keeps the root with its newest reply; the
 * side question and the terminal float over the chat, so the panel never covers them.
 */
import type { ChatItem } from '../../shared/types';
import { replyExcerpt, withReply } from '../../shared/reply';
import { isReport, threadIndex } from '../../shared/thread';
import { $, lang, S, t, toast, tryCall, ui } from './core';
import { keepThreadFocus } from './thread';
import { chatAll, renderChat, rootHtml, rootName, rootQuote, rootWho, threadRow } from './chat';
import { togglePanel } from './sidebar';

let drawn = '';
let sending = false;

/** The open thread's root and replies among the chat items held; null when its root is not among them. */
function current(): { root: ChatItem; rows: ChatItem[] } | null {
  if (!ui.thread || !S) return null;
  const all = chatAll();
  const at = all.findIndex((c) => c.id === ui.thread);
  if (at < 0) return null;
  return { root: all[at], rows: (threadIndex(all).replies.get(at) ?? []).map((j) => all[j]) };
}

const input = () => $<HTMLTextAreaElement>('#thr-input');

function fit(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(Math.round(window.innerHeight * 0.3), el.scrollHeight)}px`;
}

/** Draw the open thread: its root, then a row per reply. Called with every chat draw; nothing changes, nothing is drawn. */
export function renderThreadPanel() {
  const cur = current();
  // The root left the messages held (cleared, or a page let go): the panel goes with it.
  if (ui.thread && S && !cur) { closeThread(false); return; }
  $('#win').classList.toggle('thr-open', !!cur);
  if (!cur) { drawn = ''; return; }
  const { root, rows } = cur;
  ui.threadSeen.set(root.id, rows.length);
  const x = isReport(root) ? S!.tasks.find((k) => k.id === root.ref) : null;
  const key = `${lang()}:${root.id}:${rows.map((c) => c.id).join()}:${x ? x.status + x.prUrl : ''}`;
  if (key === drawn) return;
  const fresh = !drawn;
  drawn = key;
  $('#thr-title').textContent = t('thr.title', { name: rootName(root) });
  const send = $('#thr-send');
  send.setAttribute('aria-label', t('send'));
  const body = $('#thr-body');
  const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  // The root and each reply are messages of a conversation, as in the chat: one Tab stop, ↑ ↓ Home End between them.
  const refocus = keepThreadFocus(body);
  body.innerHTML = rootHtml(root) + rows.map((c, k) => threadRow(c, rows[k - 1] ?? null, root, false)).join('');
  if (fresh || atEnd) body.scrollTop = body.scrollHeight;
  refocus?.(false);
}

/** Open a thread in the panel, and put the keyboard in its composer. */
export function openThread(id: string, focus = true) {
  if (ui.thread !== id) {
    keepDraft();
    ui.thread = id;
    const el = input();
    el.value = ui.threadDrafts.get(id) ?? '';
    if (ui.insMin) { togglePanel('ins'); ui.threadOpenedIns = true; }
    drawn = '';
    renderChat();
    // Measured once the panel shows: hidden, the box has no height to take.
    fit(el);
  }
  if (focus) input().focus();
}

/** Close the panel; the right sidebar's own content comes back. `back`: the keyboard goes back to the thread in the chat. */
export function closeThread(back = true) {
  const id = ui.thread;
  if (!id) return;
  keepDraft();
  ui.thread = null;
  drawn = '';
  $('#win').classList.remove('thr-open');
  if (ui.threadOpenedIns) {
    ui.threadOpenedIns = false;
    if (!ui.insMin) togglePanel('ins');
  }
  renderChat();
  if (back) document.querySelector<HTMLElement>(`#chat-thread [data-action="thread-open"][data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}

function keepDraft() {
  if (!ui.thread) return;
  const v = input().value;
  if (v.trim()) ui.threadDrafts.set(ui.thread, v); else ui.threadDrafts.delete(ui.thread);
}

/** A message in the panel goes to the Dispatcher as a reply in the thread, with its root quoted on top. */
async function sendThread() {
  const cur = current();
  const el = input();
  const typed = el.value;
  const text = typed.trim();
  if (!cur || !text || sending) return;
  sending = true;
  const r = await tryCall('chat:send', withReply({ who: rootWho(cur.root), quote: rootQuote(cur.root) }, text), [], cur.root.id);
  sending = false;
  if (!r.ok) { toast(r.error, true); return; }
  // What was typed while it went stays.
  if (el.value === typed) el.value = '';
  ui.threadDrafts.delete(cur.root.id);
  fit(el);
  const body = $('#thr-body');
  body.scrollTop = body.scrollHeight;
}

/**
 * The message a quote names, where it is only in a thread: the thread opens and its row is given back.
 * Null when no message held says it.
 */
export function revealQuoted(who: string, quote: string): HTMLElement | null {
  const all = chatAll();
  const ix = threadIndex(all);
  for (let i = all.length - 1; i >= 0; i--) {
    const c = all[i];
    if (ix.rootOf[i] < 0 || c.kind !== 'dispatcher' || who !== 'Dispatcher' || replyExcerpt(c.text) !== quote) continue;
    openThread(all[ix.rootOf[i]].id, false);
    return $('#thr-body').querySelector<HTMLElement>(`:scope > .t-row[data-id="${CSS.escape(c.id)}"]`);
  }
  return null;
}

export function bindThread() {
  const panel = $('#chat-thr');
  const el = input();
  $('#thr-form').addEventListener('submit', (e) => { e.preventDefault(); void sendThread(); });
  el.addEventListener('input', () => fit(el));
  panel.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeThread(); return; }
    if (e.target !== el) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendThread(); return; }
    // From an empty composer, ↑ goes to the newest reply.
    const rows = [...panel.querySelectorAll<HTMLElement>('#thr-body > .t-row')];
    if (e.key === 'ArrowUp' && !el.value && rows.length) {
      e.preventDefault();
      const r = rows[rows.length - 1];
      r.tabIndex = -1;
      r.focus();
    }
  });
  // T on a message in the chat opens its thread (or starts one on it).
  $('#chat-thread').addEventListener('keydown', (e) => {
    if (e.code !== 'KeyT' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return;
    const t0 = e.target as HTMLElement;
    if (t0.matches('input, textarea, [contenteditable]')) return;
    const root = t0.closest<HTMLElement>('[data-root]')?.dataset.root;
    if (!root) return;
    e.preventDefault();
    openThread(root);
  });
}
