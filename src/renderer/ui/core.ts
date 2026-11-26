// What every screen shares: the state the window holds, the bridge to the main process, text, small HTML helpers, scrolling, paging and sound.
import { NOTES } from '../../shared/sounds';
import type { AppState, ChatItem, ClaudeInfo, DiffView, MemoryFile, MemoryHit, ModelList, Task, Worker, WorkerLogItem, SoundName, Lang } from '../../shared/types';
import type { SideView } from '../../shared/side';
import type { TermView } from '../../shared/terminal';
import { tr, type Key } from '../../shared/i18n';
import { modelLabel as labelFor } from '../../shared/models';
import { linkify } from '../../shared/linkify';
import { mdHtml } from '../../shared/markdown';
import { type DiffNote } from '../../shared/diffComment';
import { type Issue } from '../../shared/issues';
import { type PermFilter } from '../../shared/retro';
import { parseReply, replyExcerpt, withReply, type Reply } from '../../shared/reply';
import { SIDE_WHO } from '../../shared/side';
import { slotsUsed, waitsForSlot } from '../../shared/slots';
import { restoreScroll, saveScroll } from '../../shared/scroll';
import { firstPage } from '../../shared/paging';
import { type NavDir, type Screen, type View, type WorkerFilter } from '../../shared/history';
import { init } from '../app';
import { go, screen, show } from './history';
import { ms } from './sidebar';
import { keepThreadFocus } from './thread';
import { receive, type Held, type Part, type StateMsg } from '../../shared/stateSync';

