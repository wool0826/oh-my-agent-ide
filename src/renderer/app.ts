import type { AppState, AutoAnswer, ChatItem, ClaudeInfo, Decision, DiffView, MemoryFile, MemoryHit, Task, Worker, WorkerLogItem, AccountView, SoundName, Lang } from '../shared/types';
import { ALLOW, DENY, EFFORTS, MAX_ACCOUNTS, type Effort } from '../shared/types';
import { tr, type Key } from '../shared/i18n';
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN, FONT_SUGGESTIONS, clampFontSize, fontStack, normalizeFontFamily } from '../shared/font';

declare global {
  interface Window {
    ide: {
      platform: string;
      call<T = any>(channel: string, ...args: unknown[]): Promise<T>;
      onState(fn: (s: AppState) => void): void;
      onWorkerLog(fn: (id: string, item: WorkerLogItem) => void): void;
      onDecisionAlert(fn: () => void): void;
      pathForFile(f: File): string;
    };
  }
}

const ide = window.ide;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const COMPACT_AT = 250_000;
const isMac = ide.platform === 'darwin';

let S: AppState | null = null;
const lang = (): Lang => S?.settings.language ?? 'en';
const t = (key: Key, vars?: Record<string, string | number>) => tr(lang(), key, vars);

type Pane = 'accounts' | 'general' | 'display' | 'alerts' | 'memory' | 'models';
const ui = {
  view: 'chat' as 'chat' | 'worker' | 'repo' | 'memory',
  wSel: null as string | null,
  wOpen: false,
  repoSel: null as string | null,
  memSel: null as string | null,
  memFiles: [] as MemoryFile[],
  memHits: null as MemoryHit[] | null,
  memText: '' as string,
  aaSel: null as string | null,
  aaEdit: null as string | null,
  logs: new Map<string, WorkerLogItem[]>(),
  undo: [] as { kind: 'result' | 'auto'; ids: string[] }[],
  lastChatKey: '',
  lastLogKey: '',
  settingsShown: false,
  pane: 'accounts' as Pane,
  attach: { chat: [] as string[], ws: [] as string[] },
  langApplied: '' as string,
  accKey: '' as string,
  accMenu: null as string | null,
  accRename: null as string | null,
  accRemove: null as string | null,
  setQ: '',
  version: '',
  claude: null as ClaudeInfo | null,
  accKind: 'token' as 'token' | 'login',
  wTab: 'chat' as 'chat' | 'changes',
  diffs: new Map<string, DiffView | 'loading' | null>(),
  diffOpen: new Set<string>(),
};

/* ---------- helpers ---------- */

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Escaped one-line text with `code` spans, for summaries written by agents. */
function inline(s: unknown) {
  return esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

function linkify(html: string) {
  return html.replace(/(https?:\/\/[^\s<>"')\]]+)/g, (u) => `<a data-action="open-url" data-href="${u}">${u}</a>`);
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
function userText(text: string) {
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
  const x = m.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:$|-\d{8}$)/);
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] ? `.${x[3]}` : ''}` : m;
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

let toastTimer: number | undefined;
function toast(text: string, err = false) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.toggle('err', err);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, err ? 6000 : 3000);
}

async function call<T = any>(ch: string, ...args: unknown[]): Promise<T | undefined> {
  try {
    return await ide.call<T>(ch, ...args);
  } catch (e) {
    toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    return undefined;
  }
}

/** Keep typed values and focus across re-renders. Only inputs with data-keep. */
function keepInputs(root: HTMLElement, render: () => void) {
  const vals = new Map<string, string>();
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-keep]').forEach((el) => vals.set(el.dataset.keep!, el.value));
  const active = document.activeElement as HTMLInputElement | null;
  const focusKey = active && root.contains(active) ? active.dataset.keep : undefined;
  const sel = focusKey ? [active!.selectionStart, active!.selectionEnd] : null;
  const scroll = root.scrollTop;
  render();
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-keep]').forEach((el) => {
    const v = vals.get(el.dataset.keep!);
    if (v !== undefined && el.type !== 'radio') el.value = v;
  });
  if (focusKey) {
    const el = root.querySelector<HTMLInputElement>(`[data-keep="${CSS.escape(focusKey)}"]`);
    if (el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not selectable */ } }
  }
  root.scrollTop = scroll;
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
  if (x?.status === 'queued' || x?.status === 'blocked') return ic('wait');
  if (x?.status === 'pr_open') return ic('pr');
  if (x?.status === 'done') return ic('done');
  return ic('idle');
}

function renderSidebar() {
  const s = S!;
  const pending = s.decisions.filter((d) => d.status === 'pending');
  const running = s.workers.filter((w) => w.status === 'running' || w.status === 'waiting' || w.status === 'starting' || w.status === 'error');
  const prs = s.tasks.filter((x) => x.status === 'pr_open');
  const queued = s.tasks.filter((x) => x.status === 'queued' || x.status === 'blocked');
  const todayStr = new Date().toDateString();
  const doneToday = s.tasks.filter((x) => (x.status === 'done' || x.status === 'pr_open') && x.finishedAt && new Date(x.finishedAt).toDateString() === todayStr).length;
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
    return `<div class="row" data-action="goto-decision" data-id="${d.id}">${ic('ask')}<span class="t"><b>${esc(oneLine(d.title, 60))}</b><small>${esc([d.workerId ?? 'Dispatcher', x?.title].filter(Boolean).join(', '))}</small></span></div>`;
  }).join('');
  const runRows = running.map((w) => {
    const x = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
    const what = x?.title ?? w.title;
    const small = w.status === 'error' ? `${w.id}, ${t('st.error')}` : w.status === 'waiting' ? `${w.id}, ${t('st.waitingMe')}` : `${w.repo ?? t('general')}, ${w.id}, ${ago(x?.updatedAt ?? w.lastActiveAt)}`;
    return `<div class="row${selCls(w.id)}" data-action="open-worker" data-id="${w.id}">${workerIcon(w)}<span class="t"><b>${esc(what)}</b><small>${esc(small)}</small></span></div>`;
  }).join('');
  const prRows = prs.map((x) => `<div class="row${selCls(x.workerId)}" data-action="open-worker" data-id="${x.workerId ?? ''}">${ic('pr')}<span class="t"><b>${esc(x.title)}</b><small>${esc(`${x.repo ?? ''} #${prNum(x.prUrl)}, ${t('st.inReview')}`)}</small></span></div>`).join('');
  const qRows = queued.map((x) => {
    const small = x.status === 'blocked' ? t('side.afterMerge', { id: x.afterTaskId ?? '' }) : `${x.repo ?? t('general')}, ${x.workerId ?? ''} ${t('task.queued')}`;
    return `<div class="row${selCls(x.workerId)}" data-action="open-worker" data-id="${x.workerId ?? ''}">${ic('wait')}<span class="t"><b>${esc(x.title)}</b><small>${esc(small)}</small></span></div>`;
  }).join('');
  const any = decRows || runRows || prRows || qRows;
  const empty = any ? '' : `<div class="side-empty">${sym('s-check')}<span>${t('side.emptyTitle')}</span></div>`;
  const misc = `<section class="side-sec"><h4>${t('side.history')}</h4>
    <div class="row${doneToday ? '' : ' zero'}" data-action="view" data-v="worker">${ic('done')}<span class="t"><b>${t('side.doneToday')}</b></span><span class="badge">${doneToday}</span></div>
    <div class="row${archived ? '' : ' zero'}" data-action="view" data-v="worker">${ic('arch')}<span class="t"><b>${t('side.archived')}</b></span><span class="badge">${archived}</span></div>
  </section>`;
  $('#side').innerHTML = sec(t('side.decisions'), decRows, 'sec-dec') + sec(t('side.running'), runRows) + sec(t('side.prs'), prRows) + sec(t('side.queue'), qRows) + empty + misc;
}

function usageTip(a: AccountView) {
  const head = `${a.label}\n5h ${pct(a.fiveHour.utilization)} · 7d ${pct(a.sevenDay.utilization)}`;
  if (a.lastError) return `${head}\n${a.lastError}`;
  if (!a.usageUpdatedAt) return `${head}\n${t('usage.unknown')}`;
  const parts = [head, t('usage.asOf', { t: hhmm(a.usageUpdatedAt) })];
  if (a.sevenDay.utilization === null) parts.push(t('usage.no7d'));
  return parts.join('\n');
}

function renderUsage() {
  const accs = S!.accounts;
  const el = $('#usage');
  if (!accs.length) {
    el.className = 'usage-empty nodrag';
    el.innerHTML = `<a data-action="open-settings">${t('usage.addAccount')}</a>`;
    return;
  }
  // Up to two accounts: one row each with 5h/7d labels. Three or more: two accounts per row, bars in the same order, numbers in the tooltip.
  const compact = accs.length > 2;
  el.className = `usage nodrag${compact ? ' compact' : ''}`;
  const lbl = (s: string) => (compact ? '' : `<span>${s}</span>`);
  el.innerHTML = accs.map((a: AccountView) => `<span class="acct${a.limited ? ' limited' : ''}" title="${esc(usageTip(a))}"><span class="nm">${esc(a.label)}</span>` +
    `${lbl('5h')}<span class="cap"><i class="${lv(a.fiveHour.utilization)}" style="width:${a.fiveHour.utilization ?? 0}%"></i></span><span class="pc">${pct(a.fiveHour.utilization)}</span>` +
    `${lbl('7d')}<span class="cap"><i class="${lv(a.sevenDay.utilization)}" style="width:${a.sevenDay.utilization ?? 0}%"></i></span><span class="pc">${pct(a.sevenDay.utilization)}</span></span>`).join('');
}

/* ---------- chat ---------- */

function resultLinks(x: Task | null) {
  const links: string[] = [];
  if (x?.prUrl) {
    const st = x.prState === 'MERGED' ? ` · ${t('pr.merged')}` : x.prState === 'CLOSED' ? ` · ${t('pr.closed')}` : '';
    links.push(`<a data-action="open-url" data-href="${esc(x.prUrl)}">PR #${prNum(x.prUrl)}${st}</a>`);
  }
  for (const f of x?.files ?? []) links.push(`<a data-action="open-file" data-path="${esc(f)}" title="${esc(f)}">${esc(base(f))}</a>`);
  return links;
}

