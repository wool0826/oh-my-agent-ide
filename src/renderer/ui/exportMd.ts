// Exporting a Worker's work (item 12A): the ⋯ menu in the Worker header (copy Markdown, save as .md, publish), and
// the publish dialog with its parts, what was hidden and a preview. The text is written by shared/exportMd.ts; main
// gathers the data, saves the file and publishes (main/exportMd.ts).
import { EXPORT_DEFAULT, EXPORT_PARTS, exportCounts, exportFileName, exportMarkdown, previewLines, type ExportPart, type ExportSource, type ExportWords } from '../../shared/exportMd';
import { $, call, esc, isMac, locale, sym, t, toast } from './core';
import { layerClose, layerOpen } from './layer';

type PublishResult = { ok: true; url: string } | { ok: false; why: 'login' | 'failed'; msg?: string };

/** Ctrl+Shift+E, as the menu and the shortcut list show it. */
export const publishKeys = () => (isMac ? ['⇧', '⌘', 'E'] : ['Ctrl', 'Shift', 'E']);

function words(): ExportWords {
  return {
    report: t('export.report'), chat: t('export.chat'), changes: t('ws.tabChanges'), shots: t('export.shots'),
    who: { user: t('export.you'), worker: 'Worker', dispatcher: 'Dispatcher', auto: t('export.auto') },
    ci: { passing: t('export.ciPassing'), failing: t('export.ciFailing'), pending: t('export.ciPending'), none: t('export.ciNone'), merged: t('export.merged'), closed: t('export.closed') },
    mask: t('export.mask'),
    time: (iso) => new Date(iso).toLocaleString(locale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    more: (n) => t('export.more', { n }),
  };
}

const item = (action: string, wid: string, icon: string, label: string, extra = '') =>
  `<button class="menu-item" role="menuitem" data-action="${action}" data-id="${esc(wid)}" data-close>${icon}<span>${esc(label)}</span>${extra}</button>`;

/** The header ⋯ menu. Copying has no shortcut (it is one click here and in the palette); publishing has Ctrl+Shift+E. */
export function exportMenuHtml(wid: string) {
  return item('export-copy', wid, sym('s-copy'), t('export.copy'))
    + item('export-save', wid, sym('s-doc'), t('export.save'))
    + item('export-publish', wid, sym('s-open'), t('export.publish'), `<small>${publishKeys().join(' ')}</small>`);
}

const source = (wid: string) => call<ExportSource | null>('worker:export', wid);

export async function copyExport(wid: string) {
  const src = await source(wid);
  if (!src) return;
  const { md } = exportMarkdown(src, EXPORT_DEFAULT, words());
  await navigator.clipboard.writeText(md).then(() => toast(t('sel.copied')), () => toast(t('copy.failed'), true));
}

export async function saveExport(wid: string) {
  const src = await source(wid);
  if (!src) return;
  const { md } = exportMarkdown(src, EXPORT_DEFAULT, words());
  const saved = await call<string | null>('worker:exportSave', exportFileName(src), md);
  if (saved) toast(t('export.saved', { path: saved }));
}

/* ---------- the publish dialog ---------- */

interface Publish { wid: string; src: ExportSource; parts: ExportPart[]; state: 'ready' | 'busy' | 'done' | 'failed'; url?: string; why?: string; run: number }
let pub: Publish | null = null;
let runs = 0;

/** Read from the layer itself, as the shortcut list is: other dialogs redraw #dlg without telling this module. */
export function publishOpen() {
  const root = $('#dlg');
  return !root.hidden && root.dataset.key === 'publish';
}

export async function openPublish(wid: string) {
  const root = $('#dlg');
  if (!root.hidden) return;
  const src = await source(wid);
  if (!src || !root.hidden) return;
  pub = { wid, src, parts: [...EXPORT_DEFAULT], state: 'ready', run: 0 };
  layerClose('publish', false);
  layerOpen('publish');
  root.dataset.key = 'publish';
  root.classList.add('opening');
  root.hidden = false;
  renderPublish();
  root.querySelector<HTMLElement>('.dlg-btns .btn-primary')?.focus();
}

export function closePublish() {
  if (!publishOpen()) return;
  // Closed while publishing: the session stops, so nothing is published that the user cannot see.
  if (pub?.state === 'busy') void call('worker:publishCancel');
  pub = null;
  const root = $('#dlg');
  root.hidden = true;
  root.innerHTML = '';
  root.dataset.key = '';
  layerClose('publish');
}

const tick = `<svg class="xck-t" aria-hidden="true"><use href="#s-tick"/></svg>`;

function partsHtml(p: Publish) {
  const n = exportCounts(p.src);
  const off = p.state === 'busy' || p.state === 'done';
  return EXPORT_PARTS.map((k) => {
    const label = t(k === 'chat' ? 'export.chat' : k === 'report' ? 'export.report' : k === 'diff' ? 'export.diff' : 'export.shots');
    const count = k === 'diff' ? t('export.files', { n: n.diff }) : String(n[k]);
    const none = !n[k];
    return `<label class="xrow${none ? ' none' : ''}"><span class="xck-w"><input type="checkbox" class="xck" data-change="export-part" value="${k}"${p.parts.includes(k) && !none ? ' checked' : ''}${off || none ? ' disabled' : ''}>${tick}</span><span class="xrow-l">${esc(label)}</span><small>${esc(count)}</small></label>`;
  }).join('');
}

function liveHtml(p: Publish) {
  const w = words();
  const r = exportMarkdown(p.src, p.parts, w);
  const mask = esc(w.mask);
  const lines = previewLines(r.md, w.mask, 4).map((l) => `<span>${esc(l).split(mask).join(`<mark>${mask}</mark>`)}</span>`).join('');
  return `<div class="pub-hid">${sym('s-lock')}<span>${esc(t('export.hidden', { n: r.hidden.total, t: r.hidden.tokens, p: r.hidden.paths }))}</span></div><div class="pub-prev">${lines}</div>`;
}

function footHtml(p: Publish) {
  if (p.state === 'done' && p.url) {
    return `<div class="pub-url"><span class="pub-link">${esc(p.url)}</span><button type="button" class="btn btn-icon" data-action="export-copy-url" data-v="${esc(p.url)}" aria-label="${esc(t('export.copyUrl'))}" data-tip="${esc(t('export.copyUrl'))}">${sym('s-copy')}</button><button type="button" class="btn btn-icon" data-action="export-open-url" data-v="${esc(p.url)}" aria-label="${esc(t('export.openUrl'))}" data-tip="${esc(t('export.openUrl'))}">${sym('s-open')}</button></div>
    <div class="dlg-btns pub-btns"><button type="button" class="btn btn-lg btn-primary" data-action="export-close">${t('close')}</button></div>`;
  }
  const fail = p.state === 'failed' ? `<div class="pub-err" role="alert">${sym('s-alert')}<span>${esc(t('export.failed', { why: p.why ?? '' }))}</span></div>` : '';
  const go = p.state === 'failed'
    ? `<button type="button" class="btn btn-lg btn-primary" data-action="export-go">${sym('s-refresh')}<span>${t('export.retry')}</span></button>`
    : `<button type="button" class="btn btn-lg btn-primary${p.state === 'busy' ? ' busy' : ''}" data-action="export-go"${p.state === 'busy' ? ' aria-busy="true" disabled' : ''}>${p.state === 'busy' ? '<span class="sq-spin" aria-hidden="true"></span>' : ''}<span>${t('export.go')}</span></button>`;
  return `${fail}<div class="dlg-btns pub-btns"><button type="button" class="btn btn-lg" data-action="export-close">${t('cancel')}</button>${go}</div>`;
}

export function renderPublish() {
  const root = $('#dlg');
  if (!pub || !publishOpen()) return;
  root.innerHTML = `<div class="dlg-back" data-action="export-close"></div>
  <div class="dlg pub" role="dialog" aria-modal="true" aria-labelledby="pub-t">
    <h2 id="pub-t">${t('export.title')}</h2>
    <div class="xrows">${partsHtml(pub)}</div>
    <div class="pub-live">${liveHtml(pub)}</div>
    ${footHtml(pub)}
  </div>`;
}

/** A part was ticked or cleared: the count of hidden values and the preview follow; the focus stays on the box. */
export function exportPartChanged() {
  if (!pub || pub.state === 'busy') return;
  const root = $('#dlg');
  pub.parts = EXPORT_PARTS.filter((k) => root.querySelector<HTMLInputElement>(`.xck[value="${k}"]`)?.checked);
  const live = root.querySelector('.pub-live');
  if (live) live.innerHTML = liveHtml(pub);
}

export async function publishGo() {
  const p = pub;
  if (!p || p.state === 'busy' || p.state === 'done') return;
  const { md } = exportMarkdown(p.src, p.parts, words());
  p.state = 'busy';
  p.run = ++runs;
  renderPublish();
  const r = await call<PublishResult>('worker:publish', p.wid, md, p.parts.includes('shots'));
  // Closed, or opened again for another publish, meanwhile: that dialog is not this one's.
  if (pub !== p || p.run !== runs) return;
  if (r?.ok) { p.state = 'done'; p.url = r.url; } else { p.state = 'failed'; p.why = r?.ok === false && r.why === 'login' ? t('export.needLogin') : r?.msg || t('export.noLink'); }
  renderPublish();
  $('#dlg').querySelector<HTMLElement>(p.state === 'done' ? '.pub-url .btn' : '.pub-btns .btn-primary')?.focus();
}