declare global {
  interface Window {
    ide: {
      platform: string;
      call<T = any>(channel: string, ...args: unknown[]): Promise<T>;
      onState(fn: (msg: StateMsg) => void): void;
      onWorkerLog(fn: (id: string, item: WorkerLogItem) => void): void;
      onSideState(fn: (v: SideView) => void): void;
      onTermState(fn: (v: TermView) => void): void;
      onDecisionAlert(fn: (loud: boolean) => void): void;
      /** A task-end notification was clicked: show that task's result card. */
      onOpenResult(fn: (taskId: string) => void): void;
      /** A task ended and may sound: play the task-end sound. */
      onDoneAlert(fn: () => void): void;
      /** Back or Forward from the OS (mouse side buttons and Back keys arrive as app commands on Windows and Linux). */
      onNav(fn: (dir: NavDir) => void): void;
      /** The window entered or left full screen (macOS hides the traffic lights then). */
      onFullScreen(fn: (on: boolean) => void): void;
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

/** The numbered state last taken from the main process (shared/stateSync.ts). */
let taken: Held | null = null;
let reread: ((msg: StateMsg) => void) | null = null;
let asking = false;
/** The newest message missed while the whole state was on its way. */
let behind = 0;

/**
 * Reads a state message from the main process: the state to draw and the parts that changed (null: all of them), or
 * null when it brings nothing to draw. After a missed message the whole state is asked for again; `again` reads it.
 */
export function readState(msg: StateMsg, again: (msg: StateMsg) => void): { state: AppState; parts: Set<Part> | null } | null {
  reread = again;
  const r = receive(taken, msg);
  if (r.step === 'resync') { behind = Math.max(behind, msg.seq); askWholeState(); }
  if (r.step !== 'take') return null;
  taken = r.held;
  return { state: r.held.state, parts: r.parts };
}

/**
 * Asks the main process for the whole state: after a missed message, and after a call that failed, since the window
 * may have changed its copy before the call (a setting) and parts that did not change are not sent again.
 */
function askWholeState() {
  const back = reread;
  if (asking || !back) return;
  asking = true;
  void ide.call<StateMsg>('state:full').then(back, () => {}).finally(() => {
    asking = false;
    // One missed while it was on its way that is newer than what it brought: ask once more.
    if (taken && behind > taken.seq) askWholeState();
  });
}

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
  /** Why the last add failed, shown in the form until the next try. */
  repoAddError: '',
  memSel: null as string | null,
  memFiles: [] as MemoryFile[],
  memHits: null as MemoryHit[] | null,
  /** The query memHits answer, and how many hits it has in all (they load a page at a time). */
  memQ: '',
  memTotal: 0,
  memText: '' as string,
  aaSel: null as string | null,
  /** The selected decision card in the inbox (it takes the keys), and the pending ids it was chosen among. */
  decSel: null as string | null,
  decIds: [] as string[],
  /** The decision just answered from its card: once it is gone, the focus goes to the next card. */
  decAnswered: null as { id: string; at: number } | null,
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
  /** Hand-out blocks the user opened or folded against their default (by their first line). */
  handToggled: new Set<string>(),
  /** Inbox results whose summary is shown in full. */
  resOpen: new Set<string>(),
  lastChatKey: '',
  lastHandKey: '',
  lastLogKey: '',
  settingsShown: false,
  pane: 'accounts' as Pane,
  attach: { chat: [] as string[], ws: [] as string[] },
  /** The chat composer is in shell mode ("!" typed first): Enter runs the line (ui/shell.ts). */
  shell: false,
  /** Where "!" lines run: a repository's name, or '' for the IDE home. */
  shellRepo: localStorage.getItem('oma.shellRepo') ?? '',
  /** Shell run blocks shown with all their kept lines. */
  shellOpen: new Set<string>(),
  /** stderr stretches opened past their first line (G2): "<run id>:<first line number>". */
  errOpen: new Set<string>(),
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
  /** The Summary tab shows the open Worker's tasks or the last seven days of every Worker's, and which permission decisions. */
  sumScope: 'worker' as 'worker' | 'week',
  permFilter: 'all' as PermFilter,
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
  /** A narrow window (I1, shared/panelWidth narrowLayout): the right sidebar is a drawer over the chat, the left one a
   *  rail. While so, sideMin and insMin are not kept: the stored choice comes back once the window is wide again. */
  drawer: false,
  rail: false,
  /** "Done today" in the sidebar shows its latest tasks (kept across launches). */
  doneOpen: stored('oma.doneOpen'),
  /** The chat view's right sidebar shows the inbox or the memos; the memo being edited, and the one asked about before deleting. */
  /** The message being answered in each composer; the Worker's is dropped when another Worker is opened. */
  reply: { chat: null as Reply | null, ws: null as (Reply & { wid: string }) | null },
  insTab: 'inbox' as 'inbox' | 'memo' | 'auto' | 'script',
  /** The Automations tab's add form: which trigger is picked, and weekdays only. */
  autoKind: 'daily' as 'daily' | 'merged',
  autoWk: false,
  /** The selected memo, and automation ('new': the add form), in the right sidebar (ui/panes.ts). */
  memoSel: null as string | null,
  autoSel: null as string | null,
  /** The automation being changed, with what its form's switches say; the text and the time keep themselves (data-keep). */
  autoEdit: null as { id: string; kind: 'daily' | 'merged'; wk: boolean } | null,
  /** The selected saved script ('new': the add form), and the one being edited (ui/scripts.ts). */
  scriptSel: null as string | null,
  scriptEdit: null as string | null,
  memoEdit: null as string | null,
  memoDel: null as string | null,
  /** The last chat item and Worker log length already drawn; what comes after them is new. */
  chatSeen: null as string | null,
  logSeen: null as { wid: string; n: number } | null,
  /** Asking before cancelling queued tasks: one task, or the whole queue. */
  cancelAsk: null as { ids: string[]; all: boolean } | null,
  /** The in-app confirm dialog for archiving a Worker or removing a repository; no OK label: it only explains. */
  confirmAsk: null as { title: string; body: string; ok: string | null; action: 'archive' | 'repo-remove' | 'ctx-clear'; id: string } | null,
  /** Open decisions the user chose to send a normal message past, and the ones the Worker composer has shown (M7). */
  decAsMessage: new Set<string>(),
  decSeen: new Set<string>(),
  /** The decision the Worker composer's strip names right now, which a send answers. */
  decShown: null as { wid: string; id: string } | null,
  /** Workers whose Stop was sent and has not come back yet: their Stop button waits. */
  stopping: new Set<string>(),
  /** Why the last send from a composer, a new memo or a new automation failed; shown until it is dismissed or sent again (L8). */
  sendErr: { chat: '', ws: '' } as Record<'chat' | 'ws', string>,
  formErr: { memo: '', auto: '', script: '' } as Record<'memo' | 'auto' | 'script', string>,
};

/* ---------- helpers ---------- */

export function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Escaped one-line text with `code` spans, for summaries written by agents. */
export function inline(s: unknown) {
  return esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

/**
 * The Reply button of an agent's message. `box` is the composer the reply is written in; `task` files the reply under
 * that report; `src` names the message, so it is ringed while it is being answered. Empty for a message with no text.
 */
export function replyBtn(box: 'chat' | 'ws', who: string, text: string, task?: string, src?: string) {
  const quote = replyExcerpt(text);
  if (!quote) return '';
  return `<button class="rbtn" data-action="reply" data-box="${box}" data-who="${esc(who)}" data-quote="${esc(quote)}"${task ? ` data-task="${esc(task)}"` : ''}${src ? ` data-src="${esc(src)}"` : ''} data-tip="${t('chat.reply')}"${box === 'chat' ? ' data-tip-key="R"' : ''} aria-label="${t('chat.reply')}"><svg aria-hidden="true"><use href="#s-reply"/></svg></button>`;
}

/** An agent's bubble with the Reply button beside it (replyBtn). */
export function replyable(bubble: string, box: 'chat' | 'ws', who: string, text: string, task?: string, src?: string, more = '') {
  const btn = replyBtn(box, who, text, task, src);
  return btn ? `<div class="bline"${src ? ` data-src="${esc(src)}"` : ''}>${bubble}${btn}${more}</div>` : bubble;
}

/** Whose message a quote is from, as shown: a side question's answer reads as one. */
export const whoLabel = (who: string) => (who === SIDE_WHO ? t('sq.from') : who);

/**
 * The quote card inside a composer while a reply is written: whose message, two lines of it, and a way out. The
 * message being answered is ringed in the thread (markReplyTarget).
 */
export function renderReply(box: 'chat' | 'ws') {
  if (box === 'ws' && ui.reply.ws && ui.reply.ws.wid !== ui.wSel) ui.reply.ws = null;
  const r = ui.reply[box];
  const el = $(box === 'chat' ? '#chat-reply' : '#ws-reply');
  el.hidden = !r;
  el.innerHTML = r ? `${r.icon ? sym(r.icon) : ''}<b>${esc(whoLabel(r.who))}</b><span>${esc(r.quote)}</span><button type="button" data-action="reply-cancel" data-box="${box}" data-tip="${t('reply.cancel')}" aria-label="${t('reply.cancel')}"><svg aria-hidden="true"><use href="#s-x"/></svg></button>` : '';
  el.classList.toggle('has-icon', !!r?.icon);
  markReplyTarget(box);
}

/** Rings the message a composer's reply answers, wherever its thread draws it (`data-src`). */
export function markReplyTarget(box: 'chat' | 'ws') {
  const th = document.querySelector(box === 'chat' ? '#chat-thread' : '#ws-thread');
  if (!th) return;
  const src = ui.reply[box]?.src;
  for (const el of th.querySelectorAll('.target')) if (el.getAttribute('data-src') !== src) el.classList.remove('target');
  if (src) for (const el of th.querySelectorAll(`[data-src="${CSS.escape(src)}"]:not([data-action="reply"])`)) el.classList.add('target');
}

/** The text to send from a composer, with the quote on top while a reply is open. The reply stays until the send succeeds. */
export function replyText(box: 'chat' | 'ws', text: string) {
  const r = ui.reply[box];
  return r ? withReply(r, text) : text;
}

/** A composer's last send failed, or it went (''): the error line above its text, until dismissed (L8). */
export function setSendErr(box: 'chat' | 'ws', msg: string) {
  ui.sendErr[box] = msg;
  const el = document.getElementById(box === 'chat' ? 'chat-err' : 'ws-err');
  if (!el) return;
  el.hidden = !msg;
  el.innerHTML = msg ? `${sym('s-alert', 'c-red')}<span>${esc(t('err.notSent', { msg }))}</span><button type="button" data-action="send-err-x" data-box="${box}" data-tip="${t('err.dismiss')}" aria-label="${t('err.dismiss')}"><svg aria-hidden="true"><use href="#s-x"/></svg></button>` : '';
}

/** Agent markdown: code blocks, headings, lists, tables, bold, italics, links, line breaks (shared/markdown.ts). */
export function md(src: string) {
  return mdHtml(src);
}

/**
 * What a reply quotes, at the top of its bubble: whose message and its first words. It goes back to the message
 * (goto-quote); a side question's answer has no message in the thread, so its quote only reads.
 */
export function quoteHtml(who: string, quote: string) {
  const inner = `<b>${esc(whoLabel(who))}</b><span>${esc(quote)}</span>`;
  return who === SIDE_WHO ? `<span class="bq">${inner}</span>` : `<button type="button" class="bq" data-action="goto-quote" data-who="${esc(who)}" data-quote="${esc(quote)}">${inner}</button>`;
}

/** A user message: plain text, with the "[Attached files]" block shown as file chips. */
export function userText(text: string): string {
  const reply = parseReply(text);
  if (reply) return `${quoteHtml(reply.who, reply.quote)}${userText(reply.body)}`;
  const i = text.indexOf('\n\n[Attached files]\n');
  if (i < 0) return linkify(esc(text));
  const files = text.slice(i).split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  return `${linkify(esc(text.slice(0, i)))}<span class="sent-files">${files.map((f) => `<a class="fchip" data-action="reveal" data-path="${esc(f)}" data-tip="${esc(f)}">${esc(base(f))}</a>`).join('')}</span>`;
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

/** A pill's tone as the attribute the stylesheet reads; none for the neutral pill. */
export const pillTone = (v: string) => (v ? ` data-tone="${v}"` : '');

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

/** "5m ago", and "just now" on its own: the word for under a minute already says when. */
export function agoText(iso: string) {
  const d = ago(iso);
  return d === t('time.now') ? d : t('time.ago', { d });
}

export function k(n: number) { return `${Math.round(n / 1000)}K`; }

export function ring(frac: number) {
  const v = Math.max(0, Math.min(100, frac * 100)).toFixed(1);
  return `<svg class="ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="trk" cx="10" cy="10" r="7.5"/><circle class="val" cx="10" cy="10" r="7.5" pathLength="100" stroke-dasharray="${v} 100" transform="rotate(-90 10 10)"/></svg>`;
}

/** A bar meter's `data-level` attribute: the same four steps as the rings; none while it is in the first one. */
export function meterLevel(v: number | null) {
  const l = v === null || v <= 30 ? '' : v <= 50 ? 'caution' : v <= 80 ? 'warn' : 'critical';
  return l ? ` data-level="${l}"` : '';
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
/** Every task the window knows of, open and finished. */
export const allTasks = (): readonly Task[] => S?.tasks ?? [];

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

export interface ToastAction { label: string; run: () => void }

/** At most this many toasts at once; a newer one pushes the oldest out. */
const TOAST_MAX = 3;

function dropToast(el: Element) {
  if (!el.isConnected || el.classList.contains('out')) return;
  el.classList.add('out');
  window.setTimeout(() => el.remove(), ms('--dur-base'));
}

/**
 * A short message over the composer. They stack, newest at the bottom, each on its own timer; `action` adds a button
 * (Undo). An error is announced at once and stays until it is dismissed.
 */
export function toast(text: string, err = false, action?: ToastAction) {
  const box = $('#toasts');
  // The same message again moves to the bottom instead of showing twice.
  for (const old of box.children) if (old.querySelector(':scope > span')?.textContent === text) old.remove();
  const el = document.createElement('div');
  el.className = `toast${err ? ' err' : ''}`;
  if (err) el.setAttribute('role', 'alert');
  const msg = document.createElement('span');
  msg.textContent = text;
  el.append(msg);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'linkbtn';
    b.textContent = action.label;
    b.addEventListener('click', () => { dropToast(el); action.run(); });
    el.append(b);
  }
  if (err) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'toast-x';
    x.setAttribute('aria-label', t('toast.dismiss'));
    x.innerHTML = '<svg aria-hidden="true"><use href="#s-x"/></svg>';
    x.addEventListener('click', () => dropToast(el));
    el.append(x);
  }
  box.append(el);
  // Past the limit the oldest go first, errors last: an error stays until it is dismissed.
  const live = [...box.children].filter((c) => !c.classList.contains('out'));
  const byAge = [...live.filter((c) => c.getAttribute('role') !== 'alert'), ...live.filter((c) => c.getAttribute('role') === 'alert')];
  for (const old of byAge.slice(0, Math.max(0, live.length - TOAST_MAX))) dropToast(old);
  if (!err) window.setTimeout(() => dropToast(el), action ? 6000 : 3000);
}

/** Reads a new agent message out to screen readers (#live), instead of making a whole thread a live region. */
export function announce(text: string) {
  const el = document.getElementById('live');
  if (!el || !text.trim()) return;
  el.textContent = '';
  // A change a moment later is read even when the text is the same as before.
  window.setTimeout(() => { el.textContent = oneLine(text, 300); }, 50);
}

/** The message of an error from the main process, without Electron's wrapping. */
export const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export async function call<T = any>(ch: string, ...args: unknown[]): Promise<T | undefined> {
  const r = await tryCall<T>(ch, ...args);
  if (r.ok) return r.v;
  toast(r.error, true);
  return undefined;
}

/** Like call(), but the caller shows the error where it belongs (L8): next to the text that was not sent. */
export async function tryCall<T = any>(ch: string, ...args: unknown[]): Promise<{ ok: true; v: T } | { ok: false; error: string }> {
  try {
    return { ok: true, v: await ide.call<T>(ch, ...args) };
  } catch (e) {
    askWholeState();
    return { ok: false, error: errText(e) };
  }
}

/* ---------- IME composition ---------- */

/** The field a composition (Korean, Japanese) is going on in, from compositionstart to compositionend. */
let composing: Element | null = null;
/** Draws put off until that composition ends: the latest one per panel. */
const held = new Map<Element, () => void>();
/** The composition is over: the draws held for it run, each through its own check again (a new one may have begun). */
function release() {
  composing = null;
  const due = [...held.values()];
  held.clear();
  // After the input event that carries the finished syllable.
  setTimeout(() => due.forEach((draw) => draw()), 0);
}
document.addEventListener('compositionstart', (e) => { composing = e.target as Element; }, true);
document.addEventListener('compositionend', release, true);
// A field left mid-syllable does not always say compositionend.
document.addEventListener('focusout', (e) => { if (e.target === composing) release(); }, true);

/**
 * Drawing a panel again replaces its fields. Replacing the one being composed in ends the composition: the IME
 * commits the half-built syllable and the next key starts a new one ("하" + "ㄴ" becomes "하ㄴ", not "한").
 * True when a composition is going on inside `root`; `draw` then runs once it ends, and the caller draws nothing now.
 */
export function holdWhileComposing(root: Element, draw: () => void, replaced = '[data-keep]'): boolean {
  if (composing && !composing.isConnected) release();
  // Only a field the draw replaces: a composition elsewhere in the root does not hold it.
  if (!composing || !root.contains(composing) || !composing.matches(replaced)) return false;
  held.set(root, draw);
  return true;
}

/** Keep typed values and focus across re-renders (inputs with data-keep, rows with data-focus), and scroll offsets (keepScroll). */
export function keepInputs(root: HTMLElement, render: () => void) {
  if (holdWhileComposing(root, () => keepInputs(root, render))) return;
  const vals = new Map<string, string>();
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-keep]').forEach((el) => vals.set(el.dataset.keep!, el.value));
  const active = document.activeElement as HTMLInputElement | null;
  const focusKey = active && root.contains(active) ? active.dataset.keep : undefined;
  const sel = focusKey ? [active!.selectionStart, active!.selectionEnd] : null;
  // A row that is not an input but holds the keyboard (data-focus) gets it back too.
  const rowKey = active && root.contains(active) && !focusKey ? active.dataset.focus : undefined;
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
    if (rowKey && !root.contains(document.activeElement)) root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(rowKey)}"]`)?.focus({ preventScroll: true });
  });
}

