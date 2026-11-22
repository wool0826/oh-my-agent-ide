import type { Automation, Memo, Repo } from '../shared/types';
import type { AppState, AutoAnswer, ChatItem, ClaudeInfo, Decision, DiffView, LogPage, MemoryFile, MemoryHit, MemoryHits, MemorySuggestion, ModelList, PlanSummary, Task, Worker, WorkerLogItem, AccountView, SoundName, Lang } from '../shared/types';
import { ALLOW, ALLOW_TASK, DENY, EFFORTS, MAX_ACCOUNTS, type Effort } from '../shared/types';
import { ASK_RULES } from '../shared/grants';
import { tr, type Key } from '../shared/i18n';
import { modelLabel as labelFor } from '../shared/models';
import { hasSpend, spendVars, type Spend } from '../shared/spend';
import { cancelSet, followersOf, isQueued, statusAfterCancel, type CancelReport } from '../shared/queue';
import { queueWhy, queueWhyText, type QueueCtx } from '../shared/queueWhy';
import { prsInReview } from '../shared/prs';
import { reasonText } from '../shared/askWhy';
import { linkify } from '../shared/linkify';
import { RING, ringArc, untilReset } from '../shared/usageRing';
import { patchLines, reviewMessage, type DiffNote } from '../shared/diffComment';
import { canMerge, readyToMerge } from '../shared/prMerge';
import { lastLines } from '../shared/runOutput';
import { ghRepoRef, issueMessage, type Issue } from '../shared/issues';
import { jiraBase, jiraMessage, type JiraIssue } from '../shared/jira';
import { parseTime } from '../shared/automations';
import type { Checkpoint } from '../shared/checkpoints';
import { taskMinutes, workerTotals } from '../shared/workerSummary';
import { canPick, openComparisons } from '../shared/compare';
import { matchItems, stepIndex, type PaletteItem } from '../shared/palette';
import { awayDigest, awayRows, type AwayDigest } from '../shared/away';
import { normalizeQuickKey, quickKeyLabel } from '../shared/quickKey';
import { groupByRepo, recentlyFinished } from '../shared/sidebar';
import { memoSections } from '../shared/memos';
import { parseReply, replyExcerpt, withReply, type Reply } from '../shared/reply';
import { workerDecisions } from '../shared/inbox';
import { MAX_WORKERS_MAX, MAX_WORKERS_MIN, WAIT_SLOT_MAX, clampMaxWorkers, clampWaitSlot, slotsUsed, waitsForSlot } from '../shared/slots';
import { CONTEXT_WINDOW } from '../shared/context';
import { restoreScroll, saveScroll } from '../shared/scroll';
import { CHAT_SNAPSHOT, PAGE, firstPage, pagesFor, slideOlder, threadStart } from '../shared/paging';
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN, FONT_SUGGESTIONS, clampFontSize, fontStack, normalizeFontFamily } from '../shared/font';
import { History, NavInput, sameScreen, type NavDir, type NavSource, type Screen, type View, type WorkerFilter } from '../shared/history';

declare global {
  interface Window {
    ide: {
      platform: string;
      call<T = any>(channel: string, ...args: unknown[]): Promise<T>;
      onState(fn: (s: AppState) => void): void;
      onWorkerLog(fn: (id: string, item: WorkerLogItem) => void): void;
      onDecisionAlert(fn: () => void): void;
      /** Back or Forward from the OS (mouse side buttons and Back keys arrive as app commands on Windows and Linux). */
      onNav(fn: (dir: NavDir) => void): void;
      pathForFile(f: File): string;
    };
  }
}

const ide = window.ide;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const isMac = ide.platform === 'darwin';

let S: AppState | null = null;
const lang = (): Lang => S?.settings.language ?? 'en';
const t = (key: Key, vars?: Record<string, string | number>) => tr(lang(), key, vars);

/** A yes/no kept in this window's storage; false when storage is not available. */
function stored(key: string) {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function store(key: string, on: boolean) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* not kept */ }
}

