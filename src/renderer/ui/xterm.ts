// The real side terminal (T-0165; shared/pty.ts, main/pty.ts): the user's own shells, one tab each, drawn by xterm.js
// in the terminal's panel of the dock (ui/terminal.ts). Every tab has its view from the start, so its output is drawn,
// and said drawn for the shell's flow control, while the dock is put away; a view goes on the page when it first shows.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { PTY_EMPTY, PTY_REPLAY, PTY_SCROLLBACK, ptyFresh, ptyLabel, termFont, termKey, termMatch, termTheme, type PtyTab, type PtyView } from '../../shared/pty';
import { findCount } from '../../shared/findMarks';
import { $, esc, ide, isMac, sym, t, toast, tryCall } from './core';

/** A piece of a tab's output; `acked` when said drawn already (it came before the tab could draw it). */
interface Piece { d: string; end: number; acked?: boolean }

interface View {
  id: string;
  term: Terminal;
  search: SearchAddon;
  fit: FitAddon;
  el: HTMLElement;
  opened: boolean;
  /** How much of the tab's output is drawn; -1 until its replay came (pty:attach). */
  have: number;
  /** Pieces that came before the replay. */
  early: Piece[];
}

export const pty = {
  view: { ...PTY_EMPTY } as PtyView,
  /** The tab showing. */
  active: '',
  /** A tab is being opened: its view is made, to be measured, before its id is known. */
  opening: false,
  /** The shells a tab can open (pty:shells), the default first. */
  shells: [] as { id: string; name: string }[],
};

/** The real terminal is on: not turned off, and node-pty loaded (or not asked for yet). */
export const ptyOn = () => pty.view.available !== false;

const views = new Map<string, View>();
/** Output of a tab with no view yet (before pty:open answered); drawn when its view comes. */
const stray = new Map<string, Piece[]>();

let hooks = { render: () => {}, empty: () => {} };

const css = (token: string) => getComputedStyle(document.documentElement).getPropertyValue(token).trim();
const fontPx = () => parseFloat(getComputedStyle($('#tm-x')).fontSize) || 12;
const drawn = (id: string, n: number) => { if (id && n > 0) ide.ptySend('drawn', id, n); };

function makeView(id: string): View {
  const term = new Terminal({
    allowProposedApi: true,
    scrollback: PTY_SCROLLBACK,
    fontFamily: termFont(css('--font-mono')),
    fontSize: fontPx(),
    theme: termTheme(css),
    cursorBlink: true,
    drawBoldTextInBrightColors: true,
    // Right-click copies or pastes (below), on the Mac too.
    rightClickSelectsWord: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  const uni = new Unicode11Addon();
  term.loadAddon(uni);
  term.unicode.activeVersion = '11';
  // A link opens with Ctrl+click (⌘ on the Mac), outside the app (main: setWindowOpenHandler).
  term.loadAddon(new WebLinksAddon((e, uri) => { if (isMac ? e.metaKey : e.ctrlKey) window.open(uri, '_blank'); }));
  const el = document.createElement('div');
  el.className = 'tm-v';
  el.hidden = true;
  const v: View = { id, term, search, fit, el, opened: false, have: -1, early: [] };
  search.onDidChangeResults(({ resultIndex, resultCount }) => { if (v.id === pty.active) $('#tm-cnt').textContent = findCount(resultIndex, resultCount); });
  term.attachCustomKeyEventHandler((e) => {
    const k = termKey(e, { mac: isMac, selection: term.hasSelection() });
    if (k === 'shell') return true;
    if (k === 'copy' && e.type === 'keydown') { e.preventDefault(); copy(v); }
    if (k === 'find' && e.type === 'keydown') { e.preventDefault(); openTermFind(); }
    // Paste: the page's own paste reaches xterm (bracketed). The app's keys go on to app.ts.
    return false;
  });
  // What xterm leaves goes no further than the terminal, but the app's own keys.
  el.addEventListener('keydown', (e) => {
    if (!e.isComposing && e.keyCode !== 229 && termKey(e, { mac: isMac, selection: term.hasSelection() }) === 'app') {
      if (e.ctrlKey && (e.code === 'PageUp' || e.code === 'PageDown')) { e.preventDefault(); e.stopPropagation(); stepTab(e.code === 'PageUp' ? -1 : 1); }
      return;
    }
    e.stopPropagation();
  });
  // Right-click: copies the selection, or pastes.
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (term.hasSelection()) { copy(v); return; }
    void navigator.clipboard.readText().then((s) => { if (s) term.paste(s); }, () => {});
    term.focus();
  });
  term.onData((d) => { if (v.id) ide.ptySend('write', v.id, d); });
  term.onBinary((d) => { if (v.id) ide.ptySend('write', v.id, d); });
  term.onResize(({ cols, rows }) => { if (v.id) ide.ptySend('resize', v.id, cols, rows); });
  $('#tm-x').append(el);
  return v;
}