/* ---------- drawing only what changed (decision 140) ---------- */

/** Goes up each time the user does something, so the next draw of every panel is a real one. */
let drawTurn = 0;
export function userActed() { drawTurn++; }

/**
 * Makes a panel skip a write of the HTML it already shows. Every state update draws every panel of the screen
 * again by setting its innerHTML; most of the time a panel's HTML is the same as before, and writing it anyway
 * threw away the focus, text selections, scroll positions and running animations inside it.
 *
 * The panel's own `innerHTML` setter is replaced, so the code that draws it stays as it is. A write is skipped
 * only when the HTML is identical and the user has done nothing since the last write: after a click or a key,
 * the next draw always goes through, since handlers change the page by hand (a disabled button, a class) and
 * count on the draw to put it right.
 */
export function skipSameHtml(el: HTMLElement) {
  const native = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  if (!native?.get || !native.set) return;
  let last: string | null = null;
  let turn = -1;
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get() { return native.get!.call(el) as string; },
    set(html: string) {
      if (html === last && turn === drawTurn) return;
      last = html;
      turn = drawTurn;
      native.set!.call(el, html);
    },
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

/** What a thread drawn from pieces shows: each piece's HTML and the nodes made from it (setThread). */
const drawn = new WeakMap<HTMLElement, { pieces: { html: string; nodes: ChildNode[] }[]; touched: boolean }>();
/** Threads that already tell `touch` what the user does in them. */
const listening = new WeakSet<HTMLElement>();

/** What the user does that handlers answer by changing the page by hand (init in app.ts, and threads here). */
export const ACTS = ['click', 'keydown', 'input', 'change', 'drop', 'contextmenu'] as const;

/** The thread's nodes may no longer be what its pieces made (a handler, a loading line): draw them all again next time. */
function touch(th: Element) {
  const d = drawn.get(th as HTMLElement);
  if (d) d.touched = true;
}

function nodesOf(html: string): ChildNode[] {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return [...tpl.content.childNodes];
}

/**
 * Puts a thread's pieces in place (each a whole element or a few: a message, a time line, a branch with its
 * replies). A piece with the same HTML as last time keeps its elements, so a new message adds only its own and the
 * browser lays out only what changed. After the user did something inside the thread, or anything else changed its
 * elements, all of them are made again, as a draw from one string would.
 */
function placePieces(th: HTMLElement, pieces: string[]) {
  const was = drawn.get(th);
  if (!listening.has(th)) { listening.add(th); for (const type of ACTS) th.addEventListener(type, () => touch(th), true); }
  const old = new Map<string, ChildNode[][]>();
  if (was && !was.touched && was.pieces.every((p) => p.nodes.every((n) => n.parentNode === th))) {
    for (const p of was.pieces) old.set(p.html, [...(old.get(p.html) ?? []), p.nodes]);
  }
  const next = pieces.map((html) => ({ html, nodes: old.get(html)?.shift() ?? nodesOf(html) }));
  if (!old.size) th.replaceChildren(...next.flatMap((p) => p.nodes));
  else {
    const keep = new Set(next.flatMap((p) => p.nodes));
    for (const n of [...th.childNodes]) if (!keep.has(n)) n.remove();
    let at: ChildNode | null = th.firstChild;
    for (const p of next) for (const n of p.nodes) { if (n === at) at = at.nextSibling; else th.insertBefore(n, at); }
  }
  drawn.set(th, { pieces: next, touched: false });
}

/** Draws a thread from one string, or from pieces that keep their elements while their HTML stays the same. */
export function setThread(th: HTMLElement, html: string | string[], follow: boolean, older: boolean) {
  const fromEnd = th.scrollHeight - th.scrollTop;
  // The message that has the keyboard is a new element after this: the focus goes to the one in its place.
  const refocus = keepThreadFocus(th);
  if (typeof html === 'string') { drawn.delete(th); th.innerHTML = html; } else placePieces(th, html);
  if (older) scrollQuietly(th, th.scrollHeight - fromEnd);
  else if (follow) scrollQuietly(th, th.scrollHeight);
  refocus?.(older);
}

/** A field whose text cannot be used: the red outline, and the same said to a screen reader. */
export function markBad(el: Element | null, bad: boolean) {
  if (!el) return;
  el.classList.toggle('bad', bad);
  if (bad) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
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
  touch(th);
  const top = th.querySelector('.pg-top');
  if (top) top.textContent = t('page.loading');
}

/** Back to "Show earlier messages" when the page didn't come. */
export function unmarkLoading(th: HTMLElement) {
  touch(th);
  const top = th.querySelector('.pg-top');
  if (top) top.textContent = t('page.older');
}

/** Static text in index.html carries data-i18n / data-i18n-ph / data-i18n-tip keys. A tip is the control's name too. */
export function applyStaticText() {
  if (ui.langApplied === lang()) return;
  ui.langApplied = lang();
  document.documentElement.lang = lang();
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n as Key); });
  document.querySelectorAll<HTMLElement>('[data-i18n-ph]').forEach((el) => { (el as HTMLInputElement).placeholder = t(el.dataset.i18nPh as Key); });
  document.querySelectorAll<HTMLElement>('[data-i18n-tip]').forEach((el) => { const s = t(el.dataset.i18nTip as Key); el.dataset.tip = s; el.setAttribute('aria-label', s); });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria as Key)); });
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
  // An unknown stored name (hand-edited, or from a later version) plays nothing.
  for (const n of NOTES[name as keyof typeof NOTES] ?? []) tone(actx, n.freq, now + n.at, n.dur, v * n.gain, n.wave);
}
