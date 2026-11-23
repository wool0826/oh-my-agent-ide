// The command palette (Ctrl/Cmd+K).
import type { ChatItem, Worker } from '../../shared/types';
import { type Key } from '../../shared/i18n';
import { matchItems, stepIndex, type PaletteItem } from '../../shared/palette';
import { SEARCH_MIN, type TextHit } from '../../shared/textSearch';
import { PAGE } from '../../shared/paging';
import { type View } from '../../shared/history';
import { act, openWorker } from '../app';
import { chatAll, renderChat, renderChatInspector } from './chat';
import { closePop } from './controls';
import { $, call, esc, ic, isMac, modelLabel, oneLine, Pane, prNum, S, sym, t, task, taskLabel, toast, ui, when, worker } from './core';
import { go, nav } from './history';
import { closeSettings, openSettings } from './settings';
import { openShortcuts } from './shortcuts';
import { hideUsagePop, ms, togglePanel, workerIcon } from './sidebar';

export interface Cmd extends PaletteItem { icon: string; run: () => void; /** Listed only for a search: past tasks would bury the places to go. */ searchOnly?: boolean }

export const cmdk = { open: false, i: 0, all: [] as Cmd[], shown: [] as Cmd[], back: null as HTMLElement | null,
  /** What was typed, the things said that match it (read from the main process), and the timer that asks for them. */
  q: '', said: [] as Cmd[], saidFor: '', timer: 0 };

/** Everything the palette can go to, in the order it lists them while nothing is typed. */
export function paletteItems(): Cmd[] {
  const s = S!;
  const mod = isMac ? '⌘' : 'Ctrl+';
  const out: Cmd[] = [];
  // Waiting decisions first: they are what the user most likely came for.
  for (const d of s.decisions.filter((x) => x.status === 'pending')) {
    out.push({ id: `dec:${d.id}`, group: t('side.decisions'), title: oneLine(d.summary?.what || d.title, 80), hint: d.workerId ?? 'Dispatcher', icon: ic('ask'),
      run: () => { const row = document.createElement('i'); row.dataset.action = 'goto-decision'; row.dataset.id = d.id; void act(row, new Event('click')); } });
  }
  const views: [View, string, string][] = [['chat', t('nav.chat'), 's-chat'], ['worker', 'Worker', 's-cpu'], ['repo', t('nav.repo'), 's-box'], ['memory', t('nav.memory'), 's-doc']];
  views.forEach(([v, title, icon], i) => out.push({ id: `view:${v}`, group: t('cmdk.go'), title, keys: `${mod}${i + 1}`, icon: sym(icon), run: () => go({ view: v }) }));
  const tabs: [typeof ui.insTab, Key][] = [['inbox', 'ins.tabInbox'], ['memo', 'ins.tabMemo'], ['auto', 'ins.tabAuto']];
  for (const [v, key] of tabs) {
    out.push({ id: `tab:${v}`, group: t('cmdk.go'), title: t(key), hint: t('nav.chat'), icon: sym('s-side-r'),
      run: () => { ui.insTab = v; if (ui.insMin) togglePanel('ins'); go({ view: 'chat' }); renderChatInspector(); } });
  }
  const live = s.workers.filter((w) => w.status !== 'archived').sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  const arch = s.workers.filter((w) => w.status === 'archived').sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  for (const w of [...live, ...arch]) {
    const x = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
    out.push({ id: `w:${w.id}`, group: w.status === 'archived' ? t('side.archived') : 'Worker', title: `${w.id} ${x?.title ?? w.title}`,
      hint: [w.repo ?? t('general'), modelLabel(w.model)].join(' · '), icon: workerIcon(w), run: () => openWorker(w.id) });
  }
  // Past work, found by typing: a task's id or title, its PR number, a word of its report.
  for (const x of s.tasks.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (!x.workerId || !worker(x.workerId)) continue;
    const pr = x.prUrl ? `PR #${prNum(x.prUrl)}` : '';
    out.push({ id: `task:${x.id}`, group: t('cmdk.tasks'), title: `${x.id} ${x.title}`, hint: [x.workerId, taskLabel(x), pr, x.summary ? oneLine(x.summary, 90) : ''].filter(Boolean).join(' · '),
      icon: sym(x.prUrl ? 's-pr' : 's-check'), searchOnly: true, run: () => go({ view: 'worker', wSel: x.workerId, wOpen: true, wTab: 'summary' }) });
  }
  for (const r of s.repos) out.push({ id: `repo:${r.name}`, group: t('nav.repo'), title: r.name, hint: r.description || undefined, icon: sym('s-box'), run: () => go({ view: 'repo', repoSel: r.name }) });
  const panes: [Pane, Key][] = [['accounts', 'set.accounts'], ['general', 'set.general'], ['display', 'set.display'], ['alerts', 'set.alerts'], ['memory', 'set.memory'], ['models', 'set.models']];
  panes.forEach(([pane, key], i) => out.push({ id: `set:${pane}`, group: t('set.title'), title: t(key), hint: t('set.title'), keys: i ? undefined : `${mod},`, icon: sym('s-gear'), run: () => openSettings(pane) }));
  // A merge on GitHub shows within seconds anyway; this is for when it should show now.
  if (s.tasks.some((x) => x.prUrl && x.prState !== 'MERGED' && x.prState !== 'CLOSED'))
    out.push({ id: 'pr-refresh', group: t('side.prs'), title: t('pr.refresh'), icon: sym('s-pr'), run: () => void call('pr:refresh').then((ok) => { if (ok) toast(t('pr.refreshed')); }) });
  out.push({ id: 'side', group: t('cmdk.window'), title: t('cmdk.side'), keys: `${mod}B`, icon: sym('s-side-l'), run: () => togglePanel('side') });
  out.push({ id: 'ins', group: t('cmdk.window'), title: t('cmdk.ins'), keys: isMac ? '⌥⌘B' : 'Ctrl+Alt+B', icon: sym('s-side-r'), run: () => togglePanel('ins') });
  out.push({ id: 'keys', group: t('cmdk.window'), title: t('keys.title'), keys: `${mod}/`, icon: sym('s-key'), run: () => openShortcuts() });
  return out;
}