function copy(v: View) {
  const s = v.term.getSelection();
  if (!s) return;
  void navigator.clipboard.writeText(s).then(() => v.term.clearSelection(), () => {});
}

function drop(v: View) {
  views.delete(v.id);
  stray.delete(v.id);
  v.term.dispose();
  v.el.remove();
}

/** Draws a piece of output not drawn yet; says the whole piece was drawn once it is. */
function put(v: View, p: Piece) {
  const fresh = ptyFresh(p.d, p.end, v.have);
  v.have = Math.max(v.have, p.end);
  const n = p.acked ? 0 : p.d.length;
  if (fresh) v.term.write(fresh, () => drawn(v.id, n)); else drawn(v.id, n);
}

/** A tab found in the state (opened before a reload of the window): the end of its output, then what came since. */
async function attach(v: View) {
  const r = await tryCall<{ replay: string; end: number }>('pty:attach', v.id);
  if (views.get(v.id) !== v) return;
  if (r.ok) { v.term.write(r.v.replay); v.have = r.v.end; } else v.have = 0;
  for (const p of v.early.splice(0)) put(v, p);
}

function onData(id: string, d: string, end: number) {
  const v = views.get(id);
  if (v && v.have >= 0) { put(v, { d, end }); return; }
  // Waiting for its replay, or for its view: kept, and said drawn now so the shell does not pause in between.
  const list = v ? v.early : (stray.get(id) ?? []);
  list.push({ d, end, acked: true });
  let size = list.reduce((n, p) => n + p.d.length, 0);
  while (size > PTY_REPLAY && list.length > 1) size -= list.shift()!.d.length;
  if (!v) stray.set(id, list);
  drawn(id, d.length);
}

/** The tabs as main has them: a view for each, none for a tab gone; the tab showing stays or its neighbour shows. */
function syncViews(before: PtyTab[]) {
  const ids = new Set(pty.view.tabs.map((x) => x.id));
  for (const v of [...views.values()]) if (!ids.has(v.id)) drop(v);
  // Kept output is of a tab gone, or of one its replay below draws (none waits for pty:open now).
  stray.clear();
  for (const tab of pty.view.tabs) {
    if (views.has(tab.id)) continue;
    const v = makeView(tab.id);
    views.set(tab.id, v);
    void attach(v);
  }
  if (!ids.has(pty.active)) {
    const at = Math.max(0, before.findIndex((x) => x.id === pty.active));
    pty.active = pty.view.tabs[Math.min(at, pty.view.tabs.length - 1)]?.id ?? '';
  }
}

export function setPtyView(v: PtyView) {
  const before = pty.view.tabs;
  pty.view = v;
  if (pty.opening) return;
  // Before the last view goes, while the focus is still in it.
  if (before.length && !v.tabs.length) hooks.empty();
  syncViews(before);
  hooks.render();
}

/** Opens a tab in `repo` ('' for the IDE home) and shows it. */
export async function newTab(repo: string, shell = ''): Promise<boolean> {
  if (pty.opening) return false;
  pty.opening = true;
  const v = makeView('');
  let ok = false;
  try {
    show(v);
    // The shell starts at the panel's size: a size changed right after its start leaves its line editor (PSReadLine)
    // drawing in the wrong place.
    await measured(v);
    const cols = v.term.cols, rows = v.term.rows;
    const r = await tryCall<PtyTab>('pty:open', { repo: repo || null, shell: shell || null, cols, rows });
    if (!r.ok) {
      // Off: the state says so, and the line mode shows.
      if (ptyOn()) toast(r.error, true);
      return false;
    }
    v.id = r.v.id;
    v.have = 0;
    views.set(v.id, v);
    // Sized again while it opened.
    if (v.term.cols !== cols || v.term.rows !== rows) ide.ptySend('resize', v.id, v.term.cols, v.term.rows);
    for (const p of stray.get(v.id) ?? []) put(v, p);
    stray.delete(v.id);
    pty.active = v.id;
    ok = true;
    return true;
  } finally {
    if (!ok) drop(v);
    pty.opening = false;
    syncViews(pty.view.tabs);
    hooks.render();
    if (ok) focusPty();
  }
}

