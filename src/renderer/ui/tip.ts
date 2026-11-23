/**
 * One tooltip for the whole app, in place of the native `title`.
 *   data-tip="text"       the hint. Not shown when it only repeats the control's visible text.
 *   data-tip-key="Ctrl+B" a shortcut, drawn as a key after the text.
 *   data-tip-clip         show the hint only while the control, or a part of it, is cut.
 * Text the layout cuts with an ellipsis needs no attribute: resting on it shows it in full.
 */
import { TIP_EDGE, TIP_GAP, tipDescribes, tipJoin, tipPlace, tipRepeats, tipWait } from '../../shared/tip';

const OWNER = '[data-tip]';
/** A press is followed by a redraw that puts a new element under the pointer; that is not a new hover. */
const AFTER_PRESS = 700;
/** A focused control says the cut text inside it, unless it is a whole list. */
const DEEP_MAX = 40;

interface Hit { at: HTMLElement; text: string; again: () => string }

let el: HTMLElement | null = null;
let owner: HTMLElement | null = null;
let said = '';
let described = false;
/** Shown for the keyboard: it stays while its control has the focus, wherever the pointer goes. */
let byFocus = false;
let showTimer = 0;
let hideTimer = 0;
let goneTimer = 0;
let watch = 0;
let hiddenAt = 0;
let pressedAt = 0;

const clipped = (x: HTMLElement) => x.scrollWidth > x.clientWidth + 1 || x.scrollHeight > x.clientHeight + 1;
const shown = (x: HTMLElement) => (x.innerText ?? x.textContent ?? '').trim();

/** The layout cuts this element's text (one line with an ellipsis, or a clamp) and it does not fit now. */
function isCut(x: HTMLElement): boolean {
  const cs = getComputedStyle(x);
  if (cs.textOverflow !== 'ellipsis' && cs.getPropertyValue('-webkit-line-clamp') === 'none') return false;
  return cs.overflowX !== 'visible' && clipped(x);
}

/** What the control's own hint says now, or nothing. */
function textOf(x: HTMLElement): string {
  const own = x.dataset.tip ?? '';
  if (!own) return '';
  if ('tipClip' in x.dataset) return clipped(x) || ([...x.children] as HTMLElement[]).some(clipped) ? own : '';
  return tipRepeats(own, shown(x)) ? '' : own;
}

/** The nearest control around the element that has a hint to show. */
function ownerOf(from: HTMLElement): HTMLElement | null {
  let x = from.closest<HTMLElement>(OWNER);
  while (x && !textOf(x)) x = x.parentElement?.closest<HTMLElement>(OWNER) ?? null;
  return x;
}

/** Cut text at the pointer: the element under it or one close around it. */
function cutAt(from: HTMLElement): HTMLElement[] {
  let x: HTMLElement | null = from;
  for (let i = 0; x && i < 3; i++, x = x.parentElement) if (isCut(x)) return [x];
  return [];
}

/** Cut text inside a focused control. */
function cutIn(from: HTMLElement): HTMLElement[] {
  if (isCut(from)) return [from];
  const all = from.querySelectorAll<HTMLElement>('*');
  return all.length > DEEP_MAX ? [] : [...all].filter(isCut);
}

function read(from: HTMLElement, deep: boolean): Hit | null {
  if (el?.contains(from)) return null;
  const at = ownerOf(from);
  const cut = (deep ? cutIn(from) : cutAt(from)).filter((x) => x !== at);
  // A focused card has no hint of its own, but the exact time on its relative one is worth saying.
  const time = deep && !at ? from.querySelector<HTMLElement>('time[data-tip]')?.dataset.tip ?? '' : '';
  const text = tipJoin(cut.map(shown), at ? textOf(at) : time);
  const anchor = at ?? (deep ? from : cut[0]);
  return text && anchor ? { at: anchor, text, again: () => read(from, deep)?.text ?? '' } : null;
}

function place(at: HTMLElement) {
  if (!el) return;
  const p = tipPlace(at.getBoundingClientRect(), el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight, !!at.closest('.toolbar'), TIP_GAP, TIP_EDGE);
  el.style.left = `${p.left}px`;
  el.style.top = `${p.top}px`;
  el.dataset.side = p.below ? 'below' : 'above';
}

