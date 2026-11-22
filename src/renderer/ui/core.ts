// What every screen shares: the state the window holds, the bridge to the main process, text, small HTML helpers, scrolling, paging and sound.
import type { AppState, ChatItem, ClaudeInfo, DiffView, MemoryFile, MemoryHit, ModelList, Task, Worker, WorkerLogItem, SoundName, Lang } from '../../shared/types';
import { tr, type Key } from '../../shared/i18n';
import { modelLabel as labelFor } from '../../shared/models';
import { linkify } from '../../shared/linkify';
import { type DiffNote } from '../../shared/diffComment';
import { type Issue } from '../../shared/issues';
import { parseReply, replyExcerpt, withReply, type Reply } from '../../shared/reply';
import { slotsUsed, waitsForSlot } from '../../shared/slots';
import { restoreScroll, saveScroll } from '../../shared/scroll';
import { firstPage } from '../../shared/paging';
import { type NavDir, type Screen, type View, type WorkerFilter } from '../../shared/history';
import { init } from '../app';
import { go, screen, show } from './history';
import { ms } from './sidebar';

declare global {
  interface Window {
    ide: {
      platform: string;
      call<T = any>(channel: string, ...args: unknown[]): Promise<T>;
      onState(fn: (s: AppState) => void): void;
      onWorkerLog(fn: (id: string, item: WorkerLogItem) => void): void;
      onDecisionAlert(fn: (loud: boolean) => void): void;
      /** Back or Forward from the OS (mouse side buttons and Back keys arrive as app commands on Windows and Linux). */
      onNav(fn: (dir: NavDir) => void): void;
      pathForFile(f: File): string;
    };
  }
}

export const ide = window.ide;

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

export const isMac = ide.platform === 'darwin';

export let S: AppState | null = null;

/** Sets `S` from another module, which cannot assign to an import. */
export function setS(v: AppState | null) { S = v; }

export const lang = (): Lang => S?.settings.language ?? 'en';

export const t = (key: Key, vars?: Record<string, string | number>) => tr(lang(), key, vars);

/** A yes/no kept in this window's storage; false when storage is not available. */
export function stored(key: string) {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}

export function store(key: string, on: boolean) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* not kept */ }
}

export type Pane = 'accounts' | 'general' | 'display' | 'alerts' | 'memory' | 'models';

