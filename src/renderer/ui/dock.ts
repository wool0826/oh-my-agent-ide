// The dock under the chat (T-0081, G1 of the T-0079 audit; shared/dock.ts): the side terminal and the side question
// as two tabs of one panel between the chat and its composer. The chat gets shorter instead of being covered, and the
// two never sit on each other. Its top edge sets its height; it spans the chat's width.
import { clampDockH, DOCK_DEF, DOCK_MIN, keyDockH, parseDockH, type DockTab } from '../../shared/dock';
import { $, t } from './core';
import { setTip } from './tip';

const H_KEY = 'oma.dockH';

export const dock = {
  /** The tab showing; null while the dock is put away. */
  tab: null as DockTab | null,
};

let h = (() => { try { return parseDockH(localStorage.getItem(H_KEY)); } catch { return DOCK_DEF; } })();

/** Drawn again when the tab changes: the terminal and the side question each keep their own content and button. */
const renders: (() => void)[] = [];
export const onDock = (fn: () => void) => { renders.push(fn); };

/** Show `tab` in the dock, or put the dock away (null). */
export function setDock(tab: DockTab | null) {
  if (dock.tab === tab) return;
  dock.tab = tab;
  renderDock();
  for (const fn of renders) fn();
}

/** The room the dock has: the chat's height less its composer and the least of the chat kept above it. */
function room() {
  const main = $('#dock').parentElement!;
  const composer = document.getElementById('chat-form');
  return main.clientHeight - (composer?.offsetHeight ?? 0) - 160;
}

function applyH() {
  const s = clampDockH(h, room());
  $('#dock').style.setProperty('--dock-h', `${s}px`);
  const grip = $('#dock-rz');
  grip.setAttribute('aria-valuenow', String(s));
  grip.setAttribute('aria-valuemin', String(DOCK_MIN));
  grip.setAttribute('aria-valuemax', String(Math.max(DOCK_MIN, Math.round(room()))));
}

function saveH(v: number) {
  h = clampDockH(v, room());
  applyH();
  try { localStorage.setItem(H_KEY, String(h)); } catch { /* not kept */ }
}

export function renderDock() {
  const el = $('#dock');
  const tab = dock.tab;
  el.hidden = !tab;
  $('#chat-thread').parentElement!.classList.toggle('dock-open', !!tab);
  if (!tab) return;
  for (const b of el.querySelectorAll<HTMLElement>('.dock-tab')) {
    const on = b.dataset.v === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  for (const g of el.querySelectorAll<HTMLElement>('.dock-tools')) g.hidden = g.dataset.for !== tab;
  const hide = $('#dock-hide');
  hide.setAttribute('aria-label', t('dock.hide'));
  setTip(hide, t('dock.hide'), 'Esc');
  applyH();
}

/** ← → between the tabs, as a tab list does; the tab follows the focus. */
function tabKeys(e: KeyboardEvent, open: (tab: DockTab) => void) {
  // The terminal's own tabs (ui/xterm.ts) are a tab list of their own.
  const b = (e.target as HTMLElement).closest<HTMLElement>('.dock-tab');
  if (!b || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return false;
  e.preventDefault();
  const next = (b.dataset.v === 'tm' ? 'sq' : 'tm') as DockTab;
  open(next);
  $(`#dock-tab-${next}`).focus();
  return true;
}

/** `open` shows a tab with its input focused (app.ts: openTerm / openSide). */
export function bindDock(open: (tab: DockTab) => void) {
  const el = $('#dock');
  const grip = $('#dock-rz');
  el.addEventListener('keydown', (e) => { if (!e.isComposing) tabKeys(e, open); });
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = el.offsetHeight;
    el.classList.add('sizing');
    grip.classList.add('active');
    // The dock sits on the composer and grows up.
    const move = (m: PointerEvent) => { h = clampDockH(h0 - (m.clientY - y0), room()); applyH(); };
    const up = (ev: PointerEvent) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      grip.removeEventListener('lostpointercapture', up);
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      el.classList.remove('sizing');
      grip.classList.remove('active');
      if (ev.type === 'pointercancel') { h = h0; applyH(); } else saveH(h);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
    grip.addEventListener('lostpointercapture', up);
  });
  // A double-click goes back to the first height.
  grip.addEventListener('dblclick', () => saveH(DOCK_DEF));
  grip.addEventListener('focus', applyH);
  grip.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const next = keyDockH(e.key, e.shiftKey, el.offsetHeight, room());
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    saveH(next);
  });
  window.addEventListener('resize', () => { if (dock.tab) applyH(); });
}
