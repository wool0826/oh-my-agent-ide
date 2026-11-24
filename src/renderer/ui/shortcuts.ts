// The list of keyboard shortcuts (K1): opened with Ctrl/Cmd+/ or from the palette, closed with Escape.
import { type Key } from '../../shared/i18n';
import { $, esc, isMac, t, ui } from './core';

/** One row: what it does, then its keys. A key list of strings is shown as separate keys; '+' joins them on Windows. */
function row(label: string, keys: string[]) {
  return `<div class="keys-r"><span>${esc(label)}</span><span class="keys-k">${keys.map((k) => `<kbd>${esc(k)}</kbd>`).join('')}</span></div>`;
}

export function shortcutsHtml() {
  const mod = isMac ? '⌘' : 'Ctrl';
  const group = (title: Key, rows: string) => `<section class="keys-g"><h3>${t(title)}</h3>${rows}</section>`;
  return group('keys.dec', [
    row(t('keys.allow'), ['↵']),
    row(t('deny'), ['D']),
    row(t('allowTask'), ['T']),
    row(t('keys.pick'), ['1–9']),
    row(t('keys.move'), ['↓', '↑']),
  ].join('')) + group('keys.any', [
    row(t('keys.find'), [mod, 'K']),
    row(t('keys.view'), [mod, '1–4']),
    row(t('sq.title'), [mod, 'J']),
    row(t('term.title'), [isMac ? '⌃' : 'Ctrl', '`']),
    row(t('cmdk.side'), [mod, 'B']),
    row(t('cmdk.ins'), isMac ? ['⌥', '⌘', 'B'] : ['Ctrl', 'Alt', 'B']),
    row(t('set.title'), [mod, ',']),
    row(t('keys.undo'), [mod, 'Z']),
    row(t('keys.list'), [mod, '/']),
  ].join(''));
}

/** Draws the sheet in the shared dialog layer (#dlg); its Tab stays inside, as for every modal dialog. */
/** Read from the layer itself: the other dialogs redraw #dlg without telling this module. */
export function shortcutsOpen() {
  const root = $('#dlg');
  return !root.hidden && root.dataset.key === 'keys';
}

export function openShortcuts() {
  const root = $('#dlg');
  if (ui.confirmAsk || ui.cancelAsk || !root.hidden) return;
  root.dataset.key = 'keys';
  root.innerHTML = `<div class="dlg-back" data-action="keys-close"></div>
  <div class="dlg keys" role="dialog" aria-modal="true" aria-labelledby="keys-t">
    <h2 id="keys-t">${t('keys.title')}</h2>${shortcutsHtml()}
    <div class="dlg-btns"><button class="btn def" data-action="keys-close">${t('close')}</button></div>
  </div>`;
  root.classList.add('opening');
  root.hidden = false;
  root.querySelector<HTMLButtonElement>('.dlg-btns .btn')?.focus();
}

export function closeShortcuts() {
  if (!shortcutsOpen()) return;
  const root = $('#dlg');
  root.hidden = true;
  root.innerHTML = '';
  root.dataset.key = '';
}