export const ui = {
  // The screen fields (Screen in shared/history: view, wSel, wOpen, wTab, repoSel, memSel, wFilter):
  // a user navigation changes them through go(), so Back and Forward can retrace it.
  view: 'chat' as View,
  wSel: null as string | null,
  wOpen: false,
  wFilter: null as WorkerFilter | null,
  repoSel: null as string | null,
  /** The Repositories view's add form is open in its right panel, and whether an add is under way (a clone can take minutes). */
  repoAdd: false,
  repoAdding: false,
  memSel: null as string | null,
  memFiles: [] as MemoryFile[],
  memHits: null as MemoryHit[] | null,
  /** The query memHits answer, and how many hits it has in all (they load a page at a time). */
  memQ: '',
  memTotal: 0,
  memText: '' as string,
  aaSel: null as string | null,
  aaEdit: null as string | null,
  sugEdit: null as string | null,
  /** Each Worker's loaded conversation: lines logFrom to the end of its log (decision 85). */
  logs: new Map<string, WorkerLogItem[]>(),
  logFrom: new Map<string, number>(),
  /** Chat items older than the state's snapshot, loaded with chat:page as the reader scrolls up. */
  chatOlder: [] as ChatItem[],
  /** The id of the first chat item the thread shows, and of the first item known to have none before it. */
  chatFrom: null as string | null,
  chatEndAt: null as string | null,
  /** Threads loading their page before ('chat', or a Worker id). */
  loadingOlder: new Set<string>(),
  /** How many items each "Show more" list shows, by list key (moreBtn). */
  pages: new Map<string, number>(),
  undo: [] as { kind: 'result' | 'auto'; ids: string[] }[],
  lastChatKey: '',
  lastLogKey: '',
  settingsShown: false,
  pane: 'accounts' as Pane,
  attach: { chat: [] as string[], ws: [] as string[] },
  langApplied: '' as string,
  fontApplied: '' as string,
  accKey: '' as string,
  accMenu: null as string | null,
  accRename: null as string | null,
  accRemove: null as string | null,
  setQ: '',
  version: '',
  claude: null as ClaudeInfo | null,
  accKind: 'token' as 'token' | 'login' | 'chatgpt',
  wTab: 'chat' as 'chat' | 'changes' | 'summary',
  diffs: new Map<string, DiffView | 'loading' | null>(),
  diffOpen: new Set<string>(),
  /** Review comments not sent yet, per Worker, and the line a comment is being written for. */
  diffNotes: new Map<string, DiffNote[]>(),
  diffDraft: null as { wid: string; path: string; at: number } | null,
  /** The task whose Merge button is asking "Merge it?", and the tasks being merged. */
  /** Open issues per repository, read when its inspector first shows them. */
  issues: new Map<string, Issue[] | 'loading' | { error: string }>(),
  /** The checkpoint the Changes tab is asking about before it puts the files back. */
  ckptAsk: null as { wid: string; ref: string; at: string; label: string } | null,
  mergeAsk: null as string | null,
  merging: new Set<string>(),
  /** Plan cards whose full plan is unfolded below the summary, by decision id. */
  planOpen: new Set<string>(),
  /** Queued tasks whose request is shown in full on the Worker view's waiting card. */
  qOpen: new Set<string>(),
  models: { models: [], fetchedAt: null, error: null } as ModelList,
  modelsLoading: false,
  restartAsk: false,
  /** The left sidebar is a rail of glyphs, and the right one is hidden (kept across launches). */
  sideMin: stored('oma.sideMin'),
  insMin: stored('oma.insMin'),
  /** "Done today" in the sidebar shows its latest tasks (kept across launches). */
  doneOpen: stored('oma.doneOpen'),
  /** The chat view's right sidebar shows the inbox or the memos; the memo being edited, and the one asked about before deleting. */
  /** The message being answered in each composer; the Worker's is dropped when another Worker is opened. */
  reply: { chat: null as Reply | null, ws: null as (Reply & { wid: string }) | null },
  insTab: 'inbox' as 'inbox' | 'memo' | 'auto',
  /** The Automations tab's add form: which trigger is picked, and weekdays only. */
  autoKind: 'daily' as 'daily' | 'merged',
  autoWk: false,
  memoEdit: null as string | null,
  memoDel: null as string | null,
  /** The last chat item and Worker log length already drawn; what comes after them is new. */
  chatSeen: null as string | null,
  logSeen: null as { wid: string; n: number } | null,
  /** Asking before cancelling queued tasks: one task, or the whole queue. */
  cancelAsk: null as { ids: string[]; all: boolean } | null,
};

/* ---------- helpers ---------- */

