// A report's screenshots (T-0102): thumbnails on the result card, and one opened over the window at full size, with
// the report's other shots a click or an arrow key away. A screen shows one before/after pair; its other parts
// (wide/narrow, dark/light) are switches above it, on the card and in the opened view alike (decision 229).
import type { Key } from '../../shared/i18n';
import { middleName } from '../../shared/middleName';
import { firstPick, pickShot, setView, shotSets, shotUrl, SHOT_AXES, type Shot, type ShotAxis, type ShotPick, type ShotRole, type ShotSet } from '../../shared/shots';
import { $, base, esc, sym, t } from './core';
import { layerClose, layerOpen } from './layer';

const ROLE_KEY: Record<ShotRole, Key> = { before: 'shot.before', after: 'shot.after' };
const AXIS_KEY: Record<ShotAxis | 'role', Key> = { role: 'shot.version', width: 'shot.width', theme: 'shot.theme' };
const VALUE_KEY: Record<string, Key> = { before: 'shot.before', after: 'shot.after', wide: 'shot.wide', narrow: 'shot.narrow', dark: 'shot.dark', light: 'shot.light' };
const AXES = Object.keys(SHOT_AXES) as ShotAxis[];

/** "After · inbox · narrow · dark"; a name without any of those parts is its file name. */
const label = (s: Shot) => [s.role ? t(ROLE_KEY[s.role]) : '', s.screen.replace(/-/g, ' '), ...AXES.map((a) => (s[a] ? t(VALUE_KEY[s[a]!]) : ''))].filter(Boolean).join(' · ') || base(s.path);

/** The sets each place drew, by its key, so a switch or the opened view finds them without reading the report again. */
const placed = new Map<string, ShotSet[]>();
/** The switches of each set, by place and screen: they stay as they were when the card is drawn again. */
const picks = new Map<string, ShotPick>();
const pickId = (key: string, set: ShotSet) => `${key}|${set.screen}`;
/** The kept switches, less a value the set no longer has. */
function pickOf(key: string, set: ShotSet): ShotPick {
  const pick = firstPick(set), kept = picks.get(pickId(key, set)) ?? {};
  for (const a of AXES) if (kept[a] && set.axes[a]?.includes(kept[a]!)) pick[a] = kept[a];
  return pick;
}

/**
 * A report's files split into its screenshots, as thumbnails, and the rest, which stay files. `key` names the place
 * (a card, an inbox row, a summary) so its switches are its own.
 */
export function shotsOf(files: string[], key: string) {
  const { sets, rest } = shotSets(files);
  placed.delete(key);
  if (!sets.length) return { html: '', rest };
  placed.set(key, sets);
  // Places drawn long ago and gone from the screen are forgotten first, with their switches.
  if (placed.size > 400) {
    const old = placed.keys().next().value!;
    placed.delete(old);
    for (const p of picks.keys()) if (p.startsWith(`${old}|`)) picks.delete(p);
  }
  return { html: `<div class="shots" data-key="${esc(key)}">${sets.map((s, i) => setHtml(key, i, s)).join('')}</div>`, rest };
}

/** Files that are not screenshots, as one-line chips that open them. */
export function fileChips(files: string[]) {
  if (!files.length) return '';
  return `<span class="rfiles">${files.map((f) => `<a class="fchip" tabindex="0" role="link" data-action="open-file" data-path="${esc(f)}" data-tip="${esc(f)}">${sym('s-doc')}<span class="fn">${esc(middleName(base(f)))}</span></a>`).join('')}</span>`;
}

function setHtml(key: string, i: number, set: ShotSet) {
  const pick = pickOf(key, set);
  const v = setView(set, pick);
  const sw = AXES.filter((a) => set.axes[a]).map((a) => `<span class="seg" role="group" aria-label="${esc(t(AXIS_KEY[a]))}">${set.axes[a]!.map((val) => `<button type="button" data-action="shot-axis" data-key="${esc(key)}" data-i="${i}" data-axis="${a}" data-v="${val}" aria-pressed="${pick[a] === val}">${t(VALUE_KEY[val])}</button>`).join('')}</span>`);
  const count = v.hidden ? `<span class="gap"></span><span class="shot-n" data-tip="${esc(t('shot.count', { n: set.shots.length }))}">${sym('s-image')}${set.shots.length}</span>` : '';
  const row = set.roles.length || sw.length ? `<div class="shot-row">${set.screen ? `<b>${esc(set.screen.replace(/-/g, ' '))}</b>` : ''}${sw.join('')}${count}</div>` : '';
  // A lone image with nothing to tell it by is captioned with its file name.
  const lone = set.shots.length === 1 && !set.roles.length;
  const cols = v.cols.map((c) => `<div class="shot-col">${c.role ? `<span class="shot-h">${t(ROLE_KEY[c.role])}</span>` : ''}${c.shot ? thumb(c.shot, lone ? base(c.shot.path) : '') : '<span class="shot none"></span>'}</div>`).join('');
  return `<div class="shot-set${v.cols.length === 1 ? ' one' : ''}" data-i="${i}">${row}<div class="shot-grid">${cols}</div></div>`;
}

/** Files that failed to load, so a redrawn card does not try them again. */
const broken = new Set<string>();

function thumb(s: Shot, cap: string) {
  const l = label(s);
  const capHtml = cap ? `<span class="shot-l">${esc(middleName(cap))}</span>` : '';
  if (broken.has(s.path)) return `<span class="shot broken" data-path="${esc(s.path)}" data-tip="${esc(s.path)}"><img alt="">${capHtml}</span>`;
  return `<button type="button" class="shot" data-action="shot-open" data-path="${esc(s.path)}" data-tip="${esc(s.path)}" aria-label="${esc(`${l}, ${base(s.path)}`)}"><img src="${esc(shotUrl(s.path))}" alt="" loading="lazy" draggable="false">${capHtml}</button>`;
}

