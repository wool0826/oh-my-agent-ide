// The popover over a composer (decisions 1B, 6A, 7C): one list at a time, the text field keeps the focus and the
// keys, and the row chosen is marked with aria-activedescendant. Up on an empty composer opens the prompt history.
import { filterSent, historyKey, matchParts, opensHistory, recentStep, sentAge, type MatchPart, type SentPrompt } from '../../shared/quickInput';
import type { Key } from '../../shared/i18n';
import { $, call, esc, sym, t, ui } from './core';
import type { Box } from './chat';

/** One row: an icon, its text (parts marked where they match), and a word or a value at its end. */
export interface CpopRow {
  id: string;
  icon: string;
  label: string | MatchPart[];
  meta?: string;
  mono?: boolean;
  /** The group heading this row comes under; a row with another group starts a new heading. */
  group?: string;
}

export interface CpopList {
  kind: 'history' | 'prompts' | 'mentions';
  /** The heading of a list with one group, with the number of rows after it. */
  title?: string;
  count?: number;
  rows: CpopRow[];
  /** What an empty list says. */
  empty: string;
  /** The keys at the foot: [keys, what they do]. None while the list is empty. */
  hints: [string[], Key][];
  /** 'history': Up goes to older rows (shared/quickInput.ts recentStep), Down back, and past the newest closes. */
  nav: 'history' | 'list';
  /** Tab takes the row too (mentions). */
  tab?: boolean;
  pick: (row: CpopRow) => void;
}

type Open = { list: CpopList; at: number; el: HTMLElement };
const open: Partial<Record<Box, Open>> = {};

const inputOf = (box: Box) => $<HTMLTextAreaElement>(box === 'chat' ? '#chat-input' : '#ws-input');
const formOf = (box: Box) => $<HTMLFormElement>(box === 'chat' ? '#chat-form' : '#ws-form');

export function cpopOpen(box: Box, kind?: CpopList['kind']) {
  const o = open[box];
  return !!o && (!kind || o.list.kind === kind);
}

export function closeCpop(box: Box) {
  const o = open[box];
  if (!o) return;
  o.el.remove();
  delete open[box];
  const input = inputOf(box);
  input.removeAttribute('aria-activedescendant');
  input.setAttribute('aria-expanded', 'false');
}

function labelHtml(l: CpopRow['label']) {
  if (typeof l === 'string') return esc(l);
  return l.map((p) => (p.hit ? `<b class="hl">${esc(p.text)}</b>` : esc(p.text))).join('');
}

function draw(box: Box) {
  const o = open[box]!;
  const { list } = o;
  const one = list.title !== undefined;
  let group: string | undefined;
  const rows = list.rows.map((r, i) => {
    const head = !one && r.group !== group ? `<div class="cpop-h">${esc(r.group ?? '')}</div>` : '';
    group = r.group;
    return `${head}<div class="cpop-it${i === o.at ? ' on' : ''}" role="option" id="cpop-${box}-${i}" data-i="${i}" aria-selected="${i === o.at}">${sym(r.icon)}<span>${labelHtml(r.label)}</span>${r.meta ? `<small${r.mono ? ' class="mono"' : ''}>${esc(r.meta)}</small>` : ''}</div>`;
  }).join('');
  const head = one ? `<div class="cpop-h">${esc(list.title!)}<span class="gap"></span><small>${list.count ?? list.rows.length}</small></div>` : '';
  const body = list.rows.length ? rows : `<div class="cpop-none">${esc(list.empty)}</div>`;
  const foot = list.rows.length && list.hints.length
    ? `<div class="cpop-foot">${list.hints.map(([keys, what]) => `<span>${keys.map((k) => `<kbd>${esc(k)}</kbd>`).join('')}${esc(t(what))}</span>`).join('')}</div>`
    : '';
  o.el.innerHTML = head + `<div class="cpop-l">${body}</div>` + foot;
  const input = inputOf(box);
  if (o.at >= 0 && list.rows.length) input.setAttribute('aria-activedescendant', `cpop-${box}-${o.at}`);
  else input.removeAttribute('aria-activedescendant');
  o.el.querySelector<HTMLElement>('.cpop-it.on')?.scrollIntoView({ block: 'nearest' });
}