export function selectTab(id: string, focus = true) {
  if (!views.has(id)) return;
  pty.active = id;
  hooks.render();
  if (focus) focusPty();
}

function stepTab(dir: -1 | 1) {
  const tabs = pty.view.tabs;
  if (tabs.length < 2) return;
  const at = tabs.findIndex((x) => x.id === pty.active);
  selectTab(tabs[(at + dir + tabs.length) % tabs.length].id);
}

export async function closeTab(id: string) {
  const r = await tryCall('pty:close', id);
  if (!r.ok) toast(r.error, true);
}

/** Tabs whose shell is being started again (a second click waits for the first). */
const restarting = new Set<string>();

/** Starts an ended tab's shell again, on a cleared screen; the old screen comes back when it cannot start. */
export async function restartTab(id: string) {
  const v = views.get(id);
  const tab = pty.view.tabs.find((x) => x.id === id);
  if (!v || !tab || tab.live || restarting.has(id)) return;
  restarting.add(id);
  selectTab(id, false);
  v.term.reset();
  if (!$('#tm-find').hidden) { v.search.clearDecorations(); termFindStep(0); }
  try {
    const r = await tryCall('pty:restart', { id, cols: v.term.cols, rows: v.term.rows });
    if (!r.ok) {
      toast(r.error, true);
      const a = await tryCall<{ replay: string; end: number }>('pty:attach', id);
      if (a.ok && views.get(id) === v) v.term.write(a.v.replay);
    }
  } finally {
    restarting.delete(id);
  }
  if (pty.active === id) focusPty();
}

/** The search bar over the tab showing: what is typed is looked for at once, Enter goes on, Esc closes it. */
export function openTermFind() {
  const bar = $('#tm-find');
  const q = $<HTMLInputElement>('#tm-q');
  const sel = views.get(pty.active)?.term.getSelection() ?? '';
  if (sel && !/[\r\n]/.test(sel)) q.value = sel;
  bar.hidden = false;
  q.focus();
  q.select();
  termFindStep(0);
}

export function termFindStep(dir: -1 | 0 | 1) {
  const v = views.get(pty.active);
  const q = $<HTMLInputElement>('#tm-q').value;
  if (!v) return;
  if (!q) { v.search.clearDecorations(); $('#tm-cnt').textContent = ''; return; }
  const o = { incremental: dir === 0, decorations: termMatch(css) };
  if (dir < 0) v.search.findPrevious(q, o); else v.search.findNext(q, o);
}

export function closeTermFind() {
  $('#tm-find').hidden = true;
  for (const v of views.values()) v.search.clearDecorations();
  focusPty();
}

export function focusPty() {
  views.get(pty.active)?.term.focus();
}

export function clearPty() {
  const v = views.get(pty.active);
  v?.term.clear();
  v?.term.focus();
}

/** Puts `v` on the page (the first time) and shows it alone, at the panel's size. */
function show(v: View) {
  for (const x of views.values()) if (x !== v) x.el.hidden = true;
  v.el.hidden = false;
  if (!v.opened) {
    v.opened = true;
    v.term.open(v.el);
    // The GPU draws it when it can; the page's own drawing otherwise, or after the GPU is lost.
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      v.term.loadAddon(gl);
    } catch { /* drawn without it */ }
  }
  fitNow(v);
}

/** Fitted once xterm knows its cell size, which it learns from a frame drawn after open (a few frames at most). */
async function measured(v: View) {
  for (let i = 0; i < 20 && !v.fit.proposeDimensions(); i++) await new Promise(requestAnimationFrame);
  fitNow(v);
}

