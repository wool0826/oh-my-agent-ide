// Swiping a row of the right sidebar's Notifications list to the left or the right clears it, as its ✕ and Delete do.
// By a pointer drag (mouse, touchpad click, touch) or by a two-finger swipe on a touchpad (its wheel events); the
// keyboard keeps Delete. A row that cannot be cleared (a decision waiting for the user, an "while you were away" row)
// only gives a little and comes back.

import { WHEEL_IDLE, swipeClears, swipeIntent, swipeResist, wheelStart, wheelStep, type WheelSwipe } from '../../shared/swipe';

/** Rows the swipe handles: results and auto-answers are cleared; decisions and away rows only resist. */
const ROW = '.ins-list :is([data-nav^="res:"], [data-nav^="aa:"], [data-nav^="inbox:"], [data-nav^="away:"])';
const CLEARS = /^(res|aa):/;
/** A press on a control inside the row is the control's, never a swipe. */
const OWN = 'button, a, input, textarea, select, label, [contenteditable], .fix';

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Rows a drag or a touchpad swipe holds: the other one leaves them alone. */
const held = new WeakSet<HTMLElement>();

/** The row a pointer or wheel event at `at` would swipe, if any. */
function rowAt(root: HTMLElement, at: Element | null, own: boolean): HTMLElement | null {
  const row = at?.closest<HTMLElement>(ROW);
  if (!row || !root.contains(row) || (own && at!.closest(OWN)) || row.matches('.editing, .swipe-out') || held.has(row)) return null;
  return row;
}

/** Calls `clear` with the row's key (`res:…` or `aa:…`) once a row is swiped away. */
export function initSwipe(root: HTMLElement, clear: (nav: string) => Promise<unknown>) {
  root.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const row = rowAt(root, e.target as Element | null, true);
    if (row) track(row, e, clear);
  });

  // A two-finger swipe: wheel events mostly sideways move the row under the fingers; ones mostly down scroll the list.
  // The gesture (and its momentum) ends once the events stop for a moment.
  let wheel: { row: HTMLElement; s: WheelSwipe; ctl: Swipe | null; timer: number } | null = null;
  // Wheel events before this time start nothing: the rest of a scroll, or the momentum of a swipe already let go.
  let calm = 0;
  const done = () => {
    if (!wheel) return;
    const { row, ctl } = wheel;
    wheel = null;
    held.delete(row);
    calm = performance.now() + WHEEL_IDLE;
    ctl?.end(false, 0);
  };
  root.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (!wheel) {
      const row = rowAt(root, e.target as Element | null, false);
      // A vertical scroll is the list's to the end, even when its last events drift sideways.
      if (!row || Math.abs(e.deltaX) <= Math.abs(e.deltaY) || e.timeStamp < calm) { calm = e.timeStamp + WHEEL_IDLE; return; }
      wheel = { row, s: wheelStart(), ctl: null, timer: 0 };
      held.add(row);
    }
    const w = wheel;
    clearTimeout(w.timer);
    w.timer = window.setTimeout(done, WHEEL_IDLE);
    if (w.s.mode === 'scroll') return;
    w.s = wheelStep(w.s, e.deltaX, e.deltaY, e.deltaMode, w.row.offsetWidth);
    if (w.s.mode === 'scroll') return;
    // Sideways: not the list's (nor the window's back and forward) to scroll.
    e.preventDefault();
    if (w.s.mode !== 'swipe') return;
    if (!w.row.isConnected) { clearTimeout(w.timer); return done(); }
    if (!w.ctl) w.ctl = swipe(w.row, clear);
    w.ctl.move(w.s.dx);
  }, { passive: false });
}

interface Swipe {
  /** Draws the row `dx` from where it rests. */
  move: (dx: number) => void;
  /** Lets go moving at `v` px/ms: the row goes away or comes back. */
  end: (cancel: boolean, v: number) => void;
}