function show(hit: Hit, focus = false) {
  if (!el || !hit.at.isConnected) return;
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  clearTimeout(goneTimer);
  release();
  owner = hit.at;
  said = hit.text;
  byFocus = focus;
  const body = document.createElement('span');
  body.textContent = hit.text;
  el.replaceChildren(body);
  const key = hit.at.dataset.tipKey;
  if (key) {
    const k = document.createElement('kbd');
    k.textContent = key;
    el.append(k);
  }
  el.hidden = false;
  el.classList.remove('on');
  place(hit.at);
  void el.offsetWidth;
  el.classList.add('on');
  // Cut text is in the page in full already; only a hint of its own describes the control.
  if (hit.at.dataset.tip === hit.text && tipDescribes(hit.text, hit.at.getAttribute('aria-label'), hit.at.textContent ?? '') && !hit.at.hasAttribute('aria-describedby')) {
    hit.at.setAttribute('aria-describedby', 'tip');
    described = true;
  }
  // The control can go away or change under the tip without any event on it.
  watch = window.setInterval(() => { if (!owner?.isConnected || hit.again() !== said) hideTip(); }, 250);
}

/** Give the control back as it was. */
function release() {
  clearInterval(watch);
  if (owner && described) owner.removeAttribute('aria-describedby');
  described = false;
  owner = null;
  said = '';
}

/** Take the tooltip away now. */
export function hideTip() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  if (!el || !owner) return;
  release();
  hiddenAt = performance.now();
  el.classList.remove('on');
  const node = el;
  goneTimer = window.setTimeout(() => { node.hidden = true; }, 150);
}

/** The pointer is often on an icon's SVG: the element that counts is the HTML one around it. */
function htmlOf(target: EventTarget | null): HTMLElement | null {
  let x = target instanceof Element ? target : null;
  while (x && !(x instanceof HTMLElement)) x = x.parentElement;
  return x;
}

function hover(from: EventTarget | null) {
  const target = htmlOf(from);
  if (!target) { leave(); return; }
  // On the tooltip itself: it stays.
  if (el?.contains(target)) { clearTimeout(hideTimer); return; }
  const hit = read(target, false);
  if (!hit) { leave(); return; }
  clearTimeout(hideTimer);
  if (hit.at === owner && hit.text === said) return;
  clearTimeout(showTimer);
  const now = performance.now();
  const wait = tipWait(false, now, owner ? now : hiddenAt);
  if (!wait) { show(hit); return; }
  showTimer = window.setTimeout(() => {
    // Still there, and still with something to say.
    const fresh = target.isConnected && target.matches(':hover') ? read(target, false) : null;
    if (fresh) show(fresh);
  }, wait);
}

/** The pointer left: a short grace lets it cross the gap onto the tooltip. */
function leave() {
  clearTimeout(showTimer);
  if (!owner || (byFocus && owner.matches(':focus, :focus-within'))) return;
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hideTip, 100);
}

/** Set or clear a control's hint (and its shortcut) from code. */
export function setTip(x: HTMLElement, text: string, key = '') {
  if (text) x.dataset.tip = text; else delete x.dataset.tip;
  if (key) x.dataset.tipKey = key; else delete x.dataset.tipKey;
}

export function initTip() {
  el = document.getElementById('tip');
  if (!el) return;
  document.addEventListener('mouseover', (e) => { if (performance.now() - pressedAt >= AFTER_PRESS) hover(e.target); });
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) leave(); });
  // The keyboard gets the hint at once; a click's focus is not a request for it.
  document.addEventListener('focusin', (e) => {
    const x = htmlOf(e.target);
    if (!x || performance.now() - pressedAt < 100 || !x.matches(':focus-visible')) return;
    const hit = read(x, true);
    if (hit) show(hit, true);
  });
  document.addEventListener('focusout', (e) => { if (owner && e.target instanceof Node && (owner.contains(e.target) || e.target.contains(owner))) hideTip(); });
  document.addEventListener('pointerdown', (e) => { if (el?.contains(e.target as Node)) return; pressedAt = performance.now(); hideTip(); }, true);
  document.addEventListener('keydown', hideTip, true);
  document.addEventListener('scroll', (e) => { if (owner && e.target instanceof Node && e.target.contains(owner)) hideTip(); }, true);
  window.addEventListener('blur', hideTip);
  window.addEventListener('resize', hideTip);
}