function fitNow(v: View | undefined) {
  if (!v?.opened || v.el.hidden || !v.el.offsetParent) return;
  try { v.fit.fit(); } catch { /* not measurable yet */ }
}

/** The tab strip and the tab showing (ui/terminal.ts renderTerm, in the real terminal's mode). */
export function renderPty() {
  const strip = $('#tm-tabs');
  const tabs = pty.view.tabs;
  const key = JSON.stringify([tabs, pty.active, t('term.closeTab', { name: '' }), t('term.restart', { name: '' })]);
  if (strip.dataset.key !== key) {
    strip.dataset.key = key;
    strip.innerHTML = tabs.map(chipHtml).join('');
  }
  const v = views.get(pty.active);
  if (v && !pty.opening) show(v);
  // The search follows the tab showing.
  const find = $('#tm-find');
  if (find.dataset.tab !== pty.active) {
    for (const x of views.values()) if (x !== v) x.search.clearDecorations();
    find.dataset.tab = pty.active;
    if (!find.hidden) termFindStep(0);
  }
  if (!tabs.length) {
    find.hidden = true;
    $('#tm-cnt').textContent = '';
    delete find.dataset.tab;
  }
}

function chipHtml(tab: PtyTab) {
  const on = tab.id === pty.active;
  const label = ptyLabel(tab);
  const how = tab.live ? '' : tab.error || (tab.code == null ? t('shell.stopped') : t('shell.exit', { n: tab.code }));
  const tip = how ? `${label} · ${how}` : label;
  const close = t('term.closeTab', { name: label });
  const again = t('term.restart', { name: label });
  const restart = tab.live ? '' : `<button type="button" class="tm-close tm-re" data-action="pty-restart" data-id="${esc(tab.id)}" tabindex="-1" aria-label="${esc(again)}" data-tip="${esc(again)}">${sym('s-refresh')}</button>`;
  return `<span class="tm-chip${tab.live ? '' : ' ended'}"><button type="button" role="tab" class="tm-tab" data-action="pty-tab" data-id="${esc(tab.id)}" aria-selected="${on}" aria-controls="tm-x" tabindex="${on ? 0 : -1}" data-tip="${esc(tip)}"><span>${esc(label)}</span></button>`
    + restart + `<button type="button" class="tm-close" data-action="pty-close" data-id="${esc(tab.id)}" tabindex="-1" aria-label="${esc(close)}" data-tip="${esc(close)}">${sym('s-x')}</button></span>`;
}

/** The theme, the mono font and the text size, again on every view when one of them changed. */
let lookKey = '';
function restyle() {
  const theme = termTheme(css);
  const font = termFont(css('--font-mono'));
  const size = fontPx();
  const key = JSON.stringify([theme, font, size]);
  if (key === lookKey) return;
  lookKey = key;
  for (const v of views.values()) {
    v.term.options.theme = theme;
    v.term.options.fontFamily = font;
    v.term.options.fontSize = size;
  }
  fitNow(views.get(pty.active));
  // What a search marked, in the new colours.
  if (!$('#tm-find').hidden) {
    // The addon marks again only for another word: its marks go first.
    views.get(pty.active)?.search.clearDecorations();
    termFindStep(0);
  }
}

export function bindPty(o: { render: () => void; empty: () => void }) {
  hooks = o;
  ide.onPtyData(onData);
  ide.onPtyState((v) => setPtyView(v));
  void tryCall<PtyView>('pty:state').then((r) => { if (r.ok) setPtyView(r.v); });
  void tryCall<{ id: string; name: string }[]>('pty:shells').then((r) => { if (r.ok) { pty.shells = r.v; hooks.render(); } });
  const q = $<HTMLInputElement>('#tm-q');
  q.addEventListener('input', () => termFindStep(0));
  q.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') termFindStep(e.shiftKey ? -1 : 1);
    else if (e.key === 'Escape') closeTermFind();
    else if (termKey(e, { mac: isMac, selection: false }) === 'find') q.select();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  let frame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => fitNow(views.get(pty.active)));
  }).observe($('#tm-x'));
  new MutationObserver(restyle).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', restyle);
  // Clicking a tab's close button leaves the focus in the terminal.
  $('#tm-tabs').addEventListener('mousedown', (e) => { if ((e.target as HTMLElement).closest('.tm-close')) e.preventDefault(); });
}
