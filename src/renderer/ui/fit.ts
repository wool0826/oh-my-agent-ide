// Controls that follow their own width while it changes (a sidebar dragged, the keyboard on its handle, a double-click,
// a new text size), not only after the change ends: segmented controls place their pill, and rows marked `data-fit`
// choose their compact form. A ResizeObserver runs after layout and before paint, so both move in the same frame.
//
// The compact form is the attribute `data-fitted`, not a class: the body's MutationObserver watches classes, and a
// class turned off to measure and on again would wake it every frame.

import { glide } from './settings';

const watched = new WeakSet<Element>();

/**
 * data-fit="tabs": the labels do not fit on one line, so the tabs that are not chosen show their icon (the label stays
 * for screen readers and as the tooltip).
 * data-fit="stack": the buttons do not fit on one row, so they stack at full width instead of breaking into two rows.
 */
export function fit(el: HTMLElement) {
  const kind = el.dataset.fit;
  if (!kind || !el.offsetParent) return;
  el.removeAttribute('data-fitted');
  const kids = [...el.children] as HTMLElement[];
  const over = kind === 'tabs'
    ? kids.some((b) => b.scrollWidth > b.clientWidth + 1)
    : kids.length > 1 && kids.some((b) => b.offsetTop > kids[0].offsetTop + 2);
  if (over) el.setAttribute('data-fitted', '');
}

const sizes = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const el = target as HTMLElement;
    if (el.dataset.fit) fit(el);
    // No spring while the width changes: the spring is for choosing another segment.
    if (el.matches('.seg')) glide(el, false);
  }
});

/**
 * Follow every control on the page that is not followed yet (a new one is measured at once), and measure the rows
 * again: a new text size or font changes what fits without changing the row's own width. Called once a frame at most,
 * from glideAll.
 */
export function fitAll() {
  document.querySelectorAll<HTMLElement>('.seg, [data-fit]').forEach((el) => {
    if (el.dataset.fit) fit(el);
    if (watched.has(el)) return;
    watched.add(el);
    sizes.observe(el);
  });
}