/** Opens a list over the composer, or puts a new one in the one open; the first row is chosen. */
export function showCpop(box: Box, list: CpopList) {
  let o = open[box];
  if (!o) {
    const el = document.createElement('div');
    el.className = 'cpop';
    el.id = `cpop-${box}`;
    el.setAttribute('role', 'listbox');
    // A press on a row keeps the focus in the text field; the click takes the row.
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      const it = (e.target as HTMLElement).closest<HTMLElement>('.cpop-it');
      const cur = open[box];
      if (!it || !cur) return;
      take(box, Number(it.dataset.i));
    });
    formOf(box).appendChild(el);
    o = open[box] = { list, at: 0, el };
    const input = inputOf(box);
    input.setAttribute('aria-controls', el.id);
    input.setAttribute('aria-expanded', 'true');
  }
  o.list = list;
  o.at = list.rows.length ? 0 : -1;
  o.el.setAttribute('aria-label', list.title ?? '');
  draw(box);
}

function take(box: Box, i: number) {
  const o = open[box];
  const row = o?.list.rows[i];
  if (!o || !row) return;
  closeCpop(box);
  o.list.pick(row);
}

/** Keys in a composer while a list is open. Returns true when the key was the list's. */
export function cpopKeys(e: KeyboardEvent, box: Box): boolean {
  const o = open[box];
  if (!o || e.isComposing || e.keyCode === 229) return false;
  const n = o.list.rows.length;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCpop(box); return true; }
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (!n) return true;
    if (o.list.nav === 'history') {
      const next = recentStep(n, o.at, e.key === 'ArrowUp' ? 'up' : 'down');
      if (next < 0) { closeCpop(box); return true; }
      o.at = next;
    } else {
      o.at = Math.max(0, Math.min(n - 1, o.at + (e.key === 'ArrowDown' ? 1 : -1)));
    }
    draw(box);
    return true;
  }
  if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && o.list.tab && !e.shiftKey)) {
    e.preventDefault();
    if (o.at >= 0 && n) take(box, o.at); else closeCpop(box);
    return true;
  }
  return false;
}

// The prompt history (1B).

/** The prompts sent from each composer target, as last read from main. */
const sent = new Map<string, SentPrompt[]>();

function ageWord(at: string) {
  const a = sentAge(at, new Date());
  if (a.kind === 'now') return t('time.now');
  if (a.kind === 'yesterday') return t('day.yesterdayShort');
  if (a.kind === 'date') return `${a.month}/${a.day}`;
  return t(a.kind === 'min' ? 'time.min' : 'time.hour', { n: a.n });
}

const boxKey = (box: Box) => historyKey(box === 'ws' ? ui.wSel : null);

function historyList(box: Box): CpopList {
  const input = inputOf(box);
  const q = input.value;
  const all = filterSent(sent.get(boxKey(box)) ?? [], q);
  return {
    kind: 'history',
    title: t('hist.title'),
    count: all.length,
    rows: all.map((p, i) => ({ id: String(i), icon: 'e-clock', label: matchParts(p.text, q), meta: ageWord(p.at) })),
    empty: t('hist.empty'),
    hints: [[['↑', '↓'], 'cpop.move'], [['↵'], 'cpop.insert'], [['Esc'], 'close']],
    nav: 'history',
    pick: (row) => {
      const p = all[Number(row.id)];
      if (!p) return;
      input.value = p.text;
      input.setSelectionRange(p.text.length, p.text.length);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
  };
}

/** Up in an empty composer: the prompts sent from it, newest first. */
export async function openHistory(box: Box) {
  const key = boxKey(box);
  const got = await call<SentPrompt[]>('history:list', key);
  if (Array.isArray(got)) sent.set(key, got);
  if (boxKey(box) !== key || document.activeElement !== inputOf(box)) return;
  showCpop(box, historyList(box));
}

/** The text changed while the history is open: it keeps the prompts holding it, and closes when none does. */
export function historyTyped(box: Box) {
  if (!cpopOpen(box, 'history')) return;
  const list = historyList(box);
  if (!list.rows.length && inputOf(box).value.trim()) { closeCpop(box); return; }
  showCpop(box, list);
}

/** Up in a composer with nothing open: the history, when the composer is empty. */
export function historyKeys(e: KeyboardEvent, box: Box, shell: boolean): boolean {
  if (e.key !== 'ArrowUp' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing || shell) return false;
  const input = inputOf(box);
  if (!opensHistory(input.value)) return false;
  e.preventDefault();
  void openHistory(box);
  return true;
}

/** A prompt went: it is first in its composer's history. */
export function rememberSent(box: Box, worker: string | null, text: string) {
  if (!text.trim()) return;
  const key = historyKey(box === 'ws' ? worker : null);
  sent.delete(key);
  void call('history:add', key, text);
}
