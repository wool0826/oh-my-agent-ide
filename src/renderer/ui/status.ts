// A summarised status group in Settings (decision 247): one summary line, the rows under it when opened, and a
// row's detail (each long value whole, with a copy button) under the row when that is opened. The rows come from
// shared/statusSummary.ts; any group can draw its own items with statusRows and register how to draw them again.
import { ordered, tally, type StatusField, type StatusItem, type StatusTone } from '../../shared/statusSummary';
import { esc, ide, sym, t, toast, ui } from './core';

const PILL: Record<StatusTone, string> = { ok: 'success', warn: 'warning', bad: 'danger' };
const ICON: Record<StatusTone, string> = { ok: 's-check', warn: 's-alert', bad: 's-alert' };
const STATE: Record<StatusTone, 'pre.ok' | 'pre.fail'> = { ok: 'pre.ok', warn: 'pre.fail', bad: 'pre.fail' };

const redraws = new Map<string, () => void>();

/** How the group `gid` is drawn again when one of its rows opens or closes. */
export function onStatusRedraw(gid: string, draw: () => void) { redraws.set(gid, draw); }

const isOpen = (key: string) => ui.statusOpen.has(key);

const disc = (key: string, open: boolean, controls: string) => `<button type="button" class="disc" data-action="status-fold" data-v="${esc(key)}" aria-expanded="${open}" aria-controls="${esc(controls)}" aria-label="${t('pre.more')}" data-tip="${t('pre.more')}">${sym('s-chev')}</button>`;

const copyBtn = (f: StatusField) => `<button type="button" class="st-copy" data-action="status-copy" data-v="${esc(f.value)}" aria-label="${esc(`${t('pre.copy')}: ${f.label}`)}" data-tip="${t('pre.copy')}">${sym('s-copy')}</button>`;

function detail(id: string, fields: readonly StatusField[]) {
  return `<div class="sdet" id="${esc(id)}"><dl class="skv">${fields.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>${f.copy ? copyBtn(f) : '<span></span>'}`).join('')}</dl></div>`;
}

function itemRow(gid: string, x: StatusItem) {
  const key = `${gid}:${x.id}`;
  const det = `st-${gid}-${x.id}`.replace(/[^\w-]/g, '-');
  const open = isOpen(key) && x.fields.length > 0;
  const state = t(STATE[x.tone]);
  return `<div class="srow sitem" data-st="${esc(x.id)}"><span class="sic ${x.tone}" role="img" aria-label="${state}" data-tip="${state}">${sym(ICON[x.tone])}</span><span class="lbl">${esc(x.name)}</span><span class="v">${esc(x.short)}</span>${x.fields.length ? disc(key, open, det) : '<span class="disc-sp"></span>'}</div>${open ? detail(det, x.fields) : ''}`;
}

/** The summary line of group `gid` (its name, the rows that need something by name, how many are fine) and, when open, its rows. */
export function statusRows(gid: string, label: string, items: readonly StatusItem[]) {
  const sum = tally(items);
  const open = isOpen(gid);
  const pills = [
    ...sum.tags.map((x) => `<i class="pill" data-tone="${PILL[x.tone]}">${esc(x.tag)}</i>`),
    sum.more ? `<i class="pill">+${sum.more}</i>` : '',
    sum.ok ? `<i class="pill" data-tone="success">${t(sum.ok === sum.total ? 'pre.allOk' : 'pre.okN', { n: sum.ok })}</i>` : '',
  ].join('');
  const rows = `st-${gid}-rows`;
  return `<div class="ssum"><span class="lbl">${esc(label)}</span><span class="pills">${pills}</span>${items.length ? disc(gid, open, rows) : ''}</div>${open ? `<div class="srows" id="${rows}">${ordered(items).map((x) => itemRow(gid, x)).join('')}</div>` : ''}`;
}

/** Opens or closes a group or a row (`gid` or `gid:id`), draws the group again and keeps the focus on the button. */
export function toggleStatus(key: string) {
  if (!ui.statusOpen.delete(key)) ui.statusOpen.add(key);
  redraws.get(key.split(':')[0]!)?.();
  document.querySelector<HTMLElement>(`[data-action="status-fold"][data-v="${CSS.escape(key)}"]`)?.focus();
}

export function copyStatus(el: HTMLElement) {
  void ide.call('clipboard:write', el.dataset.v ?? '').then(() => {
    toast(t('sel.copied'));
    el.classList.add('ok');
    setTimeout(() => el.classList.remove('ok'), 1500);
  }, () => toast(t('pre.copyFailed'), true));
}

/** Draws `el` again with `html` and keeps the focus on the same control when it was inside. */
export function redrawKeepingFocus(el: HTMLElement, html: string) {
  const a = document.activeElement as HTMLElement | null;
  const sel = a && el.contains(a) && a.dataset.action ? `[data-action="${CSS.escape(a.dataset.action)}"][data-v="${CSS.escape(a.dataset.v ?? '')}"]` : '';
  el.innerHTML = html;
  if (sel) el.querySelector<HTMLElement>(sel)?.focus();
}
