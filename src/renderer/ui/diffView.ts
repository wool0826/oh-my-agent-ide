// The Changes tab's files (item 10A): the list with a seen box per file, each file's card with its fold, comment and
// seen controls, and its lines in one column or side by side with syntax colours. The rules are shared/diffView.ts and
// shared/highlight.ts; renderDiff in ui/workers.ts puts these together under the tab's header.
import { bigFile, diffLayout, numberedLines, seenKey, sizeText, splitRows, stepFile, type DiffLine } from '../../shared/diffView';
import { highlightDiff, langOf, type Tok } from '../../shared/highlight';
import type { DiffFile, Worker } from '../../shared/types';
import { $, esc, sym, t, ui } from './core';

const keyOf = (wid: string, path: string) => `${wid}:${path}`;

export function seenSet(wid: string): Set<string> {
  let s = ui.diffSeen.get(wid);
  if (!s) { s = new Set(); ui.diffSeen.set(wid, s); }
  return s;
}

export const isSeen = (wid: string, f: DiffFile) => seenSet(wid).has(seenKey(f));

/** Open unless folded by hand; a seen file starts folded. */
export function isOpen(wid: string, f: DiffFile) {
  return ui.diffFold.get(keyOf(wid, f.path)) ?? !isSeen(wid, f);
}

/** The layout this pane can show now, and whether side by side is possible at its width. */
export function layoutNow(root = $('#ws-diff')) {
  // A pane not laid out yet (0 wide) is drawn in one column; the width watcher redraws it once it has a width.
  return diffLayout(ui.diffLayout, root.clientWidth);
}

const tick = `<svg class="xck-t" aria-hidden="true"><use href="#s-tick"/></svg>`;
const box = (wid: string, f: DiffFile, label?: string) =>
  `<span class="xck-w"><input type="checkbox" class="xck" data-change="diff-seen" data-id="${esc(keyOf(wid, f.path))}"${isSeen(wid, f) ? ' checked' : ''}${label ? '' : ` aria-label="${esc(`${t('diff.seen')} ${f.path}`)}"`}>${tick}</span>`;
const counts = (f: DiffFile) => `<span class="n"><b class="plus">+${f.added}</b> <b class="minus">−${f.removed}</b></span>`;

/** The list at the top: a seen box, the path (which goes to the file) and its counts. */
export function fileListHtml(w: Worker, files: DiffFile[]) {
  return `<div class="dlist" role="list">${files.map((f) => `<div class="dli" role="listitem">${box(w.id, f)}<button type="button" class="dli-p" data-action="diff-goto" data-id="${esc(keyOf(w.id, f.path))}">${esc(f.path)}</button>${counts(f)}</div>`).join('')}</div>`;
}

/** The comments under line `i` of a file, and the box when one is being written there. */
function notesHtml(wid: string, path: string, i: number) {
  const key = esc(keyOf(wid, path));
  const said = (ui.diffNotes.get(wid) ?? []).filter((n) => n.path === path && n.at === i).map((n) => `<div class="dnote"><p>${esc(n.text)}</p><button class="btn btn-icon btn-sm clear-x" data-action="diff-note-del" data-id="${key}" data-i="${i}" data-tip="${t('diff.noteDel')}" aria-label="${t('diff.noteDel')}"><svg><use href="#s-x"/></svg></button></div>`).join('');
  const d = ui.diffDraft;
  const draft = d && d.wid === wid && d.path === path && d.at === i
    ? `<div class="dnote edit"><textarea class="inp" id="dnote-in" data-keep="dnote-${key}-${i}" data-enter="diff-note-add" aria-label="${t('diff.note')}"></textarea><div class="btns"><button class="btn" data-action="diff-note-cancel">${t('cancel')}</button><button class="btn btn-primary" data-action="diff-note-add">${t('diff.noteAdd')}</button></div></div>`
    : '';
  return said || draft ? `<div class="dnotes">${said}${draft}</div>` : '';
}

function code(toks: [Tok, string][] | undefined) {
  return (toks ?? []).map(([k, s]) => (k ? `<span class="hl-${k}">${esc(s)}</span>` : esc(s))).join('') || ' ';
}