function resultGlyph(x: Task | null, err = false) {
  if (err) return sym('s-alert', 'c-red');
  if (x?.prState === 'MERGED') return sym('s-merge', 'c-purple');
  return x?.prUrl ? sym('s-pr', 'c-purple') : x?.files.length ? sym('s-doc', 'c-teal') : sym('s-check', 'c-green');
}

function chatItemHtml(c: ChatItem) {
  switch (c.kind) {
    case 'user': return `<div class="bub me">${userText(c.text)}</div>`;
    case 'dispatcher': return `<div class="bub ai">${md(c.text)}</div>`;
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
      if (x?.workerId) links.push(`<a data-action="open-worker" data-id="${x.workerId}">${t('chat.viewWorker', { id: x.workerId })}</a>`);
      return `<div class="attach"><span class="tile">${resultGlyph(x)}</span><span class="body"><b>${esc(x?.title ?? t('task'))}</b><span class="sm">${inline(c.text)}</span><span class="links">${links.join('')}</span></span></div>`;
    }
  }
}

function renderChat(force = false) {
  const s = S!;
  const key = `${lang()}:${s.chat.length}:${s.chat[s.chat.length - 1]?.id}:${s.dispatcher.busy}:${s.dispatcher.statusText}:${s.autoAnswers.filter((a) => a.corrected).length}:${s.tasks.map((x) => x.status + x.prUrl + x.prState).join()}`;
  if (!force && key === ui.lastChatKey) return;
  ui.lastChatKey = key;
  const th = $('#chat-thread');
  const nearBottom = th.scrollHeight - th.scrollTop - th.clientHeight < 80;
  let html = '';
  let last = 0;
  // The same error said again right after itself (e.g. every account at its limit) shows once with a count.
  const items: { c: ChatItem; n: number }[] = [];
  for (const c of s.chat) {
    const prev = items[items.length - 1];
    if (prev && c.kind === 'error' && prev.c.kind === 'error' && prev.c.text === c.text && !c.ref && !prev.c.ref) { prev.n++; continue; }
    items.push({ c, n: 1 });
  }
  for (const { c, n } of items) {
    const ts = Date.parse(c.ts);
    if (ts - last > 30 * 60_000) html += `<span class="stamp">${hhmm(c.ts)}</span>`;
    last = ts;
    html += n > 1 ? chatItemHtml(c).replace(/<\/span><\/span>$/, ` <b class="times">×${n}</b></span></span>`) : chatItemHtml(c);
  }
  if (!s.chat.length) html = `<div class="empty-view">${sym('s-chat')}<b>${t('chat.emptyTitle')}</b><span>${t('chat.emptyBody')}</span></div>`;
  if (s.dispatcher.busy) html += `<div class="typing"><span class="dots"><i></i><i></i><i></i></span>${esc(s.dispatcher.statusText ? oneLine(s.dispatcher.statusText, 80) : '')}</div>`;
  th.innerHTML = html;
  if (nearBottom || force) th.scrollTop = th.scrollHeight;
  const ctx = s.dispatcher.contextTokens;
  $('#chat-ctx').innerHTML = `${ring(ctx / COMPACT_AT).replace('class="ring"', '')}${k(ctx)} / 250K`;
  $<HTMLButtonElement>('#chat-ctx').disabled = !!s.dispatcher.busy;
  updateSendButton();
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

function decisionHtml(d: Decision) {
  const x = task(d.taskId);
  const src = [d.workerId ?? 'Dispatcher', x?.title].filter(Boolean).join(', ');
  const icon = d.source === 'permission' ? sym('s-alert', 'c-red') : d.source === 'plan' ? sym('s-doc', 'c-blue') : sym('s-chat', 'c-orange');
  let buttons: string;
  if (d.source === 'plan') {
    buttons = `<div class="btns"><button class="btn def" data-action="answer" data-id="${d.id}" data-val="${ALLOW}">${t('plan.approve')}</button></div>`;
  } else if (d.source === 'permission') {
    buttons = `<div class="btns"><button class="btn" data-action="answer" data-id="${d.id}" data-val="${DENY}">${t('deny')}</button><button class="btn def" data-action="answer" data-id="${d.id}" data-val="${ALLOW}">${t('allow')}</button></div>`;
  } else {
    const col = d.options.length > 2 || d.options.some((o) => o.description);
    buttons = `<div class="btns${col ? ' col' : ''}">${d.options.map((o) => `<button class="btn" data-action="answer" data-id="${d.id}" data-val="${esc(o.label)}">${esc(o.label)}${o.description && col ? `<div class="opt-d">${esc(o.description)}</div>` : ''}</button>`).join('')}</div>`;
  }
  const custom = `<input class="inp" data-keep="dec-${d.id}" data-enter="answer-custom" data-id="${d.id}" placeholder="${d.source === 'permission' ? t('dec.denyWhy') : d.source === 'plan' ? t('plan.revise') : t('dec.other')}">`;
  return `<div class="dec" id="dec-${d.id}">
    <div class="src">${icon}<span>${esc(src)}</span></div>
    <div class="q">${esc(d.title)}</div>
    ${d.detail ? `<div class="d">${esc(d.detail)}</div>` : ''}
    ${d.code ? (d.source === 'plan' ? `<div class="plan-md">${md(d.code)}</div>` : `<code>${esc(d.code)}</code>`) : ''}
    ${buttons}${custom}
  </div>`;
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

function renderChatInspector() {
  const s = S!;
  const root = $('#chat-ins');
  keepInputs(root, () => {
    const pending = s.decisions.filter((d) => d.status === 'pending');
    // Task outcomes only. Errors without a task (accounts at their limit, Dispatcher errors) stay in the chat.
    const results = s.chat.filter((c) => (c.kind === 'result' || (c.kind === 'error' && c.ref)) && !c.cleared).slice(-30).reverse();
    const autos = s.autoAnswers.filter((a) => !a.cleared).slice(-30).reverse();
    let html = '';
    if (pending.length) html += `<div class="sect" id="sec-dec"><div class="ins-h"><b>${t('ins.decisions')}</b><span class="count" id="dec-count">${pending.length}</span></div><div class="group">${pending.map(decisionHtml).join('')}</div></div>`;
    if (results.length) {
      html += `<div class="sect"><div class="ins-h"><b>${t('ins.results')}</b><span class="gap"></span><button class="clear-x" data-action="clear" data-kind="result" title="${t('ins.clear')}" aria-label="${t('ins.clear')}"><svg><use href="#s-x"/></svg></button></div><div class="group">${results.map((c) => {
        const x = task(c.ref);
        const lk = resultLinks(x);
        return `<div class="res"><span class="tile">${resultGlyph(x, c.kind === 'error')}</span><span class="body"><span class="res-t"><b>${esc(x?.title ?? t('task'))}</b><time datetime="${esc(c.ts)}" title="${esc(hhmm(c.ts))}">${when(c.ts)}</time></span>${lk.length ? `<span class="lk">${lk.join('')}</span>` : ''}<span>${inline(oneLine(c.text, 140))}</span></span></div>`;
      }).join('')}</div></div>`;
    }
    if (autos.length) html += `<div class="sect"><div class="ins-h"><b>${t('ins.auto')}</b><span class="gap"></span><button class="clear-x" data-action="clear" data-kind="auto" title="${t('ins.clear')}" aria-label="${t('ins.clear')}"><svg><use href="#s-x"/></svg></button></div><div class="group">${autos.map(aaHtml).join('')}</div></div>`;
    if (!html) {
      const busy = s.workers.filter((w) => w.status === 'running' || w.status === 'waiting').length;
      html = `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-check"/></svg><b>${t('ins.clearTitle')}</b>${busy ? `<button class="goto" data-action="view" data-v="worker">${ic('run')}${t('ins.busy', { n: busy })}</button>` : ''}</div>`;
    }
    root.innerHTML = html;
  });
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
  if (x?.status === 'blocked') return `<span class="pill orange">${t('st.afterMerge')}</span>`;
  if (x?.status === 'queued') return `<span class="pill orange">${t('st.limitWait')}</span>`;
  if (x?.status === 'pr_open') return `<span class="pill purple">${t('st.prOpen')}</span>`;
  return `<span class="pill">${t('time.ago', { d: ago(w.lastActiveAt) })}</span>`;
}

function renderWorkerList() {
  const s = S!;
  const root = $('#wk-list');
  const active = s.workers.filter((w) => w.status !== 'archived');
  const arch = s.workers.filter((w) => w.status === 'archived');
  const order = (w: Worker) => (w.status === 'waiting' ? 0 : w.status === 'running' || w.status === 'starting' ? 1 : w.status === 'error' ? 2 : 3);
  active.sort((a, b) => order(a) - order(b) || b.lastActiveAt.localeCompare(a.lastActiveAt));
  arch.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  const li = (w: Worker) => {
    const x = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
    return `<div class="li${ui.wSel === w.id ? ' sel' : ''}${w.status === 'archived' ? ' dim' : ''}" data-action="select-worker" data-id="${w.id}">${workerIcon(w)}
      <span class="m"><b>${esc(w.id)} ${esc(x?.title ?? w.title)}</b><span>${esc([w.repo ?? t('general'), modelLabel(w.model), acctLabel(w.accountId), w.statusText && w.status === 'running' ? w.statusText : ''].filter(Boolean).join(', '))}</span></span>
      <span class="r">${w.status !== 'archived' ? ring(w.contextTokens / COMPACT_AT) + k(w.contextTokens) : ''}${statusPill(w)}</span></div>`;
  };
  if (!s.workers.length) {
    root.innerHTML = `<div class="vhead"><b>Worker</b></div><div class="empty-view">${sym('s-cpu')}<b>${t('wk.emptyTitle')}</b></div>`;
    return;
  }
  root.innerHTML = `<div class="vhead"><b>Worker</b><small>${t('wk.counts', { a: active.length, b: arch.length })}</small></div>
    <div class="lst">${active.map(li).join('')}${arch.length ? `<div class="lst-h">${t('st.archived')}</div>${arch.map(li).join('')}` : ''}</div>`;
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
    pr ? `<a data-action="open-url" data-href="${esc(pr)}">${sym('s-pr')}PR #${prNum(pr)}</a>` : '',
    ...files.map((f) => `<a data-action="open-file" data-path="${esc(f)}" title="${esc(f)}">${sym('s-doc')}${esc(base(f))}</a>`),
  ].filter(Boolean).join('');
  const rest = lines.slice(i).join('\n').trim();
  const title = inline(summary);
  return `<div class="rep-h"><b>${title}</b>${links ? `<span class="rep-l">${links}</span>` : ''}</div>${rest ? md(rest) : ''}`;
}

function logItemHtml(it: WorkerLogItem, wid: string, prev: WorkerLogItem | null) {
  switch (it.from) {
    case 'dispatcher': return `${prev?.from === 'dispatcher' ? '' : '<span class="who">Dispatcher</span>'}<div class="bub ai">${md(it.text)}</div>`;
    case 'worker': return `${prev?.from === 'worker' ? '' : `<span class="who">${esc(wid)}</span>`}<div class="bub wk">${workerReport(it.text)}</div>`;
    case 'user': return `<div class="bub me">${userText(it.text)}</div>`;
    case 'auto': return `<span class="event self">${sym('s-check', 'c-green')}<span>${esc(it.text)}</span></span>`;
    default: return `<span class="event">${sym('s-cpu', 'c-blue')}<span>${esc(it.text)}</span></span>`;
  }
}

function renderSession(force = false) {
  const w = worker(ui.wSel);
  $('#wk-list').hidden = ui.wOpen && !!w;
  $('#wk-session').hidden = !(ui.wOpen && w);
  if (!ui.wOpen || !w) return;
  const x = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
  $('#ws-title').textContent = `${w.id} ${x?.title ?? w.title}`;
  $('#ws-sub').textContent = [w.repo ?? t('general'), x?.branch, modelLabel(w.model)].filter(Boolean).join(' · ');
  const tabs = w.repo ? (['chat', 'changes'] as const) : (['chat'] as const);
  if (!w.repo) ui.wTab = 'chat';
  $('#ws-tabs').hidden = !w.repo;
  $('#ws-tabs').innerHTML = tabs.map((v) => `<button type="button" role="tab" aria-selected="${ui.wTab === v}" class="${ui.wTab === v ? 'on' : ''}" data-action="ws-tab" data-v="${v}">${t(v === 'chat' ? 'ws.tabChat' : 'ws.tabChanges')}</button>`).join('');
  $('#ws-thread').hidden = ui.wTab !== 'chat';
  $('#ws-diff').hidden = ui.wTab !== 'changes';
  if (ui.wTab === 'changes') { if (force || !ui.diffs.has(w.id)) renderDiff(w); return; }
  const log = ui.logs.get(w.id) ?? [];
  const key = `${lang()}:${w.id}:${log.length}:${w.status}:${w.statusText}`;
  if (!force && key === ui.lastLogKey) return;
  ui.lastLogKey = key;
  const th = $('#ws-thread');
  const nearBottom = th.scrollHeight - th.scrollTop - th.clientHeight < 80;
  let html = '';
  let last = 0;
  log.forEach((it, i) => {
    const ts = Date.parse(it.ts);
    const gap = ts - last > 30 * 60_000;
    if (gap) html += `<span class="stamp">${hhmm(it.ts)}</span>`;
    last = ts;
    html += logItemHtml(it, w.id, i > 0 && !gap ? log[i - 1] : null);
  });
  if (!log.length) html = `<div class="empty-view"><span>${t('ws.empty')}</span></div>`;
  if (w.status === 'running' || w.status === 'starting') html += `<div class="typing"><span class="dots"><i></i><i></i><i></i></span>${esc(oneLine(w.statusText, 90))}</div>`;
  th.innerHTML = html;
  if (nearBottom || force) th.scrollTop = th.scrollHeight;
}

function diffLines(patch: string) {
  return patch.replace(/\n+$/, '').split('\n').map((l) => {
    const c = l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('\\') ? 'h' : '';
    return `<span class="dl ${c}">${esc(l) || ' '}</span>`;
  }).join('');
}

function renderDiff(w: Worker) {
  const root = $('#ws-diff');
  const v = ui.diffs.get(w.id);
  if (v === undefined) { void loadDiff(w.id); }
  if (v === undefined || v === 'loading') { root.innerHTML = `<div class="empty-view"><span>${t('diff.loading')}</span></div>`; return; }
  if (v === null) { root.innerHTML = `<div class="empty-view"><span>${t('diff.noRepo')}</span></div>`; return; }
  if (v.error) { root.innerHTML = `<div class="empty-view"><span>${t('diff.missing')}</span></div>`; return; }
  const add = v.files.reduce((n, f) => n + f.added, 0), del = v.files.reduce((n, f) => n + f.removed, 0);
  const head = `<div class="diff-h"><span class="br">${esc(v.branch || 'HEAD')} <small>→ ${esc(v.base)}</small></span><span class="sum">${t('diff.files', { n: v.files.length })} <b class="plus">+${add}</b> <b class="minus">−${del}</b></span><button class="btn" data-action="diff-refresh" data-id="${w.id}">${t('diff.refresh')}</button></div>`;
  if (!v.files.length) { root.innerHTML = `${head}<div class="empty-view"><span>${t('diff.none', { base: v.base })}</span></div>`; return; }
  const files = v.files.map((f) => {
    const key = `${w.id}:${f.path}`;
    const open = ui.diffOpen.has(key);
    const st = f.status === '?' ? 'A' : f.status;
    return `<div class="df${open ? ' open' : ''}">
      <button class="df-h" data-action="diff-file" data-id="${esc(key)}" aria-expanded="${open}"><svg class="chev" aria-hidden="true"><use href="#s-chev"/></svg><span class="st st-${st}">${st}</span><span class="p" title="${esc(f.path)}">${esc(f.path)}</span>${f.status === '?' ? `<small>${t('diff.untracked')}</small>` : ''}<span class="n"><b class="plus">+${f.added}</b> <b class="minus">−${f.removed}</b></span></button>
      ${open ? `<pre class="df-b">${f.patch ? diffLines(f.patch) : `<span class="dl h">${t('diff.binary')}</span>`}</pre>` : ''}
    </div>`;
  }).join('');
  const st = root.scrollTop;
  root.innerHTML = `${head}${v.truncated ? `<div class="diff-note">${t('diff.truncated')}</div>` : ''}<div class="dfs">${files}</div>`;
  root.scrollTop = st;
}

async function loadDiff(id: string) {
  if (ui.diffs.get(id) === 'loading') return;
  ui.diffs.set(id, 'loading');
  const v = await call<DiffView | null>('worker:diff', id);
  ui.diffs.set(id, v ?? null);
  const w = worker(id);
  if (w && ui.wSel === id && ui.wTab === 'changes') renderDiff(w);
}

async function loadLog(id: string) {
  const items = await call<WorkerLogItem[]>('worker:log', id);
  if (items) ui.logs.set(id, items);
  renderSession(true);
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
  const pillCls = w.status === 'running' ? 'blue' : w.status === 'waiting' || w.status === 'error' ? 'red' : '';
  const stKey: Record<string, Key> = { running: 'st.running', starting: 'st.starting', waiting: 'st.waitingMe', idle: 'st.idle', error: 'st.error', archived: 'st.archived' };
  root.innerHTML = `
    <div class="ins-h"><b>${esc(w.id)}</b><span class="pill ${pillCls}">${t(stKey[w.status] ?? 'st.idle')}</span></div>
    <div class="group kv">
      <span>${t('kv.task')}</span><span>${esc(cur?.title ?? w.title)}</span>
      <span>${t('kv.repo')}</span><span>${esc(w.repo ?? t('general'))}</span>
      ${cur?.branch ? `<span>${t('kv.branch')}</span><span>${esc(cur.branch)}</span>` : ''}
      ${cur?.status === 'blocked' ? `<span>${t('kv.startsAfter')}</span><span>${esc(cur.afterTaskId ?? '')} ${t('pr.merged')}</span>` : ''}
      <span>${t('kv.folder')}</span><span><a data-action="reveal" data-path="${esc(w.cwd)}" title="${esc(w.cwd)}">${esc(base(w.cwd))}</a></span>
      <span>${t('kv.model')}</span><span>${modelLabel(w.model)} · ${t(`effort.${(S!.settings.effortPerTask && cur?.effort) || S!.settings.workerEffort}` as Key)}</span>
      <span>${t('kv.account')}</span><span>${esc(acctLabel(w.accountId))}</span>
      <span>${t('kv.context')}</span><span>${k(w.contextTokens)} / 250K</span>
      ${w.statusText && (w.status === 'running' || w.status === 'waiting' || w.status === 'error') ? `<span>${t('kv.now')}</span><span>${esc(oneLine(w.statusText, 140))}</span>` : ''}
    </div>
    <div class="ins-h"><b>${t('wk.tasks')}</b><small>${tasks.length}</small></div>
    <div class="group">${tasks.map((x) => `<div class="mini"><b>${esc(x.id)} ${esc(x.title)}</b><span>${taskStatus(x.status)}${x.planFirst && !x.planApproved ? ` · ${t('plan.badge')}` : ''}${x.prUrl ? ` · <a data-action="open-url" data-href="${esc(x.prUrl)}">PR #${prNum(x.prUrl)}${x.prState === 'MERGED' ? ` ${t('pr.merged')}` : ''}</a>` : ''}${x.files.map((f) => ` · <a data-action="open-file" data-path="${esc(f)}">${esc(base(f))}</a>`).join('')}</span>${x.summary ? `<span>${esc(oneLine(x.summary, 160))}</span>` : ''}</div>`).join('') || `<div class="mini"><span>${t('none')}</span></div>`}</div>
    <div class="ins-act">
      ${w.status === 'running' || w.status === 'waiting' ? `<button class="btn" data-action="worker-stop" data-id="${w.id}">${t('wk.stop')}</button>` : ''}
      ${w.status === 'archived' ? `<button class="btn" data-action="worker-unarchive" data-id="${w.id}">${t('wk.restore')}</button>` : `<button class="btn" data-action="worker-archive" data-id="${w.id}">${t('wk.archive')}</button>`}
      <button class="btn def" data-action="worker-msg" data-id="${w.id}">${t('wk.message')}</button>
    </div>`;
}

/* ---------- repositories ---------- */

function renderRepos() {
  const s = S!;
  const main = $('#repo-main');
  if (!s.repos.length) {
    main.innerHTML = `<div class="vhead"><b>${t('nav.repo')}</b></div><div class="empty-view">${sym('s-box')}<b>${t('repo.emptyTitle')}</b><span>${t('repo.emptyBody')}</span></div>`;
  } else {
    main.innerHTML = `<div class="vhead"><b>${t('nav.repo')}</b><small>${s.repos.length}</small></div><div class="lst">${s.repos.map((r) => {
      const ts = s.tasks.filter((x) => x.repo === r.name);
      const run = ts.filter((x) => x.status === 'running' || x.status === 'waiting').length;
      const pr = ts.filter((x) => x.status === 'pr_open').length;
      return `<div class="li${ui.repoSel === r.name ? ' sel' : ''}" data-action="repo-select" data-id="${esc(r.name)}">${ic('repo', 'box')}<span class="m"><b>${esc(r.name)}</b><span>${esc(r.description || r.url)}</span></span><span class="r">${run ? `<span class="pill blue">${t('repo.running', { n: run })}</span>` : ''}${pr ? `<span class="pill purple">PR ${pr}</span>` : ''}</span></div>`;
    }).join('')}</div>`;
  }
  const ins = $('#repo-ins');
  const r = s.repos.find((x) => x.name === ui.repoSel) ?? null;
  if (!r) {
    ins.innerHTML = `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-box"/></svg><b>${t('repo.pick')}</b></div>`;
    return;
  }
  keepInputs(ins, () => {
    const ts = s.tasks.filter((x) => x.repo === r.name).slice(-15).reverse();
    ins.innerHTML = `<div class="ins-h"><b>${esc(r.name)}</b></div>
      <div class="group kv"><span>${t('kv.path')}</span><span><a data-action="reveal" data-path="${esc(r.path)}" title="${esc(r.path)}">${esc(shortPath(r.path))}</a></span><span>${t('kv.url')}</span><span title="${esc(r.url)}">${esc(shortPath(r.url))}</span><span>${t('kv.defaultBranch')}</span><span>${esc(r.defaultBranch)}</span></div>
      <div class="ins-h"><b>${t('repo.desc')}</b></div>
      <textarea class="inp" data-keep="repo-desc-${esc(r.name)}" id="repo-desc">${esc(r.description)}</textarea>
      <div class="ins-h"><b>${t('repo.setup')}</b></div>
      <textarea class="inp mono" rows="2" spellcheck="false" data-keep="repo-setup-${esc(r.name)}" id="repo-setup" placeholder="${esc(t('repo.setupPh'))}">${esc(r.setup ?? '')}</textarea>
      <div class="ins-act"><button class="btn" data-action="repo-save" data-id="${esc(r.name)}">${t('repo.save')}</button></div>
      <div class="ins-h"><b>${t('wk.tasks')}</b><small>${ts.length}</small></div>
      <div class="group">${ts.map((x) => `<div class="mini"><b>${esc(x.title)}</b><span>${esc(x.workerId ?? '')} · ${taskStatus(x.status)}${x.prUrl ? ` · <a data-action="open-url" data-href="${esc(x.prUrl)}">PR #${prNum(x.prUrl)}</a>` : ''}</span></div>`).join('') || `<div class="mini"><span>${t('none')}</span></div>`}</div>
      <div class="ins-act"><button class="btn danger" data-action="repo-remove" data-id="${esc(r.name)}">${t('repo.remove')}</button></div>`;
  });
}

/* ---------- memory ---------- */

async function loadMemory() {
  ui.memFiles = (await call<MemoryFile[]>('memory:list')) ?? [];
  renderMemory();
}

function memIcon(kind: MemoryFile['kind']) {
  return kind === 'preference' ? ic('pref', 'star') : kind === 'repo' ? ic('repo', 'box') : kind === 'decision' ? ic('done') : ic('doc', 'doc');
}

function renderMemory() {
  const list = $('#mem-list');
  if (ui.memHits) {
    list.innerHTML = ui.memHits.length ? ui.memHits.map((h) => `<div class="hit" data-action="mem-select" data-id="${esc(h.path)}"><small>${esc(h.path)}:${h.line}</small><span>${esc(h.text)}</span></div>`).join('') : `<div class="empty-view"><span>${t('mem.noHits')}</span></div>`;
  } else {
    list.innerHTML = ui.memFiles.map((f) => `<div class="li${ui.memSel === f.path ? ' sel' : ''}" data-action="mem-select" data-id="${esc(f.path)}">${memIcon(f.kind)}<span class="m"><b>${esc(f.title)}</b><span>${esc(f.path)}</span></span><span class="r">${hhmm(f.updatedAt)}</span></div>`).join('')
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

type Opt = { value: string; label: string; font?: string };
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
  el.innerHTML = items.map((o) => `<button type="button" role="option" class="pop-i${o.value === selected ? ' on' : ''}" aria-selected="${o.value === selected}" data-v="${esc(o.value)}"${o.font ? ` style="font-family:&quot;${esc(o.font)}&quot;, var(--font)"` : ''}>${sym('s-tick', 'pop-tick')}<span>${esc(o.label)}</span></button>`).join('');
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
  const root = document.documentElement.style;
  root.setProperty('--font', fontStack(family));
  root.setProperty('--ui-font-size', `${clampFontSize(size)}px`);
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
const MODEL_IDS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-2' };

/** Model choices; a configured model that is not in the list stays selectable. */
function modelOpts(ids: string[], cur: string): Opt[] {
  const list = cur && !ids.includes(cur) ? [...ids, cur] : ids;
  return list.map((id) => ({ value: id, label: modelLabel(id) }));
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

function stepper(id: string, value: number, min: number, max: number, label: string) {
  return `<span class="step" role="group" aria-label="${esc(label)}"><button type="button" data-step="-1" data-for="${id}" aria-label="-">${sym('s-minus')}</button><input id="${id}" class="step-v" inputmode="numeric" value="${value}" data-min="${min}" data-max="${max}" aria-label="${esc(label)}"><button type="button" data-step="1" data-for="${id}" aria-label="+">${sym('s-plus')}</button></span>`;
}

function slider(id: string, value: number, label: string) {
  return `<span class="slider-wrap">${sym('s-speaker', 'slider-ic')}<input id="${id}" class="slider" type="range" min="0" max="100" step="5" value="${value}" style="--val:${value}%" aria-label="${esc(label)}"><output class="slider-out" for="${id}">${value}</output></span>`;
}

function meter(label: string, v: number | null) {
  const w = v ?? 0;
  return `<span>${label}</span><span class="meter"><i style="width:${w}%"${w >= 80 ? ' class="hot"' : ''}></i></span><span class="mv${w >= 80 ? ' hot' : ''}">${pct(v)}</span>`;
}

function initials(label: string) {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (!/^[A-Za-z0-9]/.test(words[0])) return [...words[0]][0]; // Hangul and other scripts: one character
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

function accountCard(a: AccountView, i: number) {
  const kind = a.kind === 'login' ? t('acc.kindLogin') : t('acc.kindToken');
  const plan = a.plan === 'enterprise' ? 'Enterprise' : 'Team';
  const renaming = ui.accRename === a.id;
  const name = renaming
    ? `<span class="acc-edit"><input class="inp" id="acc-rename" value="${esc(a.label)}" aria-label="${t('acc.name')}" data-id="${a.id}"><button class="btn def" data-action="acc-rename-save" data-id="${a.id}">${t('save')}</button><button class="btn" data-action="acc-rename-cancel">${t('cancel')}</button></span>`
    : `<span class="acc-name"><b>${esc(a.label)}</b><span class="plan-badge ${a.plan}">${plan}</span></span>`;
  const menu = ui.accMenu === a.id ? `<div class="amenu" role="menu" aria-label="${t('acc.options')}">
      <button role="menuitem" data-action="acc-rename" data-id="${a.id}">${t('acc.rename')}</button>
      <button role="menuitem" data-action="acc-refresh">${t('acc.refresh')}</button>
      <div class="amenu-sep"></div><span class="amenu-h">${t('acc.plan')}</span>
      ${PLAN_OPTS.map((o) => `<button role="menuitemradio" aria-checked="${a.plan === o.value}" data-action="acc-plan" data-id="${a.id}" data-v="${o.value}">${sym('s-tick', 'amenu-tick')}${o.label}</button>`).join('')}
      <div class="amenu-sep"></div>
      <button role="menuitem" class="danger" data-action="acc-remove" data-id="${a.id}">${t('acc.removeMenu')}</button>
    </div>` : '';
  return `<div class="acc-card${renaming ? ' editing' : ''}">
    <span class="avatar" style="background:${AVATAR[i % AVATAR.length]}">${esc(initials(a.label))}</span>
    <span class="acc-main">${name}<span class="acc-kind">${kind}</span>${a.lastError ? `<span class="warn">${esc(a.lastError)}</span>` : ''}</span>
    <span class="acc-meters">${meter('5h', a.fiveHour.utilization)}${meter('7d', a.sevenDay.utilization)}</span>
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
    <p>${a.kind === 'login' ? t('acc.removeLogin') : t('acc.removeToken')}</p>
    <div class="dlg-btns"><button class="btn" data-action="acc-remove-cancel">${t('cancel')}</button><button class="btn danger-fill" data-action="acc-remove-ok" data-id="${a.id}">${t('remove')}</button></div>
  </div>`;
}

function settingsHtml() {
  const s = S!;
  const st = s.settings;
  const full = s.accounts.length >= MAX_ACCOUNTS;
  const hasLogin = s.accounts.some((a) => a.kind === 'login');
  const pane = (id: Pane, body: string) => `<section class="pane" data-pane="${id}"${ui.pane === id ? '' : ' hidden'}><h2>${t(PANES.find((p) => p.id === id)!.key)}</h2>${body}</section>`;
  const row = (label: string, forId: string, control: string, cls = '') => `<div class="srow${cls ? ` ${cls}` : ''}"><label class="lbl" for="${forId}">${label}</label>${control}</div>`;
  const grp = (rows: string, cap = '') => `<div class="sgrp-wrap">${cap ? `<h3 class="scap">${cap}</h3>` : ''}<div class="sgrp">${rows}</div></div>`;
  const sounds: SoundName[] = ['chime', 'bell', 'ping', 'custom', 'none'];

  const accounts = `${grp(s.accounts.map(accountCard).join('') || `<div class="srow"><span class="lbl muted">${t('acc.none')}</span></div>`, `${t('acc.registered')} <small>${s.accounts.length} / ${MAX_ACCOUNTS}</small>`)}
    ${full ? '' : grp(`
      ${hasLogin ? '' : row(t('acc.method'), 'acc-kind', segc('acc-kind', ui.accKind, [{ value: 'token', label: t('acc.methodToken') }, { value: 'login', label: t('acc.methodLogin') }], t('acc.method'), 'data-change="acc-kind"'))}
      ${row(t('acc.name'), 'acc-label', `<input class="inp w" id="acc-label" placeholder="${t('acc.namePh')}">`)}
      ${row(t('acc.plan'), 'acc-plan', segc('acc-plan', 'team', PLAN_OPTS, t('acc.plan')))}
      ${row(t('acc.token'), 'acc-token', `<input class="inp w" id="acc-token" type="password" placeholder="sk-ant-…" autocomplete="off" spellcheck="false">`, 'acc-token-row')}
      <div class="srow end"><button class="btn def" data-action="acc-add" id="acc-add-btn">${t('acc.addToken')}</button><button class="btn def" data-action="acc-add-login" id="acc-login-btn">${t('acc.addLogin')}</button></div>`, t('acc.add'))}`;

  const general = grp(`
      ${row(t('set.language'), 'set-lang', segc('set-lang', st.language, [{ value: 'en', label: 'English' }, { value: 'ko', label: '한국어' }], t('set.language')))}
      ${row(t('set.home'), 'set-home', `<input class="inp w" id="set-home" value="${esc(st.home)}"><button class="btn" data-action="pick-home">${t('choose')}</button>`)}
      ${row(t('set.ghHost'), 'set-gh', `<input class="inp w" id="set-gh" value="${esc(st.githubHost)}" placeholder="github.com">`)}
      ${row(t('set.archive'), 'set-arch', stepper('set-arch', st.archiveDays, 1, 90, t('set.archive')))}`);

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
      ${row(t('set.memRemote'), 'set-mem', `<input class="inp w" id="set-mem" value="${esc(st.memoryRemote)}" placeholder="https://github.com/me/agent-memory.git">`)}`, t('set.ideMemory'))}
    ${grp(`
      ${row(t('set.claudeRules'), 'set-crules', `<span class="sval${ci && !ci.rules.length ? ' muted' : ''}" title="${esc(ci ? ci.home : '')}">${esc(rulesText)}</span><input class="switch" id="set-crules" type="checkbox" ${st.claudeRules ? 'checked' : ''}>`)}
      ${row(t('set.claudeMemory'), 'set-cmem', `<input class="switch" id="set-cmem" type="checkbox" ${st.claudeMemory ? 'checked' : ''}>`)}
      ${row(t('set.claudeFolder'), 'set-cdir', `<span class="sval" id="set-cdir" title="${esc(ci ? ci.home : '')}">${esc(ci ? shortPath(ci.home, 2) : '…')}</span><button class="btn" data-action="reveal-claude">${t('set.open')}</button>`)}`, 'Claude Code')}`;

  const m = MODEL_IDS;
  const models = `${grp(`
      ${row(t('set.model'), 'set-dm', segc('set-dm', st.dispatcherModel, modelOpts([m.haiku, m.sonnet, m.opus], st.dispatcherModel), 'Dispatcher'), 'wrap')}
      ${row(t('set.effort'), 'set-de', segc('set-de', st.dispatcherEffort, effortOpts(), t('set.effort')), 'wrap')}`, 'Dispatcher')}
    ${grp(`
      ${row(t('set.model'), 'set-wm', segc('set-wm', st.workerModel, modelOpts([m.sonnet, m.opus, m.fable], st.workerModel), 'Worker'), 'wrap')}
      ${row(t('set.design'), 'set-fm', segc('set-fm', st.designModel, modelOpts([m.opus, m.fable], st.designModel), t('set.design')), 'wrap')}
      ${row(t('set.defaultEffort'), 'set-we', segc('set-we', st.workerEffort, effortOpts(), t('set.effort')), 'wrap')}
      ${row(t('set.effortPerTask'), 'set-ept', `<input class="switch" id="set-ept" type="checkbox" ${st.effortPerTask ? 'checked' : ''}>`)}`, t('set.workers'))}`;

  return `<header class="stopbar drag">
      <button class="btn sback" data-action="close-settings">${sym('s-back')}${t('set.back')}</button>
      <h1>${t('set.title')}</h1>
      <span class="stop-r"><span class="dirty" id="set-dirty" hidden>${t('set.unsaved')}</span><button class="btn" data-action="revert-settings" id="set-revert" disabled>${t('set.revert')}</button><button class="btn def" data-action="save-settings">${t('save')}</button></span>
    </header>
    <div class="sbody">
      <nav class="snav" aria-label="${t('set.title')}">
        <label class="ssearch">${sym('s-search')}<input id="set-q" type="search" placeholder="${t('set.search')}" aria-label="${t('set.search')}" value="${esc(ui.setQ)}"></label>
        ${PANES.map((p) => `<button class="snav-i${ui.pane === p.id ? ' on' : ''}" data-action="pane" data-id="${p.id}"${ui.pane === p.id ? ' aria-current="page"' : ''}>${sym(p.glyph)}<span>${t(p.key)}</span>${p.id === 'accounts' && s.setupNeeded ? '<i class="dot"></i>' : ''}</button>`).join('')}
        <span class="ver">${ui.version ? `v${esc(ui.version)}` : ''}</span>
      </nav>
      <main class="spanes"><div class="sinner">${pane('accounts', accounts)}${pane('general', general)}${pane('display', display)}${pane('alerts', alerts)}${pane('memory', memory)}${pane('models', models)}</div></main>
    </div>
    ${ui.accMenu || ui.accRename ? '<div class="click-catch" data-action="acc-dismiss"></div>' : ''}
    ${removeDialog()}`;
}

/** Re-render the settings window, keeping unsaved field values. */
/** Claude Code rule files for the Memory pane; read each time Settings opens. */
async function loadClaudeInfo() {
  ui.claude = (await call<ClaudeInfo>('claude:info')) ?? null;
  if (ui.settingsShown) openSettings();
}

function openSettings(pane?: Pane) {
  if (pane) ui.pane = pane;
  // Each time the window opens (button, shortcut or first run), not on every re-render.
  if (!ui.settingsShown) void loadClaudeInfo();
  closePop();
  const root = $('#sheet');
  const keep = new Map<string, string | boolean>();
  if (ui.settingsShown) root.querySelectorAll<HTMLInputElement>('.spanes input').forEach((el) => { if (el.id && el.id !== 'acc-rename') keep.set(el.id, el.type === 'checkbox' ? el.checked : el.value); });
  const focusId = ui.settingsShown && root.contains(document.activeElement) ? (document.activeElement as HTMLElement).id : '';
  const scroll = root.querySelector('.spanes')?.scrollTop ?? 0;
  ui.settingsShown = true;
  root.innerHTML = settingsHtml();
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
  if (!pane) root.querySelector('.spanes')!.scrollTop = scroll;
  syncSoundRows();
  syncAccRows();
  filterPanes();
  syncDirty();
  root.hidden = false;
  document.body.classList.add('modal');
  if (!ui.version) void call<string>('app:version').then((v) => { if (v) { ui.version = v; const el = root.querySelector('.ver'); if (el) el.textContent = `v${v}`; } });
  void installedFonts().then(() => { const f = document.getElementById('set-font') as HTMLInputElement | null; if (f) markFont(f); });
}

function syncSlider(el: HTMLInputElement) {
  el.style.setProperty('--val', `${el.value}%`);
  const out = el.parentElement?.querySelector('output');
  if (out) out.textContent = el.value;
}

function syncAccRows() {
  const login = ($('#acc-kind') as HTMLInputElement | null)?.value === 'login';
  document.querySelectorAll<HTMLElement>('.acc-token-row').forEach((el) => { el.hidden = login; });
  const add = document.getElementById('acc-add-btn');
  const lg = document.getElementById('acc-login-btn');
  if (add) add.hidden = login;
  if (lg) lg.hidden = !login;
}

function syncSoundRows() {
  const kind = ($('#set-sound') as HTMLInputElement | null)?.value;
  document.querySelectorAll<HTMLElement>('.custom-row').forEach((el) => { el.hidden = kind !== 'custom'; });
}

/** Show "Unsaved changes" and enable Revert while the form differs from the saved settings. */
function syncDirty() {
  if (!ui.settingsShown || !S || !document.getElementById('set-lang')) return;
  const f = readSettingsForm() as Record<string, unknown>;
  const cur = S.settings as unknown as Record<string, unknown>;
  const dirty = Object.keys(f).some((k) => f[k] !== cur[k]);
  const label = document.getElementById('set-dirty');
  if (label) label.hidden = !dirty;
  const rv = document.getElementById('set-revert') as HTMLButtonElement | null;
  if (rv) rv.disabled = !dirty;
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
  document.querySelectorAll<HTMLElement>('.pane').forEach((p) => { p.hidden = p.dataset.pane !== id; });
  document.querySelectorAll<HTMLButtonElement>('.snav-i').forEach((b) => {
    const on = b.dataset.id === id;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const sp = document.querySelector('.spanes');
  if (sp) sp.scrollTop = 0;
  pathEnds();
}

/** Long folder paths in Settings show their end, which is the part that differs. Runs once the pane is visible. */
function pathEnds() {
  const home = document.querySelector<HTMLInputElement>('#set-home');
  if (home && document.activeElement !== home) home.scrollLeft = home.scrollWidth;
}

function closeSettings() {
  closePop();
  ui.settingsShown = false;
  ui.accMenu = ui.accRename = ui.accRemove = null;
  ui.setQ = '';
  $('#sheet').hidden = true;
  $('#sheet').innerHTML = '';
  document.body.classList.remove('modal');
  // Drop an unsaved preview (after a save, S.settings already holds the new values).
  if (S) applyFont(S.settings.fontFamily, S.settings.fontSize);
}

function readSettingsForm() {
  const v = (id: string) => ($(`#${id}`) as HTMLInputElement).value.trim();
  return {
    language: v('set-lang') as Lang,
    home: v('set-home'),
    githubHost: v('set-gh').replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase(),
    archiveDays: Math.max(1, Number(v('set-arch')) || 7),
    notifications: ($('#set-noti') as HTMLInputElement).checked,
    sound: v('set-sound') as SoundName,
    customSound: v('set-sfile'),
    soundVolume: Number(v('set-vol')),
    memoryRemote: v('set-mem'),
    dispatcherModel: v('set-dm'),
    workerModel: v('set-wm'),
    designModel: v('set-fm'),
    dispatcherEffort: v('set-de') as Effort,
    workerEffort: v('set-we') as Effort,
    effortPerTask: ($('#set-ept') as HTMLInputElement).checked,
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

/* ---------- render all ---------- */

function setView(v: typeof ui.view) {
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
  renderSidebar();
  renderUsage();
  if (ui.view === 'chat') { renderChat(force); renderChatInspector(); }
  if (ui.view === 'worker') { renderWorkerList(); renderSession(force); renderWorkerInspector(); }
  if (ui.view === 'repo') renderRepos();
  if (ui.view === 'memory' && force) renderMemory();
}

function openWorker(id: string) {
  if (!id) return;
  ui.wSel = id;
  ui.wOpen = true;
  ui.lastLogKey = '';
  if (ui.view !== 'worker') setView('worker');
  void loadLog(id);
  renderAll(true);
}

/* ---------- actions ---------- */

async function act(el: HTMLElement, e: Event) {
  const a = el.dataset.action!;
  const id = el.dataset.id ?? '';
  switch (a) {
    case 'view': setView(el.dataset.v as any); break;
    case 'open-settings': openSettings(); break;
    case 'reveal-memory': await call('open:path', `${S!.settings.home}/memory`); break;
    case 'reveal-claude': if (ui.claude) await call('open:path', ui.claude.home); break;
    case 'ctx-menu': {
      const menu = $('#ctxmenu');
      if (!menu.hidden && menu.dataset.for === 'ctx') { menu.hidden = true; break; }
      const empty = !S!.dispatcher.contextTokens;
      menu.dataset.for = 'ctx';
      menu.innerHTML = `<button data-action="ctx-compact"${empty ? ' disabled' : ''}>${t('ctx.compact')}</button><button data-action="ctx-clear"${empty ? ' disabled' : ''}>${t('ctx.clear')}</button>`;
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
      setView('chat');
      const card = document.getElementById(`dec-${id}`);
      card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      card?.classList.remove('flash'); void card?.offsetWidth; card?.classList.add('flash');
      break;
    }
    case 'open-worker': openWorker(id); break;
    case 'select-worker': openWorker(id); break;
    case 'close-session': ui.wOpen = false; renderAll(true); break;
    case 'ws-tab': {
      ui.wTab = el.dataset.v as typeof ui.wTab;
      if (ui.wTab === 'changes' && ui.wSel) ui.diffs.delete(ui.wSel);
      ui.lastLogKey = '';
      renderSession(true);
      break;
    }
    case 'diff-refresh': ui.diffs.delete(id); renderSession(true); break;
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
    case 'open-url': e.preventDefault(); await call('open:external', el.dataset.href); break;
    case 'open-file': e.preventDefault(); await call('open:path', el.dataset.path); break;
    case 'reveal': e.preventDefault(); await call('reveal:path', el.dataset.path); break;
    case 'unattach': {
      const box = el.dataset.box as Box;
      ui.attach[box].splice(Number(el.dataset.i), 1);
      renderChips(box);
      break;
    }
    case 'clear': {
      const kind = el.dataset.kind as 'result' | 'auto';
      const ids = kind === 'auto' ? S!.autoAnswers.filter((x) => !x.cleared).map((x) => x.id) : S!.chat.filter((c) => (c.kind === 'result' || c.kind === 'error') && !c.cleared).map((c) => c.id);
      ui.undo.push({ kind, ids });
      await call('chat:clear', kind);
      toast(t(kind === 'auto' ? 'toast.clearedAuto' : 'toast.clearedResults', { key: isMac ? '⌘Z' : 'Ctrl+Z' }));
      break;
    }
    case 'aa-select': {
      if (ui.view !== 'chat') setView('chat');
      ui.aaSel = id;
      renderChatInspector();
      document.getElementById(`aa-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      break;
    }
    case 'aa-edit': ui.aaEdit = id; ui.aaSel = id; renderChatInspector(); (document.querySelector(`[data-keep="aa-${id}"]`) as HTMLInputElement | null)?.focus(); break;
    case 'aa-cancel': ui.aaEdit = null; renderChatInspector(); break;
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
    case 'worker-archive': await call('worker:archive', id); break;
    case 'worker-unarchive': await call('worker:unarchive', id); break;
    case 'worker-msg': openWorker(id); setTimeout(() => $('#ws-input').focus(), 30); break;
    case 'repo-select': ui.repoSel = id; renderRepos(); break;
    case 'repo-save': await call('repo:update', id, $<HTMLTextAreaElement>('#repo-desc').value, $<HTMLTextAreaElement>('#repo-setup').value); toast(t('toast.descSaved')); break;
    case 'repo-remove': {
      if (!confirm(t('confirm.repoRemove', { name: id }))) return;
      await call('repo:remove', id);
      ui.repoSel = null;
      break;
    }
    case 'mem-select': {
      ui.memSel = id;
      ui.memText = (await call<string>('memory:read', id)) ?? '';
      renderMemory();
      break;
    }
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
    case 'revert-settings': {
      ui.settingsShown = false; // re-render from the saved values, not the form
      openSettings();
      if (S) applyFont(S.settings.fontFamily, S.settings.fontSize);
      break;
    }
    case 'pick-home': {
      const p = await call<string | null>('settings:pickHome');
      if (p) $<HTMLInputElement>('#set-home').value = p;
      break;
    }
    case 'pick-sound': {
      const p = await call<string | null>('sound:pick');
      if (p) $<HTMLInputElement>('#set-sfile').value = p;
      break;
    }
    case 'font-reset': {
      $<HTMLInputElement>('#set-font').value = '';
      $<HTMLInputElement>('#set-fsize').value = String(FONT_SIZE_DEFAULT);
      previewFont();
      syncDirty();
      break;
    }
    case 'sound-test': {
      const f = readSettingsForm();
      await playSound(f.sound, f.soundVolume, f.customSound);
      break;
    }
    case 'save-settings': {
      const patch = readSettingsForm();
      const r = await call<{ restart: boolean }>('settings:save', patch);
      if (!r) return;
      customCache = null;
      const langChanged = patch.language !== S!.settings.language;
      Object.assign(S!.settings, patch); // keep the new font even before the new state arrives
      if (langChanged) { ui.settingsShown = false; applyStaticText(); openSettings(); } else syncDirty();
      if (r.restart) {
        if (confirm(t('confirm.restart'))) await call('app:relaunch');
      } else toast(tr(patch.language, 'toast.settingsSaved'));
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
    if (thread && atEnd) thread.scrollTop = thread.scrollHeight;
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
  document.addEventListener('click', (e) => {
    const tgt = e.target as HTMLElement;
    const segBtn = tgt.closest<HTMLButtonElement>('[data-segc]');
    if (segBtn) { pickSeg(segBtn); return; }
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
    const el = tgt.closest<HTMLElement>('[data-action]');
    if (el) void act(el, e);
    if (!(e.target as HTMLElement).closest('#ctxmenu, #chat-ctx')) $('#ctxmenu').hidden = true;
  });
  document.addEventListener('change', async (e) => {
    const el = e.target as HTMLSelectElement;
    if (el.dataset.change === 'sound-kind') syncSoundRows();
    if (el.dataset.change === 'acc-kind') { ui.accKind = el.value as typeof ui.accKind; syncAccRows(); }
    if (el.closest?.('#sheet')) syncDirty();
  });
  document.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'set-vol') syncSlider(el);
    if (el.id === 'set-fsize') previewFont();
    if (el.id === 'set-font') { markFont(el); previewFont(); void openFontPicker(el, false); }
    if (el.id === 'set-q') { ui.setQ = el.value; filterPanes(); return; }
    if (el.closest('#sheet')) syncDirty();
  });
  document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.v as any)));
  $('#sheet').addEventListener('scroll', () => closePop(), true);
  window.addEventListener('resize', () => closePop());

  // Enter in an input runs the action named in data-enter.
  document.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    if (popKeys(e)) return;
    if (el.id === 'set-font' && e.key === 'ArrowDown') { e.preventDefault(); void openFontPicker(el as HTMLInputElement, true); return; }
    if (el.classList.contains('step-v') && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); stepValue(el.id, e.key === 'ArrowUp' ? 1 : -1); return; }
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && el.dataset?.enter) {
      e.preventDefault();
      if (el.dataset.enter === 'answer-custom') {
        const v = (el as HTMLInputElement).value.trim();
        if (v) void call('decision:answer', el.dataset.id, v);
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
      if (ui.settingsShown && (ui.accRemove || ui.accMenu || ui.accRename)) { ui.accRemove = ui.accMenu = ui.accRename = null; openSettings(); return; }
      if (ui.settingsShown) closeSettings();
      $('#ctxmenu').hidden = true;
      if (ui.aaEdit) { ui.aaEdit = null; renderChatInspector(); }
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (el.matches('input, textarea')) return;
      const u = ui.undo.pop();
      if (u) { e.preventDefault(); void call('chat:unclear', u.kind, u.ids); toast(t('toast.undone')); }
    }
    if (mod && e.key === ',') { e.preventDefault(); openSettings(); }
    if (mod && /^[1-4]$/.test(e.key)) { e.preventDefault(); setView((['chat', 'worker', 'repo', 'memory'] as const)[Number(e.key) - 1]); }
  });

  // Context menu on auto-answers
  document.addEventListener('contextmenu', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-ctx="aa"]');
    const menu = $('#ctxmenu');
    if (!el) { menu.hidden = true; return; }
    e.preventDefault();
    const id = el.dataset.id!;
    menu.dataset.for = 'aa';
    menu.innerHTML = `<button data-action="aa-edit" data-id="${id}">${t('aa.correct')}…</button><button data-action="view" data-v="memory">${t('aa.viewMemory')}</button>`;
    menu.style.left = `${Math.min(e.clientX, innerWidth - 200)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - 90)}px`;
    menu.hidden = false;
  });

  bindComposer('chat', '#chat-form', '#chat-input', async (text, files) => { await call('chat:send', text, files); });
  $('#chat-send').addEventListener('click', (e) => {
    if ($('#chat-send').classList.contains('stop')) { e.preventDefault(); void call('chat:stop'); }
  });
  bindComposer('ws', '#ws-form', '#ws-input', async (text, files) => {
    if (!ui.wSel) return;
    await call('worker:send', ui.wSel, text, files);
  });
  bindDrop();

  let memTimer: number | undefined;
  $<HTMLInputElement>('#mem-q').addEventListener('input', (e) => {
    clearTimeout(memTimer);
    const q = (e.target as HTMLInputElement).value.trim();
    memTimer = window.setTimeout(async () => {
      ui.memHits = q ? ((await call<MemoryHit[]>('memory:search', q)) ?? []) : null;
      renderMemory();
    }, 200);
  });

  ide.onState((s) => {
    const firstSetup = !S && s.setupNeeded;
    const langChanged = S && S.settings.language !== s.settings.language;
    S = s;
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
    setTimeout(() => { document.querySelector('.sec-dec')?.classList.remove('blink'); }, 3500);
  });
  window.addEventListener('focus', () => renderAll());
  setInterval(() => { if (S) { renderSidebar(); if (ui.view === 'worker') renderWorkerList(); } }, 60_000);

  void ide.call<AppState>('state').then((s) => {
    S = s;
    renderAll(true);
    if (s.setupNeeded) openSettings('accounts');
  });
}

init();