export function openPalette() {
  if (!S || cmdk.open) return;
  closePop();
  hideUsagePop();
  $('#ctxmenu').hidden = true;
  cmdk.open = true;
  cmdk.back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  cmdk.all = paletteItems();
  const root = $('#cmdk');
  root.innerHTML = `<div class="dlg-back" data-action="cmdk-close"></div>
    <div class="cmdk" role="dialog" aria-modal="true" aria-label="${t('cmdk.ph')}">
      <label class="cmdk-in">${sym('s-search')}<input id="cmdk-q" type="text" role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-autocomplete="list" placeholder="${t('cmdk.ph')}" spellcheck="false" autocomplete="off"><kbd>Esc</kbd></label>
      <div class="cmdk-list" id="cmdk-list" role="listbox"></div>
    </div>`;
  root.hidden = false;
  root.classList.add('opening');
  setTimeout(() => root.classList.remove('opening'), ms('--dur-slow') + 40);
  renderPalette('');
  $('#cmdk-q').focus();
}

/** The list for what is typed. Sections have their names only while nothing is typed: a search mixes them by rank. */
export function renderPalette(q: string, keep = false) {
  const heads = !q.trim();
  cmdk.q = q;
  // Places and tasks first, then what was said: messages are many, and a place is what one usually wants.
  cmdk.shown = [...matchItems(heads ? cmdk.all.filter((c) => !c.searchOnly) : cmdk.all, q, 60), ...(cmdk.saidFor === q.trim() ? cmdk.said : [])];
  if (!keep) { cmdk.i = 0; searchSaid(q); }
  let last = '';
  $('#cmdk-list').innerHTML = cmdk.shown.map((c, i) => {
    const head = heads && c.group !== last ? `<div class="cmdk-g" role="presentation">${esc(c.group)}</div>` : '';
    last = c.group;
    return `${head}<div class="cmdk-it" id="cmdk-${i}" role="option" data-action="cmdk-run" data-i="${i}">${c.icon}<b>${esc(c.title)}</b>${c.hint ? `<small>${esc(c.hint)}</small>` : ''}<span class="gap"></span>${c.keys ? `<kbd>${esc(c.keys)}</kbd>` : ''}</div>`;
  }).join('') || `<div class="cmdk-none">${t('cmdk.none')}</div>`;
  markPalette(keep);
}