/** One line: its numbers, then the code; a line of code takes a click (or Enter) to comment on it. */
function cell(wid: string, path: string, l: DiffLine | null, hl: [Tok, string][][], nums: 'both' | 'old' | 'new') {
  if (!l) return '<div class="dr nil" aria-hidden="true"><span class="ln"></span><span class="dc"></span></div>';
  const no = (n: number | null) => `<span class="ln">${n ?? ''}</span>`;
  const ln = nums === 'both' ? no(l.old) + no(l.new) : no(nums === 'old' ? l.old : l.new);
  if (l.kind === 'h') return `<div class="dr h">${ln}<span class="dc">${code(hl[l.i])}</span></div>`;
  const c = l.kind === 'ctx' ? '' : ` ${l.kind}`;
  return `<div class="dr${c} can" role="button" tabindex="0" data-action="diff-note" data-id="${esc(keyOf(wid, path))}" data-i="${l.i}" data-tip="${t('diff.note')}">${ln}<span class="dc">${code(hl[l.i])}</span></div>`;
}

function bodyHtml(wid: string, f: DiffFile, split: boolean) {
  const key = keyOf(wid, f.path);
  if (!f.patch) return `<div class="df-b"><div class="df-big">${sym('s-doc')}<span>${t('diff.binary')}</span></div></div>`;
  if (bigFile(f) && !ui.diffBig.has(key)) {
    return `<div class="df-b"><div class="df-big">${sym('s-doc')}<span>${esc(t('diff.big', { size: sizeText(f.bytes ?? f.patch.length) }))}</span><button type="button" class="btn" data-action="diff-big" data-id="${esc(key)}">${t('diff.expand')}</button></div></div>`;
  }
  const lines = numberedLines(f.patch);
  const hl = highlightDiff(lines, langOf(f.path));
  if (!split) {
    return `<div class="df-b u" data-scroll="diff-${esc(key)}">${lines.map((l) => cell(wid, f.path, l, hl, 'both') + notesHtml(wid, f.path, l.i)).join('')}</div>`;
  }
    return `<div class="df-b s" data-scroll="diff-${esc(key)}">${splitRows(lines).map((r) => {
    if ('h' in r) return `<div class="sr">${cell(wid, f.path, r.h, hl, 'old')}${cell(wid, f.path, r.h, hl, 'new')}</div>`;
    const notes = [r.left, r.right].filter((l, k, a): l is DiffLine => !!l && a.indexOf(l) === k).map((l) => notesHtml(wid, f.path, l.i)).join('');
    return `<div class="sr">${cell(wid, f.path, r.left, hl, 'old')}${cell(wid, f.path, r.right, hl, 'new')}</div>${notes}`;
  }).join('')}</div>`;
}

/** A file's card: fold, path and counts, then a comment button and its seen box; its lines when open. */
export function fileCardHtml(w: Worker, f: DiffFile, split: boolean) {
  const key = keyOf(w.id, f.path);
  const open = isOpen(w.id, f);
  const st = f.status === '?' ? 'A' : f.status;
  const focus = ui.diffFocus?.wid === w.id && ui.diffFocus.path === f.path;
  return `<section class="df${open ? ' open' : ''}${focus ? ' focus' : ''}" data-key="${esc(key)}">
    <div class="df-h"><button type="button" class="df-t" data-action="diff-file" data-id="${esc(key)}" aria-expanded="${open}"><svg class="chev" aria-hidden="true"><use href="#s-chev"/></svg><span class="st st-${st}">${st}</span><span class="p">${esc(f.path)}</span>${f.status === '?' ? `<small>${t('diff.untracked')}</small>` : ''}</button>${counts(f)}<button type="button" class="btn btn-icon btn-sm" data-action="diff-comment" data-id="${esc(key)}" aria-label="${t('diff.comment')}" data-tip="${t('diff.comment')}"${f.patch ? '' : ' disabled'}>${sym('s-chat')}</button><label class="df-seen">${box(w.id, f, 'label')}<span>${t('diff.seen')}</span></label></div>
    ${open ? bodyHtml(w.id, f, split) : ''}
  </section>`;
}

/* ---------- what the controls do ---------- */

const fileOf = (w: Worker, key: string): DiffFile | undefined => {
  const v = ui.diffs.get(w.id);
  return v && v !== 'loading' ? v.files.find((f) => keyOf(w.id, f.path) === key) : undefined;
};

/** Marked seen: folded (a hand fold is forgotten so the seen state decides). Unmarked: open again. */
export function setSeen(w: Worker, key: string, on: boolean) {
  const f = fileOf(w, key);
  if (!f) return;
  const s = seenSet(w.id);
  if (on) s.add(seenKey(f)); else s.delete(seenKey(f));
  ui.diffFold.delete(key);
  // A comment being written on a file that folds away would wait unseen: it is dropped.
  if (on && ui.diffDraft?.wid === w.id && ui.diffDraft.path === f.path) ui.diffDraft = null;
}

