// The handles on the inner edges of both sidebars: drag, double-click or arrow keys change the panel's width,
// kept in this window's storage. The rules (limits, fitting to the window) are in shared/panelWidth.
import { clampWidth, fitWidths, keyWidth, maxWidth, PANELS, parseWidth, type Layout, type Panel, type Widths } from '../../shared/panelWidth';
import { $, t } from './core';
import { glideAll } from './settings';
import { applyNarrow } from './sidebar';

const KEY: Record<Panel, string> = { side: 'oma.sideW', ins: 'oma.insW' };
const VAR: Record<Panel, string> = { side: '--sidebar-w', ins: '--inspector-w' };
const PANEL_LIST: Panel[] = ['side', 'ins'];

function read(p: Panel) {
  try { return parseWidth(p, localStorage.getItem(KEY[p])); } catch { return PANELS[p].def; }
}

function save(p: Panel) {
  try { localStorage.setItem(KEY[p], String(want[p])); } catch { /* not kept */ }
}

/** The widths the user chose; the window may show them narrower (fitWidths). */
const want: Widths = { side: read('side'), ins: read('ins') };

function layout(): Layout {
  const win = $('#win');
  return { winW: win.clientWidth || window.innerWidth, sideMin: win.classList.contains('side-min'), insMin: win.classList.contains('ins-min') || win.classList.contains('ins-over') };
}

const shownWidth = (p: Panel) => fitWidths(want, layout())[p];

/** Sets both widths on the window and the handles' values. Called whenever a panel opens, closes or is resized. */
export function applyWidths() {
  const win = $('#win');
  const l = layout();
  const shown = fitWidths(want, l);
  for (const p of PANEL_LIST) {
    win.style.setProperty(VAR[p], `${shown[p]}px`);
    const h = $(`#rz-${p}`);
    h.setAttribute('aria-valuenow', String(shown[p]));
    h.setAttribute('aria-valuemin', String(PANELS[p].min));
    h.setAttribute('aria-valuemax', String(maxWidth(p, want, l)));
    h.setAttribute('aria-label', t(p === 'side' ? 'rz.side' : 'rz.ins'));
  }
}

function setWidth(p: Panel, w: number) {
  want[p] = w;
  applyWidths();
}

/** Width changes that follow the pointer or the window are not animated. */
let stillTimer: number | undefined;
function still() {
  const win = $('#win');
  win.classList.add('rz-still');
  clearTimeout(stillTimer);
  stillTimer = window.setTimeout(() => win.classList.remove('rz-still'), 200);
}

function startDrag(p: Panel, h: HTMLElement, e: PointerEvent) {
  if (e.button !== 0) return;
  // No text selection starts from the press (.rz-drag keeps it off while dragging).
  e.preventDefault();
  const win = $('#win');
  const x0 = e.clientX;
  const w0 = shownWidth(p);
  h.setPointerCapture(e.pointerId);
  win.classList.add('rz-drag', 'rz-still');
  h.classList.add('active');
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - x0;
    setWidth(p, clampWidth(p, w0 + (p === 'side' ? dx : -dx), want, layout()));
  };
  const end = () => {
    h.removeEventListener('pointermove', move);
    h.removeEventListener('pointerup', end);
    h.removeEventListener('pointercancel', end);
    h.removeEventListener('lostpointercapture', end);
    if (h.hasPointerCapture(e.pointerId)) h.releasePointerCapture(e.pointerId);
    win.classList.remove('rz-drag', 'rz-still');
    h.classList.remove('active');
    save(p);
    glideAll(false);
  };
  h.addEventListener('pointermove', move);
  h.addEventListener('pointerup', end);
  h.addEventListener('pointercancel', end);
  h.addEventListener('lostpointercapture', end);
}

export function initResize() {
  for (const p of PANEL_LIST) {
    const h = $(`#rz-${p}`);
    h.addEventListener('pointerdown', (e) => startDrag(p, h, e));
    h.addEventListener('dblclick', () => { setWidth(p, PANELS[p].def); save(p); glideAll(false); });
    h.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const w = keyWidth(p, e.key, e.shiftKey, shownWidth(p), want, layout());
      if (w == null) return;
      e.preventDefault();
      e.stopPropagation();
      setWidth(p, w);
      save(p);
    });
  }
  window.addEventListener('resize', () => { still(); if (!applyNarrow()) applyWidths(); });
  applyNarrow();
  applyWidths();
}