export function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Escaped one-line text with `code` spans, for summaries written by agents. */
export function inline(s: unknown) {
  return esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

/** An agent's bubble with the Reply button beside it. `box` is the composer the reply is written in. */
export function replyable(bubble: string, box: 'chat' | 'ws', who: string, text: string) {
  const quote = replyExcerpt(text);
  if (!quote) return bubble;
  return `<div class="bline">${bubble}<button class="rbtn" data-action="reply" data-box="${box}" data-who="${esc(who)}" data-quote="${esc(quote)}" title="${t('reply.to')}" aria-label="${t('reply.to')}"><svg aria-hidden="true"><use href="#s-reply"/></svg></button></div>`;
}

/** The chip above a composer's text: whose message is being answered, its first words, and a way out. */
export function renderReply(box: 'chat' | 'ws') {
  if (box === 'ws' && ui.reply.ws && ui.reply.ws.wid !== ui.wSel) ui.reply.ws = null;
  const r = ui.reply[box];
  const el = $(box === 'chat' ? '#chat-reply' : '#ws-reply');
  el.hidden = !r;
  el.innerHTML = r ? `${sym('s-reply')}<b>${esc(r.who)}</b><span>${esc(r.quote)}</span><button type="button" data-action="reply-cancel" data-box="${box}" title="${t('reply.cancel')}" aria-label="${t('reply.cancel')}"><svg aria-hidden="true"><use href="#s-x"/></svg></button>` : '';
}

/** The text to send from a composer: with the quote on top while a reply is open, which this ends. */
export function takeReply(box: 'chat' | 'ws', text: string) {
  const r = ui.reply[box];
  if (!r) return text;
  ui.reply[box] = null;
  renderReply(box);
  return withReply(r, text);
}

/** Tiny markdown: code blocks, inline code, headings, bold, links, line breaks */
export function md(src: string) {
  const parts = String(src ?? '').split(/```[\w-]*\n?/);
  return parts.map((p, i) => {
    if (i % 2 === 1) return `<pre>${esc(p.replace(/\n$/, ''))}</pre>`;
    let h = esc(p);
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    h = h.replace(/^#{1,6} +(.+)$\n?/gm, '<b class="mh">$1</b>');
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    h = linkify(h);
    return h.split(/\n{2,}/).map((para) => para.trim() ? `<p>${para.trim().replace(/\n/g, '<br>')}</p>` : '').join('');
  }).join('');
}

/** A user message: plain text, with the "[Attached files]" block shown as file chips. */
export function userText(text: string): string {
  const reply = parseReply(text);
  if (reply) return `<span class="quote"><b>${esc(reply.who)}</b><span>${esc(reply.quote)}</span></span>${userText(reply.body)}`;
  const i = text.indexOf('\n\n[Attached files]\n');
  if (i < 0) return linkify(esc(text));
  const files = text.slice(i).split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  return `${linkify(esc(text.slice(0, i)))}<span class="sent-files">${files.map((f) => `<a class="fchip" data-action="reveal" data-path="${esc(f)}" title="${esc(f)}">${esc(base(f))}</a>`).join('')}</span>`;
}

export function oneLine(s: string, n = 120) {
  const x = String(s ?? '').replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n - 1) + '…' : x;
}

export function ic(kind: string, glyph = kind) {
  return `<span class="ic k-${kind}" aria-hidden="true"><svg><use href="#g-${glyph}"/></svg></span>`;
}

/** Placeholder rows shown while a list is being read: grey bars where the rows will be. */
export function skel(n: number, kind: 'mini' | 'file') {
  const row = kind === 'mini' ? '<div class="mini skel" aria-hidden="true"><i></i><i></i></div>' : '<div class="skel file" aria-hidden="true"><i></i></div>';
  return row.repeat(n);
}

/** A label that starts a row starts with a capital. */
export const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function sym(id: string, cls = '') {
  return `<svg class="sym ${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

export const locale = () => (lang() === 'ko' ? 'ko-KR' : 'en-US');

/** Short time for lists: the time today, the date before that. */
export function when(iso: string) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(locale(), { month: 'short', day: 'numeric' });
}

export function hhmm(iso: string) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return t('time.today', { t: time });
  return `${d.toLocaleDateString(locale(), { month: 'short', day: 'numeric' })} ${time}`;
}

export function ago(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return t('time.now');
  if (m < 60) return t('time.min', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('time.hour', { n: h });
  return t('time.day', { n: Math.round(h / 24) });
}

export function k(n: number) { return `${Math.round(n / 1000)}K`; }

export function ring(frac: number) {
  const v = Math.max(0, Math.min(100, frac * 100)).toFixed(1);
  return `<svg class="ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="trk" cx="10" cy="10" r="7.5"/><circle class="val" cx="10" cy="10" r="7.5" pathLength="100" stroke-dasharray="${v} 100" transform="rotate(-90 10 10)"/></svg>`;
}

export function lv(v: number | null) {
  if (v === null) return 'lv-n';
  return v <= 30 ? 'lv-g' : v <= 50 ? 'lv-y' : v <= 80 ? 'lv-o' : 'lv-r';
}

export const pct = (v: number | null) => (v === null ? '–' : `${v}%`);

export function modelLabel(m: string) {
  return labelFor(m, ui.models.models);
}

export function acctLabel(id: string | null) { return S?.accounts.find((a) => a.id === id)?.label ?? '–'; }

export function prNum(url: string | null) { return url?.match(/\/pull\/(\d+)/)?.[1] ?? ''; }

/** Long paths and URLs keep their last segments, e.g. …/worktrees/demo/W-02. */
export function shortPath(p: string, keep = 3) {
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > keep + 1 ? `…${sep}${parts.slice(-keep).join(sep)}` : p;
}

export function base(p: string) { return p.split(/[\\/]/).filter(Boolean).pop() ?? p; }

export const task = (id: string | null | undefined) => (id ? S?.tasks.find((x) => x.id === id) ?? null : null);

export const worker = (id: string | null | undefined) => (id ? S?.workers.find((w) => w.id === id) ?? null : null);

export const taskStatus = (st: string) => t(`task.${st}` as Key);

/** What the sidebar's "Done today" counts, and what its Worker list filter looks for. */
export const finishedToday = (x: Task) => (x.status === 'done' || x.status === 'pr_open') && !!x.finishedAt && new Date(x.finishedAt).toDateString() === new Date().toDateString();

/** What a queued task waits for: a free Worker slot ("Waiting for a slot 3/3") or a usage limit. */
export const queuedLabel = (x: Task) => (waitsForSlot(x) ? t('st.slotWait', { n: slotsUsed(S!.tasks), max: S!.settings.maxWorkers }) : t('st.limitWait'));
/**
 * The task is open because its Worker needs the Dispatcher, not the user (decision 87): the turn ended, so the Worker
 * is idle, and the task keeps its slot.
 */

export const awaitsDispatcher = (x: Task | null | undefined) => {
  const w = x?.status === 'waiting' ? worker(x.workerId) : null;
  return !!w && w.status === 'idle' && !!w.request;
};

/** Failed because the user (or the Dispatcher) pressed Stop: shown apart from failures, never in red. */
export const stoppedTask = (x: Task | null | undefined) => x?.status === 'failed' && !!x.stopped;

export const taskLabel = (x: Task) => (x.status === 'queued' ? queuedLabel(x) : awaitsDispatcher(x) ? t('st.awaitDispatcher') : stoppedTask(x) ? t('task.stopped') : taskStatus(x.status));

export let toastTimer: number | undefined;

export function toast(text: string, err = false) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.toggle('err', err);
  el.classList.remove('out');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.add('out');
    toastTimer = window.setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, ms('--dur-base'));
  }, err ? 6000 : 3000);
}