export function toggleFold(w: Worker, key: string) {
  const f = fileOf(w, key);
  if (f) ui.diffFold.set(key, !isOpen(w.id, f));
}

/** Folds every file when any is open, else opens them all. */
export function foldAll(w: Worker) {
  const v = ui.diffs.get(w.id);
  if (!v || v === 'loading') return;
  const anyOpen = v.files.some((f) => isOpen(w.id, f));
  for (const f of v.files) ui.diffFold.set(keyOf(w.id, f.path), !anyOpen);
}

/** The comment button: the file opens (a big one is drawn) and a comment starts on its first changed line. */
export function startFileComment(w: Worker, key: string) {
  const f = fileOf(w, key);
  if (!f?.patch) return;
  ui.diffFold.set(key, true);
  ui.diffBig.add(key);
  const first = numberedLines(f.patch).find((l) => l.kind === 'add' || l.kind === 'del') ?? numberedLines(f.patch).find((l) => l.kind === 'ctx');
  if (first) ui.diffDraft = { wid: w.id, path: f.path, at: first.i };
}

export function setLayout(v: 'unified' | 'split') {
  ui.diffLayout = v;
  try { localStorage.setItem('oma.diffLayout', v); } catch { /* not kept */ }
}

/** J/K: the next or previous file gets the ring and comes into view. */
export function stepFocus(w: Worker, dir: 1 | -1) {
  const v = ui.diffs.get(w.id);
  if (!v || v === 'loading' || !v.files.length) return;
  const at = ui.diffFocus?.wid === w.id ? v.files.findIndex((f) => f.path === ui.diffFocus!.path) : -1;
  const next = v.files[stepFile(at, v.files.length, dir)];
  ui.diffFocus = { wid: w.id, path: next.path };
}

export function focusedKey(w: Worker): string | null {
  return ui.diffFocus?.wid === w.id ? keyOf(w.id, ui.diffFocus.path) : null;
}

export function goTo(w: Worker, key: string) {
  const f = fileOf(w, key);
  if (!f) return;
  ui.diffFold.set(key, true);
  ui.diffFocus = { wid: w.id, path: f.path };
}

/** Brings the focused file's card into view after a render. */
export function showFocused() {
  const el = $('#ws-diff').querySelector<HTMLElement>('.df.focus');
  el?.scrollIntoView({ block: 'nearest' });
}

/**
 * Side by side turns on and off as the pane crosses 900 wide: the tab redraws when what is drawn no longer fits
 * the width (read from the drawn switch, so a redraw at another width in between cannot leave it stale).
 */
export function watchDiffWidth(redraw: () => void, root = $('#ws-diff')) {
  new ResizeObserver(() => {
    if (root.hidden || !root.clientWidth) return;
    const btn = root.querySelector<HTMLButtonElement>('[data-action="diff-layout"][data-v="split"]');
    if (btn && btn.disabled === layoutNow(root).canSplit) redraw();
  }).observe(root);
}

/**
 * J and K move between files, V marks the focused file seen, S switches one column and side by side: while the
 * Changes tab is on screen and nothing is being typed or covers it.
 */
export function bindDiffKeys(current: () => Worker | null, redraw: (w: Worker) => void) {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing || e.repeat && e.code !== 'KeyJ' && e.code !== 'KeyK') return;
    if (!['KeyJ', 'KeyK', 'KeyV', 'KeyS'].includes(e.code)) return;
    const root = $('#ws-diff');
    const w = current();
    if (!w || root.hidden || !root.offsetParent || !$('#dlg').hidden || ui.settingsShown) return;
    const el = e.target as HTMLElement;
    if (el.closest('input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable=""], [contenteditable="true"], .xterm')) return;
    const v = ui.diffs.get(w.id);
    if (!v || v === 'loading' || !v.files.length) return;
    e.preventDefault();
    if (e.code === 'KeyJ' || e.code === 'KeyK') stepFocus(w, e.code === 'KeyJ' ? 1 : -1);
    else if (e.code === 'KeyV') {
      const key = focusedKey(w);
      const f = key ? fileOf(w, key) : undefined;
      if (!key || !f) return;
      setSeen(w, key, !isSeen(w.id, f));
    } else {
      const { layout, canSplit } = layoutNow();
      if (!canSplit) return;
      setLayout(layout === 'split' ? 'unified' : 'split');
    }
    redraw(w);
    showFocused();
  });
}
