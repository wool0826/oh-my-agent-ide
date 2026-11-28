// Moving tasks in the sidebar's queue (11B): the row menu, Alt+arrows and P on a focused row, and dragging a row.
// What a move does is shared/queue.ts moveQueued; main applies it (queue:move) and the queue redraws from the state.
import { dropBefore, moveQueued, type QueueMove } from '../../shared/queue';
import { queueOrder } from '../../shared/slots';
import type { Task } from '../../shared/types';
import { $, esc, isMac, S, sym, t, task, tryCall, toast } from './core';

/** The tasks waiting for a slot, in queue order: the line the rows can be moved in. */
function line(): Task[] {
  return S ? queueOrder(S.tasks, 'slot') : [];
}

/** Whether `move` would change anything for the task `id`. */
export function canMove(id: string, move: QueueMove): boolean {
  const x = task(id);
  return !!x && moveQueued(line(), id, move, x) !== null;
}

/** A focused row is drawn again after the move; the focus stays on it. */
let refocus: string | null = null;

export async function moveTask(id: string, move: QueueMove) {
  if (!canMove(id, move)) return;
  if (document.activeElement?.closest('#side .q-row')) refocus = id;
  const r = await tryCall<boolean>('queue:move', id, move);
  if (!r.ok) { refocus = null; toast(r.error, true); }
}

/** After the sidebar is drawn: the row that had the focus before its move gets it back. */
export function afterQueueDrawn() {
  if (dragging) markDrag();
  if (!refocus) return;
  const el = document.querySelector<HTMLElement>(`#side .q-row[data-id="${CSS.escape(refocus)}"] .row-main`);
  if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); refocus = null; }
}

const keys = (...k: string[]) => (isMac ? k.join('') : k.join('+'));

/** The row menu: start next, to the top, pin, cancel. A move that would change nothing is shown off. */
export function queueMenuHtml(id: string) {
  const x = task(id);
  const item = (move: 'next' | 'top' | 'pin', icon: string, label: string, key = '') =>
    `<button class="menu-item" role="menuitem" data-action="queue-move" data-id="${esc(id)}" data-v="${move}" data-close${canMove(id, move) ? '' : ' disabled'}>${sym(icon, 'mi')}<span>${esc(label)}</span>${key ? `<small>${esc(key)}</small>` : ''}</button>`;
  return item('next', 's-play', t('side.qNext'))
    + item('top', 's-up', t('side.qTop'), isMac ? '⇧⌥↑' : keys('Alt', 'Shift', '↑'))
    + item('pin', 's-pin', t(x?.queuePinned ? 'side.qUnpin' : 'side.qPin'), 'P')
    + `<div class="menu-sep"></div><button class="menu-item" role="menuitem" data-action="task-cancel" data-id="${esc(id)}" data-close>${sym('s-x', 'mi')}<span>${t('cancel.task')}</span></button>`;
}

/** Alt+Up/Down, Alt+Shift+Up and P on a focused queue row. Says whether the key was taken. */
export function queueKeys(e: KeyboardEvent): boolean {
  const row = (e.target as HTMLElement).closest<HTMLElement>('#side .q-row[data-id]');
  if (!row || e.ctrlKey || e.metaKey) return false;
  const id = row.dataset.id!;
  let move: QueueMove | null = null;
  if (e.altKey && e.key === 'ArrowUp') move = e.shiftKey ? 'top' : 'up';
  else if (e.altKey && !e.shiftKey && e.key === 'ArrowDown') move = 'down';
  else if (!e.altKey && !e.shiftKey && e.code === 'KeyP') move = 'pin';
  if (!move) return false;
  e.preventDefault();
  e.stopPropagation();
  void moveTask(id, move);
  return true;
}

// Dragging: the rows may be drawn again while a row is dragged, so the drag keeps ids and finds the rows each time.
// The drop line is its own element over the page.

interface Drag { id: string; x: number; y: number; on: boolean; before: string | null | undefined; ok: boolean }
let dragging: Drag | null = null;

/** The rows of the line, top to bottom. */
function lineRows() {
  return [...document.querySelectorAll<HTMLElement>('#side .q-line .q-row[data-id]')];
}

function markDrag() {
  for (const r of document.querySelectorAll('#side .q-row.drag')) r.classList.remove('drag');
  if (dragging?.on) document.querySelector(`#side .q-row[data-id="${CSS.escape(dragging.id)}"]`)?.classList.add('drag');
}

function dropLine(): HTMLElement {
  let el = document.getElementById('q-drop');
  if (!el) {
    el = document.createElement('div');
    el.id = 'q-drop';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
  }
  return el;
}

function onMove(e: PointerEvent) {
  const d = dragging;
  if (!d) return;
  if (!d.on) {
    if (Math.abs(e.clientY - d.y) < 4 && Math.abs(e.clientX - d.x) < 4) return;
    d.on = true;
    document.body.classList.add('q-dragging');
  }
  markDrag();
  const rows = lineRows();
  const box = rows.map((r) => ({ id: r.dataset.id!, el: r, rect: r.getBoundingClientRect() }));
  const before = dropBefore(box.map((b) => ({ id: b.id, top: b.rect.top, height: b.rect.height })), e.clientY);
  const x = task(d.id);
  const held = !box.some((b) => b.id === d.id);
  d.before = before;
  d.ok = !held && !!x && moveQueued(line(), d.id, { before }, x) !== null;
  const el = dropLine();
  const at = before === null ? box[box.length - 1] : box.find((b) => b.id === before);
  // A move to where the row already is shows nothing; one the queue refuses (a task held by a merge) shows red.
  if (!at || (!d.ok && !held)) { el.hidden = true; return; }
  const y = before === null ? at.rect.bottom : at.rect.top;
  el.hidden = false;
  el.classList.toggle('bad', held);
  el.style.left = `${at.rect.left + 8}px`;
  el.style.width = `${at.rect.width - 16}px`;
  el.style.top = `${y - 1}px`;
}

function endDrag(drop: boolean) {
  const d = dragging;
  dragging = null;
  document.removeEventListener('pointermove', onMove, true);
  document.removeEventListener('pointerup', onUp, true);
  document.removeEventListener('pointercancel', onCancel, true);
  document.removeEventListener('keydown', onKey, true);
  document.body.classList.remove('q-dragging');
  const el = document.getElementById('q-drop');
  if (el) el.hidden = true;
  markDrag();
  if (!d?.on) return;
  // The click that ends a drag does not open the row.
  document.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => document.removeEventListener('click', swallow, true));
  if (drop && d.ok && d.before !== undefined) void moveTask(d.id, { before: d.before });
}
const swallow = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
const onUp = () => endDrag(true);
const onCancel = () => endDrag(false);
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endDrag(false); } };

/** A row of the queue follows the pointer once it moves a few pixels with the button down; Escape drops nothing. */
export function bindQueueDrag() {
  $('#side').addEventListener('pointerdown', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.q-row[data-id]');
    if (!row || e.button !== 0 || (e.target as HTMLElement).closest('.row-acts')) return;
    dragging = { id: row.dataset.id!, x: e.clientX, y: e.clientY, on: false, before: undefined, ok: false };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onCancel, true);
    document.addEventListener('keydown', onKey, true);
  });
}