export async function call<T = any>(ch: string, ...args: unknown[]): Promise<T | undefined> {
  try {
    return await ide.call<T>(ch, ...args);
  } catch (e) {
    toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    return undefined;
  }
}

/** Keep typed values and focus across re-renders (only inputs with data-keep), and scroll offsets (keepScroll). */
export function keepInputs(root: HTMLElement, render: () => void) {
  const vals = new Map<string, string>();
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-keep]').forEach((el) => vals.set(el.dataset.keep!, el.value));
  const active = document.activeElement as HTMLInputElement | null;
  const focusKey = active && root.contains(active) ? active.dataset.keep : undefined;
  const sel = focusKey ? [active!.selectionStart, active!.selectionEnd] : null;
  // Scroll offsets go back last: setting a value resets a textarea's, and focusing scrolls root.
  keepScroll(root, () => {
    render();
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-keep]').forEach((el) => {
      const v = vals.get(el.dataset.keep!);
      if (v !== undefined && el.type !== 'radio') el.value = v;
    });
    if (focusKey) {
      const el = root.querySelector<HTMLInputElement>(`[data-keep="${CSS.escape(focusKey)}"]`);
      if (el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not selectable */ } }
    }
  });
}

/* ---------- scrolling ---------- */

/** How long a scrollbar stays up after its element's last scroll event. */
export const SCROLLBAR_LINGER_MS = 1200;

/** When each showing bar hides (Date.now() ms), and its timer. */
export const bars = new WeakMap<Element, { until: number; timer: number }>();

/** Offsets the app itself moved an element to. The scroll event that follows is not the user's, so it shows no bar. */
export const quietAt = new WeakMap<Element, string>();

export const offsets = (el: Element) => `${el.scrollTop},${el.scrollLeft}`;