type Pane = 'accounts' | 'general' | 'display' | 'alerts' | 'memory' | 'models';
const ui = {
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

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Escaped one-line text with `code` spans, for summaries written by agents. */
function inline(s: unknown) {
  return esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

/** An agent's bubble with the Reply button beside it. `box` is the composer the reply is written in. */
function replyable(bubble: string, box: 'chat' | 'ws', who: string, text: string) {
  const quote = replyExcerpt(text);
  if (!quote) return bubble;
  return `<div class="bline">${bubble}<button class="rbtn" data-action="reply" data-box="${box}" data-who="${esc(who)}" data-quote="${esc(quote)}" title="${t('reply.to')}" aria-label="${t('reply.to')}"><svg aria-hidden="true"><use href="#s-reply"/></svg></button></div>`;
}

/** The chip above a composer's text: whose message is being answered, its first words, and a way out. */
function renderReply(box: 'chat' | 'ws') {
  if (box === 'ws' && ui.reply.ws && ui.reply.ws.wid !== ui.wSel) ui.reply.ws = null;
  const r = ui.reply[box];
  const el = $(box === 'chat' ? '#chat-reply' : '#ws-reply');
  el.hidden = !r;
  el.innerHTML = r ? `${sym('s-reply')}<b>${esc(r.who)}</b><span>${esc(r.quote)}</span><button type="button" data-action="reply-cancel" data-box="${box}" title="${t('reply.cancel')}" aria-label="${t('reply.cancel')}"><svg aria-hidden="true"><use href="#s-x"/></svg></button>` : '';
}

/** The text to send from a composer: with the quote on top while a reply is open, which this ends. */
function takeReply(box: 'chat' | 'ws', text: string) {
  const r = ui.reply[box];
  if (!r) return text;
  ui.reply[box] = null;
  renderReply(box);
  return withReply(r, text);
}

/** Tiny markdown: code blocks, inline code, headings, bold, links, line breaks */
function md(src: string) {
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
function userText(text: string): string {
  const reply = parseReply(text);
  if (reply) return `<span class="quote"><b>${esc(reply.who)}</b><span>${esc(reply.quote)}</span></span>${userText(reply.body)}`;
  const i = text.indexOf('\n\n[Attached files]\n');
  if (i < 0) return linkify(esc(text));
  const files = text.slice(i).split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  return `${linkify(esc(text.slice(0, i)))}<span class="sent-files">${files.map((f) => `<a class="fchip" data-action="reveal" data-path="${esc(f)}" title="${esc(f)}">${esc(base(f))}</a>`).join('')}</span>`;
}

function oneLine(s: string, n = 120) {
  const x = String(s ?? '').replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n - 1) + '…' : x;
}

function ic(kind: string, glyph = kind) {
  return `<span class="ic k-${kind}" aria-hidden="true"><svg><use href="#g-${glyph}"/></svg></span>`;
}

/** Placeholder rows shown while a list is being read: grey bars where the rows will be. */
function skel(n: number, kind: 'mini' | 'file') {
  const row = kind === 'mini' ? '<div class="mini skel" aria-hidden="true"><i></i><i></i></div>' : '<div class="skel file" aria-hidden="true"><i></i></div>';
  return row.repeat(n);
}

/** A label that starts a row starts with a capital. */
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function sym(id: string, cls = '') {
  return `<svg class="sym ${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

const locale = () => (lang() === 'ko' ? 'ko-KR' : 'en-US');
/** Short time for lists: the time today, the date before that. */
function when(iso: string) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(locale(), { month: 'short', day: 'numeric' });
}
function hhmm(iso: string) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return t('time.today', { t: time });
  return `${d.toLocaleDateString(locale(), { month: 'short', day: 'numeric' })} ${time}`;
}

function ago(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return t('time.now');
  if (m < 60) return t('time.min', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('time.hour', { n: h });
  return t('time.day', { n: Math.round(h / 24) });
}

function k(n: number) { return `${Math.round(n / 1000)}K`; }
function ring(frac: number) {
  const v = Math.max(0, Math.min(100, frac * 100)).toFixed(1);
  return `<svg class="ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="trk" cx="10" cy="10" r="7.5"/><circle class="val" cx="10" cy="10" r="7.5" pathLength="100" stroke-dasharray="${v} 100" transform="rotate(-90 10 10)"/></svg>`;
}
function lv(v: number | null) {
  if (v === null) return 'lv-n';
  return v <= 30 ? 'lv-g' : v <= 50 ? 'lv-y' : v <= 80 ? 'lv-o' : 'lv-r';
}
const pct = (v: number | null) => (v === null ? '–' : `${v}%`);
function modelLabel(m: string) {
  return labelFor(m, ui.models.models);
}
function acctLabel(id: string | null) { return S?.accounts.find((a) => a.id === id)?.label ?? '–'; }
function prNum(url: string | null) { return url?.match(/\/pull\/(\d+)/)?.[1] ?? ''; }
/** Long paths and URLs keep their last segments, e.g. …/worktrees/demo/W-02. */
function shortPath(p: string, keep = 3) {
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > keep + 1 ? `…${sep}${parts.slice(-keep).join(sep)}` : p;
}
function base(p: string) { return p.split(/[\\/]/).filter(Boolean).pop() ?? p; }
const task = (id: string | null | undefined) => (id ? S?.tasks.find((x) => x.id === id) ?? null : null);
const worker = (id: string | null | undefined) => (id ? S?.workers.find((w) => w.id === id) ?? null : null);
const taskStatus = (st: string) => t(`task.${st}` as Key);
/** What the sidebar's "Done today" counts, and what its Worker list filter looks for. */
const finishedToday = (x: Task) => (x.status === 'done' || x.status === 'pr_open') && !!x.finishedAt && new Date(x.finishedAt).toDateString() === new Date().toDateString();
/** What a queued task waits for: a free Worker slot ("Waiting for a slot 3/3") or a usage limit. */
const queuedLabel = (x: Task) => (waitsForSlot(x) ? t('st.slotWait', { n: slotsUsed(S!.tasks), max: S!.settings.maxWorkers }) : t('st.limitWait'));
/**
 * The task is open because its Worker needs the Dispatcher, not the user (decision 87): the turn ended, so the Worker
 * is idle, and the task keeps its slot.
 */
const awaitsDispatcher = (x: Task | null | undefined) => {
  const w = x?.status === 'waiting' ? worker(x.workerId) : null;
  return !!w && w.status === 'idle' && !!w.request;
};
/** Failed because the user (or the Dispatcher) pressed Stop: shown apart from failures, never in red. */
const stoppedTask = (x: Task | null | undefined) => x?.status === 'failed' && !!x.stopped;
const taskLabel = (x: Task) => (x.status === 'queued' ? queuedLabel(x) : awaitsDispatcher(x) ? t('st.awaitDispatcher') : stoppedTask(x) ? t('task.stopped') : taskStatus(x.status));

let toastTimer: number | undefined;
function toast(text: string, err = false) {
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

async function call<T = any>(ch: string, ...args: unknown[]): Promise<T | undefined> {
  try {
    return await ide.call<T>(ch, ...args);
  } catch (e) {
    toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    return undefined;
  }
}

/** Keep typed values and focus across re-renders (only inputs with data-keep), and scroll offsets (keepScroll). */
function keepInputs(root: HTMLElement, render: () => void) {
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
const SCROLLBAR_LINGER_MS = 1200;
/** When each showing bar hides (Date.now() ms), and its timer. */
const bars = new WeakMap<Element, { until: number; timer: number }>();
/** Offsets the app itself moved an element to. The scroll event that follows is not the user's, so it shows no bar. */
const quietAt = new WeakMap<Element, string>();
const offsets = (el: Element) => `${el.scrollTop},${el.scrollLeft}`;

/**
 * Scrollbars show only while their element scrolls (styles.css, "scrollbars"): .sb-on shows the thumb,
 * and SCROLLBAR_LINGER_MS after the last scroll .sb-off fades it out. One capture-phase scroll listener (init)
 * calls this for every scrolling element; keepScroll calls it, with the time left, for a new element that
 * replaced one whose bar was showing.
 */
function showBar(el: Element, ms = SCROLLBAR_LINGER_MS) {
  clearTimeout(bars.get(el)?.timer);
  // Only real changes: rewriting the class attribute wakes the observer that places the glass pills.
  if (el.classList.contains('sb-off')) el.classList.remove('sb-off');
  if (!el.classList.contains('sb-on')) el.classList.add('sb-on');
  bars.set(el, { until: Date.now() + ms, timer: window.setTimeout(() => { el.classList.replace('sb-on', 'sb-off'); bars.delete(el); }, ms) });
}

function onScroll(e: Event) {
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
function scrollQuietly(el: HTMLElement, top: number, left = el.scrollLeft) {
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
function keepScroll(root: HTMLElement, render: () => void) {
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
function shownOf(key: string, page: number) { return Math.max(page, ui.pages.get(key) ?? 0); }

/** The button that ends a list with `left` more items; each press shows `page` more. */
function moreBtn(key: string, left: number, page: number) {
  if (left <= 0) return '';
  return `<button type="button" class="more-btn" data-action="page-more" data-page="${esc(key)}" data-n="${page}">${t('page.more', { n: Math.min(left, page) })}</button>`;
}

/** The part of a list on screen, and the "Show more" button for the rest. */
function paged<T>(key: string, items: T[], page: number) {
  const { items: shown, left } = firstPage(items, shownOf(key, page));
  return { items: shown, more: moreBtn(key, left, page) };
}

/** The start of a thread with earlier items: they load as it comes within reach (watchTop), or on a click. */
function olderBtn(thread: 'chat' | 'log', loading: boolean) {
  return `<button type="button" class="pg-top" data-action="page-older" data-v="${thread}">${t(loading ? 'page.loading' : 'page.older')}</button>`;
}

/** Each thread's watch on its .pg-top. Within reach is up to 600px above the top, so a page loads before the reader gets there. */
const topWatch = new Map<HTMLElement, IntersectionObserver>();
function watchTop(th: HTMLElement, load: () => void) {
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
const NEW_FROM = '<i class="new-from" hidden></i>';

function setThread(th: HTMLElement, html: string, follow: boolean, older: boolean) {
  const fromEnd = th.scrollHeight - th.scrollTop;
  th.innerHTML = html;
  if (older) scrollQuietly(th, th.scrollHeight - fromEnd);
  else if (follow) scrollQuietly(th, th.scrollHeight);
}

/** Fade in what a container shows now (a tab or a pane just picked). Later re-renders of it don't fade. */
const swapTimers = new WeakMap<HTMLElement, number>();
function swapIn(el: HTMLElement) {
  clearTimeout(swapTimers.get(el));
  el.classList.remove('swap');
  void el.offsetWidth;
  el.classList.add('swap');
  swapTimers.set(el, window.setTimeout(() => el.classList.remove('swap'), ms('--dur-slow')));
}

/** Says "Loading…" on a thread's .pg-top while its page is on the way. */
function markLoading(th: HTMLElement) {
  const top = th.querySelector('.pg-top');
  if (top) top.textContent = t('page.loading');
}

/** Back to "Show earlier messages" when the page didn't come. */
function unmarkLoading(th: HTMLElement) {
  const top = th.querySelector('.pg-top');
  if (top) top.textContent = t('page.older');
}

/** Static text in index.html carries data-i18n / data-i18n-ph / data-i18n-title keys. */
function applyStaticText() {
  if (ui.langApplied === lang()) return;
  ui.langApplied = lang();
  document.documentElement.lang = lang();
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n as Key); });
  document.querySelectorAll<HTMLElement>('[data-i18n-ph]').forEach((el) => { (el as HTMLInputElement).placeholder = t(el.dataset.i18nPh as Key); });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle as Key); el.setAttribute('aria-label', el.title); });
}

/* ---------- sound ---------- */

let actx: AudioContext | null = null;
let customCache: { file: string; url: string | null } | null = null;

function tone(ctx: AudioContext, freq: number, start: number, dur: number, vol: number, type: OscillatorType = 'sine') {
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

async function playSound(name: SoundName, volume: number, file = '') {
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

/* ---------- sidebar ---------- */

function workerIcon(w: Worker) {
  if (w.status === 'running' || w.status === 'starting') return ic('run');
  if (w.status === 'waiting') return ic('ask');
  if (w.status === 'error') return ic('err');
  if (w.status === 'archived') return ic('arch');
  const x = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
  if (x?.status === 'queued' || x?.status === 'blocked' || awaitsDispatcher(x)) return ic('wait');
  if (x?.status === 'pr_open') return ic('pr');
  if (x?.status === 'done') return ic('done');
  return ic('idle');
}

function renderSidebar() {
  const s = S!;
  const pending = s.decisions.filter((d) => d.status === 'pending');
  const lastTask = (w: Worker) => (w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null);
  // A Worker that waits for the Dispatcher's answer is listed too: its task is open and holds a slot.
  const running = s.workers.filter((w) => w.status === 'running' || w.status === 'waiting' || w.status === 'starting' || awaitsDispatcher(lastTask(w)));
  // A Worker stopped by an error is not running; it waits for someone to tell it to continue.
  const failed = s.workers.filter((w) => w.status === 'error');
  // One row per PR, even when a follow-up task recorded the same PR.
  const prs = prsInReview(s.tasks);
  const queued = s.tasks.filter(isQueued);
  const doneTasks = s.tasks.filter(finishedToday);
  const doneToday = doneTasks.length;
  const archived = s.workers.filter((w) => w.status === 'archived').length;
  const selW = ui.view === 'worker' && ui.wOpen ? ui.wSel : null;
  let selUsed = false;
  const selCls = (wid: string | null) => {
    if (!selUsed && selW && wid === selW) { selUsed = true; return ' sel'; }
    return '';
  };

  const sec = (title: string, rows: string, cls = '') => rows ? `<section class="side-sec ${cls}"><h4>${title}</h4>${rows}</section>` : '';
  const decRows = pending.map((d) => {
    const x = task(d.taskId);
    // Why it is asked, the same text as on the card and in the notification; the whole of it in the tooltip.
    const small = d.reason ? `${d.workerId ?? 'Dispatcher'} · ${d.reason.why}` : [d.workerId ?? 'Dispatcher', x?.title].filter(Boolean).join(', ');
    return `<div tabindex="0" role="button" class="row" data-action="goto-decision" data-id="${d.id}"${d.reason ? ` title="${esc(reasonText(d.reason))}"` : ''}>${ic('ask')}<span class="t"><b>${esc(oneLine(d.summary?.what || d.title, 60))}</b><small>${esc(small)}</small></span></div>`;
  }).join('');
  const workerRow = (w: Worker, grouped = false) => {
    const x = lastTask(w);
    const what = x?.title ?? w.title;
    const small = w.status === 'waiting' ? `${w.id}, ${t('st.waitingMe')}` : awaitsDispatcher(x) ? `${w.id}, ${t('st.awaitDispatcher')}` : `${grouped ? '' : `${w.repo ?? t('general')}, `}${w.id}, ${ago(x?.updatedAt ?? w.lastActiveAt)}`;
    return `<div tabindex="0" role="button" class="row${selCls(w.id)}" data-action="open-worker" data-id="${w.id}" data-ctx="worker"${w.status === 'error' ? ` title="${esc(w.statusText)}"` : ''}>${workerIcon(w)}<span class="t"><b>${esc(what)}</b><small>${esc(small)}</small></span>${workerActs(w)}</div>`;
  };
  // Running Workers get one area per repository; the heading carries the repository's name and how many run in it.
  const runRows = groupByRepo(running, (w) => w.repo).map((g) =>
    `<div class="rg"><div class="rg-h">${ic('repo', 'box')}<b>${esc(g.repo ?? t('general'))}</b><span class="n">${g.items.length}</span></div>${g.items.map((w) => workerRow(w, true)).join('')}</div>`).join('');
  const errRows = failed.map((w) => workerRow(w)).join('');
  const prRows = prs.map((x) => `<div tabindex="0" role="button" class="row${selCls(x.workerId)}" data-action="open-worker" data-id="${x.workerId ?? ''}">${ic('pr')}<span class="t"><b>${esc(x.title)}</b><small>${esc(`${x.repo ?? ''} #${prNum(x.prUrl)}, ${t('st.inReview')}`)}</small></span></div>`).join('');
  const qRows = queued.map((x) => {
    const small = x.status === 'blocked' ? t('side.afterMerge', { id: x.afterTaskId ?? '' }) : `${x.repo ?? t('general')}, ${x.workerId ?? ''}, ${queuedLabel(x)}`;
    const why = queueWhy(t, x, queueCtx());
    return `<div tabindex="0" role="button" class="row${selCls(x.workerId)}" data-action="open-worker" data-id="${x.workerId ?? ''}"${why ? ` title="${esc(queueWhyText(why))}"` : ''}>${ic('wait')}<span class="t"><b>${esc(x.title)}</b><small>${esc(small)}</small></span>${cancelX(x)}</div>`;
  }).join('');
  // Two or more PRs ready at once: one button merges them in turn, asked once.
  const ready = readyToMerge(s.tasks);
  const allBusy = ui.merging.has('*'), allSure = ui.mergeAsk === '*';
  const prTitle = `${t('side.prs')}${ready.length > 1 || allBusy ? `<button class="h-act go${allSure ? ' sure' : ''}" data-action="pr-merge-all"${allBusy ? ' disabled' : ''}>${t(allBusy ? 'pr.merging' : allSure ? 'pr.mergeAllSure' : 'pr.mergeAll', { n: ready.length })}</button>` : ''}`;
  const qTitle = `${t('side.queue')}${queued.length ? `<button class="h-act" data-action="queue-clear" title="${t('side.clearQueueTip')}">${t('side.clearQueue')}</button>` : ''}`;
  const any = decRows || runRows || prRows || qRows || errRows;
  const empty = any ? '' : `<div class="side-empty">${sym('s-check')}<span>${t('side.emptyTitle')}</span></div>`;
  // A filter's row is selected while the Worker list it filters is on screen.
  const filterCls = (f: WorkerFilter, n: number) => `${n ? '' : ' zero'}${ui.view === 'worker' && !ui.wOpen && ui.wFilter === f ? ' sel' : ''}`;
  const misc = `<section class="side-sec"><h4>${t('side.history')}</h4>
    <div tabindex="0" role="button" class="row${filterCls('today', doneToday)}" data-action="worker-filter" data-v="today">${ic('done')}<span class="t"><b>${t('side.doneToday')}</b></span><span class="badge">${doneToday}</span>${doneToday ? `<button class="disc" data-action="done-toggle" aria-expanded="${ui.doneOpen}" title="${t(ui.doneOpen ? 'side.doneHide' : 'side.doneShow')}" aria-label="${t(ui.doneOpen ? 'side.doneHide' : 'side.doneShow')}"><svg aria-hidden="true"><use href="#s-chev"/></svg></button>` : ''}</div>${doneToday && ui.doneOpen ? doneList(doneTasks) : ''}
    <div tabindex="0" role="button" class="row${filterCls('archived', archived)}" data-action="worker-filter" data-v="archived">${ic('arch')}<span class="t"><b>${t('side.archived')}</b></span><span class="badge">${archived}</span></div>
  </section>`;
  if (ui.sideMin) {
    // One glyph per section with its count; a section with nothing in it is left out, History always shows.
    const rail = (kind: string, label: string, n: number, extra = '', red = false) =>
      `<button class="rail-b${extra}" data-action="side-toggle" title="${esc(`${label} ${n}`)}" aria-label="${esc(`${label} ${n}`)}">${ic(kind)}<span class="n${red ? ' red' : ''}">${n}</span></button>`;
    const live = [
      pending.length ? rail('ask', t('side.decisions'), pending.length, ' sec-dec', true) : '',
      running.length ? rail('run', t('side.running'), running.length) : '',
      prs.length ? rail('pr', t('side.prs'), prs.length) : '',
      queued.length ? rail('wait', t('side.queue'), queued.length) : '',
      failed.length ? rail('err', t('side.errors'), failed.length) : '',
    ].join('');
    const hist = (f: WorkerFilter, kind: string, label: string, n: number) =>
      `<button class="rail-b${filterCls(f, n)}" data-action="worker-filter" data-v="${f}" title="${esc(`${label} ${n}`)}" aria-label="${esc(`${label} ${n}`)}">${ic(kind)}${n ? `<span class="n">${n}</span>` : ''}</button>`;
    $('#side').innerHTML = `${live}${live ? '<span class="rail-sep"></span>' : ''}${hist('today', 'done', t('side.doneToday'), doneToday)}${hist('archived', 'arch', t('side.archived'), archived)}`;
    return;
  }
  $('#side').innerHTML = sec(t('side.decisions'), decRows, 'sec-dec') + sec(t('side.running'), runRows) + sec(prTitle, prRows) + sec(qTitle, qRows) + sec(t('side.errors'), errRows) + empty + misc;
}

/** What a finished task did, in one line: its PR and state, then the summary its Worker reported. */
function doneLine(x: Task) {
  const pr = x.prUrl ? `#${prNum(x.prUrl)} ${x.prState === 'MERGED' ? t('pr.merged') : x.prState === 'CLOSED' ? t('pr.closed') : t('st.inReview')}` : t('side.noPr');
  return x.summary ? `${pr} · ${oneLine(x.summary, 140)}` : pr;
}

/** Under "Done today": the five tasks finished last. A row opens its Worker; the heading row still lists them all. */
function doneList(done: Task[]) {
  const rows = recentlyFinished(done).map((x) => {
    const line = doneLine(x);
    const at = new Date(x.finishedAt!).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
    return `<div tabindex="0" role="button" class="row" data-action="open-worker" data-id="${esc(x.workerId ?? '')}" title="${esc(`${x.title}\n${line}`)}"><span class="t"><b>${esc(x.title)}</b><small>${esc(line)}</small></span><time>${at}</time></div>`;
  }).join('');
  const more = done.length > 5 ? `<button class="linkbtn" data-action="worker-filter" data-v="today">${t('side.doneAll', { n: done.length })}</button>` : '';
  return `<div class="sub">${rows}${more}</div>`;
}

/** A Worker can be stopped while it is at work. */
const stoppable = (w: Worker) => w.status === 'running' || w.status === 'waiting' || w.status === 'starting';

/** Stop and Open on a sidebar Worker row, shown on hover (the row's context menu has them too). */
function workerActs(w: Worker) {
  const btn = (action: string, icon: string, label: string) => `<button class="clear-x" data-action="${action}" data-id="${esc(w.id)}" title="${label}" aria-label="${esc(`${label}: ${w.id}`)}"><svg><use href="#${icon}"/></svg></button>`;
  return `<span class="row-acts">${stoppable(w) ? btn('worker-stop', 's-stop', t('wk.stop')) : ''}${btn('open-worker', 's-chev', t('wk.open'))}</span>`;
}

/** The × on a queued task's row: asks before cancelling it. */
function cancelX(x: Task) {
  const label = esc(`${t('cancel.task')}: ${x.title}`);
  return `<button class="clear-x" data-action="task-cancel" data-id="${esc(x.id)}" title="${t('cancel.task')}" aria-label="${label}"><svg><use href="#s-x"/></svg></button>`;
}

/** "5h", "7d", "30d": how long a usage window is. */
function winLabel(mins: number | null | undefined, fallback: string) {
  if (!mins) return fallback;
  return mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
}

/** The account's usage windows with their labels: two for a Claude account, one or two for a ChatGPT plan. */
function usageWindows(a: AccountView): { label: string; v: number | null }[] {
  if (a.provider !== 'chatgpt') return [{ label: '5h', v: a.fiveHour.utilization }, { label: '7d', v: a.sevenDay.utilization }];
  const [short, long] = a.windowMins ?? [null, null];
  return [...(short ? [{ label: winLabel(short, '5h'), v: a.fiveHour.utilization }] : []), { label: winLabel(long, '7d'), v: a.sevenDay.utilization }];
}

/** A token duration in ms, as it is now: 0 while motion is reduced. */
function ms(token: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return v.endsWith('ms') ? parseFloat(v) : v.endsWith('s') ? parseFloat(v) * 1000 : 0;
}

/** An account's two rings on the 24×24 grid: 7d outside, 5h inside. */
function ringsSvg(a: AccountView) {
  const arc = (v: number | null, r: number) => {
    const d = ringArc(v, r);
    return `<circle class="trk" cx="12" cy="12" r="${r}"/>${d ? `<circle class="${lv(v)}" cx="12" cy="12" r="${r}" stroke-dasharray="${d}"/>` : ''}`;
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${arc(a.sevenDay.utilization, RING.sevenDay)}${arc(a.fiveHour.utilization, RING.fiveHour)}</svg>`;
}

/** "Claude Team", "ChatGPT Free": whose account it is and its plan. */
function planName(a: AccountView) {
  const plan = a.provider === 'chatgpt' ? a.planLabel ?? '' : a.plan;
  return `${a.provider === 'chatgpt' ? 'ChatGPT' : 'Claude'}${plan ? ` ${plan[0].toUpperCase()}${plan.slice(1)}` : ''}`;
}

/** The same facts as the popover in one string, for screen readers. */
function usageTip(a: AccountView) {
  const parts = [`${a.label}, ${planName(a)}`, usageWindows(a).map((w) => `${w.label} ${pct(w.v)}`).join(' · ')];
  if (a.limitedUntil) parts.push(t('usage.limitedUntil', { t: hhmm(a.limitedUntil) }));
  if (a.lastError) parts.push(a.lastError);
  else if (!a.usageUpdatedAt) parts.push(t('usage.unknown'));
  return parts.join('. ');
}

/** One account in the usage popover: its rings and name, a bar per window with the time to its reset, and how fresh the numbers are. */
function usageCard(a: AccountView) {
  const wins = [
    ...(a.provider !== 'chatgpt' || a.windowMins?.[0] ? [{ label: a.provider === 'chatgpt' ? winLabel(a.windowMins?.[0], '5h') : '5h', w: a.fiveHour }] : []),
    { label: a.provider === 'chatgpt' ? winLabel(a.windowMins?.[1], '7d') : '7d', w: a.sevenDay },
  ];
  const rows = wins.map(({ label, w }) => {
    const left = untilReset(w.resetsAt)?.map((p) => t(p.unit === 'd' ? 'time.day' : p.unit === 'h' ? 'time.hour' : 'time.min', { n: p.n })).join(' ');
    return `<div class="uw"><span class="wl">${label}</span><span class="cap"><i class="${lv(w.utilization)}" style="width:${Math.min(100, w.utilization ?? 0)}%"></i></span><b>${pct(w.utilization)}</b><small>${left ? esc(t('usage.resetsIn', { t: left })) : ''}</small></div>`;
  }).join('');
  const state = a.limited
    ? `<span class="pill red">${esc(a.limitedUntil ? t('usage.limitedShort', { t: when(a.limitedUntil) }) : t('usage.limited'))}</span>`
    : `<time>${a.usageUpdatedAt ? esc(t('usage.asOf', { t: when(a.usageUpdatedAt) })) : ''}</time>`;
  const note = a.lastError ? `<p class="err">${esc(a.lastError)}</p>` : !a.usageUpdatedAt ? `<p>${t('usage.unknown')}</p>` : '';
  return `<section class="ua${a.id === usagePop.hover ? ' on' : ''}" data-id="${esc(a.id)}"><header>${ringsSvg(a)}<span class="who"><b>${esc(a.label)}</b><small>${esc(planName(a))}</small></span>${state}</header>${rows}${note}</section>`;
}

/** The usage popover: every account's numbers while the pointer or the focus is on the rings. */
const usagePop = { shown: false, hover: null as string | null, timer: 0 };
function showUsagePop() {
  const el = $('#usage-pop');
  clearTimeout(usagePop.timer);
  if (!S?.accounts.length) return;
  el.innerHTML = S.accounts.map(usageCard).join('');
  if (usagePop.shown) return;
  usagePop.shown = true;
  el.classList.remove('out');
  el.hidden = false;
  const r = $('#usage').getBoundingClientRect();
  el.style.top = `${r.bottom + 8}px`;
  el.style.left = `${Math.max(8, Math.min(r.right - el.offsetWidth, innerWidth - el.offsetWidth - 8))}px`;
  // The bars fill once, as it opens; a refresh of its numbers afterwards redraws them in place.
  el.classList.add('opening');
  usagePop.timer = window.setTimeout(() => el.classList.remove('opening'), ms('--dur-glide'));
}
function hideUsagePop() {
  if (!usagePop.shown) return;
  usagePop.shown = false;
  usagePop.hover = null;
  const el = $('#usage-pop');
  clearTimeout(usagePop.timer);
  el.classList.remove('opening');
  el.classList.add('out');
  usagePop.timer = window.setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, ms('--dur-fast'));
}
/** Marks the account whose ring the pointer is on. */
function hoverUsage(id: string | null) {
  if (usagePop.hover === id) return;
  usagePop.hover = id;
  document.querySelectorAll<HTMLElement>('#usage-pop .ua').forEach((s) => s.classList.toggle('on', s.dataset.id === id));
}

function renderUsage() {
  const accs = S!.accounts;
  const el = $('#usage');
  if (!accs.length) {
    el.className = 'usage-empty nodrag';
    el.removeAttribute('tabindex');
    el.innerHTML = `<a tabindex="0" role="link" data-action="open-settings">${t('usage.addAccount')}</a>`;
    hideUsagePop();
    return;
  }
  // One ring per account, in the order of Settings. The names and the numbers are in the popover (#usage-pop).
  el.className = 'usage nodrag';
  el.tabIndex = 0;
  el.setAttribute('aria-label', accs.map(usageTip).join('\n'));
  el.innerHTML = accs.map((a: AccountView) => `<span class="uacct${a.limited ? ' limited' : ''}" data-id="${esc(a.id)}">${ringsSvg(a)}</span>`).join('');
  if (usagePop.shown) showUsagePop();
}

/** Put the sidebars away or back, and say so on their buttons. The right one's button counts open decisions while it is hidden. */
function applyPanels() {
  const win = $('#win');
  win.classList.toggle('side-min', ui.sideMin);
  win.classList.toggle('ins-min', ui.insMin);
  const left = $('#side-toggle');
  const leftTip = t(ui.sideMin ? 'side.expand' : 'side.collapse', { key: isMac ? '⌘B' : 'Ctrl+B' });
  left.title = leftTip;
  left.setAttribute('aria-label', leftTip);
  left.setAttribute('aria-expanded', String(!ui.sideMin));
  const n = ui.insMin ? (S?.decisions.filter((d) => d.status === 'pending').length ?? 0) : 0;
  // The gear carries a dot while a newer release waits.
  document.querySelector('.foot-btn[data-action="open-settings"]')?.classList.toggle('has-update', !!S?.update);
  const find = $('#cmdk-btn');
  find.title = t('cmdk.tip', { key: isMac ? '⌘K' : 'Ctrl+K' });
  find.setAttribute('aria-label', find.title);
  const right = $('#ins-toggle');
  const key = isMac ? '⌥⌘B' : 'Ctrl+Alt+B';
  const rightTip = !ui.insMin ? t('ins.collapse', { key }) : n ? t('ins.expandDec', { key, n }) : t('ins.expand', { key });
  right.title = rightTip;
  right.setAttribute('aria-label', rightTip);
  right.setAttribute('aria-expanded', String(!ui.insMin));
  const badge = $('#ins-count');
  badge.hidden = !n;
  badge.textContent = n ? String(n) : '';
}

let sideAnim: number | undefined;
function togglePanel(which: 'side' | 'ins') {
  if (which === 'side') {
    ui.sideMin = !ui.sideMin;
    store('oma.sideMin', ui.sideMin);
    // The sidebar's new content fades in only for this change: every later state update rebuilds it and must not fade.
    const win = $('#win');
    win.classList.add('side-anim');
    clearTimeout(sideAnim);
    sideAnim = window.setTimeout(() => win.classList.remove('side-anim'), 400);
  } else {
    ui.insMin = !ui.insMin;
    store('oma.insMin', ui.insMin);
  }
  applyPanels();
  if (S) renderSidebar();
}

/* ---------- chat ---------- */

const CI_BADGE: Record<string, [string, Key]> = { passing: ['ok', 'pr.ciPassing'], failing: ['bad', 'pr.ciFailing'], pending: ['run', 'pr.ciPending'] };
const REVIEW_BADGE: Record<string, [string, Key]> = { approved: ['ok', 'pr.approved'], changes: ['warn', 'pr.changes'], required: ['', 'pr.reviewNeeded'] };

/** Is an open PR ready to merge: CI, conflicts, review. */
function prBadges(x: Task) {
  const c = x.prChecks;
  if (!c || x.prState !== 'OPEN') return '';
  const b: string[] = [];
  const ci = CI_BADGE[c.ci];
  if (ci) b.push(`<i class="${ci[0]}"${c.failed.length ? ` title="${esc(c.failed.join(', '))}"` : ''}>${t(ci[1])}</i>`);
  if (c.conflicts) b.push(`<i class="bad">${t('pr.conflicts')}</i>`);
  const rv = c.review ? REVIEW_BADGE[c.review] : null;
  if (rv) b.push(`<i class="${rv[0]}">${t(rv[1])}</i>`);
  // Ready to merge: a button, asked once before it merges.
  if (canMerge(c)) {
    const busy = ui.merging.has(x.id), sure = ui.mergeAsk === x.id;
    b.push(`<button type="button" class="prmerge${sure ? ' sure' : ''}" data-action="pr-merge" data-id="${esc(x.id)}"${busy ? ' disabled' : ''}>${t(busy ? 'pr.merging' : sure ? 'pr.mergeSure' : 'pr.merge')}</button>`);
  }
  return b.length ? `<span class="prst">${b.join('')}</span>` : '';
}

function resultLinks(x: Task | null) {
  const links: string[] = [];
  if (x?.prUrl) {
    const st = x.prState === 'MERGED' ? ` · ${t('pr.merged')}` : x.prState === 'CLOSED' ? ` · ${t('pr.closed')}` : '';
    links.push(`<a tabindex="0" role="link" data-action="open-url" data-href="${esc(x.prUrl)}">PR #${prNum(x.prUrl)}${st}</a>`);
    const badges = prBadges(x);
    if (badges) links.push(badges);
  }
  for (const f of x?.files ?? []) links.push(`<a tabindex="0" role="link" data-action="open-file" data-path="${esc(f)}" title="${esc(f)}">${esc(base(f))}</a>`);
  return links;
}

/** A task's spend, labeled as an API-equivalent estimate. Short: the cost only, tokens on hover. */
function spendHtml(s: Spend | null | undefined, short = false) {
  if (!hasSpend(s)) return '';
  const v = spendVars(s);
  const text = short ? t('spend.cost', v) : `${t('spend.cost', v)} · ${t('spend.tokens', v)}`;
  const tip = short ? `${t('spend.tokens', v)}\n${t('spend.tip', v)}` : t('spend.tip', v);
  return `<span class="spend" title="${esc(tip)}">${esc(text)}</span>`;
}

function resultGlyph(x: Task | null, err = false) {
  if (err) return sym('s-alert', 'c-red');
  if (stoppedTask(x)) return sym('s-stop', 'c-gray');
  if (x?.prState === 'MERGED') return sym('s-merge', 'c-pr-merged');
  return x?.prUrl ? sym('s-pr', x.prState === 'CLOSED' ? 'c-pr-closed' : 'c-pr-open') : x?.files.length ? sym('s-doc', 'c-teal') : sym('s-check', 'c-green');
}

function chatItemHtml(c: ChatItem) {
  switch (c.kind) {
    case 'user': return `<div class="bub me">${userText(c.text)}</div>`;
    case 'dispatcher': return replyable(`<div class="bub ai">${md(c.text)}</div>`, 'chat', 'Dispatcher', c.text);
    case 'event': return `<span class="event">${sym('s-cpu', 'c-blue')}<span>${linkify(esc(c.text))}</span></span>`;
    case 'decision': return `<span class="event mine">${sym('s-check', 'c-green')}<span><b>${t('chat.decided')}</b> ${esc(c.text)}</span></span>`;
    case 'error': return `<span class="event err">${sym('s-alert', 'c-red')}<span>${esc(c.text)}</span></span>`;
    case 'auto': {
      const a = S!.autoAnswers.find((x) => x.id === c.ref);
      return `<button class="event self" data-action="aa-select" data-id="${c.ref ?? ''}" title="${t('chat.showRight')}">${sym('s-check', 'c-green')}<span><b>${a?.corrected ? t('chat.autoCorrected') : t('chat.auto')}</b> ${esc(c.text)}</span><svg class="chev" aria-hidden="true"><use href="#s-chev"/></svg></button>`;
    }
    case 'result': {
      const x = task(c.ref);
      const links = resultLinks(x);
      if (x?.workerId) links.push(`<a tabindex="0" role="link" data-action="open-worker" data-id="${x.workerId}">${t('chat.viewWorker', { id: x.workerId })}</a>`);
      return `<div class="attach"><span class="tile">${resultGlyph(x)}</span><span class="body"><b>${esc(x?.title ?? t('task'))}</b><span class="sm">${inline(c.text)}</span><span class="links">${links.join('')}</span>${spendHtml(x?.spend)}</span></div>`;
    }
  }
}

/** The chat items held: pages loaded with chat:page, then the state's snapshot. */
function chatAll(): ChatItem[] {
  return ui.chatOlder.length ? [...ui.chatOlder, ...S!.chat] : S!.chat;
}

/** Whether the store has chat items before the first one held (the snapshot is full, and no answer said none). */
function chatHasEarlier(all: ChatItem[]) {
  return S!.chat.length >= CHAT_SNAPSHOT && !!all[0] && all[0].id !== ui.chatEndAt;
}

/**
 * The thread shows its last page and, once the reader scrolls up, from the first item shown on (ui.chatFrom).
 * `older`: a page went in above, so the reader's place is kept from the end.
 */
function renderChat(force = false, older = false) {
  const s = S!;
  const th = $('#chat-thread');
  const nearBottom = th.scrollHeight - th.scrollTop - th.clientHeight < 80;
  const all = chatAll();
  const from = threadStart(all.length, all.findIndex((c) => c.id === ui.chatFrom), PAGE.chat, (nearBottom || force) && !older);
  ui.chatFrom = all[from]?.id ?? null;
  // Pages no longer shown are let go; scrolling up loads them again.
  if (ui.chatOlder.length && from >= ui.chatOlder.length) ui.chatOlder = [];
  const earlier = from > 0 || chatHasEarlier(all);
  const key = `${lang()}:${ui.chatFrom}:${all.length - from}:${s.chat[s.chat.length - 1]?.id}:${earlier}:${ui.loadingOlder.has('chat')}:${s.dispatcher.busy}:${s.dispatcher.statusText}:${s.autoAnswers.filter((a) => a.corrected).length}:${s.tasks.map((x) => x.status + x.prUrl + x.prState + (x.prChecks ? JSON.stringify(x.prChecks) : '')).join()}`;
  if (!force && !older && key === ui.lastChatKey) return;
  ui.lastChatKey = key;
  let html = earlier ? olderBtn('chat', ui.loadingOlder.has('chat')) : '';
  let last = 0;
  // The same error said again right after itself (e.g. every account at its limit) shows once with a count.
  const items: { c: ChatItem; n: number }[] = [];
  for (const c of all.slice(from)) {
    const prev = items[items.length - 1];
    if (prev && c.kind === 'error' && prev.c.kind === 'error' && prev.c.text === c.text && !c.ref && !prev.c.ref) { prev.n++; continue; }
    items.push({ c, n: 1 });
  }
  // What arrived since the last render comes in with a short rise: everything after the marker (styles.css, .new-from).
  const seenAt = older ? -1 : items.findIndex(({ c }) => c.id === ui.chatSeen);
  const tail = items[items.length - 1]?.c.id ?? null;
  for (const [i, { c, n }] of items.entries()) {
    if (seenAt >= 0 && i === seenAt + 1) html += NEW_FROM;
    const ts = Date.parse(c.ts);
    if (ts - last > 30 * 60_000) html += `<span class="stamp">${hhmm(c.ts)}</span>`;
    last = ts;
    html += n > 1 ? chatItemHtml(c).replace(/<\/span><\/span>$/, ` <b class="times">×${n}</b></span></span>`) : chatItemHtml(c);
  }
  if (!all.length) html = `<div class="empty-view">${sym('s-chat')}<b>${t('chat.emptyTitle')}</b></div>`;
  if (s.dispatcher.busy) html += `<div class="typing"><span class="dots"><i></i><i></i><i></i></span>${esc(s.dispatcher.statusText ? oneLine(s.dispatcher.statusText, 80) : '')}</div>`;
  ui.chatSeen = tail;
  setThread(th, html, nearBottom || force, older);
  watchTop(th, () => void olderChat());
  const ctx = s.dispatcher.contextTokens;
  $('#chat-ctx').innerHTML = `${ring(ctx / CONTEXT_WINDOW).replace('class="ring"', '')}${k(ctx)} / ${k(CONTEXT_WINDOW)}`;
  $<HTMLButtonElement>('#chat-ctx').disabled = !!s.dispatcher.busy;
  updateSendButton();
}

/** Show the chat page before the first one shown: from the items held, else from the store (chat:page). */
async function olderChat() {
  if (!S || ui.loadingOlder.has('chat')) return;
  const all = chatAll();
  const from = all.findIndex((c) => c.id === ui.chatFrom);
  if (from > 0) {
    ui.chatFrom = all[Math.max(0, from - PAGE.chat)].id;
    renderChat(false, true);
    return;
  }
  if (from < 0 || !chatHasEarlier(all)) return;
  const first = all[0].id;
  ui.loadingOlder.add('chat');
  markLoading($('#chat-thread'));
  const r = await call<{ items: ChatItem[]; more: boolean }>('chat:page', first, PAGE.chat);
  ui.loadingOlder.delete('chat');
  // No answer (the error is a toast): the button stays and asks again on the next scroll or state push, but
  // nothing renders now, since a render would re-watch the button and ask again at once.
  if (!r) { unmarkLoading($('#chat-thread')); return; }
  // The items held changed meanwhile (the snapshot slid past them); scrolling up asks again.
  if (chatAll()[0]?.id === first) {
    if (r.items.length) {
      ui.chatOlder = [...r.items, ...ui.chatOlder];
      ui.chatFrom = r.items[0].id;
    }
    // None left: stop asking from this item.
    if (!r.more) ui.chatEndAt = r.items[0]?.id ?? first;
  }
  if (ui.view === 'chat') renderChat(false, true);
}

function updateSendButton() {
  const btn = $<HTMLButtonElement>('#chat-send');
  const empty = !$<HTMLTextAreaElement>('#chat-input').value.trim() && !ui.attach.chat.length;
  const stop = !!S?.dispatcher.busy && empty;
  btn.classList.toggle('stop', stop);
  btn.innerHTML = sym(stop ? 's-stop' : 's-up');
  btn.setAttribute('aria-label', stop ? t('chat.stop') : t('send'));
  btn.title = stop ? t('chat.stop') : '';
}

/** The free-text hint of a decision: it denies with a reason, asks for plan changes, or gives another answer. */
function decisionHint(d: Decision) {
  return t(d.source === 'permission' ? 'dec.denyWhy' : d.source === 'plan' ? 'plan.revise' : 'dec.other');
}

/** inWorker: in its Worker's panel, where the Worker's composer is the text field (decision 93). */
function decisionHtml(d: Decision, inWorker = false) {
  const x = task(d.taskId);
  const src = [d.workerId ?? 'Dispatcher', x?.title].filter(Boolean).join(', ');
  const icon = d.source === 'permission' ? sym('s-alert', 'c-red') : d.source === 'plan' ? sym('s-doc', 'c-blue') : sym('s-chat', 'c-orange');
  let buttons: string;
  if (d.source === 'plan') {
    buttons = `<div class="btns"><button class="btn def" data-action="answer" data-id="${d.id}" data-val="${ALLOW}">${t('plan.approve')}</button></div>`;
  } else if (d.source === 'permission') {
    // "Allow for this task" is there when the action's kind can be named; its tooltip says what the yes covers.
    const scope = d.options.find((o) => o.label === ALLOW_TASK);
    buttons = `<div class="btns"><button class="btn" data-action="answer" data-id="${d.id}" data-val="${DENY}">${t('deny')}</button>${scope ? `<button class="btn" data-action="answer" data-id="${d.id}" data-val="${ALLOW_TASK}" title="${esc(scope.description ?? '')}">${t('allowTask')}</button>` : ''}<button class="btn def" data-action="answer" data-id="${d.id}" data-val="${ALLOW}">${t('allow')}</button></div>`;
  } else {
    const col = d.options.length > 2 || d.options.some((o) => o.description);
    buttons = `<div class="btns${col ? ' col' : ''}">${d.options.map((o) => `<button class="btn" data-action="answer" data-id="${d.id}" data-val="${esc(o.label)}">${esc(o.label)}${o.description && col ? `<div class="opt-d">${esc(o.description)}</div>` : ''}</button>`).join('')}</div>`;
  }
  const custom = inWorker ? '' : `<input class="inp" data-keep="dec-${d.id}" data-enter="answer-custom" data-id="${d.id}" placeholder="${decisionHint(d)}">`;
  const sum = d.source === 'plan' ? d.summary : null;
  return `<div class="dec" id="${inWorker ? 'wdec' : 'dec'}-${d.id}">
    <div class="src">${icon}<span>${esc(src)}</span></div>
    <div class="q">${esc(d.title)}</div>
    ${d.reason ? `<div class="reason"><span>${esc(d.reason.what)}</span> ${esc(d.reason.why)}</div>` : ''}
    ${d.detail ? `<div class="d">${esc(d.detail)}</div>` : ''}
    ${sum ? planSummaryHtml(d, sum, inWorker) : d.code ? (d.source === 'plan' ? `<div class="plan-md" data-scroll="plan-${esc(d.id)}">${md(d.code)}</div>` : `<code>${esc(d.code)}</code>`) : ''}
    ${buttons}${custom}
  </div>`;
}

/** A plan card's WHAT / HOW / OUTPUT lines, with the full plan folded below them and a way to the Worker's conversation. */
function planSummaryHtml(d: Decision, sum: PlanSummary, inWorker = false) {
  const open = ui.planOpen.has(d.id);
  const row = (key: Key, v: string) => v ? `<dt>${t(key)}</dt><dd>${inline(v)}</dd>` : '';
  const links = [
    d.code ? `<button data-action="plan-toggle" data-id="${d.id}" aria-expanded="${open}">${t(open ? 'plan.hide' : 'plan.details')}<span aria-hidden="true">${open ? '▴' : '▾'}</span></button>` : '',
    d.workerId && !inWorker ? `<button data-action="open-worker" data-id="${esc(d.workerId)}">${t('plan.open')}<span aria-hidden="true">→</span></button>` : '',
  ].join('');
  return `<dl class="plan-sum">${row('plan.what', sum.what)}${row('plan.how', sum.how)}${row('plan.output', sum.output)}</dl>
    ${sum.auto ? `<div class="plan-auto" title="${esc(t('plan.autoHint'))}">${t('plan.auto')}</div>` : ''}
    ${links ? `<div class="plan-links">${links}</div>` : ''}
    ${open && d.code ? `<div class="plan-md" data-scroll="plan-${esc(d.id)}">${md(d.code)}</div>` : ''}`;
}

function aaHtml(a: AutoAnswer) {
  const sel = ui.aaSel === a.id ? ' sel' : '';
  const editing = ui.aaEdit === a.id;
  const corrected = a.corrected ? ' corrected' : '';
  const q = `${esc(oneLine(a.question, 140))} → <em>${esc(a.answer)}</em>${a.corrected ? ` <ins>${esc(a.corrected.answer)}</ins>` : ''}`;
  const fix = editing ? `<div class="fix">
      <input class="inp" data-keep="aa-${a.id}" data-enter="aa-send" data-id="${a.id}" placeholder="${t('aa.placeholder')}">
      <div class="radios" role="radiogroup" aria-label="${t('aa.scope')}">
        <label><input type="radio" name="scope-${a.id}" value="once" checked>${t('aa.once')}</label>
        <label><input type="radio" name="scope-${a.id}" value="preference">${t('aa.pref')}</label>
      </div>
      <div class="btns"><button class="btn" data-action="aa-cancel">${t('cancel')}</button><button class="btn def" data-action="aa-send" data-id="${a.id}">${t('aa.send')}</button></div>
    </div>` : '';
  return `<div class="aa${sel}${editing ? ' editing' : ''}${corrected}" id="aa-${a.id}" data-ctx="aa" data-id="${a.id}">
    <div class="src">${sym('s-check', 'c-green')}<span>${esc(a.workerId)}, ${hhmm(a.createdAt)}</span></div>
    <div class="q">${q}</div>
    <div class="why">${esc(a.basis)}</div>
    ${a.corrected ? `<div class="fixed">${a.corrected.scope === 'preference' ? t('aa.fixedPref') : t('aa.fixedOnce')}</div>` : ''}
    ${fix}
    <button class="hov" data-action="aa-edit" data-id="${a.id}" title="${t('aa.correct')}" aria-label="${t('aa.correct')}"><svg><use href="#s-pencil"/></svg></button>
  </div>`;
}

/** A "Remember this?" card: save as is, edit then save, or dismiss. */
function sugHtml(sg: MemorySuggestion) {
  const editing = ui.sugEdit === sg.id;
  const where = sg.scope === 'repo' && sg.repo ? t('sug.repo', { name: sg.repo }) : t('sug.pref');
  const src = [where, sg.taskId ?? sg.workerId].filter(Boolean).join(', ');
  const body = editing
    ? `<input class="inp" data-keep="sug-${sg.id}" data-enter="sug-save" data-id="${sg.id}" value="${esc(sg.text)}" placeholder="${t('sug.placeholder')}" aria-label="${t('sug.placeholder')}">`
    : `<div class="q">${esc(sg.text)}</div>`;
  const save = `<button class="btn def" data-action="sug-save" data-id="${sg.id}">${t('save')}</button>`;
  const btns = editing
    ? `<button class="btn" data-action="sug-cancel">${t('cancel')}</button>${save}`
    : `<button class="btn" data-action="sug-dismiss" data-id="${sg.id}">${t('sug.dismiss')}</button><button class="btn" data-action="sug-edit" data-id="${sg.id}">${t('sug.edit')}</button>${save}`;
  return `<div class="dec sug" id="sug-${sg.id}">
    <div class="src">${sym('s-sparkle', 'c-purple')}<span>${esc(src)}</span></div>
    ${body}
    ${sg.reason ? `<div class="d">${esc(sg.reason)}</div>` : ''}
    <div class="btns">${btns}</div>
  </div>`;
}

/** Auto-answers not cleared from the inspector, newest first. */
function visibleAutos() {
  return S!.autoAnswers.filter((a) => !a.cleared).reverse();
}

async function saveSug(id: string) {
  const inp = document.querySelector<HTMLInputElement>(`[data-keep="sug-${id}"]`);
  const v = inp?.value.trim();
  if (inp && !v) { inp.focus(); return; }
  document.getElementById(`sug-${id}`)?.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
  ui.sugEdit = null;
  await call('suggest:save', id, v);
}

/* ---------- while you were away (decision 122) ---------- */

const SEEN_KEY = 'oma.lastSeen';
let away: AwayDigest | null = null;

/** The user is looking now: remember when, for the next absence. */
function markSeen() {
  try { localStorage.setItem(SEEN_KEY, new Date().toISOString()); } catch { /* not kept */ }
}

/** The window came back (or the app started): if enough happened since the user last looked, the inbox says what. */
function checkAway() {
  if (!S) return;
  let since: string | null = null;
  try { since = localStorage.getItem(SEEN_KEY); } catch { /* none */ }
  const d = awayDigest(S, since, Date.now());
  markSeen();
  if (!d) return;
  away = d;
  if (ui.view === 'chat') renderChatInspector();
}

function awayHtml() {
  if (!away) return '';
  const d = away;
  const span = d.minutes >= 60 * 24 ? t('away.since', { t: when(d.since) }) : tookText(d.minutes);
  const counts = [d.failed.length ? t('away.failed', { n: d.failed.length }) : '', d.finished.length ? t('away.finished', { n: d.finished.length }) : '',
    d.merged.length ? t('away.merged', { n: d.merged.length }) : '', d.waiting ? t('away.waiting', { n: d.waiting }) : ''].filter(Boolean).join(' · ');
  const rows = awayRows(d);
  const total = new Set([...d.failed, ...d.merged, ...d.finished].map((x) => x.id)).size;
  const pill = { failed: ['red', taskStatus('failed')], merged: ['purple', t('pr.merged')], finished: ['green', taskStatus('done')] } as const;
  return `<div class="sect" id="sec-away"><div class="ins-h"><b>${t('away.title')}</b><small>${esc(span)}</small><span class="gap"></span><button class="clear-x always" data-action="away-dismiss" title="${t('away.dismiss')}" aria-label="${t('away.dismiss')}"><svg><use href="#s-x"/></svg></button></div>
    <div class="group"><div class="mini"><span>${esc(counts)}</span></div>${rows.map(({ task: x, kind }) => `<div tabindex="0" role="button" class="mini away-row" data-action="open-worker" data-id="${esc(x.workerId ?? '')}"><b>${esc(x.title)}</b><span class="away-m"><span>${esc(x.workerId ?? '')}${x.prUrl ? ` · PR #${prNum(x.prUrl)}` : ''}</span><i class="pill ${pill[kind][0]}">${pill[kind][1]}</i></span></div>`).join('')}${total > rows.length ? `<div class="mini"><span>${t('away.more', { n: total - rows.length })}</span></div>` : ''}</div></div>`;
}

function renderChatInspector() {
  const s = S!;
  const root = $('#chat-ins');
  keepInputs(root, () => {
    const pending = s.decisions.filter((d) => d.status === 'pending');
    const tab = (v: 'inbox' | 'memo' | 'auto', label: string, n = 0) => `<button type="button" role="tab" data-action="ins-tab" data-v="${v}" aria-selected="${ui.insTab === v}"${ui.insTab === v ? ' class="on"' : ''}>${label}${n ? `<span class="count"${v === 'inbox' ? ' id="tab-count"' : ''}>${n}</span>` : ''}</button>`;
    // The inbox tab counts what waits for the user, so a decision is seen from the Memos tab too.
    const tabs = `<div class="segc ins-tabs" role="tablist" aria-label="${t('ins.tabs')}">${tab('inbox', t('ins.tabInbox'), pending.length)}${tab('memo', t('ins.tabMemo'))}${tab('auto', t('ins.tabAuto'))}</div>`;
    if (ui.insTab === 'memo') { root.innerHTML = tabs + memosHtml(); return; }
    if (ui.insTab === 'auto') { root.innerHTML = tabs + autosHtml(); return; }
    // Task outcomes only (s.results). Errors without a task (accounts at their limit, Dispatcher errors) stay in the chat.
    const results = paged('results', s.results.slice().reverse(), PAGE.results);
    const autos = paged('autos', visibleAutos(), PAGE.autos);
    let html = '';
    if (pending.length) html += `<div class="sect" id="sec-dec"><div class="ins-h"><b>${t('ins.decisions')}</b><span class="count" id="dec-count">${pending.length}</span></div><div class="group">${pending.map((d) => decisionHtml(d)).join('')}</div></div>`;
    // Decisions stay on top; what happened meanwhile comes right under them.
    html += awayHtml();
    html += comparisonsHtml();
    if (s.memorySuggestions.length) html += `<div class="sect"><div class="ins-h" title="${esc(t('sug.hint'))}"><b>${t('ins.remember')}</b></div><div class="group">${s.memorySuggestions.map(sugHtml).join('')}</div></div>`;
    if (results.items.length) {
      html += `<div class="sect"><div class="ins-h"><b>${t('ins.results')}</b><span class="gap"></span><button class="clear-x" data-action="clear" data-kind="result" title="${t('ins.clear')}" aria-label="${t('ins.clear')}"><svg><use href="#s-x"/></svg></button></div><div class="group">${results.items.map((c) => {
        const x = task(c.ref);
        const lk = resultLinks(x);
        return `<div class="res"><span class="tile">${resultGlyph(x, c.kind === 'error')}</span><span class="body"><span class="res-t"><b>${esc(x?.title ?? t('task'))}</b><time datetime="${esc(c.ts)}" title="${esc(hhmm(c.ts))}">${when(c.ts)}</time></span>${lk.length ? `<span class="lk">${lk.join('')}</span>` : ''}<span>${inline(oneLine(c.text, 140))}</span>${spendHtml(x?.spend, true)}</span></div>`;
      }).join('')}${results.more}</div></div>`;
    }
    if (autos.items.length) html += `<div class="sect"><div class="ins-h"><b>${t('ins.auto')}</b><span class="gap"></span><button class="clear-x" data-action="clear" data-kind="auto" title="${t('ins.clear')}" aria-label="${t('ins.clear')}"><svg><use href="#s-x"/></svg></button></div><div class="group">${autos.items.map(aaHtml).join('')}${autos.more}</div></div>`;
    if (!html) {
      const busy = s.workers.filter((w) => w.status === 'running' || w.status === 'waiting').length;
      html = `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-check"/></svg><b>${t('ins.clearTitle')}</b>${busy ? `<button class="goto" data-action="view" data-v="worker">${ic('run')}${t('ins.busy', { n: busy })}</button>` : ''}</div>`;
    }
    root.innerHTML = tabs + html;
  });
  syncSegs(root);
}

/** One memo: its text, when it changed, and Share / Edit / Delete, shown while it is hovered or focused. */
function memoHtml(m: Memo) {
  if (ui.memoEdit === m.id) {
    return `<div class="memo"><textarea class="inp" data-keep="memo-${m.id}" aria-label="${t('memo.edit')}">${esc(m.text)}</textarea>
      <div class="btns"><button class="btn" data-action="memo-edit-cancel">${t('cancel')}</button><button class="btn def" data-action="memo-save" data-id="${m.id}">${t('save')}</button></div></div>`;
  }
  const act = (action: string, icon: string, label: string, cls = '') => `<button class="mact${cls}" data-action="${action}" data-id="${m.id}" title="${label}" aria-label="${label}"><svg aria-hidden="true"><use href="#${icon}"/></svg></button>`;
  // One button for both steps, so asking is a change of its width and colour, not a new element.
  const sure = ui.memoDel === m.id;
  const del = `<button class="mact del${sure ? ' sure' : ''}" data-action="memo-remove" data-id="${m.id}" title="${t('memo.remove')}" aria-label="${t(sure ? 'memo.removeSure' : 'memo.remove')}"><svg aria-hidden="true"><use href="#s-x"/></svg><span class="lbl">${t('memo.removeSure')}</span></button>`;
  return `<div class="memo" data-memo="${m.id}"><p>${linkify(esc(m.text))}</p><span class="meta">${m.shared ? sym('s-pin') : ''}<time datetime="${esc(m.updatedAt)}" title="${esc(hhmm(m.updatedAt))}">${when(m.updatedAt)}</time>
    <span class="acts">${act('memo-share', 's-pin', t(m.shared ? 'memo.unshare' : 'memo.share'), m.shared ? ' on' : '')}${act('memo-edit', 's-pencil', t('memo.edit'))}${del}</span></span></div>`;
}

/**
 * Two attempts at one task, side by side in the inbox: each with its Worker and model, where it stands and its
 * report, a way to its changes, and "Use this one" once it has finished. Picking closes the comparison.
 */
function comparisonsHtml() {
  const groups = openComparisons(S!.tasks);
  if (!groups.length) return '';
  const cards = groups.map((g) => `<div class="cmp">${g.tasks.map((x) => {
    const w = worker(x.workerId);
    const cls = x.status === 'failed' && !x.stopped ? ' red' : x.status === 'running' ? ' blue' : x.status === 'done' ? ' green' : '';
    return `<div class="cmp-side"><div class="cmp-h"><b>${esc(x.workerId ?? '')}</b><small>${esc(w ? modelLabel(w.model) : '')}</small><span class="pill${cls}">${taskLabel(x)}</span></div>
      ${x.summary ? `<p>${inline(oneLine(x.summary, 220))}</p>` : ''}${spendHtml(x.spend, true)}
      <div class="cmp-f">${x.workerId ? `<button type="button" class="linkbtn" data-action="cmp-changes" data-id="${esc(x.workerId)}">${t('cmp.changes')}</button>` : ''}<span class="gap"></span><button class="btn def" data-action="cmp-pick" data-id="${esc(x.id)}"${canPick(x) ? '' : ' disabled'}>${t('cmp.pick')}</button></div></div>`;
  }).join('')}</div>`).join('');
  const title = (g: (typeof groups)[number]) => esc(g.tasks[0].title.replace(/ \([^()]*\)$/, ''));
  return `<div class="sect"><div class="ins-h"><b>${t('cmp.title')}</b><small>${groups.length === 1 ? title(groups[0]) : groups.length}</small></div><div class="group">${cards}</div></div>`;
}

/** "Daily 09:00", "Weekdays 09:00", "When a PR merges". */
function triggerLabel(a: Automation) {
  return a.trigger.kind === 'merged' ? t('auto.merged') : t(a.trigger.weekdays ? 'auto.weekdaysAt' : 'auto.dailyAt', { t: a.trigger.time });
}

/** The Automations tab: what to hand the Dispatcher and when, then the ones set up, each with its switch. */
function autosHtml() {
  const daily = ui.autoKind === 'daily';
  const add = `<div class="auto-add"><textarea class="inp" id="auto-prompt" data-keep="auto-prompt" placeholder="${t('auto.prompt')}" aria-label="${t('auto.prompt')}"></textarea>
    <div class="auto-when">${segc('auto-kind', ui.autoKind, [{ value: 'daily', label: t('auto.daily') }, { value: 'merged', label: t('auto.merged') }], t('ins.tabAuto'))}${daily ? `<input class="inp" id="auto-time" data-keep="auto-time" value="09:00" inputmode="numeric" aria-label="${t('auto.time')}">` : ''}</div>
    <div class="auto-when">${daily ? `<label class="auto-wk">${t('auto.weekdays')}<input class="switch" type="checkbox" id="auto-wk"${ui.autoWk ? ' checked' : ''}></label>` : ''}<span class="gap"></span><button class="btn def" data-action="auto-add">${t('auto.add')}</button></div></div>`;
  const list = S!.automations;
  if (!list.length) return `${add}<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-refresh"/></svg><b>${t('auto.empty')}</b></div>`;
  const rows = list.map((a) => {
    const sure = ui.memoDel === a.id;
    const next = a.enabled && a.nextRunAt ? ` · ${t('auto.next', { t: when(a.nextRunAt) })}` : '';
    return `<div class="memo auto${a.enabled ? '' : ' off'}"><p title="${esc(a.prompt)}">${esc(a.title)}</p><span class="meta"><span>${esc(triggerLabel(a))}${esc(next)}</span>
      <span class="acts"><input class="switch" type="checkbox" data-change="auto-toggle" data-id="${a.id}"${a.enabled ? ' checked' : ''} aria-label="${esc(`${t('auto.on')}: ${a.title}`)}"><button class="mact del${sure ? ' sure' : ''}" data-action="auto-remove" data-id="${a.id}" title="${t('memo.remove')}" aria-label="${t(sure ? 'memo.removeSure' : 'memo.remove')}"><svg aria-hidden="true"><use href="#s-x"/></svg><span class="lbl">${t('memo.removeSure')}</span></button></span></span></div>`;
  }).join('');
  return `${add}<div class="sect"><div class="ins-h"><b>${t('ins.tabAuto')}</b><small>${list.length}</small></div><div class="group">${rows}</div></div>`;
}

async function addAuto() {
  const inp = $<HTMLTextAreaElement>('#auto-prompt');
  const prompt = inp?.value.trim();
  if (!prompt) { inp?.focus(); return; }
  let trigger: Automation['trigger'] = { kind: 'merged' };
  if (ui.autoKind === 'daily') {
    const time = parseTime($<HTMLInputElement>('#auto-time')?.value ?? '');
    if (!time) { toast(t('auto.badTime'), true); $<HTMLInputElement>('#auto-time')?.focus(); return; }
    trigger = { kind: 'daily', time, weekdays: ui.autoWk };
  }
  inp.value = '';
  await call('auto:add', prompt, trigger);
}

/** The Memos tab: a field to add one, then the memos shared with agents and the user's own. */
function memosHtml() {
  const { shared, mine } = memoSections(S!.memos);
  const sect = (title: string, list: Memo[]) => list.length ? `<div class="sect"><div class="ins-h"><b>${title}</b><small>${list.length}</small></div><div class="group">${list.map(memoHtml).join('')}</div></div>` : '';
  const add = `<div class="memo-add"><input class="inp" id="memo-new" data-keep="memo-new" data-enter="memo-add" placeholder="${t('memo.add')}" aria-label="${t('memo.add')}"><button class="btn" data-action="memo-add" title="${t('memo.add')}" aria-label="${t('memo.add')}"><svg aria-hidden="true"><use href="#s-plus"/></svg></button></div>`;
  const body = sect(t('memo.shared'), shared) + sect(t('memo.mine'), mine);
  return add + (body || `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-doc"/></svg><b>${t('memo.empty')}</b></div>`);
}

/** Which memo's Delete is asking "Delete it?" (null: none). Changed in place, so the button can animate. */
function askMemoDel(id: string | null) {
  ui.memoDel = id;
  document.querySelectorAll<HTMLElement>('.mact.del').forEach((b) => {
    const on = b.dataset.id === id;
    b.classList.toggle('sure', on);
    b.setAttribute('aria-label', t(on ? 'memo.removeSure' : 'memo.remove'));
  });
}

/** Delete a memo: its row closes up first, then it goes. */
async function removeMemo(id: string) {
  ui.memoDel = null;
  const row = document.querySelector<HTMLElement>(`.memo[data-memo="${CSS.escape(id)}"]`);
  const d = ms('--dur-base');
  if (row && d) {
    row.style.overflow = 'hidden';
    const h = `${row.offsetHeight}px`;
    row.animate([{ height: h, opacity: 1 }, { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px' }], { duration: d, easing: 'cubic-bezier(.2, 0, 0, 1)', fill: 'forwards' });
    // A timer, not the animation's `finished`: that never settles while the window is hidden.
    await new Promise((r) => setTimeout(r, d));
  }
  await call('memo:remove', id);
}

async function addMemo() {
  const inp = $<HTMLInputElement>('#memo-new');
  const text = inp?.value.trim();
  if (!text) { inp?.focus(); return; }
  inp.value = '';
  await call('memo:add', text);
  $<HTMLInputElement>('#memo-new')?.focus();
}

/* ---------- workers ---------- */

function statusPill(w: Worker) {
  const x = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
  switch (w.status) {
    case 'running': case 'starting': return `<span class="pill blue">${x ? ago(x.updatedAt) : t('st.running')}</span>`;
    case 'waiting': return `<span class="pill red">${t('st.waitingMe')}</span>`;
    case 'error': return `<span class="pill red">${t('st.error')}</span>`;
    case 'archived': return `<span class="pill">${t('st.archived')}</span>`;
  }
  if (awaitsDispatcher(x)) return `<span class="pill orange">${t('st.awaitDispatcher')}</span>`;
  if (x?.status === 'blocked') return `<span class="pill orange">${t('st.afterMerge')}</span>`;
  if (x?.status === 'queued') return `<span class="pill orange">${queuedLabel(x)}</span>`;
  if (x?.status === 'pr_open') return `<span class="pill pr-open">${t('st.prOpen')}</span>`;
  return `<span class="pill">${t('time.ago', { d: ago(w.lastActiveAt) })}</span>`;
}

/** The Workers a list filter keeps: ones with a task finished today, or archived ones. */
function filterWorkers(ws: Worker[], f: WorkerFilter | null) {
  if (f === 'archived') return ws.filter((w) => w.status === 'archived');
  if (f === 'today') {
    const ids = new Set(S!.tasks.filter(finishedToday).map((x) => x.workerId));
    return ws.filter((w) => ids.has(w.id));
  }
  return ws;
}

function renderWorkerList() {
  const s = S!;
  const root = $('#wk-list');
  const f = ui.wFilter;
  const shown = filterWorkers(s.workers, f);
  const active = shown.filter((w) => w.status !== 'archived');
  const arch = shown.filter((w) => w.status === 'archived');
  const order = (w: Worker) => (w.status === 'waiting' ? 0 : w.status === 'running' || w.status === 'starting' ? 1 : w.status === 'error' ? 2 : 3);
  active.sort((a, b) => order(a) - order(b) || b.lastActiveAt.localeCompare(a.lastActiveAt));
  arch.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  const li = (w: Worker) => {
    const x = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
    return `<div tabindex="0" role="button" class="li${ui.wSel === w.id ? ' sel' : ''}${w.status === 'archived' ? ' dim' : ''}" data-action="select-worker" data-id="${w.id}">${workerIcon(w)}
      <span class="m"><b>${esc(w.id)} ${esc(x?.title ?? w.title)}</b><span>${esc([w.repo ?? t('general'), modelLabel(w.model), w.accountId && S?.accounts.some((a) => a.id === w.accountId) ? acctLabel(w.accountId) : '', w.statusText && w.status === 'running' ? w.statusText : ''].filter(Boolean).join(', '))}</span></span>
      <span class="r">${w.status !== 'archived' ? ring(w.contextTokens / CONTEXT_WINDOW) + k(w.contextTokens) : ''}${statusPill(w)}</span></div>`;
  };
  if (!s.workers.length) {
    root.innerHTML = `<div class="vhead"><b>Worker</b></div><div class="empty-view">${sym('s-cpu')}<b>${t('wk.emptyTitle')}</b></div>`;
    return;
  }
  // Archived Workers come a page at a time, in every list that has them.
  const archPage = paged('archived', arch, PAGE.archived);
  const archLis = archPage.items.map(li).join('') + archPage.more;
  // Each filter keys its own list, so switching filters starts the new list at the top.
  const lst = `<div class="lst" data-scroll="wk-list-${f ?? 'all'}">`;
  keepScroll(root, () => {
    if (f) {
      // The filter as a chip, with "All" to go back to every Worker.
      const label = t(f === 'today' ? 'side.doneToday' : 'side.archived');
      const head = `<div class="vhead"><b>Worker</b><span class="wf"><span class="wf-chip">${ic(f === 'today' ? 'done' : 'arch')}${label}<small>${shown.length}</small></span><button type="button" class="linkbtn wf-all" data-action="worker-filter" data-v="">${t('wk.filterAll')}</button></span></div>`;
      root.innerHTML = shown.length
        ? `${head}${lst}${active.map(li).join('')}${arch.length && active.length ? `<div class="lst-h">${t('st.archived')}</div>` : ''}${archLis}</div>`
        : `${head}<div class="empty-view">${sym(f === 'today' ? 's-check' : 's-arch')}<b>${t(f === 'today' ? 'wk.noneToday' : 'wk.noneArchived')}</b></div>`;
      return;
    }
    root.innerHTML = `<div class="vhead"><b>Worker</b><small>${t('wk.counts', { a: active.length, b: arch.length })}</small></div>
    ${lst}${active.map(li).join('')}${arch.length ? `<div class="lst-h">${t('st.archived')}</div>${archLis}` : ''}</div>`;
  });
}

/** A Worker's final report starts with RESULT:/PR:/FILE: lines; show them as a result header instead of raw protocol. */
function workerReport(text: string) {
  const lines = text.split('\n');
  const head: string[] = [];
  let i = 0;
  while (i < lines.length && (/^(RESULT|PR|FILE):/i.test(lines[i].trim()) || (head.length && !lines[i].trim()))) { if (lines[i].trim()) head.push(lines[i].trim()); i++; }
  if (!head.some((l) => /^RESULT:/i.test(l))) return md(text);
  const val = (l: string) => l.slice(l.indexOf(':') + 1).trim().replace(/^`|`$/g, '');
  const summary = val(head.find((l) => /^RESULT:/i.test(l))!);
  const pr = head.filter((l) => /^PR:/i.test(l)).map(val).map((v) => v.match(/https?:\/\/\S+\/pull\/\d+/)?.[0]).find(Boolean);
  const files = head.filter((l) => /^FILE:/i.test(l)).map(val).filter(Boolean);
  const links = [
    pr ? `<a tabindex="0" role="link" data-action="open-url" data-href="${esc(pr)}">${sym('s-pr')}PR #${prNum(pr)}</a>` : '',
    ...files.map((f) => `<a tabindex="0" role="link" data-action="open-file" data-path="${esc(f)}" title="${esc(f)}">${sym('s-doc')}${esc(base(f))}</a>`),
  ].filter(Boolean).join('');
  const rest = lines.slice(i).join('\n').trim();
  const title = inline(summary);
  return `<div class="rep-h"><b>${title}</b>${links ? `<span class="rep-l">${links}</span>` : ''}</div>${rest ? md(rest) : ''}`;
}

function logItemHtml(it: WorkerLogItem, wid: string, prev: WorkerLogItem | null) {
  switch (it.from) {
    case 'dispatcher': return `${prev?.from === 'dispatcher' ? '' : '<span class="who">Dispatcher</span>'}${replyable(`<div class="bub ai">${md(it.text)}</div>`, 'ws', 'Dispatcher', it.text)}`;
    case 'worker': return `${prev?.from === 'worker' ? '' : `<span class="who">${esc(wid)}</span>`}${replyable(`<div class="bub wk">${workerReport(it.text)}</div>`, 'ws', wid, it.text)}`;
    case 'user': return `<div class="bub me">${userText(it.text)}</div>`;
    case 'auto': return `<span class="event self">${sym('s-check', 'c-green')}<span>${esc(it.text)}</span></span>`;
    default: return `<span class="event">${sym('s-cpu', 'c-blue')}<span>${esc(it.text)}</span></span>`;
  }
}

/** `older`: a page of the conversation went in above, so the reader's place is kept from the end. */
function renderSession(force = false, older = false) {
  const w = worker(ui.wSel);
  renderReply('ws');
  $('#wk-list').hidden = ui.wOpen && !!w;
  $('#wk-session').hidden = !(ui.wOpen && w);
  if (!ui.wOpen || !w) return;
  const x = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
  $('#ws-title').textContent = `${w.id} ${x?.title ?? w.title}`;
  $('#ws-sub').textContent = [w.repo ?? t('general'), x?.branch, modelLabel(w.model)].filter(Boolean).join(' · ');
  const tabs = w.repo ? (['chat', 'changes', 'summary'] as const) : (['chat', 'summary'] as const);
  if (!w.repo && ui.wTab === 'changes') ui.wTab = 'chat';
  $('#ws-tabs').hidden = false;
  $('#ws-tabs').innerHTML = tabs.map((v) => `<button type="button" role="tab" aria-selected="${ui.wTab === v}" class="${ui.wTab === v ? 'on' : ''}" data-action="ws-tab" data-v="${v}">${t(v === 'chat' ? 'ws.tabChat' : v === 'changes' ? 'ws.tabChanges' : 'ws.tabSummary')}</button>`).join('');
  $('#ws-thread').hidden = ui.wTab !== 'chat';
  $('#ws-diff').hidden = ui.wTab !== 'changes';
  $('#ws-sum').hidden = ui.wTab !== 'summary';
  if (ui.wTab === 'changes') { if (force || !ui.diffs.has(w.id)) renderDiff(w); return; }
  if (ui.wTab === 'summary') { renderSummary(w); return; }
  const log = ui.logs.get(w.id) ?? [];
  const th = $('#ws-thread');
  const nearBottom = th.scrollHeight - th.scrollTop - th.clientHeight < 80;
  // Following the end, a conversation grown past two pages goes back to its last page; scrolling up loads the rest again.
  const cut = threadStart(log.length, 0, PAGE.log, (nearBottom || force) && !older);
  if (cut) { log.splice(0, cut); ui.logFrom.set(w.id, (ui.logFrom.get(w.id) ?? 0) + cut); }
  const start = ui.logFrom.get(w.id) ?? 0;
  const loading = ui.loadingOlder.has(w.id);
  const key = `${lang()}:${w.id}:${start}:${log.length}:${loading}:${w.status}:${w.statusText}`;
  if (!force && !older && key === ui.lastLogKey) return;
  ui.lastLogKey = key;
  let html = start > 0 ? olderBtn('log', loading) : '';
  let last = 0;
  const seen = !older && ui.logSeen?.wid === w.id ? ui.logSeen.n - start : -1;
  log.forEach((it, i) => {
    if (seen > 0 && i === seen) html += NEW_FROM;
    const ts = Date.parse(it.ts);
    const gap = ts - last > 30 * 60_000;
    if (gap) html += `<span class="stamp">${hhmm(it.ts)}</span>`;
    last = ts;
    html += logItemHtml(it, w.id, i > 0 && !gap ? log[i - 1] : null);
  });
  if (!log.length) html = `<div class="empty-view"><span>${t('ws.empty')}</span></div>`;
  if (w.status === 'running' || w.status === 'starting') html += `<div class="typing"><span class="dots"><i></i><i></i><i></i></span>${esc(oneLine(w.statusText, 90))}</div>`;
  ui.logSeen = { wid: w.id, n: start + log.length };
  setThread(th, html, nearBottom || force, older);
  watchTop(th, () => { if (ui.wSel) void olderLog(ui.wSel); });
}

/** A file's diff. Each line takes a click to comment on it; the comments and the one being written sit under their lines. */
function diffLines(wid: string, path: string, patch: string) {
  const key = esc(`${wid}:${path}`);
  const notes = (ui.diffNotes.get(wid) ?? []).filter((n) => n.path === path);
  const draft = ui.diffDraft?.wid === wid && ui.diffDraft.path === path ? ui.diffDraft.at : -1;
  return patchLines(patch).map((l, i) => {
    const c = l.kind === 'ctx' ? '' : l.kind;
    const line = l.kind === 'h'
      ? `<span class="dl h">${esc(l.text) || ' '}</span>`
      : `<span class="dl ${c} can" data-action="diff-note" data-id="${key}" data-i="${i}" title="${t('diff.note')}">${esc(l.text) || ' '}</span>`;
    const said = notes.filter((n) => n.at === i).map((n) => `<div class="dnote"><p>${esc(n.text)}</p><button class="clear-x" data-action="diff-note-del" data-id="${key}" data-i="${i}" title="${t('diff.noteDel')}" aria-label="${t('diff.noteDel')}"><svg><use href="#s-x"/></svg></button></div>`).join('');
    const box = draft === i ? `<div class="dnote edit"><textarea class="inp" id="dnote-in" data-keep="dnote-${key}-${i}" data-enter="diff-note-add" placeholder="${t('diff.note')}" aria-label="${t('diff.note')}"></textarea><div class="btns"><button class="btn" data-action="diff-note-cancel">${t('cancel')}</button><button class="btn def" data-action="diff-note-add">${t('diff.noteAdd')}</button></div></div>` : '';
    return line + said + box;
  }).join('');
}

/** "12m", "1h 5m": how long something took. */
function tookText(mins: number) {
  if (mins < 60) return t('time.min', { n: Math.max(1, mins) });
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${t('time.hour', { n: h })} ${t('time.min', { n: m })}` : t('time.hour', { n: h });
}

/**
 * The Summary tab: what the Worker has done without reading its conversation. Totals first (tasks, PRs, files,
 * spend), then each task, newest first: what was asked, where it stands, its report in full, its PR and files.
 */
function renderSummary(w: Worker) {
  const root = $('#ws-sum');
  const tasks = w.taskIds.map((id) => task(id)).filter((x): x is Task => !!x);
  if (!tasks.length) { root.innerHTML = `<div class="empty-view"><b>${t('sum.none')}</b></div>`; return; }
  const tot = workerTotals(tasks);
  const stat = (label: string, parts: string[]) => `<div class="sum-stat"><small>${label}</small><b>${parts.filter(Boolean).join(' · ') || '–'}</b></div>`;
  const stats = [
    stat(t('sum.tasks'), [tot.done ? t('sum.done', { n: tot.done }) : '', tot.open ? t('sum.open', { n: tot.open }) : '', tot.failed ? t('sum.failed', { n: tot.failed }) : '']),
    stat(t('sum.prs'), [tot.prsOpen ? t('sum.prOpen', { n: tot.prsOpen }) : '', tot.prsMerged ? t('sum.prMerged', { n: tot.prsMerged }) : '']),
    stat(t('sum.files'), [tot.files ? String(tot.files) : '']),
    stat(t('sum.spend'), [hasSpend(tot.spend) ? t('spend.cost', spendVars(tot.spend)) : '']),
  ].join('');
  const cards = tasks.slice().reverse().map((x) => {
    const mins = taskMinutes(x);
    const meta = [x.finishedAt ? hhmm(x.finishedAt) : x.startedAt ? hhmm(x.startedAt) : '', mins !== null ? t('sum.took', { t: tookText(mins) }) : ''].filter(Boolean).join(' · ');
    const links = resultLinks(x);
    const cls = x.status === 'failed' && !x.stopped ? ' red' : x.status === 'running' ? ' blue' : x.status === 'pr_open' ? ' pr-open' : x.status === 'done' ? ' green' : '';
    return `<article class="sum-task">
      <header><b>${esc(x.id)} ${esc(x.title)}</b><span class="pill${cls}">${taskLabel(x)}</span></header>
      ${meta ? `<small class="sum-meta">${esc(meta)}</small>` : ''}
      <details class="sum-ask"><summary><svg aria-hidden="true"><use href="#s-chev"/></svg>${t('sum.asked')}</summary><div class="sum-prompt">${esc(x.prompt.trim())}</div></details>
      ${x.summary ? `<div class="sum-report">${md(x.summary)}</div>` : ''}
      ${links.length ? `<div class="sum-links">${links.join('')}</div>` : ''}
      ${spendHtml(x.spend)}
    </article>`;
  }).join('');
  keepScroll(root, () => {
    const open = new Set([...root.querySelectorAll<HTMLDetailsElement>('details[open]')].map((d) => d.closest('article')?.querySelector('header b')?.textContent ?? ''));
    root.innerHTML = `<div class="sum-stats">${stats}</div>${cards}`;
    root.querySelectorAll<HTMLDetailsElement>('details').forEach((d) => { if (open.has(d.closest('article')?.querySelector('header b')?.textContent ?? '')) d.open = true; });
  });
}

/** "Put the files back to 14:02?" under the Changes tab's header, once a checkpoint is picked. */
function ckptAskHtml(w: Worker) {
  const a = ui.ckptAsk;
  if (!a || a.wid !== w.id) return '';
  return `<div class="ckpt-ask" role="alertdialog" aria-label="${t('ckpt.title')}"><span><b>${esc(t('ckpt.ask', { t: hhmm(a.at) }))}</b><small>${esc(a.label)}</small></span><button class="btn" data-action="ckpt-cancel">${t('cancel')}</button><button class="btn danger-fill" data-action="ckpt-restore">${t('ckpt.restore')}</button></div>`;
}

/** The Worker's checkpoints as a list under the button: picking one asks before anything changes. */
async function openCheckpoints(owner: HTMLElement, wid: string) {
  const list = (await call<Checkpoint[]>('worker:checkpoints', wid)) ?? [];
  if (!list.length) { toast(t('ckpt.none')); return; }
  openPop(owner, list.map((c) => ({ value: c.ref, label: c.label || t('ckpt.title'), sub: hhmm(c.at) })), '', (ref) => {
    const c = list.find((x) => x.ref === ref);
    const w = worker(wid);
    if (!c || !w) return;
    ui.ckptAsk = { wid, ref, at: c.at, label: c.label };
    renderDiff(w);
  }, 300);
}

/** Keep the comment being written as one of the Worker's review comments. */
function addDiffNote() {
  const d = ui.diffDraft;
  const text = $<HTMLTextAreaElement>('#dnote-in')?.value.trim();
  const w = worker(ui.wSel);
  if (!d || !w) return;
  const v = ui.diffs.get(d.wid);
  const line = v && v !== 'loading' ? patchLines(v.files.find((f) => f.path === d.path)?.patch ?? '')[d.at] : undefined;
  ui.diffDraft = null;
  if (text && line) ui.diffNotes.set(d.wid, [...(ui.diffNotes.get(d.wid) ?? []), { path: d.path, at: d.at, no: line.no, code: line.text, text }]);
  renderDiff(w);
}

function renderDiff(w: Worker) {
  const root = $('#ws-diff');
  const v = ui.diffs.get(w.id);
  if (v === undefined) { void loadDiff(w.id); }
  if (v === undefined || v === 'loading') { root.innerHTML = `<div class="skel-list" role="status" aria-label="${t('diff.loading')}">${skel(3, 'file')}</div>`; return; }
  if (v === null) { root.innerHTML = `<div class="empty-view"><span>${t('diff.noRepo')}</span></div>`; return; }
  if (v.error) { root.innerHTML = `<div class="empty-view"><span>${t('diff.missing')}</span></div>`; return; }
  const add = v.files.reduce((n, f) => n + f.added, 0), del = v.files.reduce((n, f) => n + f.removed, 0);
  const nNotes = ui.diffNotes.get(w.id)?.length ?? 0;
  const head = `<div class="diff-h"><span class="br">${esc(v.branch || 'HEAD')} <small>→ ${esc(v.base)}</small></span><span class="sum">${t('diff.files', { n: v.files.length })} <b class="plus">+${add}</b> <b class="minus">−${del}</b></span>${nNotes ? `<button class="btn def" data-action="diff-notes-send">${t('diff.noteSend', { n: nNotes })}</button>` : ''}<button class="btn" data-action="ckpt-menu" data-id="${w.id}" aria-haspopup="listbox">${t('ckpt.title')}</button><button class="btn" data-action="diff-refresh" data-id="${w.id}">${t('diff.refresh')}</button></div>`;
  if (!v.files.length) { root.innerHTML = `${head}${ckptAskHtml(w)}<div class="empty-view"><span>${t('diff.none', { base: v.base })}</span></div>`; return; }
  const files = v.files.map((f) => {
    const key = `${w.id}:${f.path}`;
    const open = ui.diffOpen.has(key);
    const st = f.status === '?' ? 'A' : f.status;
    return `<div class="df${open ? ' open' : ''}">
      <button class="df-h" data-action="diff-file" data-id="${esc(key)}" aria-expanded="${open}"><svg class="chev" aria-hidden="true"><use href="#s-chev"/></svg><span class="st st-${st}">${st}</span><span class="p" title="${esc(f.path)}">${esc(f.path)}</span>${f.status === '?' ? `<small>${t('diff.untracked')}</small>` : ''}<span class="n"><b class="plus">+${f.added}</b> <b class="minus">−${f.removed}</b></span></button>
      ${open ? `<pre class="df-b" data-scroll="diff-${esc(key)}">${f.patch ? diffLines(w.id, f.path, f.patch) : `<span class="dl h">${t('diff.binary')}</span>`}</pre>` : ''}
    </div>`;
  }).join('');
  keepInputs(root, () => { root.innerHTML = `${head}${ckptAskHtml(w)}${v.truncated ? `<div class="diff-note">${t('diff.truncated')}</div>` : ''}<div class="dfs">${files}</div>`; });
}

async function loadDiff(id: string) {
  if (ui.diffs.get(id) === 'loading') return;
  ui.diffs.set(id, 'loading');
  const v = await call<DiffView | null>('worker:diff', id);
  ui.diffs.set(id, v ?? null);
  const w = worker(id);
  if (w && ui.wSel === id && ui.wTab === 'changes') renderDiff(w);
}

/** A Worker's conversation opens on its last page. */
async function loadLog(id: string) {
  const r = await call<LogPage>('worker:log', id, { limit: PAGE.log });
  if (r) { ui.logs.set(id, r.items); ui.logFrom.set(id, r.start); }
  renderSession(true);
}

/** Load the page of a Worker's conversation before the first one loaded. */
async function olderLog(id: string) {
  const from = ui.logFrom.get(id) ?? 0;
  if (!from || !ui.logs.has(id) || ui.loadingOlder.has(id)) return;
  ui.loadingOlder.add(id);
  markLoading($('#ws-thread'));
  const r = await call<LogPage>('worker:log', id, { before: from, limit: PAGE.log });
  ui.loadingOlder.delete(id);
  // No answer: as in olderChat, the button stays for the next try.
  if (!r) { unmarkLoading($('#ws-thread')); return; }
  const log = ui.logs.get(id);
  // Reloaded or cut meanwhile, the page no longer joins what is loaded; scrolling up asks again.
  if (log && ui.logFrom.get(id) === from) {
    ui.logs.set(id, [...r.items, ...log]);
    ui.logFrom.set(id, r.start);
  }
  if (ui.view === 'worker' && ui.wOpen && ui.wSel === id && ui.wTab === 'chat') renderSession(false, true);
}

/** What the "why it waits" rules (shared/queueWhy.ts) read from the state. */
function queueCtx(): QueueCtx {
  return { tasks: S!.tasks, accounts: S!.accounts, maxWorkers: S!.settings.maxWorkers, time: (ms) => hhmm(new Date(ms).toISOString()) };
}

/** One card per queued or blocked task of the Worker: why it waits, what starts it, its request and the tasks waiting on it. */
function waitingCardsHtml(w: Worker) {
  const ctx = queueCtx();
  return w.taskIds.map((id) => task(id)).filter((x): x is Task => !!x && isQueued(x)).map((x) => {
    const q = queueWhy(t, x, ctx);
    if (!q) return '';
    const dep = x.status === 'blocked' ? task(x.afterTaskId) : null;
    const followers = followersOf(ctx.tasks, x.id);
    // A request that only repeats the title says nothing new.
    const prompt = x.prompt.trim() === x.title.trim() ? '' : x.prompt.trim();
    const long = prompt.length > 240 || prompt.split('\n').length > 4;
    const open = ui.qOpen.has(x.id);
    const links = [
      long ? `<button data-action="queue-prompt" data-id="${esc(x.id)}" aria-expanded="${open}">${t(open ? 'plan.hide' : 'plan.details')}<span aria-hidden="true">${open ? '▴' : '▾'}</span></button>` : '',
      dep?.workerId && dep.workerId !== w.id ? `<button data-action="open-worker" data-id="${esc(dep.workerId)}">${t('q.openDep', { id: dep.id })}<span aria-hidden="true">→</span></button>` : '',
      `<button class="danger" data-action="task-cancel" data-id="${esc(x.id)}">${t('cancel.task')}</button>`,
    ].join('');
    const follow = followers.map((f) => `<button type="button" class="linkbtn" data-action="open-worker" data-id="${esc(f.workerId ?? '')}"${f.workerId ? '' : ' disabled'}>${esc(f.id)} ${esc(oneLine(f.title, 60))}</button>`).join('<br>');
    return `<div class="ins-h"><b>${t('q.title')}</b><span class="pill orange">${x.status === 'blocked' ? t('st.afterMerge') : queuedLabel(x)}</span></div>
    <div class="group qcard">
      <div class="mini"><b>${esc(x.id)} ${esc(x.title)}</b><span>${esc([x.repo ?? t('general'), x.planFirst && !x.planApproved ? t('plan.badge') : ''].filter(Boolean).join(' · '))} · <time datetime="${esc(x.updatedAt)}" title="${esc(hhmm(x.updatedAt))}">${t('q.since', { t: Date.now() - Date.parse(x.updatedAt) < 60_000 ? t('time.now') : t('time.ago', { d: ago(x.updatedAt) }) })}</time></span></div>
      <dl class="plan-sum q-sum"><dt>${t('q.why')}</dt><dd>${esc(q.why)}</dd><dt>${t('q.starts')}</dt><dd${q.cancelled ? ' class="warn"' : ''}>${esc(q.starts)}</dd>${q.again ? `<dt></dt><dd>${esc(q.again)}</dd>` : ''}</dl>
      ${prompt ? `<div class="q-prompt${long && !open ? ' clip' : ''}" data-scroll="qp-${esc(x.id)}"><small>${t('q.prompt')}</small>${esc(prompt)}</div>` : ''}
      ${follow ? `<div class="q-follow"><small>${t('q.followers')}</small>${follow}</div>` : ''}
      <div class="plan-links q-links">${links}</div>
    </div>`;
  }).join('');
}

/** The repository's run command in this Worker's worktree: start and stop it, the address it printed, and the end of its output. */
function runHtml(w: Worker) {
  const repo = w.repo ? S!.repos.find((r) => r.name === w.repo) : null;
  if (!repo?.run?.trim() || w.status === 'archived') return '';
  const r = S!.runs.find((x) => x.workerId === w.id);
  const state = !r ? '' : r.running ? `<span class="pill blue">${t('run.running')}</span>` : r.stopped ? `<span class="pill">${t('run.stopped')}</span>` : `<span class="pill${r.code ? ' red' : ''}">${t('run.exited', { code: r.code ?? '' })}</span>`;
  const btns = r?.running
    ? `<button class="btn" data-action="run-stop" data-id="${w.id}">${t('run.stop')}</button>`
    : `${r ? `<button class="btn" data-action="run-clear" data-id="${w.id}">${t('run.clear')}</button>` : ''}<button class="btn" data-action="run-start" data-id="${w.id}">${t(r ? 'run.again' : 'run.start')}</button>`;
  const url = r?.url && r.running ? `<a class="run-url" tabindex="0" role="link" data-action="open-url" data-href="${esc(r.url)}">${esc(r.url)}</a>` : '';
  const out = r?.tail.trim() ? `<pre class="run-out" data-scroll="run-${w.id}">${esc(lastLines(r.tail, 14))}</pre>` : '';
  return `<div class="ins-h"><b>${t('run.title')}</b>${state}</div>
    <div class="group run"><code class="run-cmd" title="${esc(repo.run)}">${esc(oneLine(repo.run, 80))}</code>${url}${out}<div class="ins-act">${btns}</div></div>`;
}

function renderWorkerInspector() {
  const root = $('#wk-ins');
  const w = worker(ui.wSel);
  if (!w) {
    root.innerHTML = `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-cpu"/></svg><b>${t('wk.pickTitle')}</b></div>`;
    return;
  }
  const tasks = w.taskIds.map((id) => task(id)).filter(Boolean).reverse() as Task[];
  const cur = tasks[0];
  const open = workerDecisions(S!.decisions, w.id);
  // While one is open, the composer answers it (decision 93); its hint says how.
  const ph = open[0] ? decisionHint(open[0]) : '';
  const inp = $<HTMLTextAreaElement>('#ws-input');
  if (inp.placeholder !== ph) inp.placeholder = ph;
  const asked = awaitsDispatcher(cur);
  const pillCls = w.status === 'running' ? 'blue' : w.status === 'waiting' || w.status === 'error' ? 'red' : asked ? 'orange' : '';
  const stKey: Record<string, Key> = { running: 'st.running', starting: 'st.starting', waiting: 'st.waitingMe', idle: 'st.idle', error: 'st.error', archived: 'st.archived' };
  keepScroll(root, () => { root.innerHTML = `
    ${open.length ? `<div class="ins-h"><b>${t('ins.decisions')}</b><span class="count">${open.length}</span></div><div class="group">${open.map((d) => decisionHtml(d, true)).join('')}</div>` : ''}
    <div class="ins-h"><b>${esc(w.id)}</b><span class="pill ${pillCls}">${t(asked ? 'st.awaitDispatcher' : stKey[w.status] ?? 'st.idle')}</span></div>
    ${waitingCardsHtml(w)}
    <div class="group kv">
      <span>${t('kv.task')}</span><span>${esc(cur?.title ?? w.title)}</span>
      <span>${t('kv.repo')}</span><span>${esc(w.repo ?? t('general'))}</span>
      ${cur?.branch ? `<span>${t('kv.branch')}</span><span>${esc(cur.branch)}</span>` : ''}
      ${cur?.status === 'blocked' ? `<span>${t('kv.startsAfter')}</span><span>${esc(cur.afterTaskId ?? '')} ${t('pr.merged')}</span>` : ''}
      <span>${t('kv.folder')}</span><span><a tabindex="0" role="link" data-action="reveal" data-path="${esc(w.cwd)}" title="${esc(w.cwd)}">${esc(base(w.cwd))}</a></span>
      <span>${t('kv.model')}</span><span>${modelLabel(w.model)} · ${t(`effort.${(S!.settings.effortPerTask && cur?.effort) || S!.settings.workerEffort}` as Key)}</span>
      <span>${t('kv.account')}</span><span>${esc(acctLabel(w.accountId))}</span>
      <span>${t('kv.context')}</span><span>${k(w.contextTokens)} / ${k(CONTEXT_WINDOW)}</span>
      ${w.statusText && (w.status === 'running' || w.status === 'waiting' || w.status === 'error') ? `<span>${t('kv.now')}</span><span>${esc(oneLine(w.statusText, 140))}</span>` : ''}
      ${w.request && w.status !== 'archived' ? `<span>${t('kv.request')}</span><span title="${esc(w.request.text)}">${esc(oneLine(w.request.text, 140))}</span>` : ''}
    </div>
    ${runHtml(w)}
    <div class="ins-h"><b>${t('wk.tasks')}</b><small>${tasks.length}</small></div>
    <div class="group">${tasks.map((x) => `<div class="mini"><b>${esc(x.id)} ${esc(x.title)}</b><span>${taskLabel(x)}${isQueued(x) ? ` · <button type="button" class="linkbtn danger" data-action="task-cancel" data-id="${esc(x.id)}">${t('cancel.task')}</button>` : ''}${x.planFirst && !x.planApproved ? ` · ${t('plan.badge')}` : ''}${x.prUrl ? ` · <a tabindex="0" role="link" data-action="open-url" data-href="${esc(x.prUrl)}">PR #${prNum(x.prUrl)}${x.prState === 'MERGED' ? ` ${t('pr.merged')}` : ''}</a> ${prBadges(x)}` : ''}${x.files.map((f) => ` · <a tabindex="0" role="link" data-action="open-file" data-path="${esc(f)}">${esc(base(f))}</a>`).join('')}</span>${x.summary ? `<span>${esc(oneLine(x.summary, 160))}</span>` : ''}</div>`).join('') || `<div class="mini"><span>${t('none')}</span></div>`}</div>
    <div class="ins-act">
      ${w.status === 'running' || w.status === 'waiting' ? `<button class="btn" data-action="worker-stop" data-id="${w.id}">${t('wk.stop')}</button>` : ''}
      ${w.status === 'archived' ? `<button class="btn" data-action="worker-unarchive" data-id="${w.id}">${t('wk.restore')}</button>` : `<button class="btn" data-action="worker-archive" data-id="${w.id}">${t('wk.archive')}</button>`}
      <button class="btn def" data-action="worker-msg" data-id="${w.id}">${t('wk.message')}</button>
    </div>`; });
}

/* ---------- cancelling queued tasks ---------- */

/** Ask before cancelling: what goes, what only loses its queued work, and which waiting tasks go with it. */
function renderCancelDialog() {
  const root = $('#dlg');
  const ask = ui.cancelAsk;
  // The whole queue as it is now, so a task queued while the dialog is open is listed too.
  const set = ask && S ? cancelSet(S.tasks, ask.all ? S.tasks.filter(isQueued).map((x) => x.id) : ask.ids) : null;
  if (!ask || !set?.picked.length) {
    // Nothing left to ask about (closed, or the task started or was cancelled meanwhile).
    ui.cancelAsk = null;
    root.hidden = true;
    root.innerHTML = '';
    root.dataset.key = '';
    return;
  }
  const list = (xs: Task[]) => {
    const shown = xs.slice(0, 5);
    return `<ul class="dlg-list">${shown.map((x) => `<li>${esc(x.title)}</li>`).join('')}${xs.length > shown.length ? `<li class="more">${t('cancel.more', { n: xs.length - shown.length })}</li>` : ''}</ul>`;
  };
  let title: string, body: string, ok: string;
  if (ask.all) {
    title = t('cancel.allTitle');
    body = `<p>${t('cancel.allBody', { n: set.picked.length })}</p>${list(set.picked)}`;
    ok = t('cancel.allOk');
  } else {
    const x = set.picked[0];
    const st = statusAfterCancel(x);
    title = t('cancel.title', { title: x.title });
    body = `<p>${t(st === 'pr_open' ? 'cancel.bodyPr' : st === 'done' ? 'cancel.bodyFollowup' : 'cancel.body')}</p>${set.followers.length ? `<p>${t('cancel.followers')}</p>${list(set.followers)}` : ''}`;
    ok = t('cancel.ok');
  }
  // State updates arrive often; re-render only when the content changes, so focus stays put.
  const key = JSON.stringify([title, body, ok]);
  if (!root.hidden && root.dataset.key === key) return;
  const opening = root.hidden;
  root.dataset.key = key;
  root.innerHTML = `<div class="dlg-back" data-action="cancel-dismiss"></div>
  <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="cdlg-t">
    <h2 id="cdlg-t">${esc(title)}</h2>${body}
    <div class="dlg-btns"><button class="btn" data-action="cancel-dismiss">${t('cancel.keep')}</button><button class="btn danger-fill" data-action="cancel-ok">${esc(ok)}</button></div>
  </div>`;
  root.classList.toggle('opening', root.hidden === true);
  root.hidden = false;
  if (opening) root.querySelector<HTMLButtonElement>('.dlg-btns .btn')?.focus();
}

async function confirmCancel() {
  const ask = ui.cancelAsk;
  ui.cancelAsk = null;
  renderCancelDialog();
  if (!ask) return;
  const rs = ask.all ? await call<CancelReport[]>('queue:clear') : await call<CancelReport[]>('task:cancel', ask.ids[0]);
  if (rs?.length) toast(rs.some((r) => r.kept) ? t('toast.cancelKept') : t('toast.cancelled', { n: rs.length }));
}

/* ---------- repositories ---------- */

/* ---------- Jira issues assigned to the user (decision 125) ---------- */

let jira: undefined | 'loading' | JiraIssue[] | { error: string };
const jiraOn = () => !!S && !!jiraBase(S.settings.jiraUrl) && S.settings.jiraTokenSet;

async function loadJira() {
  jira = 'loading';
  try {
    jira = (await ide.call<JiraIssue[]>('jira:issues')) ?? [];
  } catch (e) {
    jira = { error: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  }
  if (ui.view === 'repo') renderRepos();
}

/** Under the repository list: the user's open Jira issues, each with a button that hands it to the Dispatcher. */
function jiraHtml() {
  if (!jiraOn()) return '';
  if (jira === undefined) void loadJira();
  const refresh = `<button class="clear-x always" data-action="jira-refresh" title="${t('diff.refresh')}" aria-label="${t('diff.refresh')}"><svg><use href="#s-refresh"/></svg></button>`;
  const head = (n: string) => `<div class="jira-h"><b>Jira</b>${n ? `<small>${n}</small>` : ''}<span class="gap"></span>${refresh}</div>`;
  if (jira === undefined || jira === 'loading') return `${head('')}<div class="jira-list" role="status" aria-label="${t('issue.loading')}">${skel(3, 'file')}</div>`;
  if (!Array.isArray(jira)) return `${head('')}<div class="jira-list"><div class="jira-msg err">${esc(jira.error)}</div></div>`;
  if (!jira.length) return `${head('0')}<div class="jira-list"><div class="jira-msg">${t('jira.none')}</div></div>`;
  const list = paged('jira', jira, 8);
  return `${head(String(jira.length))}<div class="jira-list">${list.items.map((i) => `<div class="li jira">${ic('doc')}<span class="m"><b><a tabindex="0" role="link" data-action="open-url" data-href="${esc(i.url)}">${esc(i.key)}</a> ${esc(i.summary)}</b><span>${esc([i.type, i.updatedAt ? when(i.updatedAt) : ''].filter(Boolean).join(' · '))}</span></span>
    <span class="r">${i.status ? `<span class="pill">${esc(i.status)}</span>` : ''}<button class="btn" data-action="jira-assign" data-id="${esc(i.key)}">${t('issue.assign')}</button></span></div>`).join('')}${list.more}</div>`;
}

function renderRepos() {
  const s = S!;
  const main = $('#repo-main');
  const addBtn = (cls: string) => `<button class="btn ${cls}" data-action="repo-add-open"${ui.repoAdd ? ' disabled' : ''}>${t('repo.add')}</button>`;
  if (!s.repos.length) {
    main.innerHTML = `<div class="vhead"><b>${t('nav.repo')}</b></div><div class="empty-view">${sym('s-box')}<b>${t('repo.emptyTitle')}</b>${addBtn('def')}</div>${jiraHtml()}`;
  } else keepScroll(main, () => {
    main.innerHTML = `<div class="vhead"><b>${t('nav.repo')}</b><span class="vhead-r"><small>${s.repos.length}</small>${addBtn('')}</span></div><div class="lst" data-scroll="repo-list">${s.repos.map((r) => {
      const ts = s.tasks.filter((x) => x.repo === r.name);
      const run = ts.filter((x) => x.status === 'running' || x.status === 'waiting').length;
      const pr = prsInReview(ts).length;
      return `<div tabindex="0" role="button" class="li${ui.repoSel === r.name ? ' sel' : ''}" data-action="repo-select" data-id="${esc(r.name)}">${ic('repo', 'box')}<span class="m"><b>${esc(r.name)}</b><span>${esc(r.description || r.url)}</span></span><span class="r">${run ? `<span class="pill blue">${t('repo.running', { n: run })}</span>` : ''}${pr ? `<span class="pill pr-open">PR ${pr}</span>` : ''}</span></div>`;
    }).join('')}${jiraHtml()}</div>`;
  });
  const ins = $('#repo-ins');
  if (ui.repoAdd) { keepInputs(ins, () => { ins.innerHTML = repoAddHtml(); }); return; }
  const r = s.repos.find((x) => x.name === ui.repoSel) ?? null;
  if (!r) {
    ins.innerHTML = `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-box"/></svg><b>${t('repo.pick')}</b></div>`;
    return;
  }
  keepInputs(ins, () => {
    const all = s.tasks.filter((x) => x.repo === r.name).reverse();
    const ts = paged(`repo-tasks:${r.name}`, all, PAGE.repoTasks);
    ins.innerHTML = `<div class="ins-h"><b>${esc(r.name)}</b></div>
      <div class="group kv"><span>${t('kv.path')}</span><span><a tabindex="0" role="link" data-action="reveal" data-path="${esc(r.path)}" title="${esc(r.path)}">${esc(shortPath(r.path))}</a></span><span>${t('kv.url')}</span><span title="${esc(r.url)}">${esc(shortPath(r.url))}</span><span>${t('kv.defaultBranch')}</span><span>${esc(r.defaultBranch)}</span></div>
      <div class="ins-h"><b>${t('repo.desc')}</b></div>
      <textarea class="inp" data-keep="repo-desc-${esc(r.name)}" data-scroll="repo-desc-${esc(r.name)}" id="repo-desc">${esc(r.description)}</textarea>
      <div class="ins-h"><b>${t('repo.setup')}</b></div>
      <textarea class="inp mono" rows="2" spellcheck="false" data-keep="repo-setup-${esc(r.name)}" data-scroll="repo-setup-${esc(r.name)}" id="repo-setup" placeholder="${esc(t('repo.setupPh'))}">${esc(r.setup ?? '')}</textarea>
      <div class="ins-h"><b>${t('repo.run')}</b></div>
      <textarea class="inp mono" rows="2" spellcheck="false" data-keep="repo-run-${esc(r.name)}" data-scroll="repo-run-${esc(r.name)}" id="repo-run" placeholder="${esc(t('repo.runPh'))}">${esc(r.run ?? '')}</textarea>
      <div class="ins-act"><button class="btn" data-action="repo-save" data-id="${esc(r.name)}">${t('repo.save')}</button></div>
      ${issuesHtml(r)}
      <div class="ins-h"><b>${t('wk.tasks')}</b><small>${all.length}</small></div>
      <div class="group">${ts.items.map((x) => `<div class="mini"><b>${esc(x.title)}</b><span>${esc(x.workerId ?? '')} · ${taskLabel(x)}${x.prUrl ? ` · <a tabindex="0" role="link" data-action="open-url" data-href="${esc(x.prUrl)}">PR #${prNum(x.prUrl)}</a>` : ''}</span></div>`).join('') || `<div class="mini"><span>${t('none')}</span></div>`}${ts.more}</div>
      <div class="ins-act"><button class="btn danger" data-action="repo-remove" data-id="${esc(r.name)}">${t('repo.remove')}</button></div>`;
  });
}

/** A GitHub repository's open issues, each with a button that hands it to the Dispatcher as a task. */
function issuesHtml(r: Repo) {
  if (!ghRepoRef(r.url)) return '';
  const v = ui.issues.get(r.name);
  if (v === undefined) { void loadIssues(r.name); }
  const refresh = `<button class="clear-x always" data-action="issues-refresh" data-id="${esc(r.name)}" title="${t('diff.refresh')}" aria-label="${t('diff.refresh')}"><svg><use href="#s-refresh"/></svg></button>`;
  const head = (n: string) => `<div class="ins-h"><b>${t('issue.title')}</b>${n ? `<small>${n}</small>` : ''}<span class="gap"></span>${refresh}</div>`;
  if (v === undefined || v === 'loading') return `${head('')}<div class="group" role="status" aria-label="${t('issue.loading')}">${skel(3, 'mini')}</div>`;
  if (!Array.isArray(v)) return `${head('')}<div class="group"><div class="mini"><span class="err" title="${esc(v.error)}">${t('issue.err')}</span></div></div>`;
  if (!v.length) return `${head('0')}<div class="group"><div class="mini"><span>${t('issue.none')}</span></div></div>`;
  const list = paged(`issues:${r.name}`, v, 6);
  return `${head(String(v.length))}<div class="group">${list.items.map((i) => `<div class="mini issue"><b><a tabindex="0" role="link" data-action="open-url" data-href="${esc(i.url)}">#${i.number}</a> ${esc(i.title)}</b>
    <span class="issue-f"><span class="lbls">${i.labels.slice(0, 3).map((l) => `<i class="pill">${esc(l)}</i>`).join('')}</span><button class="btn" data-action="issue-assign" data-id="${esc(r.name)}" data-n="${i.number}">${t('issue.assign')}</button></span></div>`).join('')}${list.more}</div>`;
}

async function loadIssues(name: string) {
  ui.issues.set(name, 'loading');
  try {
    const v = await ide.call<Issue[] | null>('repo:issues', name);
    ui.issues.set(name, v ?? []);
  } catch (e) {
    ui.issues.set(name, { error: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || t('issue.err') });
  }
  if (ui.view === 'repo') renderRepos();
}

/** The add form: what to register (cloned unless it is a local folder) and its description, sent to repo:add. */
function repoAddHtml() {
  const off = ui.repoAdding ? ' disabled' : '';
  return `<div class="ins-h"><b>${t('repo.add')}</b></div>
    <div class="repo-add-row"><input class="inp" id="repo-add-url" data-keep="repo-add-url" data-enter="repo-add" placeholder="${esc(t('repo.addUrl'))}" aria-label="${esc(t('repo.addUrl'))}" spellcheck="false"${off}><button class="btn" data-action="repo-add-pick"${off}>${t('repo.pickFolder')}</button></div>
    <div class="ins-h"><b>${t('repo.desc')}</b></div>
    <textarea class="inp" id="repo-add-desc" data-keep="repo-add-desc" placeholder="${esc(t('repo.addDescPh'))}"${off}></textarea>
    <div class="ins-act"><button class="btn" data-action="repo-add-cancel"${off}>${t('cancel')}</button><button class="btn def" data-action="repo-add"${off}>${t(ui.repoAdding ? 'repo.adding' : 'repo.addGo')}</button></div>`;
}

async function addRepo() {
  const inp = $<HTMLInputElement>('#repo-add-url');
  const url = inp.value.trim();
  if (!url) { inp.focus(); return; }
  if (ui.repoAdding) return;
  ui.repoAdding = true;
  renderRepos();
  const r = await call<{ name: string }>('repo:add', url, undefined, $<HTMLTextAreaElement>('#repo-add-desc').value);
  ui.repoAdding = false;
  if (!r) { renderRepos(); return; }
  ui.repoAdd = false;
  toast(t('repo.added', { name: r.name }));
  go({ repoSel: r.name });
  renderRepos();
}

/* ---------- memory ---------- */

/** What the last sync with the remote did: "Synced, 2m, 3 in · 1 out", or the failure and the commits that wait. */
function memSyncDetail() {
  const m = S!.memorySync;
  if (m.state === 'error') return m.pending ? t('mem.sync.pending', { n: m.pending }) : '';
  if (m.state !== 'ok' || !m.at) return '';
  return m.pulled || m.pushed ? `${ago(m.at)} · ${t('mem.sync.counts', { in: m.pulled, out: m.pushed })}` : ago(m.at);
}

/** The sync status in Settings (a row under the remote's address) and in the Memory view's header (a pill). */
function renderMemSync() {
  const m = S!.memorySync;
  const detail = memSyncDetail();
  const pill = $('#mem-sync');
  if (pill) {
    const tone = m.state === 'ok' ? ' green' : m.state === 'error' ? ' orange' : m.state === 'syncing' ? ' blue' : '';
    const label = !m.remote ? t('mem.sync.off') : m.state === 'off' ? '' : t(`mem.sync.${m.state}` as Key);
    pill.innerHTML = label ? `<span class="pill${tone}"${m.error ? ` title="${esc(m.error)}"` : ''}>${esc(detail ? `${label} · ${detail}` : label)}</span>` : '';
  }
  const row = document.getElementById('set-msync');
  if (!row) return;
  row.hidden = !m.remote || m.state === 'off';
  if (row.hidden) { row.innerHTML = ''; return; }
  const glyph = m.state === 'ok' ? sym('s-check', 'c-green') : m.state === 'error' ? sym('s-alert', 'c-orange') : ic('run');
  const busy = m.state === 'syncing';
  row.innerHTML = `<div class="srow"><span class="msync${m.state === 'error' ? ' bad' : ''}">${glyph}<b>${t(`mem.sync.${m.state}` as Key)}</b><span>${esc(detail)}</span></span><button class="btn" data-action="mem-sync"${busy ? ' disabled' : ''}>${t(m.state === 'error' ? 'mem.sync.retry' : 'mem.sync.now')}</button></div>${m.error ? `<div class="msync-err">${esc(m.error)}</div>` : ''}`;
}

async function loadMemory() {
  ui.memFiles = (await call<MemoryFile[]>('memory:list')) ?? [];
  renderMemory();
}

/** Search memory: a new query's first page, or (`offset`, the hits shown) the page after them. */
async function searchMem(q: string, offset = 0) {
  ui.memQ = q;
  if (!q) { ui.memHits = null; ui.memTotal = 0; renderMemory(); return; }
  const r = await call<MemoryHits>('memory:search', q, offset);
  // A newer query, or the same page asked twice: this answer is stale.
  if (ui.memQ !== q || (offset && offset !== ui.memHits?.length)) return;
  // Each page is a fresh search, so a memory file edited between pages can shift a hit into the next page: skip repeats.
  const kept = offset ? ui.memHits ?? [] : [];
  const seen = new Set(kept.map((h) => `${h.path}:${h.line}`));
  ui.memHits = [...kept, ...(r?.hits ?? []).filter((h) => !seen.has(`${h.path}:${h.line}`))];
  ui.memTotal = r?.total ?? ui.memHits.length;
  if (!offset) scrollQuietly($('#mem-list'), 0);
  renderMemory();
}

function memIcon(kind: MemoryFile['kind']) {
  return kind === 'preference' ? ic('pref', 'star') : kind === 'repo' ? ic('repo', 'box') : kind === 'decision' ? ic('done') : ic('doc', 'doc');
}

function renderMemory() {
  const list = $('#mem-list');
  if (ui.memHits) {
    list.innerHTML = ui.memHits.length
      ? ui.memHits.map((h) => `<div class="hit" data-action="mem-select" data-id="${esc(h.path)}"><small>${esc(h.path)}:${h.line}</small><span>${esc(h.text)}</span></div>`).join('') + moreBtn('mem-hits', ui.memTotal - ui.memHits.length, PAGE.memHits)
      : `<div class="empty-view"><span>${t('mem.noHits')}</span></div>`;
  } else {
    list.innerHTML = ui.memFiles.map((f) => `<div tabindex="0" role="button" class="li${ui.memSel === f.path ? ' sel' : ''}" data-action="mem-select" data-id="${esc(f.path)}">${memIcon(f.kind)}<span class="m"><b>${esc(f.title)}</b><span>${esc(f.path)}</span></span><span class="r">${hhmm(f.updatedAt)}</span></div>`).join('')
      || `<div class="empty-view">${sym('s-sparkle')}<b>${t('mem.emptyTitle')}</b></div>`;
  }
  const ins = $('#mem-ins');
  if (!ui.memSel) {
    ins.innerHTML = `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-sparkle"/></svg><b>${t('mem.pickTitle')}</b></div>`;
    return;
  }
  ins.innerHTML = `<div class="ins-h"><b>${esc(ui.memSel)}</b></div>
    <textarea class="inp memedit" id="mem-edit" spellcheck="false">${esc(ui.memText)}</textarea>
    <div class="ins-act">${ui.memSel.startsWith('repos/') ? `<button class="btn" data-action="mem-promote" data-id="${esc(ui.memSel.slice(6, -3))}" title="${t('mem.promoteHint')}">${t('mem.promote')}</button>` : ''}<button class="btn def" data-action="mem-save">${t('save')}</button></div>`;
}

/* ---------- controls: popover list, font picker ---------- */

type Opt = { value: string; label: string; font?: string; sub?: string };
const pop = { el: null as HTMLElement | null, owner: null as HTMLElement | null };

function closePop(focusOwner = false) {
  pop.el?.remove();
  pop.owner?.setAttribute('aria-expanded', 'false');
  if (focusOwner) pop.owner?.focus();
  pop.el = null;
  pop.owner = null;
}

function placePop(el: HTMLElement, anchor: HTMLElement, minWidth: number) {
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

function openPop(owner: HTMLElement, items: Opt[], selected: string, onPick: (v: string) => void, minWidth = 160, focusList = true) {
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
let fontList: string[] | null = null;
async function installedFonts(): Promise<string[]> {
  if (fontList) return fontList;
  try {
    const fonts: { family: string }[] = await (window as any).queryLocalFonts();
    fontList = [...new Set(fonts.map((f) => f.family))].sort((x, y) => x.localeCompare(y));
  } catch {
    fontList = FONT_SUGGESTIONS.filter((f) => document.fonts.check(`12px "${f}"`));
  }
  return fontList;
}

async function openFontPicker(input: HTMLInputElement, focusList: boolean) {
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
function markFont(input: HTMLInputElement) {
  const names = input.value.split(',').map((x) => x.trim()).filter(Boolean);
  const bad = !!fontList && names.some((n) => !fontList!.some((f) => f.toLowerCase() === n.toLowerCase()));
  input.classList.toggle('bad', bad);
  input.title = bad ? t('set.fontMissing') : '';
}

/** Arrow keys, Enter and Escape inside an open popover. Returns true when handled. */
function popKeys(e: KeyboardEvent) {
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

function stepValue(id: string, delta: number) {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) return;
  const min = Number(el.dataset.min), max = Number(el.dataset.max);
  el.value = String(Math.max(min, Math.min(max, (Number(el.value) || min) + delta)));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/* ---------- settings ---------- */

/** Apply the UI font and text size as CSS variables. Also used for the live preview in Settings. */
function applyFont(family: string, size: number) {
  const font = fontStack(family), px = `${clampFontSize(size)}px`;
  // Every render calls this. Re-place the pills only when the text really changed size; a placement on
  // each render turned every tab switch into a jump.
  if (ui.fontApplied === `${font}|${px}`) return;
  ui.fontApplied = `${font}|${px}`;
  const root = document.documentElement.style;
  root.setProperty('--font', font);
  root.setProperty('--ui-font-size', px);
  glideSoon(false);
}

function previewFont() {
  applyFont($<HTMLInputElement>('#set-font').value, Number($<HTMLInputElement>('#set-fsize').value));
}

const PANES: { id: Pane; key: Key; glyph: string }[] = [
  { id: 'accounts', key: 'set.accounts', glyph: 's-person' },
  { id: 'general', key: 'set.general', glyph: 's-gear' },
  { id: 'display', key: 'set.display', glyph: 's-textsize' },
  { id: 'alerts', key: 'set.alerts', glyph: 's-bell' },
  { id: 'memory', key: 'set.memory', glyph: 's-sparkle' },
  { id: 'models', key: 'set.models', glyph: 's-cpu' },
];

const PLAN_OPTS: Opt[] = [{ value: 'team', label: 'Team' }, { value: 'enterprise', label: 'Enterprise' }];
const effortOpts = (): Opt[] => EFFORTS.map((e) => ({ value: e, label: t(`effort.${e}` as Key) }));
const AVATAR = ['var(--blue)', 'var(--green)', 'var(--purple)', 'var(--orange)'];
/** Choices until the account's model list has been read once. */
const FALLBACK_MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

/** Every model the accounts can use, newest first; a configured model missing from the list stays selectable. */
/** `claudeOnly`: for an agent that has to run on Claude Code (the Dispatcher). */
function modelOpts(cur: string, claudeOnly = false): Opt[] {
  const known = ui.models.models.filter((m) => !claudeOnly || (m.provider ?? 'claude') === 'claude');
  const ids = known.length ? known.map((m) => m.id) : FALLBACK_MODELS;
  const list = cur && !ids.includes(cur) ? [cur, ...ids] : ids;
  return list.map((id) => ({ value: id, label: modelLabel(id), sub: id }));
}

/** A button that opens a model list, backed by a hidden input like segc. */
function modelPicker(id: string, value: string, label: string) {
  return `<span class="dd"><input type="hidden" id="${id}" value="${esc(value)}"><button type="button" class="dd-btn" data-dd="${id}" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label)}"><span>${esc(modelLabel(value))}</span>${sym('s-updown')}</button></span>`;
}

function openModelPicker(btn: HTMLElement) {
  if (pop.owner === btn) { closePop(); return; }
  const inp = document.getElementById(btn.dataset.dd!) as HTMLInputElement | null;
  if (!inp) return;
  openPop(btn, modelOpts(inp.value), inp.value, (v) => {
    if (v === inp.value) return;
    inp.value = v;
    btn.querySelector('span')!.textContent = modelLabel(v);
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, 260);
}

/** Read the model list; 'now' asks the API even if the saved list is recent. */
async function loadModels(mode: 'cached' | 'fresh' | 'now') {
  ui.modelsLoading = true;
  syncModelRows();
  const r = await call<ModelList>('models:list', mode);
  ui.modelsLoading = false;
  if (r) ui.models = r;
  syncModelRows();
}

function modelsStatus() {
  const m = ui.models;
  if (ui.modelsLoading) return '…';
  if (m.error === 'no-account' && !m.models.length) return t('set.modelsNoAccount');
  if (m.error === 'no-token' && !m.models.length) return t('set.modelsNoToken');
  if (m.error && !m.models.length) return t('set.modelsFailed', { msg: m.error });
  if (!m.fetchedAt) return '–';
  return t(m.error ? 'set.modelsStale' : 'set.modelsCount', { n: m.models.length, time: when(m.fetchedAt) });
}

/** Update the list status and the picker labels in place, without re-rendering Settings. */
function syncModelRows() {
  const st = document.getElementById('set-mlist');
  if (st) { st.textContent = modelsStatus(); st.classList.toggle('bad', !!ui.models.error); }
  document.querySelectorAll<HTMLElement>('[data-dd]').forEach((b) => {
    const v = (document.getElementById(b.dataset.dd!) as HTMLInputElement | null)?.value;
    const s = b.querySelector('span');
    if (v && s) s.textContent = modelLabel(v);
  });
}

/** Segmented control backed by a hidden input, so the form reads it like any field. */
function segc(id: string, value: string, opts: Opt[], label: string, extra = '') {
  const cur = opts.some((o) => o.value === value) ? value : opts[0].value;
  return `<span class="segc" role="radiogroup" aria-label="${esc(label)}"><input type="hidden" id="${id}" value="${esc(cur)}" ${extra}>${opts.map((o) => `<button type="button" role="radio" data-segc="${id}" data-v="${esc(o.value)}" aria-checked="${o.value === cur}"${o.value === cur ? ' class="on"' : ''}>${esc(o.label)}</button>`).join('')}</span>`;
}

function pickSeg(btn: HTMLButtonElement) {
  const inp = document.getElementById(btn.dataset.segc!) as HTMLInputElement | null;
  if (!inp || inp.value === btn.dataset.v) return;
  inp.value = btn.dataset.v!;
  syncSegs(btn.parentElement!);
  inp.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Make each segmented control show its hidden input's value (after restoring kept values). */
function syncSegs(root: ParentNode = document) {
  root.querySelectorAll<HTMLButtonElement>('[data-segc]').forEach((b) => {
    const on = (document.getElementById(b.dataset.segc!) as HTMLInputElement | null)?.value === b.dataset.v;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
}

/**
 * Liquid Glass segmented controls: one glass pill (the control's ::before) sits under the chosen
 * segment. A changed choice slides and stretches it there; a new, re-shown or resized control places it
 * without motion.
 */
function glideAll(animate: boolean) {
  document.querySelectorAll<HTMLElement>('.seg, .segc').forEach((c) => glide(c, animate));
}

/**
 * Run glideAll once in the next frame for every request made before it. Separate frame callbacks ran in
 * the order they were queued, so whichever came first decided whether a switch slid. A placement without
 * motion (new text size) wins over a slide asked for in the same frame.
 */
let glideNext: boolean | null = null;
function glideSoon(animate: boolean) {
  if (glideNext !== null) { glideNext &&= animate; return; }
  glideNext = animate;
  requestAnimationFrame(() => {
    const a = glideNext!;
    glideNext = null;
    glideAll(a);
  });
}

function glide(c: HTMLElement, animate: boolean) {
  const on = c.querySelector<HTMLElement>(':scope > button[aria-pressed="true"], :scope > button.on');
  if (!on || !c.offsetParent) {
    // Only a control that still shows a pill: rewriting the class of a hidden one is itself a mutation,
    // which woke the observer every frame and kept a requestAnimationFrame loop running.
    if (c.dataset.glide !== undefined || c.classList.contains('glide-on')) {
      c.classList.remove('glide-on', 'glide-ready', 'glide-move');
      delete c.dataset.glide;
    }
    return;
  }
  const box = [on.offsetLeft, on.offsetTop, on.offsetWidth, on.offsetHeight];
  const key = box.join(',');
  if (c.dataset.glide === key) return;
  const from = c.dataset.glide?.split(',').map(Number);
  const slide = animate && !!from && c.classList.contains('glide-ready');
  c.dataset.glide = key;
  if (!slide) c.classList.remove('glide-ready', 'glide-move');
  c.style.setProperty('--gx', `${box[0]}px`);
  c.style.setProperty('--gy', `${box[1]}px`);
  c.style.setProperty('--gw', `${box[2]}px`);
  c.style.setProperty('--gh', `${box[3]}px`);
  c.classList.add('glide-on');
  if (!slide) {
    void c.offsetWidth; // place it first, then turn transitions on
    c.classList.add('glide-ready');
  } else if (from && (Math.abs(from[0] - box[0]) > 1 || Math.abs(from[1] - box[1]) > 1)) {
    c.classList.remove('glide-move');
    void c.offsetWidth; // restart the stretch
    c.classList.add('glide-move');
  }
}

function stepper(id: string, value: number, min: number, max: number, label: string) {
  return `<span class="step" role="group" aria-label="${esc(label)}"><button type="button" data-step="-1" data-for="${id}" aria-label="-">${sym('s-minus')}</button><input id="${id}" class="step-v" inputmode="numeric" value="${value}" data-min="${min}" data-max="${max}" aria-label="${esc(label)}"><button type="button" data-step="1" data-for="${id}" aria-label="+">${sym('s-plus')}</button></span>`;
}

function slider(id: string, value: number, label: string) {
  return `<span class="slider-wrap">${sym('s-speaker', 'slider-ic')}<input id="${id}" class="slider" type="range" min="0" max="100" step="5" value="${value}" style="--val:${value}%" aria-label="${esc(label)}"><output class="slider-out" for="${id}">${value}</output></span>`;
}

function meter(label: string, v: number | null) {
  const w = v ?? 0;
  return `<span>${label}</span><span class="cap"><i class="${lv(v)}" style="width:${Math.min(100, w)}%"></i></span><span class="mv${w > 80 ? ' hot' : ''}">${pct(v)}</span>`;
}

function initials(label: string) {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (!/^[A-Za-z0-9]/.test(words[0])) return [...words[0]][0]; // Hangul and other scripts: one character
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

function accountCard(a: AccountView, i: number) {
  const gpt = a.provider === 'chatgpt';
  const kind = gpt ? t('acc.kindChatgpt') : a.kind === 'login' ? t('acc.kindLogin') : t('acc.kindToken');
  const plan = gpt ? (a.planLabel || 'ChatGPT') : a.plan === 'enterprise' ? 'Enterprise' : 'Team';
  const renaming = ui.accRename === a.id;
  const name = renaming
    ? `<span class="acc-edit"><input class="inp" id="acc-rename" value="${esc(a.label)}" aria-label="${t('acc.name')}" data-id="${a.id}"><button class="btn def" data-action="acc-rename-save" data-id="${a.id}">${t('save')}</button><button class="btn" data-action="acc-rename-cancel">${t('cancel')}</button></span>`
    : `<span class="acc-name"><b>${esc(a.label)}</b><span class="plan-badge ${gpt ? 'chatgpt' : a.plan}">${esc(plan)}</span></span>`;
  const menu = ui.accMenu === a.id ? `<div class="amenu" role="menu" aria-label="${t('acc.options')}">
      <button role="menuitem" data-action="acc-rename" data-id="${a.id}">${t('acc.rename')}</button>
      <button role="menuitem" data-action="acc-refresh">${t('acc.refresh')}</button>
      ${gpt ? '' : `<div class="amenu-sep"></div><span class="amenu-h">${t('acc.plan')}</span>
      ${PLAN_OPTS.map((o) => `<button role="menuitemradio" aria-checked="${a.plan === o.value}" data-action="acc-plan" data-id="${a.id}" data-v="${o.value}">${sym('s-tick', 'amenu-tick')}${o.label}</button>`).join('')}`}
      <div class="amenu-sep"></div>
      <button role="menuitem" class="danger" data-action="acc-remove" data-id="${a.id}">${t('acc.removeMenu')}</button>
    </div>` : '';
  return `<div class="acc-card${renaming ? ' editing' : ''}">
    <span class="avatar" style="background:${AVATAR[i % AVATAR.length]}">${esc(initials(a.label))}</span>
    <span class="acc-main">${name}<span class="acc-kind">${kind}</span>${a.lastError ? `<span class="warn">${esc(a.lastError)}</span>` : ''}</span>
    <span class="acc-meters">${usageWindows(a).map((w) => meter(w.label, w.v)).join('')}</span>
    <span class="acc-more"><button class="btn icon" data-action="acc-menu" data-id="${a.id}" aria-haspopup="menu" aria-expanded="${ui.accMenu === a.id}" aria-label="${t('acc.options')}">${sym('s-more')}</button>${menu}</span>
  </div>`;
}

function removeDialog() {
  const a = S!.accounts.find((x) => x.id === ui.accRemove);
  if (!a) return '';
  const i = S!.accounts.indexOf(a);
  return `<div class="dlg-back" data-action="acc-remove-cancel"></div>
  <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t">
    <span class="avatar big" style="background:${AVATAR[i % AVATAR.length]}">${esc(initials(a.label))}</span>
    <h2 id="dlg-t">${esc(t('acc.removeTitle', { name: a.label }))}</h2>
    <p>${a.provider === 'chatgpt' ? t('acc.removeChatgpt') : a.kind === 'login' ? t('acc.removeLogin') : t('acc.removeToken')}</p>
    <div class="dlg-btns"><button class="btn" data-action="acc-remove-cancel">${t('cancel')}</button><button class="btn danger-fill" data-action="acc-remove-ok" data-id="${a.id}">${t('remove')}</button></div>
  </div>`;
}

function settingsHtml() {
  const s = S!;
  const st = s.settings;
  const full = s.accounts.length >= MAX_ACCOUNTS;
  const hasLogin = s.accounts.some((a) => a.kind === 'login' && a.provider !== 'chatgpt');
  const hasChatgpt = s.accounts.some((a) => a.provider === 'chatgpt');
  // Ways to add an account that are still open: one login of this PC's Claude Code, one of its Codex.
  const methods: Opt[] = [{ value: 'token', label: t('acc.methodToken') }, ...(hasLogin ? [] : [{ value: 'login', label: t('acc.methodLogin') }]), ...(hasChatgpt ? [] : [{ value: 'chatgpt', label: t('acc.methodChatgpt') }])];
  if (!methods.some((m) => m.value === ui.accKind)) ui.accKind = 'token';
  const pane = (id: Pane, body: string) => `<section class="pane" data-pane="${id}"${ui.pane === id ? '' : ' hidden'}><h2>${t(PANES.find((p) => p.id === id)!.key)}</h2>${body}</section>`;
  const row = (label: string, forId: string, control: string, cls = '') => `<div class="srow${cls ? ` ${cls}` : ''}"><label class="lbl" for="${forId}">${label}</label>${control}</div>`;
  const grp = (rows: string, cap = '') => `<div class="sgrp-wrap">${cap ? `<h3 class="scap">${cap}</h3>` : ''}<div class="sgrp">${rows}</div></div>`;
  const sounds: SoundName[] = ['chime', 'bell', 'ping', 'custom', 'none'];

  const accounts = `${grp(s.accounts.map(accountCard).join('') || `<div class="srow"><span class="lbl muted">${t('acc.none')}</span></div>`, `${t('acc.registered')} <small>${s.accounts.length} / ${MAX_ACCOUNTS}</small>`)}
    ${full ? '' : grp(`
      ${methods.length < 2 ? '' : row(t('acc.method'), 'acc-kind', segc('acc-kind', ui.accKind, methods, t('acc.method'), 'data-change="acc-kind"'))}
      ${row(t('acc.name'), 'acc-label', `<input class="inp w" id="acc-label" placeholder="${t('acc.namePh')}">`)}
      ${row(t('acc.plan'), 'acc-plan', segc('acc-plan', 'team', PLAN_OPTS, t('acc.plan')), 'acc-plan-row')}
      ${row(t('acc.token'), 'acc-token', `<input class="inp w" id="acc-token" type="password" placeholder="sk-ant-…" autocomplete="off" spellcheck="false">`, 'acc-token-row')}
      <div class="srow end"><button class="btn def" data-action="acc-add" id="acc-add-btn">${t('acc.addToken')}</button><button class="btn def" data-action="acc-add-login" id="acc-login-btn">${t('acc.addLogin')}</button><button class="btn def" data-action="acc-add-chatgpt" id="acc-chatgpt-btn">${t('acc.addChatgpt')}</button></div>`, t('acc.add'))}`;

  const general = `${grp(`
      ${row(t('set.language'), 'set-lang', segc('set-lang', st.language, [{ value: 'en', label: 'English' }, { value: 'ko', label: '한국어' }], t('set.language')))}
      ${row(t('set.home'), 'set-home', `<input class="inp w" id="set-home" value="${esc(st.home)}"><button class="btn" data-action="pick-home">${t('choose')}</button>`)}
      ${row(t('set.ghHost'), 'set-gh', `<input class="inp w" id="set-gh" value="${esc(st.githubHost)}" placeholder="github.com">`)}
      ${row(t('set.archive'), 'set-arch', stepper('set-arch', st.archiveDays, 1, 90, t('set.archive')))}
      ${row(t('set.background'), 'set-bg', `<input class="switch" id="set-bg" type="checkbox" ${st.background ? 'checked' : ''}>`)}
      ${row(t('set.openAtLogin'), 'set-login', `<input class="switch" id="set-login" type="checkbox" ${st.openAtLogin ? 'checked' : ''}>`)}
      ${row(t('set.quickKey'), 'set-qkey', `<input class="inp w" id="set-qkey" value="${esc(quickKeyLabel(st.quickKey, isMac))}" spellcheck="false" autocomplete="off">`)}
      ${row(t('set.updateCheck'), 'set-upd', `<input class="switch" id="set-upd" type="checkbox" ${st.updateCheck ? 'checked' : ''}>`)}`)}${grp(
      `${row(t('set.jiraUrl'), 'set-jurl', `<input class="inp w" id="set-jurl" value="${esc(st.jiraUrl)}" placeholder="https://company.atlassian.net" spellcheck="false" autocomplete="off">`)}
      ${row(t('set.jiraEmail'), 'set-jmail', `<input class="inp w" id="set-jmail" value="${esc(st.jiraEmail)}" placeholder="${t('set.jiraEmailPh')}" spellcheck="false" autocomplete="off">`)}
      ${row(t('set.jiraToken'), 'set-jtok', `<input class="inp w" id="set-jtok" type="password" placeholder="${st.jiraTokenSet ? t('set.jiraTokenSet') : ''}" autocomplete="off" spellcheck="false">${st.jiraTokenSet ? `<button class="btn" data-action="jira-token-clear">${t('set.jiraTokenClear')}</button>` : ''}`)}`, 'Jira')}${grp(
      ASK_RULES.map((r) => row(cap1(t(r)), `ask-${r}`, `<input class="switch ask-rule" id="ask-${r}" data-rule="${r}" type="checkbox" ${st.askOff.includes(r) ? '' : 'checked'}>`)).join(''), t('set.alwaysAsk'))}`;

  const display = `${grp(`
      ${row(t('set.font'), 'set-font', `<span class="combo"><input class="inp" id="set-font" value="${esc(st.fontFamily)}" placeholder="${t('set.fontSystem')}" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false"><button type="button" class="combo-btn" data-combo="set-font" tabindex="-1" aria-label="${t('set.font')}">${sym('s-updown')}</button></span>`)}
      ${row(t('set.fontSize'), 'set-fsize', `<button class="btn" data-action="font-reset">${t('set.fontReset')}</button>${stepper('set-fsize', st.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, t('set.fontSize'))}`)}`)}
    <div class="fprev" aria-hidden="true"><span class="me">${t('set.preview1')}</span><span class="ai">${t('set.preview2')}</span></div>`;

  const alerts = grp(`
      ${row(t('set.osNoti'), 'set-noti', `<input class="switch" id="set-noti" type="checkbox" ${st.notifications ? 'checked' : ''}>`)}
      ${row(t('set.sound'), 'set-sound', `<button class="segico" data-action="sound-test" title="${t('set.soundTest')}" aria-label="${t('set.soundTest')}">${sym('s-play')}</button>${segc('set-sound', st.sound, sounds.map((x) => ({ value: x, label: t(`sound.${x}` as Key) })), t('set.sound'), 'data-change="sound-kind"')}`, 'wrap')}
      ${row(t('set.soundFile'), 'set-sfile', `<input class="inp w" id="set-sfile" value="${esc(st.customSound)}" placeholder="mp3, wav, ogg, m4a"><button class="btn" data-action="pick-sound">${t('choose')}</button>`, 'custom-row')}
      ${row(t('set.volume'), 'set-vol', slider('set-vol', st.soundVolume, t('set.volume')), 'vol')}`);

  const ci = ui.claude;
  const rulesText = !ci ? '…' : ci.rules.length ? ci.rules.join(', ') : t('set.claudeNoRules');
  const memory = `${grp(`
      ${row(t('set.memFolder'), 'set-memdir', `<span class="sval" id="set-memdir" title="${esc(st.home)}">${esc(shortPath(`${st.home}/memory`))}</span><button class="btn" data-action="reveal-memory">${t('set.open')}</button>`)}
      ${row(t('set.memRemote'), 'set-mem', `<input class="inp w" id="set-mem" value="${esc(st.memoryRemote)}" placeholder="https://github.com/me/agent-memory.git">`)}
      <div id="set-msync" hidden></div>
      ${row(t('set.memSuggest'), 'set-msug', `<input class="switch" id="set-msug" type="checkbox" ${st.memorySuggest ? 'checked' : ''}>`)}`, t('set.ideMemory'))}
    ${grp(`
      ${row(t('set.claudeRules'), 'set-crules', `<span class="sval${ci && !ci.rules.length ? ' muted' : ''}" title="${esc(ci ? ci.home : '')}">${esc(rulesText)}</span><input class="switch" id="set-crules" type="checkbox" ${st.claudeRules ? 'checked' : ''}>`)}
      ${row(t('set.claudeMemory'), 'set-cmem', `<input class="switch" id="set-cmem" type="checkbox" ${st.claudeMemory ? 'checked' : ''}>`)}
      ${row(t('set.claudeFolder'), 'set-cdir', `<span class="sval" id="set-cdir" title="${esc(ci ? ci.home : '')}">${esc(ci ? shortPath(ci.home, 2) : '…')}</span><button class="btn" data-action="reveal-claude">${t('set.open')}</button>`)}`, 'Claude Code')}`;

  const models = `${grp(`
      ${row(t('set.modelList'), 'set-mlist', `<span class="sval${ui.models.error ? ' bad' : ''}" id="set-mlist">${esc(modelsStatus())}</span><button class="btn" data-action="models-refresh">${t('diff.refresh')}</button>`)}`)}
    ${grp(`
      ${row(t('set.model'), 'set-dm', modelPicker('set-dm', st.dispatcherModel, 'Dispatcher'))}
      ${row(t('set.effort'), 'set-de', segc('set-de', st.dispatcherEffort, effortOpts(), t('set.effort')), 'wrap')}`, 'Dispatcher')}
    ${grp(`
      ${row(t('set.model'), 'set-wm', modelPicker('set-wm', st.workerModel, 'Worker'))}
      ${row(t('set.design'), 'set-fm', modelPicker('set-fm', st.designModel, t('set.design')))}
      ${row(t('set.defaultEffort'), 'set-we', segc('set-we', st.workerEffort, effortOpts(), t('set.effort')), 'wrap')}
      ${row(t('set.effortPerTask'), 'set-ept', `<input class="switch" id="set-ept" type="checkbox" ${st.effortPerTask ? 'checked' : ''}>`)}
      ${row(t('set.selfReview'), 'set-srev', `<input class="switch" id="set-srev" type="checkbox" ${st.selfReview ? 'checked' : ''}>`)}
      ${row(t('set.maxWorkers'), 'set-maxw', stepper('set-maxw', st.maxWorkers, MAX_WORKERS_MIN, MAX_WORKERS_MAX, t('set.maxWorkers')))}
      ${row(t('set.waitSlot'), 'set-wslot', stepper('set-wslot', st.waitSlotMinutes, 0, WAIT_SLOT_MAX, t('set.waitSlot')))}`, t('set.workers'))}`;

  return `<header class="stopbar drag">
      <button class="btn sback" data-action="close-settings">${sym('s-back')}${t('set.back')}</button>
      <h1>${t('set.title')}</h1>
    </header>
    <div class="sbody">
      <nav class="snav" aria-label="${t('set.title')}">
        <label class="ssearch">${sym('s-search')}<input id="set-q" type="search" placeholder="${t('set.search')}" aria-label="${t('set.search')}" value="${esc(ui.setQ)}"></label>
        ${PANES.map((p) => `<button class="snav-i${ui.pane === p.id ? ' on' : ''}" data-action="pane" data-id="${p.id}"${ui.pane === p.id ? ' aria-current="page"' : ''}>${sym(p.glyph)}<span>${t(p.key)}</span>${p.id === 'accounts' && s.setupNeeded ? '<i class="dot"></i>' : ''}</button>`).join('')}
        <span class="ver"><span id="ver-n">${ui.version ? `v${esc(ui.version)}` : ''}</span>${s.update ? `<a class="upd" tabindex="0" role="link" data-action="open-url" data-href="${esc(s.update.url)}">${t('upd.get', { v: s.update.version })}</a>` : ''}</span>
      </nav>
      <main class="spanes"><div class="sinner">${pane('accounts', accounts)}${pane('general', general)}${pane('display', display)}${pane('alerts', alerts)}${pane('memory', memory)}${pane('models', models)}</div></main>
    </div>
    ${ui.accMenu || ui.accRename ? '<div class="click-catch" data-action="acc-dismiss"></div>' : ''}
    ${removeDialog()}
    ${restartDialog()}`;
}

/** After the IDE home folder changes: it takes effect on the next launch. */
function restartDialog() {
  if (!ui.restartAsk) return '';
  return `<div class="dlg-back" data-action="restart-later"></div>
  <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t">
    <h2 id="dlg-t">${t('set.restartTitle')}</h2>
    <p>${t('set.restartBody')}</p>
    <div class="dlg-btns"><button class="btn" data-action="restart-later">${t('set.restartLater')}</button><button class="btn def" data-action="restart-now">${t('set.restartNow')}</button></div>
  </div>`;
}

/** Re-render the settings window, keeping unsaved field values. */
/** Claude Code rule files for the Memory pane; read each time Settings opens. */
async function loadClaudeInfo() {
  ui.claude = (await call<ClaudeInfo>('claude:info')) ?? null;
  if (ui.settingsShown) openSettings();
}

let sheetTimer: number | undefined;
function openSettings(pane?: Pane) {
  if (pane) ui.pane = pane;
  // Each time the window opens (button, shortcut or first run), not on every re-render.
  if (!ui.settingsShown) { void loadClaudeInfo(); if (ui.pane === 'models') void loadModels('fresh'); }
  closePop();
  const root = $('#sheet');
  const keep = new Map<string, string | boolean>();
  if (ui.settingsShown) root.querySelectorAll<HTMLInputElement>('.spanes input').forEach((el) => { if (el.id && el.id !== 'acc-rename') keep.set(el.id, el.type === 'checkbox' ? el.checked : el.value); });
  const focusId = ui.settingsShown && root.contains(document.activeElement) ? (document.activeElement as HTMLElement).id : '';
  const scroll = root.querySelector('.spanes')?.scrollTop ?? 0;
  clearTimeout(sheetTimer);
  root.classList.remove('closing');
  if (!ui.settingsShown) swapIn(root);
  ui.settingsShown = true;
  root.innerHTML = settingsHtml();
  renderMemSync();
  keep.forEach((v, id) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    if (el.type === 'checkbox') el.checked = v as boolean; else el.value = v as string;
  });
  syncSegs(root);
  requestAnimationFrame(pathEnds);
  const vol = document.getElementById('set-vol') as HTMLInputElement | null;
  if (vol) syncSlider(vol);
  const ren = document.getElementById('acc-rename') as HTMLInputElement | null;
  if (ren) { ren.focus(); ren.select(); } else if (focusId) document.getElementById(focusId)?.focus();
  if (!pane) scrollQuietly(root.querySelector<HTMLElement>('.spanes')!, scroll);
  syncSoundRows();
  syncAccRows();
  filterPanes();
  root.hidden = false;
  document.body.classList.add('modal');
  if (!ui.version) void call<string>('app:version').then((v) => { if (v) { ui.version = v; const el = root.querySelector('#ver-n'); if (el) el.textContent = `v${v}`; } });
  void installedFonts().then(() => { const f = document.getElementById('set-font') as HTMLInputElement | null; if (f) markFont(f); });
}

function syncSlider(el: HTMLInputElement) {
  el.style.setProperty('--val', `${el.value}%`);
  const out = el.parentElement?.querySelector('output');
  if (out) out.textContent = el.value;
}

function syncAccRows() {
  const kind = ($('#acc-kind') as HTMLInputElement | null)?.value ?? 'token';
  document.querySelectorAll<HTMLElement>('.acc-token-row').forEach((el) => { el.hidden = kind !== 'token'; });
  // A ChatGPT account's plan comes from Codex.
  document.querySelectorAll<HTMLElement>('.acc-plan-row').forEach((el) => { el.hidden = kind === 'chatgpt'; });
  const show = (id: string, on: boolean) => { const el = document.getElementById(id); if (el) el.hidden = !on; };
  show('acc-add-btn', kind === 'token');
  show('acc-login-btn', kind === 'login');
  show('acc-chatgpt-btn', kind === 'chatgpt');
}

function syncSoundRows() {
  const kind = ($('#set-sound') as HTMLInputElement | null)?.value;
  document.querySelectorAll<HTMLElement>('.custom-row').forEach((el) => { el.hidden = kind !== 'custom'; });
}

/* Settings save as they change: switches, segments, pickers and steppers at once; typed text after a
   short pause or when the field loses focus; the home folder only when it loses focus or is picked. */
let saveTimer = 0;
function saveSoon(delay = 600) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveSettingsNow(), delay);
}

async function saveSettingsNow() {
  clearTimeout(saveTimer);
  if (!ui.settingsShown || !S || !document.getElementById('set-lang')) return;
  const f = readSettingsForm() as Record<string, unknown>;
  const cur = S.settings as unknown as Record<string, unknown>;
  const patch = Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== cur[k])) as Partial<ReturnType<typeof readSettingsForm>>;
  if (!Object.keys(patch).length) return;
  const langChanged = patch.language !== undefined;
  Object.assign(S.settings, patch); // the new values count before the state comes back (font, labels)
  customCache = null;
  if (langChanged) { ui.settingsShown = false; applyStaticText(); openSettings(); }
  const r = await call<{ restart: boolean; quickKeyOk?: boolean }>('settings:save', patch);
  if (patch.quickKey && r?.quickKeyOk === false) { toast(t('quick.taken'), true); $('#set-qkey')?.classList.add('bad'); }
  if (r?.restart && ui.settingsShown) { ui.restartAsk = true; openSettings(); }
}

/** Search box: keep only the sections whose labels match, and show the first match. */
function filterPanes() {
  const q = ui.setQ.trim().toLowerCase();
  const hits: Pane[] = [];
  document.querySelectorAll<HTMLButtonElement>('.snav-i').forEach((b) => {
    const id = b.dataset.id as Pane;
    const sec = document.querySelector(`.pane[data-pane="${id}"]`);
    const words = [b.textContent ?? '', ...[...(sec?.querySelectorAll('.lbl, .scap, h2') ?? [])].map((x) => x.textContent ?? '')].join(' ').toLowerCase();
    const hit = !q || words.includes(q);
    b.hidden = !hit;
    if (hit) hits.push(id);
  });
  if (q && hits.length && !hits.includes(ui.pane)) showPane(hits[0]);
}

function showPane(id: Pane) {
  ui.pane = id;
  document.querySelectorAll<HTMLElement>('.pane').forEach((p) => { p.hidden = p.dataset.pane !== id; if (!p.hidden) swapIn(p); });
  document.querySelectorAll<HTMLButtonElement>('.snav-i').forEach((b) => {
    const on = b.dataset.id === id;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const sp = document.querySelector('.spanes');
  if (sp instanceof HTMLElement) scrollQuietly(sp, 0);
  pathEnds();
  if (id === 'models') void loadModels('fresh');
}

/** Long folder paths in Settings show their end, which is the part that differs. Runs once the pane is visible. */
function pathEnds() {
  const home = document.querySelector<HTMLInputElement>('#set-home');
  if (home && document.activeElement !== home) home.scrollLeft = home.scrollWidth;
}

function closeSettings() {
  void saveSettingsNow(); // reads the form before it goes away
  closePop();
  ui.settingsShown = false;
  ui.accMenu = ui.accRename = ui.accRemove = null;
  ui.restartAsk = false;
  ui.setQ = '';
  const sheet = $('#sheet');
  const gone = () => { sheet.hidden = true; sheet.innerHTML = ''; sheet.classList.remove('closing'); };
  const d = ms('--dur-fast');
  clearTimeout(sheetTimer);
  if (d) { sheet.classList.add('closing'); sheetTimer = window.setTimeout(gone, d); } else gone();
  document.body.classList.remove('modal');
  if (S) applyFont(S.settings.fontFamily, S.settings.fontSize);
}

/** The company GitHub host keeps only the host name: no scheme, path or capitals. */
const hostOnly = (v: string) => v.trim().replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();

function readSettingsForm() {
  const v = (id: string) => ($(`#${id}`) as HTMLInputElement).value.trim();
  return {
    language: v('set-lang') as Lang,
    home: v('set-home') || S!.settings.home,
    githubHost: hostOnly(v('set-gh')),
    archiveDays: Math.max(1, Number(v('set-arch')) || 7),
    notifications: ($('#set-noti') as HTMLInputElement).checked,
    background: ($('#set-bg') as HTMLInputElement).checked,
    openAtLogin: ($('#set-login') as HTMLInputElement).checked,
    updateCheck: ($('#set-upd') as HTMLInputElement).checked,
    // An unreadable shortcut keeps the one in use; the field shows it is not taken.
    quickKey: normalizeQuickKey(($('#set-qkey') as HTMLInputElement).value) ?? S!.settings.quickKey,
    jiraUrl: v('set-jurl'),
    jiraEmail: v('set-jmail'),
    askOff: [...document.querySelectorAll<HTMLInputElement>('.ask-rule')].filter((x) => !x.checked).map((x) => x.dataset.rule ?? ''),
    sound: v('set-sound') as SoundName,
    customSound: v('set-sfile'),
    soundVolume: Number(v('set-vol')),
    memoryRemote: v('set-mem'),
    memorySuggest: ($('#set-msug') as HTMLInputElement).checked,
    dispatcherModel: v('set-dm'),
    workerModel: v('set-wm'),
    designModel: v('set-fm'),
    dispatcherEffort: v('set-de') as Effort,
    workerEffort: v('set-we') as Effort,
    effortPerTask: ($('#set-ept') as HTMLInputElement).checked,
    selfReview: ($('#set-srev') as HTMLInputElement).checked,
    maxWorkers: clampMaxWorkers(v('set-maxw')),
    waitSlotMinutes: clampWaitSlot(v('set-wslot')),
    fontFamily: normalizeFontFamily(v('set-font')),
    fontSize: clampFontSize(v('set-fsize')),
    claudeRules: ($('#set-crules') as HTMLInputElement).checked,
    claudeMemory: ($('#set-cmem') as HTMLInputElement).checked,
  };
}

/* ---------- attachments ---------- */

type Box = 'chat' | 'ws';
function renderChips(box: Box) {
  const el = $(box === 'chat' ? '#chat-files' : '#ws-files');
  const files = ui.attach[box];
  el.hidden = !files.length;
  el.innerHTML = files.map((f, i) => `<span class="fchip" title="${esc(f)}">${sym('s-doc')}<span>${esc(base(f))}</span><button type="button" data-action="unattach" data-box="${box}" data-i="${i}" aria-label="${t('remove')}"><svg><use href="#s-x"/></svg></button></span>`).join('');
  if (box === 'chat') updateSendButton();
}

function addFiles(box: Box, list: FileList | null) {
  if (!list?.length) return;
  for (const f of Array.from(list)) {
    let p = '';
    try { p = ide.pathForFile(f); } catch { /* not a local file */ }
    if (p && !ui.attach[box].includes(p)) ui.attach[box].push(p);
  }
  renderChips(box);
}

/* ---------- command palette: Ctrl/Cmd+K (decision 116) ---------- */

interface Cmd extends PaletteItem { icon: string; run: () => void; /** Listed only for a search: past tasks would bury the places to go. */ searchOnly?: boolean }
const cmdk = { open: false, i: 0, all: [] as Cmd[], shown: [] as Cmd[], back: null as HTMLElement | null };

/** Everything the palette can go to, in the order it lists them while nothing is typed. */
function paletteItems(): Cmd[] {
  const s = S!;
  const mod = isMac ? '⌘' : 'Ctrl+';
  const out: Cmd[] = [];
  // Waiting decisions first: they are what the user most likely came for.
  for (const d of s.decisions.filter((x) => x.status === 'pending')) {
    out.push({ id: `dec:${d.id}`, group: t('side.decisions'), title: oneLine(d.summary?.what || d.title, 80), hint: d.workerId ?? 'Dispatcher', icon: ic('ask'),
      run: () => { const row = document.createElement('i'); row.dataset.action = 'goto-decision'; row.dataset.id = d.id; void act(row, new Event('click')); } });
  }
  const views: [View, string, string][] = [['chat', t('nav.chat'), 's-chat'], ['worker', 'Worker', 's-cpu'], ['repo', t('nav.repo'), 's-box'], ['memory', t('nav.memory'), 's-doc']];
  views.forEach(([v, title, icon], i) => out.push({ id: `view:${v}`, group: t('cmdk.go'), title, keys: `${mod}${i + 1}`, icon: sym(icon), run: () => go({ view: v }) }));
  const tabs: [typeof ui.insTab, Key][] = [['inbox', 'ins.tabInbox'], ['memo', 'ins.tabMemo'], ['auto', 'ins.tabAuto']];
  for (const [v, key] of tabs) {
    out.push({ id: `tab:${v}`, group: t('cmdk.go'), title: t(key), hint: t('nav.chat'), icon: sym('s-side-r'),
      run: () => { ui.insTab = v; if (ui.insMin) togglePanel('ins'); go({ view: 'chat' }); renderChatInspector(); } });
  }
  const live = s.workers.filter((w) => w.status !== 'archived').sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  const arch = s.workers.filter((w) => w.status === 'archived').sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  for (const w of [...live, ...arch]) {
    const x = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
    out.push({ id: `w:${w.id}`, group: w.status === 'archived' ? t('side.archived') : 'Worker', title: `${w.id} ${x?.title ?? w.title}`,
      hint: [w.repo ?? t('general'), modelLabel(w.model)].join(' · '), icon: workerIcon(w), run: () => openWorker(w.id) });
  }
  // Past work, found by typing: a task's id or title, its PR number, a word of its report.
  for (const x of s.tasks.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (!x.workerId || !worker(x.workerId)) continue;
    const pr = x.prUrl ? `PR #${prNum(x.prUrl)}` : '';
    out.push({ id: `task:${x.id}`, group: t('cmdk.tasks'), title: `${x.id} ${x.title}`, hint: [x.workerId, taskLabel(x), pr, x.summary ? oneLine(x.summary, 90) : ''].filter(Boolean).join(' · '),
      icon: sym(x.prUrl ? 's-pr' : 's-check'), searchOnly: true, run: () => go({ view: 'worker', wSel: x.workerId, wOpen: true, wTab: 'summary' }) });
  }
  for (const r of s.repos) out.push({ id: `repo:${r.name}`, group: t('nav.repo'), title: r.name, hint: r.description || undefined, icon: sym('s-box'), run: () => go({ view: 'repo', repoSel: r.name }) });
  const panes: [Pane, Key][] = [['accounts', 'set.accounts'], ['general', 'set.general'], ['display', 'set.display'], ['alerts', 'set.alerts'], ['memory', 'set.memory'], ['models', 'set.models']];
  panes.forEach(([pane, key], i) => out.push({ id: `set:${pane}`, group: t('set.title'), title: t(key), hint: t('set.title'), keys: i ? undefined : `${mod},`, icon: sym('s-gear'), run: () => openSettings(pane) }));
  out.push({ id: 'side', group: t('cmdk.window'), title: t('cmdk.side'), keys: `${mod}B`, icon: sym('s-side-l'), run: () => togglePanel('side') });
  out.push({ id: 'ins', group: t('cmdk.window'), title: t('cmdk.ins'), keys: isMac ? '⌥⌘B' : 'Ctrl+Alt+B', icon: sym('s-side-r'), run: () => togglePanel('ins') });
  return out;
}

function openPalette() {
  if (!S || cmdk.open) return;
  closePop();
  hideUsagePop();
  $('#ctxmenu').hidden = true;
  cmdk.open = true;
  cmdk.back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  cmdk.all = paletteItems();
  const root = $('#cmdk');
  root.innerHTML = `<div class="dlg-back" data-action="cmdk-close"></div>
    <div class="cmdk" role="dialog" aria-modal="true" aria-label="${t('cmdk.ph')}">
      <label class="cmdk-in">${sym('s-search')}<input id="cmdk-q" type="text" role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-autocomplete="list" placeholder="${t('cmdk.ph')}" spellcheck="false" autocomplete="off"><kbd>Esc</kbd></label>
      <div class="cmdk-list" id="cmdk-list" role="listbox"></div>
    </div>`;
  root.hidden = false;
  root.classList.add('opening');
  setTimeout(() => root.classList.remove('opening'), ms('--dur-slow') + 40);
  renderPalette('');
  $('#cmdk-q').focus();
}

/** The list for what is typed. Sections have their names only while nothing is typed: a search mixes them by rank. */
function renderPalette(q: string) {
  const heads = !q.trim();
  cmdk.shown = matchItems(heads ? cmdk.all.filter((c) => !c.searchOnly) : cmdk.all, q, 60);
  cmdk.i = 0;
  let last = '';
  $('#cmdk-list').innerHTML = cmdk.shown.map((c, i) => {
    const head = heads && c.group !== last ? `<div class="cmdk-g" role="presentation">${esc(c.group)}</div>` : '';
    last = c.group;
    return `${head}<div class="cmdk-it" id="cmdk-${i}" role="option" data-action="cmdk-run" data-i="${i}">${c.icon}<b>${esc(c.title)}</b>${c.hint ? `<small>${esc(c.hint)}</small>` : ''}<span class="gap"></span>${c.keys ? `<kbd>${esc(c.keys)}</kbd>` : ''}</div>`;
  }).join('') || `<div class="cmdk-none">${t('cmdk.none')}</div>`;
  markPalette(false);
}

function markPalette(scroll = true) {
  document.querySelectorAll<HTMLElement>('#cmdk-list .cmdk-it').forEach((el, i) => {
    el.setAttribute('aria-selected', String(i === cmdk.i));
    if (i === cmdk.i && scroll) el.scrollIntoView({ block: 'nearest' });
  });
  const input = $('#cmdk-q');
  if (cmdk.shown.length) input.setAttribute('aria-activedescendant', `cmdk-${cmdk.i}`); else input.removeAttribute('aria-activedescendant');
  if (!scroll) $('#cmdk-list').scrollTop = 0;
}

function closePalette(restore = true) {
  if (!cmdk.open) return;
  cmdk.open = false;
  const root = $('#cmdk');
  root.hidden = true;
  root.innerHTML = '';
  if (restore && cmdk.back?.isConnected) cmdk.back.focus({ preventScroll: true });
  cmdk.back = null;
}

function runPalette(i: number) {
  const c = cmdk.shown[i];
  if (!c) return;
  closePalette(false);
  // Settings covers the window: leave it for anywhere else, stay in it for one of its own panes.
  if (ui.settingsShown && !c.id.startsWith('set:')) closeSettings();
  c.run();
}

/** Keys while the palette is open. Typing goes to its field; the window's other shortcuts wait. */
function paletteKeys(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); cmdk.i = stepIndex(cmdk.i, e.key === 'ArrowDown' ? 1 : -1, cmdk.shown.length); markPalette(); return; }
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); runPalette(cmdk.i); return; }
  if (e.key === 'Tab') { e.preventDefault(); $('#cmdk-q').focus(); }
}

/* ---------- render all ---------- */

/** Shows a view tab. Navigation goes through go(), which calls this. */
function setView(v: View) {
  ui.view = v;
  document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  document.querySelectorAll<HTMLElement>('.view').forEach((el) => { el.hidden = el.dataset.view !== v; });
  if (v === 'memory') void loadMemory();
  renderAll(true);
}

function renderAll(force = false) {
  if (!S) return;
  const langChanged = ui.langApplied !== lang();
  applyStaticText();
  // Don't overwrite the preview while Settings is open.
  if (!ui.settingsShown) applyFont(S.settings.fontFamily, S.settings.fontSize);
  if (langChanged) force = true;
  // A focused row is drawn again as a new element; the focus goes to the one that took its place.
  const focused = document.activeElement instanceof HTMLElement && document.activeElement.matches('div[data-action][tabindex]') ? document.activeElement : null;
  const focusKey = focused ? `div[data-action="${focused.dataset.action}"][tabindex]${focused.dataset.id ? `[data-id="${CSS.escape(focused.dataset.id)}"]` : ''}${focused.dataset.v ? `[data-v="${CSS.escape(focused.dataset.v)}"]` : ''}` : '';
  const focusRoot = focused?.closest<HTMLElement>('.sidebar, .view');
  applyPanels();
  renderSidebar();
  renderUsage();
  renderMemSync();
  if (ui.cancelAsk) renderCancelDialog();
  if (ui.view === 'chat') { renderChat(force); renderChatInspector(); }
  if (ui.view === 'worker') { renderWorkerList(); renderSession(force); renderWorkerInspector(); }
  if (ui.view === 'repo') renderRepos();
  if (ui.view === 'memory' && force) renderMemory();
  if (focused && !focused.isConnected && document.activeElement === document.body) focusRoot?.querySelector<HTMLElement>(focusKey)?.focus({ preventScroll: true });
}

function openWorker(id: string) {
  if (!id) return;
  go({ view: 'worker', wSel: id, wOpen: true });
}

/* ---------- screen history: Back and Forward (decision 81) ---------- */

const nav = new History<Screen>(sameScreen);
const navInput = new NavInput();

function screen(): Screen {
  return { view: ui.view, wSel: ui.wSel, wOpen: ui.wOpen, wTab: ui.wTab, repoSel: ui.repoSel, memSel: ui.memSel, wFilter: ui.wFilter };
}

/**
 * Every user navigation goes through here: a view tab, a Worker's conversation opened or closed, its
 * Chat/Changes tab, a repository or memory file picked, a Worker list filter. The screen it leaves goes
 * on the Back stack. A new view (a tab, a list filter) adds its field to Screen and navigates with go().
 */
function go(next: Partial<Screen>) {
  const from = screen();
  const to = { ...from, ...next };
  nav.push(from, to);
  show(to, from);
}

/** Puts a screen on the window, loading what it needs that `from` did not show. */
function show(to: Screen, from: Screen) {
  const conv = (s: Screen) => (s.view === 'worker' && s.wOpen ? s.wSel : null);
  Object.assign(ui, to);
  const opened = conv(to);
  if (opened && opened !== conv(from)) { ui.lastLogKey = ''; void loadLog(opened); }
  if (to.wTab !== from.wTab) ui.lastLogKey = '';
  // Fresh changes each time a Worker's Changes tab comes on screen.
  if (to.wTab === 'changes' && to.wSel && (from.wTab !== 'changes' || from.wSel !== to.wSel)) ui.diffs.delete(to.wSel);
  if (to.memSel !== from.memSel) {
    ui.memText = '';
    if (to.memSel) void readMemFile(to.memSel);
  }
  setView(to.view);
}

async function readMemFile(id: string) {
  const text = await call<string>('memory:read', id);
  if (ui.memSel === id) { ui.memText = text ?? ''; renderMemory(); }
}

/** What a saved screen looks like now: a removed repository is deselected; a Worker that is gone too, and its conversation dropped. */
function stillThere(s: Screen): Screen | null {
  if (s.repoSel && !S?.repos.some((r) => r.name === s.repoSel)) s = { ...s, repoSel: null };
  if (!s.wSel || worker(s.wSel)) return s;
  return s.view === 'worker' && s.wOpen ? null : { ...s, wSel: null, wOpen: false };
}

/** Back or Forward, from a mouse side button, the OS, or a shortcut. */
function navStep(dir: NavDir, src: NavSource) {
  if (!navInput.accept(src, dir, performance.now())) return;
  closePop();
  $('#ctxmenu').hidden = true;
  // A sheet or dialog on top: Back closes it first, Forward waits until it is gone. Neither is a history entry.
  if (ui.settingsShown || ui.cancelAsk) {
    if (dir === 'forward') return;
    if (ui.cancelAsk) { ui.cancelAsk = null; renderCancelDialog(); } else closeSettings();
    return;
  }
  const cur = screen();
  const to = dir === 'back' ? nav.goBack(cur, stillThere) : nav.goForward(cur, stillThere);
  if (to) show(to, cur);
}

/** The Back/Forward shortcut: ⌘[ and ⌘] on macOS; Alt+← and Alt+→ elsewhere, but not while typing in a field. */
function navKey(e: KeyboardEvent): NavDir | null {
  if (e.isComposing || e.shiftKey || e.ctrlKey) return null;
  if (isMac) return e.metaKey && !e.altKey ? (e.code === 'BracketLeft' ? 'back' : e.code === 'BracketRight' ? 'forward' : null) : null;
  if (!e.altKey || e.metaKey || (e.target as HTMLElement).matches?.('input, textarea, select, [contenteditable]')) return null;
  return e.key === 'ArrowLeft' ? 'back' : e.key === 'ArrowRight' ? 'forward' : null;
}

/* ---------- actions ---------- */

async function act(el: HTMLElement, e: Event) {
  const a = el.dataset.action!;
  const id = el.dataset.id ?? '';
  switch (a) {
    case 'view': go({ view: el.dataset.v as View }); break;
    case 'worker-filter': go({ view: 'worker', wOpen: false, wFilter: (el.dataset.v || null) as WorkerFilter | null }); break;
    case 'open-settings': openSettings(); break;
    case 'side-toggle': togglePanel('side'); break;
    case 'reply': {
      const box = el.dataset.box === 'ws' ? 'ws' : 'chat';
      const r = { who: el.dataset.who ?? '', quote: el.dataset.quote ?? '' };
      if (box === 'ws') ui.reply.ws = { ...r, wid: ui.wSel ?? '' }; else ui.reply.chat = r;
      renderReply(box);
      $(box === 'chat' ? '#chat-input' : '#ws-input').focus();
      break;
    }
    case 'reply-cancel': {
      const box = el.dataset.box === 'ws' ? 'ws' : 'chat';
      ui.reply[box] = null;
      renderReply(box);
      $(box === 'chat' ? '#chat-input' : '#ws-input').focus();
      break;
    }
    case 'ins-tab': ui.insTab = el.dataset.v === 'memo' ? 'memo' : el.dataset.v === 'auto' ? 'auto' : 'inbox'; ui.memoEdit = null; ui.memoDel = null; renderChatInspector(); swapIn($('#chat-ins')); break;
    case 'memo-add': await addMemo(); break;
    case 'auto-add': await addAuto(); break;
    case 'cmp-changes': if (id) go({ view: 'worker', wSel: id, wOpen: true, wTab: 'changes' }); break;
    case 'cmp-pick': (el as HTMLButtonElement).disabled = true; await call('compare:pick', id); break;
    case 'auto-remove': if (ui.memoDel === id) { ui.memoDel = null; await call('auto:remove', id); } else askMemoDel(id ?? null); break;
    case 'memo-share': { const m = S!.memos.find((x) => x.id === id); if (m) await call('memo:update', id, { shared: !m.shared }); break; }
    case 'memo-edit': ui.memoEdit = id; ui.memoDel = null; renderChatInspector(); document.querySelector<HTMLTextAreaElement>(`[data-keep="memo-${id}"]`)?.focus(); break;
    case 'memo-edit-cancel': ui.memoEdit = null; renderChatInspector(); break;
    case 'memo-save': {
      const text = document.querySelector<HTMLTextAreaElement>(`[data-keep="memo-${id}"]`)?.value ?? '';
      ui.memoEdit = null;
      if (text.trim()) await call('memo:update', id, { text });
      renderChatInspector();
      break;
    }
    case 'memo-remove': if (ui.memoDel === id) await removeMemo(id!); else askMemoDel(id ?? null); break;
    case 'done-toggle': ui.doneOpen = !ui.doneOpen; store('oma.doneOpen', ui.doneOpen); renderSidebar(); break;
    case 'ins-toggle': togglePanel('ins'); break;
    case 'away-dismiss': away = null; renderChatInspector(); break;
    case 'cmdk-open': openPalette(); break;
    case 'cmdk-close': closePalette(); break;
    case 'cmdk-run': runPalette(Number(el.dataset.i)); break;
    case 'reveal-memory': await call('open:path', `${S!.settings.home}/memory`); break;
    case 'reveal-claude': if (ui.claude) await call('open:path', ui.claude.home); break;
    case 'ctx-menu': {
      const menu = $('#ctxmenu');
      if (!menu.hidden && menu.dataset.for === 'ctx') { menu.hidden = true; break; }
      const empty = !S!.dispatcher.contextTokens;
      menu.dataset.for = 'ctx';
      const spent = hasSpend(S!.dispatcher.spend) ? `<div class="note">${t('spend.dispatcher')}<br>${spendHtml(S!.dispatcher.spend)}</div><hr>` : '';
      menu.innerHTML = `${spent}<button data-action="ctx-compact"${empty ? ' disabled' : ''}>${t('ctx.compact')}</button><button data-action="ctx-clear"${empty ? ' disabled' : ''}>${t('ctx.clear')}</button>`;
      menu.hidden = false;
      const r = el.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${r.top - menu.offsetHeight - 6}px`;
      menu.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
      break;
    }
    case 'ctx-compact': $('#ctxmenu').hidden = true; await call('dispatcher:compact'); break;
    case 'ctx-clear': $('#ctxmenu').hidden = true; await call('dispatcher:clear'); break;
    case 'close-settings': closeSettings(); break;
    case 'pane': showPane(id as Pane); break;
    case 'goto-decision': {
      // In the view of the Worker that asks, its own panel shows the card.
      const here = ui.view === 'worker' && ui.wOpen && !!document.getElementById(`wdec-${id}`);
      if (!here) {
        // The card is in the inbox tab of the right sidebar: show both before looking for it.
        ui.insTab = 'inbox';
        if (ui.insMin) togglePanel('ins');
        go({ view: 'chat' });
        renderChatInspector();
      }
      const card = document.getElementById(`${here ? 'wdec' : 'dec'}-${id}`);
      card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      card?.classList.remove('flash'); void card?.offsetWidth; card?.classList.add('flash');
      break;
    }
    case 'open-worker': openWorker(id); break;
    case 'select-worker': openWorker(id); break;
    case 'close-session': go({ wOpen: false }); break;
    case 'ws-tab': go({ wTab: el.dataset.v as Screen['wTab'] }); break;
    case 'diff-refresh': ui.diffs.delete(id); renderSession(true); break;
    case 'issues-refresh': if (id) { ui.issues.delete(id); renderRepos(); } break;
    case 'issue-assign': {
      const list = id ? ui.issues.get(id) : undefined;
      const issue = Array.isArray(list) ? list.find((i) => i.number === Number(el.dataset.n)) : undefined;
      if (!id || !issue) break;
      (el as HTMLButtonElement).disabled = true;
      await call('chat:send', issueMessage(id, issue), []);
      toast(t('issue.sent', { n: issue.number }));
      go({ view: 'chat' });
      break;
    }
    case 'jira-token-clear': await call('jira:token', ''); jira = undefined; S!.settings.jiraTokenSet = false; openSettings(); break;
    case 'jira-refresh': void loadJira(); renderRepos(); break;
    case 'jira-assign': {
      const issue = Array.isArray(jira) ? jira.find((i) => i.key === id) : undefined;
      if (!issue) break;
      (el as HTMLButtonElement).disabled = true;
      await call('chat:send', jiraMessage(issue), []);
      toast(t('jira.sent', { key: issue.key }));
      go({ view: 'chat' });
      break;
    }
    case 'run-start': await call('run:start', id); break;
    case 'run-stop': await call('run:stop', id); break;
    case 'run-clear': await call('run:clear', id); break;
    case 'pr-merge': {
      if (!id) break;
      if (ui.mergeAsk !== id) { ui.mergeAsk = id; renderAll(true); break; }
      ui.mergeAsk = null;
      ui.merging.add(id);
      renderAll(true);
      await call('pr:merge', id);
      ui.merging.delete(id);
      renderAll(true);
      break;
    }
    case 'pr-merge-all': {
      if (ui.mergeAsk !== '*') { ui.mergeAsk = '*'; renderAll(true); break; }
      ui.mergeAsk = null;
      const list = readyToMerge(S!.tasks);
      ui.merging.add('*');
      for (const x of list) ui.merging.add(x.id);
      renderAll(true);
      // One after another: each merge can change whether the next is still ready, and the app checks again before each.
      let merged = 0;
      for (const x of list) {
        try { await ide.call('pr:merge', x.id); merged++; } catch { /* counted below */ }
        ui.merging.delete(x.id);
        renderAll(true);
      }
      ui.merging.delete('*');
      toast(merged === list.length ? t('pr.mergedAll', { n: merged }) : t('pr.mergedSome', { n: merged, m: list.length - merged }), merged !== list.length);
      renderAll(true);
      break;
    }
    case 'diff-note': {
      // Selecting text in the diff is not a click on its line.
      if (String(getSelection() ?? '')) break;
      const w = worker(ui.wSel);
      if (!w || !id) break;
      ui.diffDraft = { wid: w.id, path: id.slice(w.id.length + 1), at: Number(el.dataset.i) };
      renderDiff(w);
      $<HTMLTextAreaElement>('#dnote-in')?.focus();
      break;
    }
    case 'ckpt-menu': if (id) await openCheckpoints(el, id); break;
    case 'ckpt-cancel': { ui.ckptAsk = null; const w = worker(ui.wSel); if (w) renderDiff(w); break; }
    case 'ckpt-restore': {
      const a = ui.ckptAsk;
      if (!a) break;
      (el as HTMLButtonElement).disabled = true;
      const done = await call('worker:restore', a.wid, a.ref).then(() => true, () => false);
      ui.ckptAsk = null;
      ui.diffs.delete(a.wid);
      if (done !== false) toast(t('ckpt.done', { t: hhmm(a.at) }));
      renderSession(true);
      break;
    }
    case 'diff-note-add': addDiffNote(); break;
    case 'diff-note-cancel': { ui.diffDraft = null; const w = worker(ui.wSel); if (w) renderDiff(w); break; }
    case 'diff-note-del': {
      const w = worker(ui.wSel);
      if (!w || !id) break;
      const path = id.slice(w.id.length + 1), at = Number(el.dataset.i);
      ui.diffNotes.set(w.id, (ui.diffNotes.get(w.id) ?? []).filter((n) => !(n.path === path && n.at === at)));
      renderDiff(w);
      break;
    }
    case 'diff-notes-send': {
      const w = worker(ui.wSel);
      const msg = w ? reviewMessage(ui.diffNotes.get(w.id) ?? []) : '';
      if (!w || !msg) break;
      (el as HTMLButtonElement).disabled = true;
      await call('worker:send', w.id, msg, []);
      ui.diffNotes.delete(w.id);
      ui.diffDraft = null;
      go({ wTab: 'chat' });
      break;
    }
    case 'diff-file': {
      if (ui.diffOpen.has(id)) ui.diffOpen.delete(id); else ui.diffOpen.add(id);
      const w = worker(ui.wSel);
      if (w) renderDiff(w);
      break;
    }
    case 'answer': {
      el.closest('.dec')?.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
      await call('decision:answer', id, el.dataset.val);
      break;
    }
    case 'queue-prompt': {
      if (!ui.qOpen.delete(id)) ui.qOpen.add(id);
      renderWorkerInspector();
      document.querySelector<HTMLButtonElement>(`[data-action="queue-prompt"][data-id="${CSS.escape(id)}"]`)?.focus();
      break;
    }
    case 'plan-toggle': {
      if (!ui.planOpen.delete(id)) ui.planOpen.add(id);
      renderChatInspector();
      document.querySelector<HTMLButtonElement>(`[data-action="plan-toggle"][data-id="${CSS.escape(id)}"]`)?.focus();
      break;
    }
    case 'open-url': e.preventDefault(); await call('open:external', el.dataset.href); break;
    case 'open-file': e.preventDefault(); await call('open:path', el.dataset.path); break;
    case 'reveal': e.preventDefault(); await call('reveal:path', el.dataset.path); break;
    case 'unattach': {
      const box = el.dataset.box as Box;
      ui.attach[box].splice(Number(el.dataset.i), 1);
      renderChips(box);
      break;
    }
    case 'page-more': {
      // A "Show more" button (moreBtn): the next page of its list. Focus moves to the button that replaces it,
      // below the new items, without scrolling there, so the list stays where the new items start.
      const key = el.dataset.page ?? '';
      if (key === 'mem-hits') await searchMem(ui.memQ, ui.memHits?.length ?? 0);
      else {
        const n = Number(el.dataset.n) || 1;
        ui.pages.set(key, shownOf(key, n) + n);
        renderAll();
      }
      document.querySelector<HTMLElement>(`[data-action="page-more"][data-page="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
      break;
    }
    case 'page-older': if (el.dataset.v === 'chat') void olderChat(); else if (ui.wSel) void olderLog(ui.wSel); break;
    case 'clear': {
      const kind = el.dataset.kind as 'result' | 'auto';
      const ids = kind === 'auto' ? S!.autoAnswers.filter((x) => !x.cleared).map((x) => x.id) : S!.results.map((c) => c.id);
      ui.undo.push({ kind, ids });
      await call('chat:clear', kind);
      toast(t(kind === 'auto' ? 'toast.clearedAuto' : 'toast.clearedResults', { key: isMac ? '⌘Z' : 'Ctrl+Z' }));
      break;
    }
    case 'aa-select': {
      if (ui.view !== 'chat') go({ view: 'chat' });
      ui.aaSel = id;
      // An older one may be past the pages shown.
      const at = visibleAutos().findIndex((x) => x.id === id);
      if (at >= 0) ui.pages.set('autos', pagesFor(at, shownOf('autos', PAGE.autos), PAGE.autos));
      renderChatInspector();
      document.getElementById(`aa-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      break;
    }
    case 'aa-edit': ui.aaEdit = id; ui.aaSel = id; renderChatInspector(); (document.querySelector(`[data-keep="aa-${id}"]`) as HTMLInputElement | null)?.focus(); break;
    case 'aa-cancel': ui.aaEdit = null; renderChatInspector(); break;
    case 'sug-edit': ui.sugEdit = id; renderChatInspector(); document.querySelector<HTMLInputElement>(`[data-keep="sug-${id}"]`)?.focus(); break;
    case 'sug-cancel': ui.sugEdit = null; renderChatInspector(); break;
    case 'sug-save': await saveSug(id); break;
    case 'sug-dismiss': await call('suggest:dismiss', id); break;
    case 'aa-send': {
      const inp = document.querySelector<HTMLInputElement>(`[data-keep="aa-${id}"]`);
      const v = inp?.value.trim();
      if (!v) { inp?.focus(); return; }
      const scope = (document.querySelector<HTMLInputElement>(`input[name="scope-${id}"]:checked`)?.value ?? 'once') as 'once' | 'preference';
      ui.aaEdit = null;
      await call('auto:correct', id, v, scope);
      break;
    }
    case 'worker-stop': await call('worker:stop', id); break;
    case 'task-cancel': ui.cancelAsk = { ids: [id], all: false }; renderCancelDialog(); break;
    case 'queue-clear': ui.cancelAsk = { ids: [], all: true }; renderCancelDialog(); break;
    case 'cancel-dismiss': ui.cancelAsk = null; renderCancelDialog(); break;
    case 'cancel-ok': await confirmCancel(); break;
    case 'worker-archive': await call('worker:archive', id); break;
    case 'worker-unarchive': await call('worker:unarchive', id); break;
    case 'worker-msg': openWorker(id); setTimeout(() => $('#ws-input').focus(), 30); break;
    case 'repo-select': if (!ui.repoAdding) ui.repoAdd = false; go({ repoSel: id }); renderRepos(); break;
    case 'repo-add-open': ui.repoAdd = true; renderRepos(); $('#repo-add-url').focus(); break;
    case 'repo-add-cancel': ui.repoAdd = false; renderRepos(); break;
    case 'repo-add-pick': {
      const p = await call<string | null>('repo:pickFolder');
      if (p) { $<HTMLInputElement>('#repo-add-url').value = p; $<HTMLInputElement>('#repo-add-url').focus(); }
      break;
    }
    case 'repo-add': await addRepo(); break;
    case 'repo-save': await call('repo:update', id, $<HTMLTextAreaElement>('#repo-desc').value, $<HTMLTextAreaElement>('#repo-setup').value, $<HTMLTextAreaElement>('#repo-run').value); toast(t('toast.descSaved')); break;
    case 'repo-remove': {
      if (!confirm(t('confirm.repoRemove', { name: id }))) return;
      await call('repo:remove', id);
      ui.repoSel = null;
      break;
    }
    // Picking the open file again reads it again (a Worker may have changed it).
    case 'mem-select': if (ui.memSel === id) void readMemFile(id); else go({ memSel: id }); break;
    case 'mem-sync': await call('memory:sync'); break;
    case 'mem-save': {
      if (!ui.memSel) return;
      ui.memText = $<HTMLTextAreaElement>('#mem-edit').value;
      await call('memory:write', ui.memSel, ui.memText);
      toast(t('toast.memSaved'));
      void loadMemory();
      break;
    }
    case 'mem-promote': {
      if (!S!.repos.some((r) => r.name === id)) { toast(t('err.noRepo', { name: id }), true); return; }
      const tid = await call<string>('memory:promote', id);
      if (tid) toast(t('toast.promoted', { id: tid }));
      break;
    }
    case 'acc-add': {
      const r = await call('account:add', $<HTMLInputElement>('#acc-label').value, 'token', $<HTMLInputElement>('#acc-token').value, $<HTMLInputElement>('#acc-plan').value);
      if (r) { $<HTMLInputElement>('#acc-token').value = ''; $<HTMLInputElement>('#acc-label').value = ''; toast(t('toast.accAdded')); }
      break;
    }
    case 'acc-add-login': {
      const r = await call('account:add', $<HTMLInputElement>('#acc-label').value || t('acc.loginName'), 'login', '', $<HTMLInputElement>('#acc-plan').value);
      if (r) { $<HTMLInputElement>('#acc-label').value = ''; ui.accKind = 'token'; toast(t('toast.loginAdded')); }
      break;
    }
    case 'acc-add-chatgpt': {
      const r = await call('account:addChatgpt', $<HTMLInputElement>('#acc-label').value);
      if (r) { $<HTMLInputElement>('#acc-label').value = ''; ui.accKind = 'token'; toast(t('toast.chatgptAdded')); void loadModels('now'); }
      break;
    }
    case 'acc-menu': ui.accMenu = ui.accMenu === id ? null : id; ui.accRename = null; openSettings(); break;
    case 'acc-dismiss': ui.accMenu = null; ui.accRename = null; openSettings(); break;
    case 'acc-rename': ui.accMenu = null; ui.accRename = id; openSettings(); break;
    case 'acc-rename-cancel': ui.accRename = null; openSettings(); break;
    case 'acc-rename-save': {
      const nv = ($('#acc-rename') as HTMLInputElement | null)?.value.trim();
      ui.accRename = null;
      if (nv) await call('account:rename', id, nv);
      openSettings();
      break;
    }
    case 'acc-refresh': ui.accMenu = null; openSettings(); await call('account:refresh'); break;
    case 'acc-plan': ui.accMenu = null; openSettings(); await call('account:plan', id, el.dataset.v); break;
    case 'acc-remove': ui.accMenu = null; ui.accRemove = id; openSettings(); break;
    case 'acc-remove-cancel': ui.accRemove = null; openSettings(); break;
    case 'acc-remove-ok': ui.accRemove = null; openSettings(); await call('account:remove', id); break;
    case 'pick-home': {
      const p = await call<string | null>('settings:pickHome');
      if (p) { $<HTMLInputElement>('#set-home').value = p; void saveSettingsNow(); }
      break;
    }
    case 'pick-sound': {
      const p = await call<string | null>('sound:pick');
      if (p) { $<HTMLInputElement>('#set-sfile').value = p; void saveSettingsNow(); }
      break;
    }
    case 'restart-later': ui.restartAsk = false; openSettings(); break;
    case 'restart-now': await call('app:relaunch'); break;
    case 'models-refresh': void loadModels('now'); break;
    case 'font-reset': {
      $<HTMLInputElement>('#set-font').value = '';
      $<HTMLInputElement>('#set-fsize').value = String(FONT_SIZE_DEFAULT);
      previewFont();
      void saveSettingsNow();
      break;
    }
    case 'sound-test': {
      const f = readSettingsForm();
      await playSound(f.sound, f.soundVolume, f.customSound);
      break;
    }
  }
}

/** The composer grows with its text up to half the window; past that it scrolls with no visible bar. */
function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = Math.min(Math.round(window.innerHeight * 0.5), el.scrollHeight) + 'px';
}

function bindComposer(box: Box, formSel: string, inputSel: string, send: (text: string, files: string[]) => Promise<void> | void) {
  const form = $<HTMLFormElement>(formSel);
  const input = $<HTMLTextAreaElement>(inputSel);
  // The composer floats over the end of its thread, so the thread keeps that much room below the last message.
  const host = form.parentElement!;
  const thread = host.querySelector<HTMLElement>('.thread');
  new ResizeObserver(() => {
    const h = `${form.offsetHeight}px`;
    if (host.style.getPropertyValue('--composer-h') === h) return;
    const atEnd = !!thread && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
    host.style.setProperty('--composer-h', h);
    if (thread && atEnd) scrollQuietly(thread, thread.scrollHeight);
  }).observe(form);
  input.addEventListener('input', () => { autosize(input); updateSendButton(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const files = [...ui.attach[box]];
    const text = input.value.trim() || (files.length ? t('attach.defaultText') : '');
    if (!text) return;
    input.value = '';
    ui.attach[box] = [];
    renderChips(box);
    autosize(input);
    updateSendButton();
    await send(text, files);
  });
}

/** Files dropped anywhere go to the visible composer; never let the window navigate to them. */
function bindDrop() {
  let depth = 0;
  const target = (): Box | null => (ui.settingsShown ? null : ui.view === 'chat' ? 'chat' : ui.view === 'worker' && ui.wOpen && ui.wSel ? 'ws' : null);
  const setHot = (on: boolean) => {
    const box = target();
    document.querySelectorAll('.composer').forEach((c) => c.classList.remove('drop'));
    if (on && box) $(box === 'chat' ? '#chat-form' : '#ws-form').classList.add('drop');
  };
  document.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; setHot(true); } });
  document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) setHot(false); });
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = target() ? 'copy' : 'none';
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    setHot(false);
    const box = target();
    if (!box) { toast(t('attach.where'), true); return; }
    addFiles(box, e.dataTransfer?.files ?? null);
    $(box === 'chat' ? '#chat-input' : '#ws-input').focus();
  });
}

function init() {
  document.body.classList.add(`platform-${ide.platform}`);
  // Before the first paint, so a sidebar that was put away does not animate shut at launch.
  applyPanels();
  document.addEventListener('click', (e) => {
    const tgt = e.target as HTMLElement;
    const segBtn = tgt.closest<HTMLButtonElement>('[data-segc]');
    if (segBtn) { pickSeg(segBtn); return; }
    const dd = tgt.closest<HTMLElement>('[data-dd]');
    if (dd) { openModelPicker(dd); return; }
    const combo = tgt.closest<HTMLElement>('[data-combo]');
    if (combo) {
      const inp = document.getElementById(combo.dataset.combo!) as HTMLInputElement;
      if (pop.owner === inp) closePop(); else { inp.focus(); void openFontPicker(inp, false); }
      return;
    }
    if (tgt.id === 'set-font' && pop.owner !== tgt) { void openFontPicker(tgt as HTMLInputElement, false); return; }
    const step = tgt.closest<HTMLElement>('[data-step]');
    if (step) { stepValue(step.dataset.for!, Number(step.dataset.step)); return; }
    if (pop.el && !pop.el.contains(tgt) && tgt !== pop.owner) closePop();
    if (ui.memoDel && !tgt.closest('.mact.del.sure')) askMemoDel(null);
    if (ui.mergeAsk && !tgt.closest('.prmerge.sure, .h-act.sure')) { ui.mergeAsk = null; renderAll(true); }
    const el = tgt.closest<HTMLElement>('[data-action]');
    if (el) void act(el, e);
    if (!(e.target as HTMLElement).closest('#ctxmenu, #chat-ctx') || el?.hasAttribute('data-close')) $('#ctxmenu').hidden = true;
  });
  document.addEventListener('change', async (e) => {
    const el = e.target as HTMLSelectElement;
    if (el.dataset.change === 'sound-kind') syncSoundRows();
    // The Jira token goes to the main process by itself and is cleared from the field: it is never part of the page's state.
    if (el.id === 'set-jtok') {
      const tok = (el as unknown as HTMLInputElement).value.trim();
      if (!tok) return;
      (el as unknown as HTMLInputElement).value = '';
      await call('jira:token', tok);
      jira = undefined;
      S!.settings.jiraTokenSet = true;
      openSettings();
      toast(t('set.jiraSaved'));
      return;
    }
    if (el.dataset.change === 'auto-toggle') { void call('auto:toggle', el.dataset.id, (el as unknown as HTMLInputElement).checked); return; }
    if (el.id === 'auto-wk') { ui.autoWk = (el as unknown as HTMLInputElement).checked; return; }
    if (el.id === 'auto-kind') { ui.autoKind = el.value === 'merged' ? 'merged' : 'daily'; renderChatInspector(); return; }
    if (el.dataset.change === 'acc-kind') { ui.accKind = el.value as typeof ui.accKind; syncAccRows(); }
    if (el.id === 'set-gh') el.value = hostOnly(el.value);
    if (el.closest?.('#sheet')) void saveSettingsNow();
  });
  document.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'cmdk-q') { renderPalette(el.value); return; }
    if (el.id === 'set-qkey') el.classList.toggle('bad', normalizeQuickKey(el.value) === null);
    if (el.id === 'set-vol') syncSlider(el);
    if (el.id === 'set-fsize') previewFont();
    if (el.id === 'set-font') { markFont(el); previewFont(); void openFontPicker(el, false); }
    if (el.id === 'set-q') { ui.setQ = el.value; filterPanes(); return; }
    if (el.closest('#sheet') && el.id !== 'set-home') saveSoon(el.matches('.step-v, .slider') ? 300 : 600);
  });
  document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.addEventListener('click', () => go({ view: b.dataset.v as View })));
  // Mouse side buttons step through the screen history. Their default (the page's own history) is blocked.
  const sideButton = (e: MouseEvent) => e.button === 3 || e.button === 4;
  document.addEventListener('mousedown', (e) => { if (sideButton(e)) e.preventDefault(); });
  document.addEventListener('auxclick', (e) => { if (sideButton(e)) e.preventDefault(); });
  document.addEventListener('mouseup', (e) => {
    if (!sideButton(e)) return;
    e.preventDefault();
    navStep(e.button === 3 ? 'back' : 'forward', 'mouse');
  });
  ide.onNav((dir) => navStep(dir, 'os'));
  // Liquid Glass pills follow every change of selection, however the control was updated.
  new MutationObserver(() => glideSoon(true)).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-pressed', 'aria-checked', 'aria-selected', 'hidden'] });
  window.addEventListener('resize', () => glideAll(false));
  void document.fonts.ready.then(() => glideAll(false));
  void loadModels('cached');
  $('#sheet').addEventListener('scroll', () => closePop(), true);
  const usage = $('#usage');
  usage.addEventListener('mouseover', (e) => {
    if (!usage.classList.contains('usage')) return;
    showUsagePop();
    hoverUsage((e.target as HTMLElement).closest<HTMLElement>('.uacct')?.dataset.id ?? null);
  });
  usage.addEventListener('mouseleave', hideUsagePop);
  usage.addEventListener('focus', () => { if (usage.matches(':focus-visible')) showUsagePop(); });
  usage.addEventListener('blur', hideUsagePop);
  window.addEventListener('resize', () => closePop());
  // Scroll events don't bubble; capturing on document sees every scrolling element.
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });

  // Enter in an input runs the action named in data-enter.
  document.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    // Ctrl/Cmd+K opens the palette from anywhere, and closes it.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyK') { e.preventDefault(); if (cmdk.open) closePalette(); else openPalette(); return; }
    if (cmdk.open) { paletteKeys(e); return; }
    if (popKeys(e)) return;
    // A row that acts on a click does the same on Enter or Space; a link does on Enter.
    if ((e.key === 'Enter' || e.key === ' ') && !e.isComposing && el.matches?.('div[data-action][tabindex]')) { e.preventDefault(); void act(el, e); return; }
    if (e.key === 'Enter' && !e.isComposing && el.matches?.('a[data-action][tabindex]')) { e.preventDefault(); void act(el, e); return; }
    // Ctrl/Cmd+B puts the left sidebar away, with Alt the right one. Not while Settings covers them.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyB' && !ui.settingsShown) { e.preventDefault(); togglePanel(e.altKey ? 'ins' : 'side'); return; }
    if (el.id === 'set-font' && e.key === 'ArrowDown') { e.preventDefault(); void openFontPicker(el as HTMLInputElement, true); return; }
    if (el.classList.contains('step-v') && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); stepValue(el.id, e.key === 'ArrowUp' ? 1 : -1); return; }
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && el.dataset?.enter && !(e.shiftKey && el.tagName === 'TEXTAREA')) {
      e.preventDefault();
      if (el.dataset.enter === 'answer-custom') {
        const v = (el as HTMLInputElement).value.trim();
        if (v) void call('decision:answer', el.dataset.id, v);
      } else if (el.dataset.enter === 'repo-add') {
        void addRepo();
      } else if (el.dataset.enter === 'diff-note-add') {
        addDiffNote();
      } else if (el.dataset.enter === 'memo-add') {
        void addMemo();
      } else if (el.dataset.enter === 'sug-save') {
        void saveSug(el.dataset.id ?? '');
      } else if (el.dataset.enter === 'aa-send') {
        void act(Object.assign(document.createElement('button'), { dataset: { action: 'aa-send', id: el.dataset.id } }) as HTMLElement, e);
      }
      return;
    }
    if (el.id === 'acc-rename' && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void act(Object.assign(document.createElement('button'), { dataset: { action: 'acc-rename-save', id: el.dataset.id } }) as HTMLElement, e);
      return;
    }
    if (e.key === 'Escape') {
      if (pop.el) { closePop(true); return; }
      hideUsagePop();
      if (ui.memoDel) askMemoDel(null);
      if (ui.mergeAsk) { ui.mergeAsk = null; renderAll(true); }
      if (ui.diffDraft) { ui.diffDraft = null; const w = worker(ui.wSel); if (w) renderDiff(w); return; }
      if (ui.cancelAsk) { ui.cancelAsk = null; renderCancelDialog(); return; }
      if (ui.settingsShown && (ui.accRemove || ui.accMenu || ui.accRename)) { ui.accRemove = ui.accMenu = ui.accRename = null; openSettings(); return; }
      if (ui.settingsShown) closeSettings();
      $('#ctxmenu').hidden = true;
      if (ui.aaEdit) { ui.aaEdit = null; renderChatInspector(); }
      if (ui.sugEdit) { ui.sugEdit = null; renderChatInspector(); }
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (el.matches('input, textarea')) return;
      const u = ui.undo.pop();
      if (u) { e.preventDefault(); void call('chat:unclear', u.kind, u.ids); toast(t('toast.undone')); }
    }
    if (mod && e.key === ',') { e.preventDefault(); openSettings(); }
    if (mod && /^[1-4]$/.test(e.key)) { e.preventDefault(); go({ view: (['chat', 'worker', 'repo', 'memory'] as const)[Number(e.key) - 1] }); }
    const dir = navKey(e);
    if (dir) { e.preventDefault(); navStep(dir, 'key'); }
  });

  // Context menu on auto-answers and sidebar Worker rows
  document.addEventListener('contextmenu', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-ctx="aa"], [data-ctx="worker"]');
    const menu = $('#ctxmenu');
    if (!el) { menu.hidden = true; return; }
    e.preventDefault();
    const id = el.dataset.id!;
    if (el.dataset.ctx === 'worker') {
      const w = worker(id);
      menu.dataset.for = 'worker';
      menu.innerHTML = `<button data-action="open-worker" data-id="${esc(id)}" data-close>${t('wk.open')}</button>${w && stoppable(w) ? `<button data-action="worker-stop" data-id="${esc(id)}" data-close>${t('wk.stop')}</button>` : ''}`;
      menu.style.left = `${Math.min(e.clientX, innerWidth - 200)}px`;
      menu.style.top = `${Math.min(e.clientY, innerHeight - 70)}px`;
      menu.hidden = false;
      return;
    }
    menu.dataset.for = 'aa';
    menu.innerHTML = `<button data-action="aa-edit" data-id="${id}">${t('aa.correct')}…</button><button data-action="view" data-v="memory">${t('aa.viewMemory')}</button>`;
    menu.style.left = `${Math.min(e.clientX, innerWidth - 200)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - 90)}px`;
    menu.hidden = false;
  });

  bindComposer('chat', '#chat-form', '#chat-input', async (text, files) => { await call('chat:send', takeReply('chat', text), files); });
  $('#chat-send').addEventListener('click', (e) => {
    if ($('#chat-send').classList.contains('stop')) { e.preventDefault(); void call('chat:stop'); }
  });
  bindComposer('ws', '#ws-form', '#ws-input', async (text, files) => {
    if (!ui.wSel) return;
    await call('worker:send', ui.wSel, takeReply('ws', text), files);
  });
  bindDrop();

  let memTimer: number | undefined;
  $<HTMLInputElement>('#mem-q').addEventListener('input', (e) => {
    clearTimeout(memTimer);
    const q = (e.target as HTMLInputElement).value.trim();
    memTimer = window.setTimeout(() => void searchMem(q), 200);
  });

  ide.onState((s) => {
    const firstSetup = !S && s.setupNeeded;
    const langChanged = S && S.settings.language !== s.settings.language;
    if (S) ui.chatOlder = slideOlder(ui.chatOlder, S.chat, s.chat, ui.chatFrom);
    const first = !S;
    S = s;
    // At launch: what happened since the app was last looked at, a quit included.
    if (first) checkAway();
    renderAll();
    // The settings sheet only depends on accounts; re-render it only when they change.
    const accKey = JSON.stringify(s.accounts) + s.setupNeeded;
    const accChanged = accKey !== ui.accKey;
    ui.accKey = accKey;
    if (firstSetup && !ui.settingsShown) openSettings('accounts');
    else if (ui.settingsShown && accChanged && !langChanged) openSettings();
  });
  ide.onWorkerLog((id, item) => {
    const l = ui.logs.get(id);
    if (l) l.push(item);
    if (ui.view === 'worker' && ui.wSel === id) renderSession();
  });
  ide.onDecisionAlert(() => {
    if (S) void playSound(S.settings.sound, S.settings.soundVolume, S.settings.customSound);
    document.querySelector('.sec-dec')?.classList.add('blink');
    $('#dec-count')?.classList.add('pulse');
    // The right sidebar stays hidden when a decision arrives; its button's count pulses instead.
    const badge = $('#ins-count');
    badge.classList.remove('pulse');
    void badge.offsetWidth;
    badge.classList.add('pulse');
    setTimeout(() => { document.querySelector('.sec-dec')?.classList.remove('blink'); }, 3500);
  });
  window.addEventListener('focus', () => { checkAway(); renderAll(); });
  // Looking away starts the clock; while the window has the focus it is kept current.
  window.addEventListener('blur', markSeen);
  setInterval(() => { if (document.hasFocus()) markSeen(); }, 60_000);
  setInterval(() => { if (S) { renderSidebar(); if (ui.view === 'worker') renderWorkerList(); } }, 60_000);

  void ide.call<AppState>('state').then((s) => {
    S = s;
    renderAll(true);
    if (s.setupNeeded) openSettings('accounts');
  });
}

init();