/** Starts moving `row` sideways: the red side it leaves, and what letting go does. */
function swipe(row: HTMLElement, clear: (nav: string) => Promise<unknown>): Swipe {
  const nav = row.dataset.nav ?? '';
  const clears = CLEARS.test(nav);
  let dx = 0;
  let under: HTMLElement | null = null;

  const draw = () => {
    const x = clears ? dx : swipeResist(dx);
    row.style.transform = x ? `translateX(${x}px)` : '';
    if (!under) return;
    const w = row.offsetWidth;
    under.style.width = `${Math.min(Math.abs(dx), w)}px`;
    under.classList.toggle('right', dx < 0);
    under.classList.toggle('armed', swipeClears(dx, 0, w));
  };

  document.getSelection()?.removeAllRanges();
  row.classList.add('swiping');
  if (clears && row.parentElement) {
    row.parentElement.classList.add('swipe-host');
    under = document.createElement('div');
    under.className = 'swipe-under';
    under.setAttribute('aria-hidden', 'true');
    under.innerHTML = '<svg><use href="#s-x"/></svg>';
    under.style.top = `${row.offsetTop}px`;
    under.style.height = `${row.offsetHeight}px`;
    // At the end of the list, so the rows' own sibling rules (the line between two rows) stay as they are.
    row.parentElement.append(under);
  }

  const tidy = () => {
    under?.remove();
    under = null;
    row.parentElement?.classList.remove('swipe-host');
    row.classList.remove('swiping', 'swipe-out', 'swipe-close');
    row.style.transform = '';
    row.style.height = '';
  };

  /**
   * Moves the row (and the red side) from where they are drawn to where `set` puts them, then calls `then`. The end
   * state is set first and the animation only plays the way there, so it is right even when no frame runs (a hidden
   * window) or the user wants less motion.
   */
  const glide = (dur: string, set: () => void, then: () => void) => {
    const from = [row, under].map((el) => { if (!el) return null; const cs = getComputedStyle(el); return { el, t: el.style.transform, w: cs.width, h: cs.height, pt: cs.paddingTop, pb: cs.paddingBottom }; });
    set();
    // A window no one sees draws no frames and slows its timers: the animation would hold the row for nothing.
    if (still() || document.hidden) return then();
    const ms = parseFloat(getComputedStyle(row).getPropertyValue(dur)) || 180;
    const ease = getComputedStyle(row).getPropertyValue('--ease-out').trim() || 'ease-out';
    const runs = from.flatMap((f) => {
      if (!f) return [];
      const to = getComputedStyle(f.el);
      return [f.el.animate([{ transform: f.t || 'none', width: f.w, height: f.h, paddingTop: f.pt, paddingBottom: f.pb }, { transform: f.el.style.transform || 'none', width: to.width, height: to.height, paddingTop: to.paddingTop, paddingBottom: to.paddingBottom }], { duration: ms, easing: ease })];
    });
    let done = false;
    const go = () => { if (done) return; done = true; runs.forEach((a) => a.cancel()); then(); };
    void Promise.all(runs.map((a) => a.finished)).then(go, go);
    setTimeout(go, ms + 100);
  };

  const finish = () => {
    under?.remove();
    under = null;
    row.parentElement?.classList.remove('swipe-host');
    // The list drops the row once it is cleared. If clearing fails, or the row is somehow still drawn, it comes back.
    const restore = () => { if (row.isConnected) tidy(); };
    clear(nav).then(() => setTimeout(restore, 1000), restore);
  };

  // Out to the side, then the row closes up, then the list loses it (the toast offers Undo).
  const away = (side: number, w: number) => {
    row.classList.add('swipe-out');
    glide('--dur-base', () => { dx = side * w; draw(); }, () => {
      if (!row.isConnected) return finish();
      glide('--dur-fast', () => {
        row.style.height = '0px';
        row.classList.add('swipe-close');
        under?.style.setProperty('height', '0px');
      }, finish);
    });
  };

  return {
    move: (to) => { dx = to; draw(); },
    end: (cancel, v) => {
      if (!row.isConnected) return tidy();
      const w = row.offsetWidth;
      if (!cancel && clears && swipeClears(dx, v, w)) return away(Math.sign(dx) || 1, w);
      dx = 0;
      glide('--dur-base', draw, tidy);
    },
  };
}

function track(row: HTMLElement, down: PointerEvent, clear: (nav: string) => Promise<unknown>) {
  held.add(row);
  const x0 = down.clientX, y0 = down.clientY, id = down.pointerId;
  let mode: 'wait' | 'swipe' | 'scroll' = 'wait';
  let ctl: Swipe | null = null;
  let dx = 0;
  // The last moves, for the speed at letting go.
  const trail: { x: number; t: number }[] = [];

  const move = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    if (!row.isConnected) return end(true);
    dx = e.clientX - x0;
    if (mode === 'wait') {
      mode = swipeIntent(dx, e.clientY - y0);
      if (mode === 'scroll') return stop();
      if (mode === 'wait') return;
      try { row.setPointerCapture(id); } catch { /* the pointer is gone already */ }
      document.body.classList.add('swipe-drag');
      ctl = swipe(row, clear);
    }
    e.preventDefault();
    // Moves are handed over once a frame; the ones in between keep the speed right.
    for (const c of e.getCoalescedEvents?.() ?? []) trail.push({ x: c.clientX, t: c.timeStamp });
    if (trail[trail.length - 1]?.t !== e.timeStamp) trail.push({ x: e.clientX, t: e.timeStamp });
    while (trail.length > 2 && e.timeStamp - trail[0].t > 100) trail.shift();
    ctl!.move(dx);
  };

  let upAt = 0;
  const up = (e: PointerEvent) => { if (e.pointerId === id) { upAt = e.timeStamp; end(e.type === 'pointercancel'); } };

  const stop = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
    window.removeEventListener('keydown', esc, true);
    document.body.classList.remove('swipe-drag');
    held.delete(row);
  };

  // Escape puts a row being dragged back.
  const esc = (k: KeyboardEvent) => {
    if (k.key !== 'Escape' || mode !== 'swipe') return;
    k.preventDefault();
    k.stopPropagation();
    end(true);
  };

  const end = (cancel: boolean) => {
    stop();
    if (mode !== 'swipe' || !ctl) return;
    // The click that follows a drag on the row is not a click on it (a decision would be selected by it). Only that
    // one: a click elsewhere, or a later one, goes through.
    const eat = (c: Event) => {
      window.removeEventListener('click', eat, true);
      if (c.target instanceof Node && row.contains(c.target)) { c.stopPropagation(); c.preventDefault(); }
    };
    window.addEventListener('click', eat, true);
    setTimeout(() => window.removeEventListener('click', eat, true), 300);
    const first = trail[0], last = trail[trail.length - 1];
    // A row held still before letting go is not flicked, however fast it got there.
    const v = first && last && last.t > first.t && upAt - last.t <= 100 ? (last.x - first.x) / (last.t - first.t) : 0;
    ctl.end(cancel, v);
    mode = 'wait';
  };

  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('keydown', esc, true);
}