/** Asks the main process for what was said that matches, a moment after the typing stops, and adds it under the list. */
export function searchSaid(q: string) {
  clearTimeout(cmdk.timer);
  const query = q.trim();
  if (query.length < SEARCH_MIN) { cmdk.said = []; cmdk.saidFor = ''; return; }
  if (cmdk.saidFor === query) return;
  cmdk.timer = window.setTimeout(async () => {
    const hits = (await call<TextHit[]>('search:text', query)) ?? [];
    // Typed on, or closed, while it was read: this answer is for an older question.
    if (!cmdk.open || cmdk.q.trim() !== query) return;
    cmdk.saidFor = query;
    cmdk.said = hits.map((h, i) => ({
      id: `said:${i}`, group: t('cmdk.said'), title: h.snippet, hint: `${h.where === 'chat' ? t('nav.chat') : h.where} · ${when(h.ts)}`, icon: sym('s-chat'), searchOnly: true,
      run: () => (h.where === 'chat' ? void jumpToChat(h.id) : openWorker(h.where)),
    }));
    renderPalette(cmdk.q, true);
  }, 180);
}

/**
 * Shows the chat from a message on, loading older pages until it is there (at most 40), and marks it for a moment.
 */

export async function jumpToChat(id: string) {
  go({ view: 'chat' });
  for (let i = 0; i < 40 && !chatAll().some((c) => c.id === id); i++) {
    const first = chatAll()[0]?.id;
    if (!first) break;
    const r = await call<{ items: ChatItem[]; more: boolean }>('chat:page', first, PAGE.chat);
    if (!r?.items.length) break;
    ui.chatOlder = [...r.items, ...ui.chatOlder];
  }
  if (!chatAll().some((c) => c.id === id)) return;
  ui.chatFrom = id;
  ui.lastChatKey = '';
  renderChat(false, true);
  const th = $('#chat-thread');
  const hit = th.querySelector<HTMLElement>(':scope > .bub, :scope > .rp, :scope > div:not(.empty-view)');
  hit?.scrollIntoView({ block: 'start' });
  hit?.classList.add('found');
  setTimeout(() => hit?.classList.remove('found'), 1600);
}

export function markPalette(scroll = true) {
  document.querySelectorAll<HTMLElement>('#cmdk-list .cmdk-it').forEach((el, i) => {
    el.setAttribute('aria-selected', String(i === cmdk.i));
    if (i === cmdk.i && scroll) el.scrollIntoView({ block: 'nearest' });
  });
  const input = $('#cmdk-q');
  if (cmdk.shown.length) input.setAttribute('aria-activedescendant', `cmdk-${cmdk.i}`); else input.removeAttribute('aria-activedescendant');
  if (!scroll) $('#cmdk-list').scrollTop = 0;
}

export function closePalette(restore = true) {
  if (!cmdk.open) return;
  cmdk.open = false;
  const root = $('#cmdk');
  root.hidden = true;
  root.innerHTML = '';
  if (restore && cmdk.back?.isConnected) cmdk.back.focus({ preventScroll: true });
  cmdk.back = null;
  clearTimeout(cmdk.timer);
  cmdk.said = [];
  cmdk.saidFor = '';
}

export function runPalette(i: number) {
  const c = cmdk.shown[i];
  if (!c) return;
  closePalette(false);
  // Settings covers the window: leave it for anywhere else, stay in it for one of its own panes.
  if (ui.settingsShown && !c.id.startsWith('set:')) closeSettings();
  c.run();
}

/** Keys while the palette is open. Typing goes to its field; the window's other shortcuts wait. */
export function paletteKeys(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); cmdk.i = stepIndex(cmdk.i, e.key === 'ArrowDown' ? 1 : -1, cmdk.shown.length); markPalette(); return; }
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); runPalette(cmdk.i); return; }
  if (e.key === 'Tab') { e.preventDefault(); $('#cmdk-q').focus(); }
}