/**
 * Scrollbars show only while their element scrolls (styles.css, "scrollbars"): .sb-on shows the thumb,
 * and SCROLLBAR_LINGER_MS after the last scroll .sb-off fades it out. One capture-phase scroll listener (init)
 * calls this for every scrolling element; keepScroll calls it, with the time left, for a new element that
 * replaced one whose bar was showing.
 */

export function showBar(el: Element, ms = SCROLLBAR_LINGER_MS) {
  clearTimeout(bars.get(el)?.timer);
  // Only real changes: rewriting the class attribute wakes the observer that places the glass pills.
  if (el.classList.contains('sb-off')) el.classList.remove('sb-off');
  if (!el.classList.contains('sb-on')) el.classList.add('sb-on');
  bars.set(el, { until: Date.now() + ms, timer: window.setTimeout(() => { el.classList.replace('sb-on', 'sb-off'); bars.delete(el); }, ms) });
}

export function onScroll(e: Event) {
  const el = e.target;
  // Text fields scroll as the caret moves and have no bar.
  if (!(el instanceof HTMLElement) || el instanceof HTMLInputElement) return;
  const quiet = quietAt.get(el);
  if (quiet !== undefined) {
    quietAt.delete(el);
    if (quiet === offsets(el)) return;
  }
  showBar(el);
}

/** Move an element without showing its bar: following new messages, or putting an offset back. */
export function scrollQuietly(el: HTMLElement, top: number, left = el.scrollLeft) {
  if (el.scrollTop === top && el.scrollLeft === left) return;
  const before = offsets(el);
  el.scrollTop = top;
  el.scrollLeft = left;
  // A write the element can't follow (already at the bottom, or hidden) fires no scroll event to clear the mark.
  if (offsets(el) !== before) quietAt.set(el, offsets(el));
}

/**
 * Keep scroll offsets across a render that rebuilds root's content: root's own, and those of the elements
 * inside marked data-scroll (lists, plans, diffs), which the render replaces with new elements at the start.
 * Without this every state push (each tool call of a running Worker) sent them back to the top.
 * A bar that was showing stays up on the new element for the time it had left, so pushes don't keep it up.
 */

export function keepScroll(root: HTMLElement, render: () => void) {
  const keyed = () => root.querySelectorAll<HTMLElement>('[data-scroll]');
  const saved = saveScroll(keyed(), (el) => (bars.get(el)?.until ?? 0) - Date.now());
  const top = root.scrollTop, left = root.scrollLeft;
  render();
  scrollQuietly(root, top, left);
  if (!saved.size) return;
  // An element the render kept still has its bar and timer; only a new one needs them.
  for (const [el, ms] of restoreScroll(keyed(), saved, (el) => quietAt.set(el, offsets(el)))) if (!bars.has(el)) showBar(el, ms);
}

/* ---------- paging (decision 85) ---------- */

/** How many items a "Show more" list shows now: one page until its button is pressed. */
export function shownOf(key: string, page: number) { return Math.max(page, ui.pages.get(key) ?? 0); }

/** The button that ends a list with `left` more items; each press shows `page` more. */
export function moreBtn(key: string, left: number, page: number) {
  if (left <= 0) return '';
  return `<button type="button" class="more-btn" data-action="page-more" data-page="${esc(key)}" data-n="${page}">${t('page.more', { n: Math.min(left, page) })}</button>`;
}

/** The part of a list on screen, and the "Show more" button for the rest. */
export function paged<T>(key: string, items: T[], page: number) {
  const { items: shown, left } = firstPage(items, shownOf(key, page));
  return { items: shown, more: moreBtn(key, left, page) };
}

/** The start of a thread with earlier items: they load as it comes within reach (watchTop), or on a click. */
export function olderBtn(thread: 'chat' | 'log', loading: boolean) {
  return `<button type="button" class="pg-top" data-action="page-older" data-v="${thread}">${t(loading ? 'page.loading' : 'page.older')}</button>`;
}

/** Each thread's watch on its .pg-top. Within reach is up to 600px above the top, so a page loads before the reader gets there. */
export const topWatch = new Map<HTMLElement, IntersectionObserver>();

