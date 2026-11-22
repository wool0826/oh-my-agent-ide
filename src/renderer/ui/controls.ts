// Controls built by hand: the popover list and the font picker.
import { FONT_SUGGESTIONS, normalizeFontFamily } from '../../shared/font';
import { esc, sym, t, when } from './core';
import { previewFont } from './settings';

export type Opt = { value: string; label: string; font?: string; sub?: string };

export const pop = { el: null as HTMLElement | null, owner: null as HTMLElement | null };

export function closePop(focusOwner = false) {
  pop.el?.remove();
  pop.owner?.setAttribute('aria-expanded', 'false');
  if (focusOwner) pop.owner?.focus();
  pop.el = null;
  pop.owner = null;
}

export function placePop(el: HTMLElement, anchor: HTMLElement, minWidth: number) {
  const r = anchor.getBoundingClientRect();
  el.style.minWidth = `${Math.max(minWidth, r.width)}px`;
  const below = innerHeight - r.bottom - 12;
  const want = Math.min(el.scrollHeight, 320);
  if (below < want && r.top > below) {
    const h = Math.min(want, r.top - 12);
    el.style.maxHeight = `${h}px`;
    el.style.top = `${r.top - h - 4}px`;
  } else {
    el.style.maxHeight = `${Math.min(320, below)}px`;
    el.style.top = `${r.bottom + 4}px`;
  }
  el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8))}px`;
}

export function openPop(owner: HTMLElement, items: Opt[], selected: string, onPick: (v: string) => void, minWidth = 160, focusList = true) {
  closePop();
  const el = document.createElement('div');
  el.className = 'pop';
  el.setAttribute('role', 'listbox');
  el.innerHTML = items.map((o) => `<button type="button" role="option" class="pop-i${o.value === selected ? ' on' : ''}" aria-selected="${o.value === selected}" data-v="${esc(o.value)}"${o.font ? ` style="font-family:&quot;${esc(o.font)}&quot;, var(--font)"` : ''}>${sym('s-tick', 'pop-tick')}<span>${esc(o.label)}</span>${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</button>`).join('');
  document.body.appendChild(el);
  placePop(el, owner, minWidth);
  pop.el = el;
  pop.owner = owner;
  owner.setAttribute('aria-expanded', 'true');
  el.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in a combobox input
  el.addEventListener('click', (e) => {
    const it = (e.target as HTMLElement).closest<HTMLElement>('.pop-i');
    if (!it) return;
    onPick(it.dataset.v!);
    closePop(owner.classList.contains('dd-btn'));
  });
  const on = el.querySelector<HTMLElement>('.pop-i.on') ?? el.querySelector<HTMLElement>('.pop-i');
  on?.scrollIntoView({ block: 'nearest' });
  if (focusList) on?.focus();
}

/** Installed font families, read once from the OS. */
export let fontList: string[] | null = null;

export async function installedFonts(): Promise<string[]> {
  if (fontList) return fontList;
  try {
    const fonts: { family: string }[] = await (window as any).queryLocalFonts();
    fontList = [...new Set(fonts.map((f) => f.family))].sort((x, y) => x.localeCompare(y));
  } catch {
    fontList = FONT_SUGGESTIONS.filter((f) => document.fonts.check(`12px "${f}"`));
  }
  return fontList;
}

export async function openFontPicker(input: HTMLInputElement, focusList: boolean) {
  const all = await installedFonts();
  if (!input.isConnected) return;
  const q = input.value.split(',').pop()!.trim().toLowerCase();
  const exact = all.some((f) => f.toLowerCase() === q);
  const list = (q && !exact ? all.filter((f) => f.toLowerCase().includes(q)) : all).slice(0, 300);
  const items: Opt[] = [{ value: '', label: t('set.fontSystem') }, ...list.map((f) => ({ value: f, label: f, font: f }))];
  openPop(input, items, normalizeFontFamily(input.value), (v) => {
    input.value = v;
    markFont(input);
    previewFont();
  }, 260, focusList);
}

/** Outline the font field when a typed name is not installed. */
export function markFont(input: HTMLInputElement) {
  const names = input.value.split(',').map((x) => x.trim()).filter(Boolean);
  const bad = !!fontList && names.some((n) => !fontList!.some((f) => f.toLowerCase() === n.toLowerCase()));
  input.classList.toggle('bad', bad);
  input.title = bad ? t('set.fontMissing') : '';
}

/** Arrow keys, Enter and Escape inside an open popover. Returns true when handled. */
export function popKeys(e: KeyboardEvent) {
  if (!pop.el) return false;
  const items = [...pop.el.querySelectorAll<HTMLElement>('.pop-i')];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'Escape') { e.preventDefault(); closePop(true); return true; }
  if (e.key === 'Tab') { closePop(); return false; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = i < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    items[n]?.focus();
    items[n]?.scrollIntoView({ block: 'nearest' });
    return true;
  }
  if ((e.key === 'Enter' || e.key === ' ') && i >= 0) { e.preventDefault(); items[i].click(); return true; }
  return false;
}

export function stepValue(id: string, delta: number) {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) return;
  const min = Number(el.dataset.min), max = Number(el.dataset.max);
  el.value = String(Math.max(min, Math.min(max, (Number(el.value) || min) + delta)));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
