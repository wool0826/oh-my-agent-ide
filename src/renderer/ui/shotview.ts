// A report's screenshots (T-0102): thumbnails on the result card, and one opened over the window at full size, with
// the report's other shots a click or an arrow key away.
import { reportShots, shotUrl, type Shot } from '../../shared/shots';
import { $, base, esc, t } from './core';
import { layerClose, layerOpen } from './layer';

type Item = { path: string; label: string };

const label = (s: Shot) => (s.role ? [t(s.role === 'before' ? 'shot.before' : 'shot.after'), s.screen.replace(/-/g, ' ')].filter(Boolean).join(' · ') : base(s.path));

/** A report's files split into thumbnails and the rest, which stay file links. */
export function shotsOf(files: string[]) {
  const { shots, rest } = reportShots(files);
  return { html: shots.length ? `<div class="shots">${shots.map(thumb).join('')}</div>` : '', rest };
}

function thumb(s: Shot) {
  const l = label(s);
  return `<button type="button" class="shot" data-action="shot-open" data-path="${esc(s.path)}" data-label="${esc(l)}" data-tip="${esc(s.path)}" aria-label="${esc(`${l}, ${base(s.path)}`)}"><img src="${esc(shotUrl(s.path))}" alt="" loading="lazy" draggable="false"><span class="shot-l">${esc(l)}</span></button>`;
}

/** A thumbnail whose file is gone keeps its place and its label, without a broken image. */
export function markBrokenShot(e: Event) {
  const img = e.target;
  if (img instanceof HTMLImageElement) img.closest('.shot')?.classList.add('broken');
}

let items: Item[] = [];
let at = 0;

export function shotOpen() {
  const root = $('#dlg');
  return !root.hidden && root.dataset.key === 'shot';
}

/** Opens the clicked thumbnail; the other thumbnails of the same report come along. */
export function openShot(el: HTMLElement) {
  const root = $('#dlg');
  if (!root.hidden && !shotOpen()) return;
  const all = [...(el.closest('.shots')?.querySelectorAll<HTMLElement>('.shot') ?? [el])];
  items = all.map((x) => ({ path: x.dataset.path ?? '', label: x.dataset.label ?? '' }));
  at = Math.max(0, all.indexOf(el));
  if (!shotOpen()) layerOpen('shot');
  root.dataset.key = 'shot';
  root.classList.add('opening');
  root.hidden = false;
  renderShot();
  root.querySelector<HTMLButtonElement>('[data-action="shot-close"].btn')?.focus();
}

export function stepShot(d: number) {
  if (!shotOpen() || items.length < 2) return;
  showShot((at + d + items.length) % items.length);
}

export function showShot(i: number) {
  if (!shotOpen() || !items[i]) return;
  at = i;
  const keep = document.activeElement instanceof HTMLElement && $('#dlg').contains(document.activeElement) ? document.activeElement.dataset.action : null;
  renderShot();
  $('#dlg').classList.remove('opening');
  const back = keep === 'shot-pick' ? `[data-action="shot-pick"][data-i="${at}"]` : keep ? `[data-action="${keep}"]` : '';
  if (back) $('#dlg').querySelector<HTMLElement>(back)?.focus();
}

function renderShot() {
  const x = items[at];
  const pick = items.length > 1
    ? `<span class="seg" role="group">${items.map((s, i) => `<button type="button" data-action="shot-pick" data-i="${i}" aria-pressed="${i === at}">${esc(s.label)}</button>`).join('')}</span>`
    : '';
  $('#dlg').innerHTML = `<div class="dlg-back" data-action="shot-close"></div>
  <div class="dlg shot-view" role="dialog" aria-modal="true" aria-labelledby="shot-t">
    <div class="shot-bar"><b id="shot-t">${esc(x.label)}</b>${pick}<span class="gap"></span>
      <button type="button" class="btn btn-icon btn-sm btn-ghost" data-action="open-file" data-path="${esc(x.path)}" data-tip="${esc(x.path)}" aria-label="${esc(t('shot.openFile'))}"><svg aria-hidden="true"><use href="#s-open"/></svg></button>
      <button type="button" class="btn btn-icon btn-sm btn-ghost" data-action="shot-close" data-tip="${esc(t('close'))}" aria-label="${esc(t('close'))}"><svg aria-hidden="true"><use href="#s-x"/></svg></button>
    </div>
    <div class="shot-img"><img src="${esc(shotUrl(x.path))}" alt="${esc(base(x.path))}" draggable="false"></div>
  </div>`;
}

export function closeShot() {
  if (!shotOpen()) return;
  const root = $('#dlg');
  root.hidden = true;
  root.innerHTML = '';
  root.dataset.key = '';
  items = [];
  layerClose('shot');
}