/** A thumbnail whose file is gone keeps its place, without a broken image. */
export function markBrokenShot(e: Event) {
  const img = e.target;
  const el = img instanceof HTMLImageElement ? img.closest<HTMLElement>('.shot') : null;
  if (!el?.dataset.path) return;
  broken.add(el.dataset.path);
  el.classList.add('broken');
  el.removeAttribute('data-action');
  el.setAttribute('aria-disabled', 'true');
}

/** A switch above a set: shows the pair it picks, with the focus kept on the switch. */
export function pickAxis(el: HTMLElement) {
  if (el.closest('#dlg')) { dlgAxis(el.dataset.axis ?? '', el.dataset.v ?? ''); return; }
  const key = el.dataset.key ?? '', i = Number(el.dataset.i), axis = el.dataset.axis as ShotAxis;
  const set = placed.get(key)?.[i];
  const box = el.closest<HTMLElement>('.shot-set');
  if (!set || !box || !set.axes[axis]) return;
  picks.set(pickId(key, set), { ...pickOf(key, set), [axis]: el.dataset.v });
  box.outerHTML = setHtml(key, i, set);
  document.querySelector<HTMLElement>(`.shots[data-key="${CSS.escape(key)}"] > .shot-set[data-i="${i}"] [data-action="shot-axis"][data-axis="${axis}"][data-v="${CSS.escape(el.dataset.v ?? '')}"]`)?.focus();
}

type Item = { shot: Shot; set: ShotSet };

let items: Item[] = [];
let at = 0;

export function shotOpen() {
  const root = $('#dlg');
  return !root.hidden && root.dataset.key === 'shot';
}

/** Opens the clicked thumbnail; every shot of the same report comes along. */
export function openShot(el: HTMLElement) {
  const root = $('#dlg');
  if (!root.hidden && !shotOpen()) return;
  const sets = placed.get(el.closest<HTMLElement>('.shots')?.dataset.key ?? '') ?? [];
  items = sets.flatMap((set) => set.shots.map((shot) => ({ shot, set })));
  at = items.findIndex((x) => x.shot.path === el.dataset.path);
  if (at < 0) return;
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
  const a = document.activeElement;
  const keep = a instanceof HTMLElement && $('#dlg').contains(a) ? a : null;
  const back = keep?.dataset.action === 'shot-pick' ? `[data-action="shot-pick"][data-i="${at}"]`
    : keep?.dataset.action === 'shot-axis' ? `[data-action="shot-axis"][data-axis="${keep.dataset.axis}"][data-v="${keep.dataset.v}"]`
      : keep?.dataset.action ? `[data-action="${keep.dataset.action}"]` : '';
  renderShot();
  $('#dlg').classList.remove('opening');
  if (back) $('#dlg').querySelector<HTMLElement>(back)?.focus();
}

/** A switch in the opened view: the shot of the same screen that differs only in that part. */
function dlgAxis(axis: string, v: string) {
  const { shot, set } = items[at] ?? {};
  if (!shot || !set) return;
  const role = axis === 'role' ? (v as ShotRole) : shot.role;
  const pick: ShotPick = {};
  for (const a of AXES) if (set.axes[a] && shot[a]) pick[a] = shot[a]!;
  if (axis !== 'role') pick[axis as ShotAxis] = v;
  const to = pickShot(set, role, pick);
  const i = to ? items.findIndex((x) => x.shot === to) : -1;
  if (i >= 0) showShot(i);
}

function renderShot() {
  const { shot: x, set } = items[at];
  const seg = (axis: ShotAxis | 'role', vals: string[], on: string | null) => `<span class="seg" role="group" aria-label="${esc(t(AXIS_KEY[axis]))}">${vals.map((val) => `<button type="button" data-action="shot-axis" data-axis="${axis}" data-v="${val}" aria-pressed="${on === val}">${t(VALUE_KEY[val])}</button>`).join('')}</span>`;
  const segs = [set.roles.length > 1 ? seg('role', set.roles, x.role) : '', ...AXES.map((a) => (set.axes[a] ? seg(a, set.axes[a]!, x[a]) : ''))].join('');
  const strip = items.length > 1
    ? `<div class="shot-strip">${items.map((s, i) => `<button type="button" data-action="shot-pick" data-i="${i}" aria-pressed="${i === at}" aria-label="${esc(label(s.shot))}" data-tip="${esc(label(s.shot))}"><img src="${esc(shotUrl(s.shot.path))}" alt="" loading="lazy" draggable="false"></button>`).join('')}</div>`
    : '';
  $('#dlg').innerHTML = `<div class="dlg-back" data-action="shot-close"></div>
  <div class="dlg shot-view" role="dialog" aria-modal="true" aria-labelledby="shot-t">
    <div class="shot-bar"><b id="shot-t">${esc(label(x))}</b><span class="gap"></span>
      <button type="button" class="btn btn-icon btn-sm btn-ghost" data-action="open-file" data-path="${esc(x.path)}" data-tip="${esc(x.path)}" aria-label="${esc(t('shot.openFile'))}"><svg aria-hidden="true"><use href="#s-open"/></svg></button>
      <button type="button" class="btn btn-icon btn-sm btn-ghost" data-action="shot-close" data-tip="${esc(t('close'))}" aria-label="${esc(t('close'))}"><svg aria-hidden="true"><use href="#s-x"/></svg></button>
    </div>
    ${segs ? `<div class="shot-segs">${segs}</div>` : ''}
    <div class="shot-img"><img src="${esc(shotUrl(x.path))}" alt="${esc(base(x.path))}" draggable="false"></div>
    ${strip}
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