export function watchTop(th: HTMLElement, load: () => void) {
  let io = topWatch.get(th);
  if (!io) {
    io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) load(); }, { root: th, rootMargin: '600px 0px 0px 0px' });
    topWatch.set(th, io);
  }
  io.disconnect();
  const top = th.querySelector('.pg-top');
  if (top) io.observe(top);
}

/**
 * Put a thread's new content in, keeping the reader's place: at the end when following it, the same distance
 * from the end when a page went in above (`older`), and otherwise the same offset, since what is above stays put.
 */

/** Marks where a thread's new items begin; they rise in after it. */
export const NEW_FROM = '<i class="new-from" hidden></i>';

export function setThread(th: HTMLElement, html: string, follow: boolean, older: boolean) {
  const fromEnd = th.scrollHeight - th.scrollTop;
  th.innerHTML = html;
  if (older) scrollQuietly(th, th.scrollHeight - fromEnd);
  else if (follow) scrollQuietly(th, th.scrollHeight);
}

/** Fade in what a container shows now (a tab or a pane just picked). Later re-renders of it don't fade. */
export const swapTimers = new WeakMap<HTMLElement, number>();

export function swapIn(el: HTMLElement) {
  clearTimeout(swapTimers.get(el));
  el.classList.remove('swap');
  void el.offsetWidth;
  el.classList.add('swap');
  swapTimers.set(el, window.setTimeout(() => el.classList.remove('swap'), ms('--dur-slow')));
}

/** Says "Loading…" on a thread's .pg-top while its page is on the way. */
export function markLoading(th: HTMLElement) {
  const top = th.querySelector('.pg-top');
  if (top) top.textContent = t('page.loading');
}

/** Back to "Show earlier messages" when the page didn't come. */
export function unmarkLoading(th: HTMLElement) {
  const top = th.querySelector('.pg-top');
  if (top) top.textContent = t('page.older');
}

/** Static text in index.html carries data-i18n / data-i18n-ph / data-i18n-title keys. */
export function applyStaticText() {
  if (ui.langApplied === lang()) return;
  ui.langApplied = lang();
  document.documentElement.lang = lang();
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n as Key); });
  document.querySelectorAll<HTMLElement>('[data-i18n-ph]').forEach((el) => { (el as HTMLInputElement).placeholder = t(el.dataset.i18nPh as Key); });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle as Key); el.setAttribute('aria-label', el.title); });
}

/* ---------- sound ---------- */

export let actx: AudioContext | null = null;

export let customCache: { file: string; url: string | null } | null = null;

/** Sets `customCache` from another module, which cannot assign to an import. */
export function setCustomCache(v: { file: string; url: string | null } | null) { customCache = v; }

export function tone(ctx: AudioContext, freq: number, start: number, dur: number, vol: number, type: OscillatorType = 'sine') {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(vol, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(ctx.destination);
  o.start(start);
  o.stop(start + dur + 0.05);
}

export async function playSound(name: SoundName, volume: number, file = '') {
  const vol = Math.max(0, Math.min(100, volume)) / 100;
  if (name === 'none' || vol === 0) return;
  if (name === 'custom') {
    if (!file) return;
    if (customCache?.file !== file) customCache = { file, url: (await call<string | null>('sound:data', file)) ?? null };
    if (!customCache.url) { toast(t('set.soundMissing'), true); return; }
    const a = new Audio(customCache.url);
    a.volume = vol;
    void a.play().catch(() => {});
    return;
  }
  actx ??= new AudioContext();
  if (actx.state === 'suspended') await actx.resume().catch(() => {});
  const now = actx.currentTime + 0.02;
  const v = 0.35 * vol;
  if (name === 'chime') { tone(actx, 880, now, 0.5, v); tone(actx, 1318.5, now + 0.16, 0.7, v); }
  else if (name === 'bell') { tone(actx, 660, now, 1.4, v, 'triangle'); tone(actx, 1320, now, 0.9, v * 0.35); tone(actx, 1980, now, 0.5, v * 0.15); }
  else if (name === 'ping') { tone(actx, 1568, now, 0.35, v); }
}
