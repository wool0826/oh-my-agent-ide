// The chat with the Dispatcher and its right sidebar: decisions, comparisons, bundles, results, memos, automations, and attachments.
import { middleName } from '../../shared/middleName';
import { refreshFind } from './find';
import type { Automation, Memo } from '../../shared/types';
import type { AutoAnswer, ChatItem, Decision, MemorySuggestion, PlanSummary, RiskTag, Task } from '../../shared/types';
import { ALLOW, ALLOW_TASK, DENY } from '../../shared/types';
import { stepView } from '../../shared/steps';
import { taskMinutes } from '../../shared/workerSummary';
import { askLine, lastFailed, plainStatus, stepText } from '../../shared/workerState';
import { dayWord, keepPick } from '../../shared/insPanes';
import { handoutCounts, handoutFolded, handoutRuns, handoutSettled, handoutState, isHandout, runTasks, type HandoutState } from '../../shared/handouts';
import { EV_KINDS, TONE_COLOR, evBadge, eventBlocks, type EvBlock, type EvIcon, type EvRow, type EvTone } from '../../shared/chatEvents';
import { type Key } from '../../shared/i18n';
import { hasSpend, spendVars, type Spend } from '../../shared/spend';
import { linkify, reportLinks, type ReportLink } from '../../shared/linkify';
import { mdInline } from '../../shared/markdown';
import { busyPrs, mergeWait, type MergeWait } from '../../shared/prMerge';
import { queuedPrs } from '../../shared/mergeQueue';
import { parseTime } from '../../shared/automations';
import { canPick, openComparisons } from '../../shared/compare';
import { awayDigest, awayRows, type AwayDigest } from '../../shared/away';
import { bundleMergeOrder, openBundles } from '../../shared/bundle';
import { memoSections } from '../../shared/memos';
import { scriptsHtml } from './scripts';
import { COMPACT_AT, CONTEXT_WINDOW } from '../../shared/context';
import { CHAT_SNAPSHOT, PAGE, threadStart } from '../../shared/paging';
import { canStop } from '../../shared/canStop';
import { branchLayout, canRoot, isReport, threadIndex } from '../../shared/thread';
import { parseReply, replyExcerpt } from '../../shared/reply';
import { decisionKeys, decisionKind, decisionLate, keepCard, slotClock, type DecisionKind } from '../../shared/decisionView';
import { cardBrief } from '../../shared/brief';
import { shellBlockHtml, shellKey } from './shell';
import { fileChips, placeAttached, sentFiles, shotsOf } from './shotview';
import { planPaste } from '../../shared/paste';
import { $, ago, announce, base, call, esc, hhmm, ic, ide, inline, k, keepInputs, lang, locale, markLoading, md, modelLabel, NEW_FROM, markReplyTarget, olderBtn, oneLine, paged, pillTone, prNum, replyable, ring, S, setThread, stoppedTask, sym, t, task, taskLabel, taskStatus, toast, tryCall, ui, unmarkLoading, userText, watchTop, when, worker, workerTask } from './core';
import { setTip } from './tip';
import { segc, syncSegs } from './settings';
import { ms } from './sidebar';
import { tookText } from './workers';
import { colsHtml, markPick, navItems, rove, rowHtml, slotHtml } from './panes';

export const CI_BADGE: Record<string, [string, Key]> = { passing: ['ok', 'pr.ciPassing'], failing: ['bad', 'pr.ciFailing'], pending: ['run', 'pr.ciPending'] };

export const REVIEW_BADGE: Record<string, [string, Key]> = { approved: ['ok', 'pr.approved'], changes: ['warn', 'pr.changes'], required: ['', 'pr.reviewNeeded'] };

/** The tip of a Merge button that cannot be pressed yet: when it opens. */
const MERGE_WAIT: Record<MergeWait, Key> = { queued: 'pr.waitQueued', worker: 'pr.waitWorker', ci: 'pr.waitCi', ciFailed: 'pr.waitCiFailed', conflicts: 'pr.waitConflicts', changes: 'pr.waitChanges', review: 'pr.waitReview' };

/** Is an open PR ready to merge: CI, conflicts, review. */
export function prBadges(x: Task) {
  const c = x.prChecks;
  if (!c || x.prState !== 'OPEN') return '';
  const b: string[] = [];
  const ci = CI_BADGE[c.ci];
  if (ci) b.push(`<i class="${ci[0]}"${c.failed.length ? ` data-tip="${esc(c.failed.join(', '))}"` : ''}>${t(ci[1])}</i>`);
  if (c.conflicts) b.push(`<i class="bad">${t('pr.conflicts')}</i>`);
  const rv = c.review ? REVIEW_BADGE[c.review] : null;
  if (rv) b.push(`<i class="${rv[0]}">${t(rv[1])}</i>`);
  // Not ready yet: the button is there but dimmed, and its tip says what it waits for. No data-action, so a click
  // does nothing; aria-disabled rather than disabled keeps it focusable and hoverable for the tip.
  const wait = mergeWait(c, !!x.prUrl && busyPrs(S?.tasks ?? []).has(x.prUrl.toLowerCase()), !!x.prUrl && queuedPrs(S?.mergeQueue ?? []).has(x.prUrl.toLowerCase()));
  if (wait) {
    // A "Merge it?" asked before the PR went back to waiting is not carried over to when it opens again.
    if (ui.mergeAsk === x.id) ui.mergeAsk = null;
    b.push(`<button type="button" class="prmerge wait" aria-disabled="true" data-tip="${esc(t(MERGE_WAIT[wait]))}">${t('pr.merge')}</button>`);
  } else {
    // Ready to merge: a button, asked once before it merges.
    const sure = ui.mergeAsk === x.id;
    b.push(`<button type="button" class="prmerge${sure ? ' sure' : ''}" data-action="pr-merge" data-id="${esc(x.id)}">${t(sure ? 'pr.mergeSure' : 'pr.merge')}</button>`);
  }
  return b.length ? `<span class="prst">${b.join('')}</span>` : '';
}

/** A link a report names, by its short name with ↗: "PR #158 ↗", an artifact's title, a page's host. */
export function reportLinkHtml(l: ReportLink) {
  const name = l.kind === 'pr' ? `PR #${l.name}` : l.name || t('link.artifact');
  return `<a tabindex="0" role="link" data-action="open-url" data-href="${esc(l.url)}" data-tip="${esc(l.url)}">${esc(name)} ↗</a>`;
}

/** A report's text with its URLs as links, in the same color as the card's link row. */
export const reportText = (s: string) => mdInline(s);

/** A result's PR as a chip: its number and where it stands, then whether an open one is ready to merge. */
function prChip(x: Task, url: string) {
  const [tone, key, icon, color]: [string, Key, string, string] = x.prState === 'MERGED' ? ['review', 'res.prMerged', 's-merge', 'c-pr-merged']
    : x.prState === 'CLOSED' ? ['', 'res.prClosed', 's-pr', 'c-pr-closed'] : ['pr-open', 'res.prOpen', 's-pr', 'c-pr-open'];
  return `<a class="prchip" tabindex="0" role="link" data-action="open-url" data-href="${esc(url)}" data-tip="${esc(url)}">${sym(icon, color)}#${prNum(url)}<span class="pill"${pillTone(tone)}>${t(key)}</span></a>${prBadges(x)}`;
}

/**
 * What a result carries, drawn the same on its chat card, its inbox row and the Worker's summary (decision 232): its
 * screenshots as before/after pairs with switches, its other files as chips, then one row with its PR, the URLs its
 * report names, `acts` (buttons the place adds) and its cost. `text` is the report as the place shows it; the task's
 * own summary and the links its report named are read too. `key` names the place, so its switches are its own.
 */
export function resultParts(x: Task | null, text: string | null | undefined, key: string, acts = '') {
  const { html: shots, rest } = shotsOf(x?.files ?? [], key);
  const urls = reportLinks([text, x?.summary, ...(x?.links ?? [])].filter(Boolean).join('\n'), [x?.prUrl]).map(reportLinkHtml);
  const lead = [x?.prUrl ? prChip(x, x.prUrl) : '', ...urls, acts].join('');
  const spend = spendHtml(x?.spend, true);
  return { media: shots + fileChips(rest), row: lead || spend ? `<span class="links racts">${lead}${spend ? `<span class="gap"></span>${spend}` : ''}</span>` : '' };
}

/** A task's spend, labeled as an API-equivalent estimate. Short: the cost only, tokens on hover. */
export function spendHtml(s: Spend | null | undefined, short = false) {
  if (!hasSpend(s)) return '';
  const v = spendVars(s);
  const text = short ? t('spend.cost', v) : `${t('spend.cost', v)} · ${t('spend.tokens', v)}`;
  const tip = short ? `${t('spend.tokens', v)}\n${t('spend.tip', v)}` : t('spend.tip', v);
  return `<span class="spend" data-tip="${esc(tip)}">${esc(text)}</span>`;
}

/** How a finished task went, beside its title: how long it took and how much of its plan it did. */
function resultMeta(x: Task | null) {
  if (!x?.finishedAt) return '';
  const mins = taskMinutes(x);
  const v = stepView(x);
  const parts = [mins !== null ? tookText(mins) : '', v ? t('sum.steps', { done: v.done, total: v.total }) : ''].filter(Boolean);
  return parts.length ? `<span class="rmeta">${esc(parts.join(' · '))}</span>` : '';
}

/** A report cut to about n characters without cutting a URL or a Markdown link in two: the word it would cut goes. */
function clipWords(s: string, n: number) {
  const x = oneLine(s, n);
  if (!x.endsWith('…')) return x;
  const cut = x.slice(0, -1);
  const last = cut.slice(cut.lastIndexOf(' ') + 1);
  return /https?:|\[|\]\(/.test(last) ? `${cut.slice(0, cut.length - last.length).trimEnd()}…` : x;
}

/** An inbox result's report without the RESULT: label; a long one opens in place. */
function resultSummary(c: ChatItem) {
  const full = plainStatus(c.text);
  if (full.length <= 140) return `<span>${reportText(full)}</span>`;
  const open = ui.resOpen.has(c.id);
  return `<span>${reportText(open ? full : clipWords(full, 140))} <button type="button" class="linkbtn" data-action="res-more" data-id="${esc(c.id)}" aria-expanded="${open}">${t(open ? 'res.less' : 'res.more')}</button></span>`;
}

export function resultGlyph(x: Task | null, err = false) {
  if (err) return sym('s-alert', 'c-red');
  if (stoppedTask(x)) return sym('s-stop', 'c-gray');
  if (x?.prState === 'MERGED') return sym('s-merge', 'c-pr-merged');
  return x?.prUrl ? sym('s-pr', x.prState === 'CLOSED' ? 'c-pr-closed' : 'c-pr-open') : x?.files.length ? sym('s-doc', 'c-teal') : sym('s-check', 'c-green');
}

/**
 * A task that failed, as a card: what it was, the step it stopped at, the error, and what to do about it. Told apart by
 * its alert tile and "Failed" pill. Null for an error that is not about a Worker's task, which stays a line.
 */
function failureHtml(c: ChatItem) {
  const x = task(c.ref);
  const w = x?.workerId ? worker(x.workerId) : null;
  if (!x || !w) return null;
  // Still where it failed: the card says where and offers to go on. Once the task moved on, it is history.
  const still = x.status === 'failed' && !x.stopped;
  const v = still ? stepView(x) : null;
  const at = v && !v.allDone ? stepText(t, v, true) : '';
  const why = still ? plainStatus(x.summary) : c.text;
  const last = workerTask(w)?.id === x.id;
  const go = still && last && lastFailed(w, x) ? `<button type="button" class="btn" data-action="worker-continue" data-id="${esc(w.id)}" aria-label="${esc(t('wk.continueWho', { id: w.id }))}">${t('wk.continue')}</button>` : '';
  return `<div class="attach fail" data-task="${esc(x.id)}" data-src="card:${esc(x.id)}"><span class="tile">${sym('s-alert', 'c-red')}</span><span class="body"><b>${esc(x.title)}<span class="pill" data-tone="danger">${t('st.failed')}</span></b><span class="sm">${esc([w.id, w.repo ?? t('general'), at, why].filter(Boolean).join(' · '))}</span><span class="links">${go}<a tabindex="0" role="link" data-action="open-worker" data-id="${esc(w.id)}">${t('chat.viewWorker', { id: w.id })}</a>${replyLink(x, why, c.id)}</span></span></div>`;
}

/**
 * "Reply" on a report card: the composer's reply chip quotes the report, and the message is filed under the card.
 * `icon`: an icon-only button, as in a result card's action row.
 */
function replyLink(x: Task, text: string, card: string, icon = false) {
  const data = `data-action="reply" data-box="chat" data-who="${esc(x.workerId ?? x.id)}" data-quote="${esc(replyExcerpt(`${x.title}: ${text}`))}" data-task="${esc(card)}" data-src="card:${esc(x.id)}"`;
  return icon ? iconBtn('s-reply', t('chat.reply'), data) : `<a tabindex="0" role="link" ${data}>${t('chat.reply')}</a>`;
}

/** An icon-only button in a result's action row, named by its label for screen readers and on hover. */
const iconBtn = (icon: string, label: string, data: string) => `<button type="button" class="btn btn-icon btn-sm btn-ghost" ${data} aria-label="${esc(label)}" data-tip="${esc(label)}">${sym(icon)}</button>`;

/** The hand-out runs of the thread drawn last, by their first line (shared/handouts.ts). */
let runs = new Map<string, ChatItem[]>();

const HAND_PILL: Record<HandoutState, [string, Key]> = { ask: ['ask', 'st.waitingMe'], run: ['accent', 'st.running'], failed: ['danger', 'st.failed'], queued: ['warning', 'st.queued'], done: ['success', 'task.done'], stopped: ['', 'task.stopped'] };
const HAND_ICON: Record<HandoutState, [string, string]> = { ask: ['ask', 'ask'], run: ['run', 'run'], failed: ['err', 'err'], queued: ['wait', 'wait'], done: ['done', 'done'], stopped: ['idle', 'idle'] };

/** Each task of a run with where it stands now; tasks no longer in the state are left out. */
function handoutRows(run: ChatItem[]) {
  const pending = S!.decisions.filter((d) => d.status === 'pending');
  return runTasks(run).map((id) => task(id)).filter((x): x is Task => !!x).map((x) => {
    const d = pending.find((p) => p.taskId === x.id) ?? null;
    return { x, d, st: handoutState(x, !!d) };
  });
}

/** What a run's block depends on, so the thread is drawn again when one of its tasks moves. */
function handoutKey() {
  return [...runs.values()].map((run) => handoutRows(run).map(({ x, d, st }) => `${x.id}${st}${d?.id ?? ''}${stepView(x)?.done ?? ''}`).join()).join('|');
}

/**
 * A run of hand-outs as one block: how many tasks and where they stand, then a row per task that opens its Worker.
 * It stays open while something is left to follow and folds to its heading once all are done; the heading toggles it.
 */
function handoutHtml(c: ChatItem) {
  const run = runs.get(c.id) ?? [c];
  const rows = handoutRows(run);
  if (!rows.length) return run.map((e) => `<span class="event">${sym('s-cpu', 'c-blue')}<span>${linkify(esc(e.text))}</span></span>`).join('');
  const states = rows.map((r) => r.st);
  // Folding is kept by the run's first task, which stays the same when older pages load and the run starts earlier.
  const key = runTasks(run)[0] ?? c.id;
  const open = handoutSettled(states) === ui.handToggled.has(key);
  const sum = handoutCounts(states).map(([s, n]) => t(`ho.${s}` as Key, { n })).join(' · ');
  const row = ({ x, d, st }: (typeof rows)[number]) => {
    const w = worker(x.workerId);
    const v = stepView(x);
    const detail = st === 'ask' && d ? oneLine(askLine(d), 100)
      : st === 'run' && v && !v.allDone ? stepText(t, v)
      : st === 'failed' && v && !v.allDone ? stepText(t, v, true)
      : st === 'queued' ? taskLabel(x)
      : st === 'done' && x.prUrl ? `PR #${prNum(x.prUrl)}` : '';
    const [cls, label] = st === 'queued' && x.status === 'blocked' ? ['warning', 'st.afterMerge' as Key] : st === 'done' && x.prUrl && x.prState === 'OPEN' ? ['pr-open', 'st.prOpen' as Key] : HAND_PILL[st];
    const sub = [x.workerId, w?.repo ?? t('general'), detail].filter(Boolean).join(' · ');
    const body = `${ic(...HAND_ICON[st])}<span class="t"><b>${esc(x.title)}</b><small>${esc(sub)}</small></span><span class="pill"${pillTone(cls)}>${t(label)}</span>`;
    return w ? `<button type="button" class="hrow" data-action="open-worker" data-id="${esc(w.id)}">${body}</button>` : `<div class="hrow">${body}</div>`;
  };
  const head = `<button type="button" class="hand-h" data-action="hand-fold" data-id="${esc(key)}" aria-expanded="${open}">${sym('s-cpu', 'c-blue')}<b>${t(rows.length === 1 ? 'ho.titleOne' : 'ho.title', { n: rows.length })}</b><span>${esc(sum)}</span><svg class="chev" aria-hidden="true"><use href="#s-chev"/></svg></button>`;
  return `<div class="hand${open ? ' open' : ''}" role="group" aria-label="${esc(t(rows.length === 1 ? 'ho.titleOne' : 'ho.title', { n: rows.length }))}">${head}${open ? `<div class="hand-rows">${rows.map(row).join('')}</div>` : ''}</div>`;
}

/** The event blocks of the thread drawn last, by their first line (shared/chatEvents.ts). */
let evBlocks = new Map<string, EvBlock<ChatItem>>();
/** How many times an error said again right after itself was said (renderChat). */
let evTimes = new Map<string, number>();

const evIcon = (icon: EvIcon, tone: EvTone, label: string) => `<span class="evi" role="img" aria-label="${esc(label)}" data-tip="${esc(label)}">${sym(`e-${icon}`, TONE_COLOR[tone])}</span>`;

/** An event's time as 24-hour HH:MM (the day is in its tooltip and in the thread's stamps). */
const clock = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * One event as a row (option A of T-0140): its icon, the task's id, a short title cut with an ellipsis, the Worker,
 * a badge and the time. Clicking the title opens the Worker. A line saved without its parts shows its sentence.
 */
function evRowHtml(c: ChatItem, then = false) {
  const n = evTimes.get(c.id) ?? 1;
  const times = n > 1 ? ` <b class="times">×${n}</b>` : '';
  const e = c.ev;
  const pre = then ? `<span class="evi" role="img" aria-label="${esc(t('evs.then'))}">${sym('e-then', 'c-gray')}</span>` : '';
  const time = `<time datetime="${esc(c.ts)}" data-tip="${esc(hhmm(c.ts))}">${clock(c.ts)}</time>`;
  if (!e) {
    // An error about a Worker's task saved before rows: its card, as it was.
    if (c.kind === 'error' && failureHtml(c)) return `<div class="evrow wide" role="listitem">${failureHtml(c)}</div>`;
    const icon = c.kind === 'error' ? sym('s-alert', 'c-red') : sym('s-cpu', 'c-blue');
    return `<div class="evrow${c.kind === 'error' ? ' err' : ''}" role="listitem">${pre}<span class="evi">${icon}</span><span class="evt" data-tip="${esc(c.text)}">${linkify(esc(c.text))}${times}</span>${time}</div>`;
  }
  const info = EV_KINDS[e.k];
  const x = task(e.task);
  const w = worker(e.worker ?? x?.workerId);
  // A usage limit is about every account; a line about nothing named keeps its sentence, cut to the row.
  const title = e.title || x?.title || (e.k === 'limitPaused' || e.k === 'limitHeld' ? t('evs.allAccounts') : c.text);
  const b = evBadge(e);
  let go = '';
  if (e.k === 'failed' && x && w) {
    // Still where it failed: the badge says the step, and it can go on from there.
    const v = stepView(x);
    if (x.status === 'failed' && !x.stopped && v && !v.allDone) Object.assign(b, { key: 'evb.failedAt', vars: { ...b.vars, n: v.at + 1, max: v.total } });
    if (x.status === 'failed' && !x.stopped && workerTask(w)?.id === x.id && lastFailed(w, x)) go = iconBtn('s-play', t('wk.continueWho', { id: w.id }), `data-action="worker-continue" data-id="${esc(w.id)}"`);
  }
  const chip = e.task ? `<span class="evid">${esc(e.task)}</span>` : '';
  const name = w ? `<button type="button" class="evt" data-action="open-worker" data-id="${esc(w.id)}" data-tip="${esc(c.text)}">${esc(title)}</button>` : `<span class="evt" data-tip="${esc(c.text)}">${esc(title)}</span>`;
  const who = e.worker || x?.workerId ? `<span class="evw">${esc(e.worker ?? x?.workerId ?? '')}</span>` : '';
  return `<div class="evrow${evFresh.has(c.id) ? ' fresh' : ''}" role="listitem" data-ev="${esc(e.k)}">${pre}${evIcon(info.icon, info.tone, t(`evk.${e.k}` as Key))}${chip}${name}${times}${who}<span class="pill"${pillTone(info.tone)}>${esc(t(b.key as Key, b.vars))}</span>${go}${time}</div>`;
}

/** Lines new since the last draw that joined a block already on screen: they rise in on their own (or its summary row does). */
let evFresh = new Set<string>();

/** A row with the events it caused hanging under it, in one box (a merge, then the task that waited on it). */
const evPairHtml = (r: EvRow<ChatItem>) => (r.then.length ? `<div class="evpair" role="group">${evRowHtml(r.c)}${r.then.map((x) => evRowHtml(x, true)).join('')}</div>` : evRowHtml(r.c));

/**
 * A run of events (option C of T-0140): a few stay rows; a burst folds into one summary row that counts them by kind
 * and opens to the rows. What needs the user (a failure, a usage limit, an error) is never folded: it stays under it.
 */
function evBlockHtml(b: EvBlock<ChatItem>) {
  const rows = b.rows.map(evPairHtml).join('');
  if (!b.fold) return `<div class="evs" role="list" aria-label="${esc(t('evs.list'))}">${rows}</div>`;
  const open = ui.evOpen.has(b.id);
  const label = t('evs.title', { n: b.n });
  const span = clock(b.from) === clock(b.to) ? clock(b.from) : `${clock(b.from)}–${clock(b.to)}`;
  const counts = b.counts.map((n) => {
    const what = n.kinds.length ? n.kinds.map((k) => t(`evk.${k}` as Key)).join(', ') : t('evs.list');
    return `<span class="evn" data-tip="${esc(what)}">${evIcon(n.icon, n.tone, what)}${n.n}</span>`;
  }).join('');
  const fresh = !open && b.rows.some((r) => [r.c, ...r.then].some((x) => evFresh.has(x.id)));
  const head = `<button type="button" class="evs-h${fresh ? ' fresh' : ''}" data-action="evs-fold" data-id="${esc(b.id)}" aria-expanded="${open}" aria-label="${esc(`${label} ${span}`)}">${sym('e-stack', 'c-gray')}<b>${esc(label)}</b><span class="evs-at">${span}</span><span class="evs-n">${counts}</span><svg class="chev" aria-hidden="true"><use href="#s-chev"/></svg></button>`;
  const body = open ? `<div class="evs-rows" role="list" aria-label="${esc(t('evs.list'))}">${rows}</div>` : '';
  const pinned = b.pinned.length ? `<div class="evs pin" role="list" aria-label="${esc(t('evs.pinned'))}">${b.pinned.map((c) => evRowHtml(c)).join('')}</div>` : '';
  return `<div class="evblk"><div class="evs fold${open ? ' open' : ''}" role="group" aria-label="${esc(label)}">${head}${body}</div>${pinned}</div>`;
}

export function chatItemHtml(c: ChatItem) {
  switch (c.kind) {
    case 'user': return `<div class="bub me">${userText(c.text, (f) => sentFiles(f, `me:${c.id}`))}</div>`;
    case 'dispatcher': return replyable(`<div class="bub ai">${md(c.text)}</div>`, 'chat', 'Dispatcher', c.text, c.id, c.id);
    case 'event': return isHandout(c) ? handoutHtml(c) : `<span class="event">${sym('s-cpu', 'c-blue')}<span>${linkify(esc(c.text))}</span></span>`;
    case 'decision': return `<span class="event mine">${sym('s-check', 'c-green')}<span><b>${t('chat.decided')}</b> ${esc(c.text)}</span></span>`;
    case 'error': return failureHtml(c) ?? `<span class="event err">${sym('s-alert', 'c-red')}<span>${esc(c.text)}</span></span>`;
    case 'auto': {
      const a = S!.autoAnswers.find((x) => x.id === c.ref);
      return `<button class="event self" data-action="aa-select" data-id="${c.ref ?? ''}" data-tip="${t('chat.showRight')}">${sym('s-check', 'c-green')}<span><b>${a?.corrected ? t('chat.autoCorrected') : t('chat.auto')}</b> ${esc(c.text)}</span><svg class="chev" aria-hidden="true"><use href="#s-chev"/></svg></button>`;
    }
    case 'shell': return shellBlockHtml(c);
    case 'result': {
      const x = task(c.ref);
      const conv = x?.workerId ? iconBtn('s-chat', t('chat.viewWorker', { id: x.workerId }), `data-action="open-worker" data-id="${esc(x.workerId)}"`) : '';
      const p = resultParts(x, c.text, `card:${c.id}`, conv + (x ? replyLink(x, c.text, c.id, true) : ''));
      return `<div class="attach" data-task="${esc(c.ref ?? '')}"${x ? ` data-src="card:${esc(x.id)}"` : ''}><span class="tile">${resultGlyph(x)}</span><span class="body"><b>${esc(x?.title ?? t('task'))}${resultMeta(x)}</b><span class="sm">${reportText(plainStatus(c.text))}</span>${p.media}${p.row}</span></div>`;
    }
  }
}

/** Who wrote a message replies can answer, as a reply quotes it: the report's Worker, or the Dispatcher. */
const rootWho = (c: ChatItem) => (isReport(c) ? task(c.ref)?.workerId ?? c.ref ?? '' : 'Dispatcher');

/** What a message replies can answer is called: the report's task, or the Dispatcher's first words. */
const rootWhat = (c: ChatItem, n = 80) => (isReport(c) ? task(c.ref)?.title ?? c.ref ?? t('task') : oneLine(c.text, n));

/**
 * One reply on its branch (A-1 of T-0086): an elbow from the trunk, then the message, the user's own on the branch's
 * end as the Dispatcher's is. A quote of the root, or of a message in the same thread, is what the line already says,
 * so the bubble shows only the words. The strip the line runs in goes back to the root when clicked.
 */
function branchRow(c: ChatItem, root: ChatItem, thread: ChatItem[]) {
  let body = chatItemHtml(c);
  if (c.kind === 'user') {
    const r = parseReply(c.text);
    const inView = !!r && ((r.who === rootWho(root) && (isReport(root) || r.quote === replyExcerpt(root.text)))
      || (r.who === 'Dispatcher' && thread.some((x) => x.kind === 'dispatcher' && replyExcerpt(x.text) === r.quote)));
    if (r && inView) body = `<div class="bub me">${userText(r.body, (f) => sentFiles(f, `me:${c.id}`))}</div>`;
  }
  const go = `<button type="button" class="br-go" data-action="reply-root" data-id="${esc(root.id)}" tabindex="-1" aria-label="${esc(t('reply.toRoot'))}"></button>`;
  return `<div class="br-r ${c.kind === 'user' ? 'me' : 'ai'}" data-k="${esc(root.id)}" data-id="${esc(c.id)}"><i class="el" aria-hidden="true"></i>${go}${body}</div>`;
}

/** A branch that starts after other messages starts from a tag naming what it answers; the tag goes back to it. */
function branchTag(root: ChatItem) {
  const who = rootWho(root), what = rootWhat(root);
  return `<button type="button" class="otag" data-action="reply-root" data-id="${esc(root.id)}" data-k="${esc(root.id)}" aria-label="${esc(t('reply.tagAria', { who, what }))}">${sym('s-reply')}<b>${esc(who)}</b><span class="q">${esc(what)}</span></button>`;
}

/** A message replies can answer carries its id, so R, the branches and their tags find it. */
function rootAttr(html: string, id: string) {
  return html.replace(/^<(\w+) class="/, `<$1 data-root="${esc(id)}" class="`);
}

/** The element of a message replies answer, as it is ringed and flashed: a report card, or the Dispatcher's bubble. */
export function rootEl(id: string): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(`#chat-thread [data-root="${CSS.escape(id)}"]`);
  return el?.matches('.bline') ? el.querySelector<HTMLElement>(':scope > .bub') : el;
}

/** Takes the light off every branch and root (lightBranch). */
function unlight(th: HTMLElement) {
  for (const el of th.querySelectorAll('.lit, .thru, .reply-on')) el.classList.remove('lit', 'thru', 'reply-on');
}

/**
 * Under the pointer or the keyboard, the way from a reply back to what it answers turns blue and the root gets its
 * ring: from a reply, its elbow and the trunk above it (and the tag of a late branch); from a tag or a root, every
 * branch of that root.
 */
function lightBranch(th: HTMLElement, from: HTMLElement | null) {
  unlight(th);
  const el = from?.closest<HTMLElement>('.br-r, .otag, [data-root]');
  if (!el || !th.contains(el)) return;
  const k = el.dataset.k ?? el.dataset.root!;
  rootEl(k)?.classList.add('reply-on');
  const whole = (br: Element) => {
    for (const x of br.querySelectorAll(':scope > .otag')) x.classList.add('lit');
    for (const x of br.querySelectorAll(':scope > .br-r')) x.classList.add('lit', 'thru');
  };
  if (el.matches('.br-r')) {
    el.classList.add('lit');
    for (let p = el.previousElementSibling; p; p = p.previousElementSibling) {
      if (p.matches('.br-r')) p.classList.add('thru');
      else if (p.matches('.otag')) p.classList.add('lit');
    }
  } else if (el.matches('.otag')) whole(el.parentElement!);
  else for (const br of th.querySelectorAll(`.br[data-k="${CSS.escape(k)}"]`)) whole(br);
}

/** A redraw drops the light: it goes back on from what is under the pointer, or else what has the focus. */
function relight(th: HTMLElement) {
  const hovered = [...th.querySelectorAll<HTMLElement>(':hover')].pop();
  const focused = th.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  if (hovered || focused) lightBranch(th, hovered ?? focused);
  else unlight(th);
}

/** The branches follow the pointer and the focus, and R on a message starts a reply to it (or to its branch's root). */
export function bindBranches() {
  const th = $('#chat-thread');
  th.addEventListener('mouseover', (e) => lightBranch(th, e.target as HTMLElement));
  th.addEventListener('mouseleave', () => unlight(th));
  th.addEventListener('focusin', (e) => lightBranch(th, e.target as HTMLElement));
  th.addEventListener('focusout', (e) => { if (!th.contains(e.relatedTarget as Node | null)) unlight(th); });
  th.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyR' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return;
    const el = e.target as HTMLElement;
    if (el.matches('input, textarea, [contenteditable]')) return;
    const msg = el.closest<HTMLElement>('.br-r, [data-root]');
    if (!msg) return;
    // A reply of the user's own has no Reply of its own: R answers what its branch answers.
    const own = msg.querySelector<HTMLElement>('[data-action="reply"]');
    const btn = own ?? (msg.dataset.k ? th.querySelector<HTMLElement>(`[data-root="${CSS.escape(msg.dataset.k)}"] [data-action="reply"]`) : null);
    if (!btn) return;
    e.preventDefault();
    btn.click();
  });
}

/** The chat items held: pages loaded with chat:page, then the state's snapshot. */
export function chatAll(): ChatItem[] {
  return ui.chatOlder.length ? [...ui.chatOlder, ...S!.chat] : S!.chat;
}

/** Whether the store has chat items before the first one held (the snapshot is full, and no answer said none). */
export function chatHasEarlier(all: ChatItem[]) {
  return S!.chat.length >= CHAT_SNAPSHOT && !!all[0] && all[0].id !== ui.chatEndAt;
}

/**
 * The thread shows its last page and, once the reader scrolls up, from the first item shown on (ui.chatFrom).
 * `older`: a page went in above, so the reader's place is kept from the end.
 */

export function renderChat(force = false, older = false) {
  const s = S!;
  const th = $('#chat-thread');
  const nearBottom = th.scrollHeight - th.scrollTop - th.clientHeight < 80;
  const all = chatAll();
  const from = threadStart(all.length, all.findIndex((c) => c.id === ui.chatFrom), PAGE.chat, (nearBottom || force) && !older);
  ui.chatFrom = all[from]?.id ?? null;
  // Pages no longer shown are let go; scrolling up loads them again.
  if (ui.chatOlder.length && from >= ui.chatOlder.length) ui.chatOlder = [];
  const earlier = from > 0 || chatHasEarlier(all);
  runs = handoutRuns(all.slice(from));
  const key = `${lang()}:${s.setupNeeded}:${s.preflightFailed}:${s.repos.length > 0}:${ui.chatFrom}:${all.length - from}:${s.chat[s.chat.length - 1]?.id}:${earlier}:${ui.loadingOlder.has('chat')}:${s.dispatcher.busy}:${s.dispatcher.statusText}:${s.autoAnswers.filter((a) => a.corrected).length}:${shellKey(all.slice(from))}:${s.tasks.map((x) => x.status + x.prUrl + x.prState + (x.prChecks ? JSON.stringify(x.prChecks) : '')).join()}`;
  // The hand-out blocks follow their tasks: a step done or a decision answered draws them again.
  const hands = `${handoutKey()}:${[...ui.handToggled].join()}:${[...ui.evOpen].join()}`;
  if (!force && !older && key === ui.lastChatKey && hands === ui.lastHandKey) return;
  ui.lastChatKey = key;
  ui.lastHandKey = hands;
  // Pieces of whole elements, so those that stay the same keep theirs (setThread).
  let pieces: string[] = earlier ? [olderBtn('chat', ui.loadingOlder.has('chat'))] : [];
  let last = 0;
  const folded = handoutFolded(runs);
  // The same error said again right after itself (e.g. every account at its limit) shows once with a count.
  const listed: { c: ChatItem; n: number }[] = [];
  for (const c of all.slice(from)) {
    const prev = listed[listed.length - 1];
    // A later hand-out of the turn is drawn in the block its first line opens.
    if (folded.has(c.id)) continue;
    if (prev && c.kind === 'error' && prev.c.kind === 'error' && prev.c.text === c.text && !c.ref && !prev.c.ref) { prev.n++; continue; }
    listed.push({ c, n: 1 });
  }
  // Events next to each other are one block, drawn where its first line is (shared/chatEvents.ts).
  evTimes = new Map(listed.filter((x) => x.n > 1).map((x) => [x.c.id, x.n]));
  evBlocks = eventBlocks(listed.map(({ c }) => c));
  const headOf = new Map<string, string>();
  for (const b of evBlocks.values()) for (const c of [...b.rows.flatMap((r) => [r.c, ...r.then]), ...b.pinned]) headOf.set(c.id, b.id);
  const items = listed.filter(({ c }) => (headOf.get(c.id) ?? c.id) === c.id);
  // What arrived since the last render comes in with a short rise: everything after the marker (styles.css, .new-from).
  const seenAt = older ? -1 : listed.findIndex(({ c }) => c.id === ui.chatSeen);
  const tail = listed[listed.length - 1]?.c.id ?? null;
  // Only what is new is read out (L14): the last line from the app or an agent since the previous draw.
  if (seenAt >= 0 && !older) {
    const fresh = listed.slice(seenAt + 1).map(({ c }) => c).filter((c) => c.kind !== 'user');
    if (fresh.length) announce(fresh[fresh.length - 1].text);
  }
  // The marker goes before the block the first new line is drawn in, unless that block was already there.
  const next = seenAt >= 0 ? listed[seenAt + 1]?.c.id : undefined;
  const nextHead = next ? headOf.get(next) ?? next : null;
  const mark = nextHead && listed.findIndex(({ c }) => c.id === nextHead) > seenAt ? items.findIndex(({ c }) => c.id === nextHead) : -1;
  evFresh = new Set(mark < 0 && next ? listed.slice(seenAt + 1).map(({ c }) => c.id).filter((id) => headOf.has(id)) : []);
  // Replies hang off what they answer (A-1 of T-0086): a run of replies right under their root is one branch from it;
  // a reply after other messages keeps its place in time, on a branch that starts from a tag naming the root.
  const ix = threadIndex(items.map(({ c }) => c));
  const layout = branchLayout(ix);
  const threadOf = (r: number) => (ix.replies.get(r) ?? []).map((j) => items[j].c);
  // The branch being drawn: one piece with its replies, closed when the next message is not on it.
  let br: string | null = null;
  for (let i = 0; i < items.length; i++) {
    const { c, n } = items[i];
    const b = layout[i];
    if (br !== null && (!b || b.start)) { pieces.push(br + '</div>'); br = null; }
    // The "new" marker goes in before the message; a reply's goes inside its branch, which stays right under its root.
    const fresh = i === mark ? NEW_FROM : '';
    if ((!b || b.late && b.start) && fresh) pieces.push(fresh);
    const ts = Date.parse(c.ts);
    // No time line inside a branch, or between a root and the branch right under it.
    if ((!b || b.late && b.start) && ts - last > 30 * 60_000) pieces.push(`<span class="stamp">${hhmm(c.ts)}</span>`);
    last = ts;
    if (b) {
      const r = items[b.root].c;
      // A late branch had its "new" marker before its time line; a near one keeps it inside, under its card.
      if (b.start) br = `<div class="br${b.late ? ' late' : ''}" data-k="${esc(r.id)}" role="group" aria-label="${esc(t('chat.repliesTo', { title: rootWhat(r, 60) }))}">${b.late ? branchTag(r) : fresh}`;
      else br = (br ?? '') + fresh;
      br += branchRow(c, r, threadOf(b.root));
      continue;
    }
    const blk = evBlocks.get(c.id);
    let one = blk ? evBlockHtml(blk) : n > 1 ? chatItemHtml(c).replace(/<\/span><\/span>$/, ` <b class="times">×${n}</b></span></span>`) : chatItemHtml(c);
    if (canRoot(c)) one = rootAttr(one, c.id);
    // Which message it is, for a search that goes to one (find.ts).
    one = one.replace(/^<(\w+)(?=[\s>])/, `<$1 data-msg="${esc(c.id)}"`);
    pieces.push(one);
  }
  if (br !== null) pieces.push(br + '</div>');
  // A first start: a few starts that fill the composer for the user to finish. Nothing is sent.
  // With no account nothing can be handed out yet: the steps that get there instead (A1).
  if (!all.length) pieces = [s.setupNeeded ? setupHtml() : `<div class="empty-view">${sym('s-chat')}<b>${t('chat.emptyTitle')}</b><div class="starts">${STARTS.map((key) => `<button type="button" class="btn" data-action="chat-start" data-text="${esc(t(key))}">${t(key)}</button>`).join('')}</div></div>`];
  ui.chatSeen = tail;
  setThread(th, pieces, nearBottom || force, older);
  refreshFind('chat-thread');
  relight(th);
  markReplyTarget('chat');
  watchTop(th, () => void olderChat());
  renderCtxMeter();
  updateSendButton();
}

const STARTS: Key[] = ['chat.start1', 'chat.start2', 'chat.start3'];

/**
 * The first run before an account: git and gh, the account, a repository. Each step is one button and is ticked
 * once done; the first open one is ringed and its button is the primary one.
 */
export function setupHtml() {
  const s = S!;
  const steps = [
    { label: t('setup.tools'), done: !s.preflightFailed, btn: `<button type="button" class="btn" data-action="open-settings" data-v="general">${t('setup.toolsSee')}</button>` },
    { label: t('setup.account'), done: false, btn: `<button type="button" class="btn" data-action="open-settings" data-v="accounts">${t('usage.addAccount')}</button>` },
    { label: t('setup.repo'), done: s.repos.length > 0, btn: `<button type="button" class="btn" data-action="setup-repo">${t('repo.add')}</button>` },
  ];
  const cur = steps.findIndex((x) => !x.done);
  const check = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.8 5.3l2.1 2.1 4.2-4.6"/></svg>';
  return `<div class="empty-view setup"><b role="heading" aria-level="2">${t('setup.title')}</b><ol class="setup-steps">${steps.map((x, i) => `<li class="setup-step${x.done ? ' done' : ''}${i === cur ? ' cur' : ''}"><span class="num">${x.done ? check : i + 1}</span><span class="lbl">${x.label}</span>${x.done ? `<span class="ok">${t('pre.ok')}</span>` : i === cur ? x.btn.replace('class="btn"', 'class="btn btn-primary"') : x.btn}</li>`).join('')}</ol></div>`;
}

/**
 * The Dispatcher's context in the composer: the ring alone under half the window, the numbers from there, and in
 * orange with a "Compact" chip from where it is compacted. Its label always has the numbers.
 */
function renderCtxMeter() {
  const ctx = S!.dispatcher.contextTokens;
  const btn = $<HTMLButtonElement>('#chat-ctx');
  const hot = ctx >= COMPACT_AT, quiet = ctx < CONTEXT_WINDOW / 2;
  btn.innerHTML = `${ring(ctx / CONTEXT_WINDOW).replace('class="ring"', '')}${quiet ? '' : `${k(ctx)} / ${k(CONTEXT_WINDOW)}`}${hot ? `<span class="pill" data-tone="warning">${t('chat.compactChip')}</span>` : ''}`;
  btn.classList.toggle('hot', hot);
  const label = t('chat.ctxLabel', { a: k(ctx), b: k(CONTEXT_WINDOW) });
  btn.setAttribute('aria-label', label);
  setTip(btn, label);
  // Its menu compacts or starts again, and says what was spent: with none of the three it has nothing to open.
  btn.disabled = !!S!.dispatcher.busy || (!ctx && !hasSpend(S!.dispatcher.spend));
}

/** "0:18", "12:05", "1:02:09": how long the Dispatcher has been at it. */
export function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

let dstatKey = '';

/**
 * While the Dispatcher works: a line on the composer (what it does, for how long, Stop) and a dot on the Chat tab,
 * so it shows from any view and when the thread is scrolled up. The clock ticks on its own (tickDispatcher).
 */
export function renderDispatcherStatus() {
  const d = S!.dispatcher;
  const busy = !!d.busy;
  document.querySelector('#views button[data-v="chat"]')?.classList.toggle('busy', busy);
  const input = $<HTMLTextAreaElement>('#chat-input');
  // Without an account there is no one to send to: the box waits, saying what it needs (A1).
  const noAcc = !!S!.setupNeeded;
  const ph = t(noAcc ? 'chat.phNoAccount' : busy ? 'chat.phBusy' : 'chat.ph');
  if (input.placeholder !== ph) input.placeholder = ph;
  if (input.disabled !== noAcc) input.disabled = noAcc;
  const el = $('#chat-dstat');
  const key = `${lang()}:${busy}:${d.busySince ?? ''}:${d.statusText}`;
  if (key === dstatKey) return;
  dstatKey = key;
  el.hidden = !busy;
  if (!busy) { el.innerHTML = ''; return; }
  const what = d.statusText ? oneLine(d.statusText, 120) : t('chat.working');
  el.innerHTML = `<span class="pulse-dot" aria-hidden="true"></span><b>Dispatcher</b><span class="what">${esc(what)}</span><time></time><button type="button" class="linkbtn" data-action="chat-stop" aria-label="${esc(t('chat.stop'))}">${t('chat.stopShort')}</button>`;
  tickDispatcher();
}

/** The status line's clock, every second while the Dispatcher works; only its own text changes. */
export function tickDispatcher() {
  const since = S?.dispatcher.busy ? S.dispatcher.busySince : null;
  const el = document.querySelector<HTMLTimeElement>('#chat-dstat time');
  if (!el) return;
  el.hidden = !since;
  if (since) el.textContent = elapsed(Date.now() - Date.parse(since));
}

/** Show the chat page before the first one shown: from the items held, else from the store (chat:page). */
export async function olderChat() {
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

/**
 * The Worker's composer: with nothing typed, the send button stops the Worker (canStop). The chat's stays Send, since
 * a message to a busy Dispatcher joins its request; its Stop is on the status line (renderDispatcherStatus).
 */
export function updateSendButton() {
  const set = (btn: HTMLButtonElement | null, stop: boolean, label: string) => {
    if (!btn) return;
    if (btn.classList.contains('stop') === stop && btn.getAttribute('aria-label') === (stop ? label : t('send'))) return;
    btn.classList.toggle('stop', stop);
    btn.innerHTML = sym(stop ? 's-stop' : 's-up');
    btn.setAttribute('aria-label', stop ? label : t('send'));
    setTip(btn, stop ? label : t('send'));
  };
  const empty = (box: Box) => !$<HTMLTextAreaElement>(box === 'chat' ? '#chat-input' : '#ws-input').value.trim() && !ui.attach[box].length;
  const send = $<HTMLButtonElement>('#chat-send');
  // Shell mode: the button runs the line.
  if (ui.shell) {
    if (send.getAttribute('aria-label') !== t('shell.run')) { send.classList.remove('stop'); send.innerHTML = sym('s-play'); send.setAttribute('aria-label', t('shell.run')); setTip(send, t('shell.run')); }
  } else set(send, false, t('chat.stop'));
  // Nothing to send: the button is not ready either. As Stop it always is.
  send.disabled = empty('chat');
  const w = worker(ui.wSel);
  const cur = w ? workerTask(w) : null;
  const ws = $<HTMLButtonElement>('#ws-send');
  const stop = !!w && canStop(w, cur) && empty('ws');
  set(ws, stop, t('wk.stop'));
  if (ws) ws.disabled = !stop && empty('ws');
}

/** The free-text hint of a decision: it denies with a reason, asks for plan changes, or gives another answer. */
export function decisionHint(d: Decision) {
  return t(d.source === 'permission' ? 'dec.denyWhy' : d.source === 'plan' ? 'plan.revise' : 'dec.other');
}

const KIND_ICON: Record<DecisionKind, string> = { command: 's-term', permission: 's-edit', question: 's-chat', plan: 's-doc' };

/** The kind of a decision as a grey chip with its icon; colour is left to the age and the slot clock. */
export function kindChip(d: Decision) {
  const kind = decisionKind(d);
  return `<span class="dkind">${sym(KIND_ICON[kind])}${t(`dec.kind.${kind}` as Key)}</span>`;
}

/** The age of a decision; its text and its lateness are written by tickDecisions, so a redraw stays the same HTML. */
export const ageHtml = (d: Decision) => `<span class="dage" data-at="${esc(d.createdAt)}" data-task="${esc(d.taskId ?? '')}"></span>`;

/**
 * The selected inbox card (ui.decSel), kept on a pending one: the same one while it waits, else the one after the
 * card just answered, else the first.
 */
export function selectedDecision(): string | null {
  const ids = S!.decisions.filter((d) => d.status === 'pending').map((d) => d.id);
  ui.decSel = keepCard(ids, ui.decSel, ui.decIds);
  ui.decIds = ids;
  return ui.decSel;
}

/** Moves the selection to card `id` in place, without drawing the inbox again; the sidebar row of it is marked too. */
export function markDecision(id: string | null) {
  ui.decSel = id;
  document.querySelectorAll<HTMLElement>('#chat-ins [data-dec]').forEach((el) => {
    const on = el.dataset.dec === id;
    el.classList.toggle('sel', on);
    el.tabIndex = on ? 0 : -1;
    if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
  });
  document.querySelectorAll<HTMLElement>('#side [data-action="goto-decision"]').forEach((el) => {
    const on = el.dataset.id === id;
    el.classList.toggle('sel', on);
    if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
  });
  if (ui.insTab === 'inbox') markPick(id);
}

/** The inbox card of a decision, if it is drawn. */
export const decisionCard = (id: string | null) => id ? document.querySelector<HTMLElement>(`#chat-ins [data-dec="${CSS.escape(id)}"]`) : null;


/**
 * Drawing the inbox again drops a focus inside a card. It goes back to the same card (and button); once the card the
 * user answered is gone, to the card selected after it, so the keyboard can go on with the next decision.
 */
function restoreCardFocus(root: HTMLElement, back: { id: string; val: string | null } | null) {
  // An answer that failed leaves its card; after a while it no longer moves the focus anywhere.
  if (ui.decAnswered && Date.now() - ui.decAnswered.at > 10_000) ui.decAnswered = null;
  const answered = ui.decAnswered?.id;
  const gone = !!answered && !root.querySelector(`[data-dec="${CSS.escape(answered)}"]`);
  if (gone) ui.decAnswered = null;
  const lost = !document.activeElement || document.activeElement === document.body;
  if (!lost) return;
  let id: string | null = null;
  let val: string | null = null;
  if (back && decisionCard(back.id)) ({ id, val } = back);
  else if (back || gone) id = ui.decSel;
  const card = decisionCard(id);
  const btn = val ? card?.querySelector<HTMLElement>(`[data-val="${CSS.escape(val)}"]:not(:disabled)`) : null;
  (btn ?? card)?.focus();
}

/** Writes the age and the slot clock of the decision cards and rows under root: their text only, never a redraw. */
export function tickDecisions(root: ParentNode = document) {
  if (!S) return;
  const now = Date.now();
  const minutes = S.settings.waitSlotMinutes;
  root.querySelectorAll<HTMLElement>('.dage').forEach((el) => {
    const at = el.dataset.at ?? '';
    const text = ago(at);
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('late', decisionLate(at, slotClock(task(el.dataset.task || null), now, minutes), now));
  });
  root.querySelectorAll<HTMLElement>('.dhold').forEach((el) => {
    const clock = slotClock(task(el.dataset.task || null), now, minutes);
    if (el.hidden !== !clock) el.hidden = !clock;
    if (!clock) return;
    el.classList.toggle('gone', clock.state === 'released');
    const text = clock.state === 'released' ? t('dec.slotGone') : t('dec.slotHold', { n: Math.max(1, Math.ceil(clock.left / 60_000)) });
    const span = el.querySelector('span');
    if (span && span.textContent !== text) span.textContent = text;
    const bar = el.querySelector<HTMLElement>('b');
    if (bar) bar.style.transform = `scaleX(${clock.state === 'released' ? 0 : clock.frac.toFixed(3)})`;
  });
}

/** The risk badge of each class: its tone and icon; the label is its i18n key, or the always-ask rule's own name. */
const TAG_LOOK: Record<RiskTag, [string, string]> = {
  rule: ['danger', 's-alert'], delete: ['danger', 's-alert'], network: ['accent', 's-open'], write: ['warning', 's-edit'], read: ['success', 's-doc'], unknown: ['', 's-alert'],
};

/** A fold of a decision card (decision 226): its details, its whole command, or its free-text field. */
const foldOpen = (fold: string, id: string) => ui.decOpen.has(`${fold}:${id}`);
const foldBtn = (fold: string, d: Decision, label: string) => {
  const open = foldOpen(fold, d.id);
  return `<button type="button" class="btn btn-icon btn-sm${fold === 'reply' ? '' : ' btn-ghost'} tog" data-action="dec-fold" data-fold="${fold}" data-id="${d.id}" aria-expanded="${open}" aria-label="${esc(label)}" data-tip="${esc(label)}">${sym(fold === 'reply' ? 's-reply' : 's-chev')}</button>`;
};

/**
 * inWorker: in its Worker's panel, where the Worker's composer is the text field (decision 93).
 * A permission reads action, reason, risk badges and scope above its folded command; any other decision reads what,
 * why, risk and result in one line each, its long text behind the details button (decision 226).
 */
export function decisionHtml(d: Decision, inWorker = false) {
  const x = task(d.taskId);
  const who = d.workerId ?? 'Dispatcher';
  const src = [who, x?.title].filter(Boolean).join(' · ');
  // The inbox has one selected card: it shows its key hints and is the one stop for Tab (roving tabindex).
  const sel = !inWorker && ui.decSel === d.id;
  const keys = decisionKeys(d);
  const kbd = (val: string) => !inWorker && keys.has(val) ? `<kbd aria-hidden="true">${esc(keys.get(val)!)}</kbd>` : '';
  const b = cardBrief(t, d);
  const tip = (s: string | null | undefined) => s ? ` data-tip="${esc(s)}"` : '';
  const label = t('dec.card', { kind: t(`dec.kind.${decisionKind(d)}` as Key), who });
  // A click on the card (not on one of its controls) selects it.
  const card = inWorker ? '' : ` data-dec="${d.id}" data-nav="inbox:${esc(d.id)}" data-action="pick" data-tab="inbox" data-id="${d.id}" role="group" aria-label="${esc(label)}" tabindex="${sel ? 0 : -1}"${sel ? ' aria-current="true"' : ''}`;
  const head = `<div class="src">${kindChip(d)}<span class="who">${esc(src)}</span>${ageHtml(d)}</div>`;
  const hold = d.taskId ? `<div class="dhold" data-task="${esc(d.taskId)}" hidden><i><b></b></i><span></span></div>` : '';
  const btn = (val: string, text: string, cls = '') => `<button class="btn${cls}" data-action="answer" data-id="${d.id}" data-val="${esc(val)}">${text}${kbd(val)}</button>`;
  const id = `${inWorker ? 'wdec' : 'dec'}-${d.id}`;
  if (d.source === 'permission') {
    // "Allow for this task" is there when the action's kind can be named and it is neither a delete nor an always-ask
    // rule; the scope row says what that yes covers.
    const tags = b.tags?.length ? b.tags : [{ kind: 'unknown' as RiskTag }];
    const danger = tags.some((g) => g.kind === 'delete' || g.kind === 'rule');
    const scope = danger ? undefined : d.options.find((o) => o.label === ALLOW_TASK);
    const pills = tags.map((g) => { const [tone, icon] = TAG_LOOK[g.kind]; return `<span class="pill"${pillTone(tone)}>${sym(icon)}${esc(g.label ?? t(`risk.tag.${g.kind}` as Key))}</span>`; }).join('');
    const row = (key: Key, v: string, full: string | null | undefined, cls = '') => v ? `<dt>${t(key)}</dt><dd${cls ? ` class="${cls}"` : ''}${tip(full)}>${v}</dd>` : '';
    const open = foldOpen('cmd', d.id);
    return `<div class="dec perm${sel ? ' sel' : ''}" id="${id}"${card}>
    ${head}
    <dl class="kv">${row('brief.action', esc(b.what), d.reason?.what ?? b.what, 'w')}${row('brief.reason', esc(b.why), d.purpose ?? b.why)}${row('brief.risk', `<span class="risks">${pills}</span>`, d.reason?.why)}${row('brief.scope', scope?.description ? `<code>${esc(scope.description)}</code>` : esc(t('brief.everyTime')), null)}</dl>
    ${d.code ? `<div class="cmd${open ? ' open' : ''}"><code${tip(d.code)}>${esc(d.code)}</code>${foldBtn('cmd', d, t('dec.cmdOpen'))}</div>` : ''}
    ${hold}
    <div class="btns perm" data-fit="stack">${btn(DENY, t('deny'))}${scope ? btn(ALLOW_TASK, t('allowTask')) : ''}${btn(ALLOW, t('allowOnce'), danger ? ' btn-danger' : ' btn-primary')}</div>
  </div>`;
  }
  const sum = d.source === 'plan' ? d.summary : null;
  const title = d.source === 'plan' && d.taskId ? t('brief.planTitle', { id: d.taskId }) : d.title;
  // Each row is one line; its tooltip is the whole text it was cut from.
  const row = (key: Key, v: string | undefined, full: string | null | undefined, cls = '') => v ? `<tr><th scope="row">${t(key)}</th><td${cls ? ` class="${cls}"` : ''}${tip(full || v)}>${esc(v)}</td></tr>` : '';
  const rows = `${row('brief.what', b.what, sum?.what ?? (d.brief ? null : d.detail || d.reason?.what))}${row('brief.why', b.why, d.source === 'plan' || d.brief ? null : d.reason?.why)}${row('brief.risk', b.risk, sum?.risk, 'risk')}${row('brief.out', b.out, sum?.output)}`;
  // Everything longer than a line: the reason's sentences, the detail, a plan's lines and the plan itself.
  const more = [
    d.reason ? `<div class="reason"><span>${esc(d.reason.what)}</span> ${esc(d.reason.why)}</div>` : '',
    d.detail ? `<div class="d">${esc(d.detail)}</div>` : '',
    sum ? planSummaryHtml(d, sum, inWorker) : d.code && d.source === 'plan' ? `<div class="plan-md" data-scroll="plan-${esc(d.id)}">${md(d.code)}</div>` : d.code ? `<code>${esc(d.code)}</code>` : '',
  ].join('');
  const col = d.options.some((o) => o.description);
  const buttons = d.source === 'plan'
    ? btn(ALLOW, t('plan.approve'), ' btn-primary')
    : d.options.map((o, i) => `<button class="btn${i === 0 ? ' btn-primary' : ''}" data-action="answer" data-id="${d.id}" data-val="${esc(o.label)}">${col ? kbd(o.label) : ''}${esc(o.label)}${col ? '' : kbd(o.label)}${o.description ? `<div class="opt-d">${esc(o.description)}</div>` : ''}</button>`).join('');
  // The free-text answer (another answer, or what to change in a plan) opens from its button; in the Worker's panel it is the composer.
  const hint = decisionHint(d);
  const custom = inWorker ? '' : `<input class="inp" data-keep="dec-${d.id}" data-enter="answer-custom" data-id="${d.id}" placeholder="${esc(hint)}" aria-label="${esc(hint)}"${foldOpen('reply', d.id) ? '' : ' hidden'}>`;
  return `<div class="dec brief${sel ? ' sel' : ''}" id="${id}"${card}>
    ${head}
    <div class="qrow"><div class="q"${tip(title)}>${esc(title)}</div>${more ? foldBtn('more', d, t('dec.more')) : ''}</div>
    ${rows ? `<table class="kvt">${rows}</table>` : ''}
    ${more ? `<div class="more"${foldOpen('more', d.id) ? '' : ' hidden'}>${more}</div>` : ''}
    ${hold}
    <div class="btns stack${col ? ' col' : ''}">${buttons}${inWorker ? '' : foldBtn('reply', d, hint)}</div>
    ${custom}
  </div>`;
}

/** A pending decision in the inbox as a slot holding its card. */
function decisionSlot(d: Decision) {
  return slotHtml(d.id, ui.decSel === d.id, decisionHtml(d));
}

/** A plan card's WHAT / HOW / OUTPUT lines, with the full plan folded below them and a way to the Worker's conversation. */
export function planSummaryHtml(d: Decision, sum: PlanSummary, inWorker = false) {
  const open = ui.planOpen.has(d.id);
  const row = (key: Key, v: string) => v ? `<dt>${t(key)}</dt><dd>${inline(v)}</dd>` : '';
  const links = [
    d.code ? `<button data-action="plan-toggle" data-id="${d.id}" aria-expanded="${open}">${t(open ? 'plan.hide' : 'plan.details')}<span aria-hidden="true">${open ? '▴' : '▾'}</span></button>` : '',
    d.workerId && !inWorker ? `<button data-action="open-worker" data-id="${esc(d.workerId)}">${t('plan.open')}<span aria-hidden="true">→</span></button>` : '',
  ].join('');
  return `<dl class="plan-sum">${row('plan.what', sum.what)}${row('plan.how', sum.how)}${row('plan.output', sum.output)}</dl>
    ${sum.auto ? `<div class="plan-auto" data-tip="${esc(t('plan.autoHint'))}">${t('plan.auto')}</div>` : ''}
    ${links ? `<div class="plan-links">${links}</div>` : ''}
    ${open && d.code ? `<div class="plan-md" data-scroll="plan-${esc(d.id)}">${md(d.code)}</div>` : ''}`;
}

export function aaHtml(a: AutoAnswer) {
  const sel = ui.aaSel === a.id ? ' sel' : '';
  const editing = ui.aaEdit === a.id;
  const corrected = a.corrected ? ' corrected' : '';
  const q = `${esc(oneLine(a.question, 140))} → <em>${esc(a.answer)}</em>${a.corrected ? ` <ins>${esc(a.corrected.answer)}</ins>` : ''}`;
  const fix = editing ? `<div class="fix">
      <input class="inp" data-keep="aa-${a.id}" data-enter="aa-send" data-id="${a.id}" placeholder="${t('aa.placeholder')}">
      ${segc(`scope-${a.id}`, 'once', [{ value: 'once', label: t('aa.once') }, { value: 'preference', label: t('aa.pref') }], t('aa.scope'), `data-keep="aa-scope-${a.id}"`, 'seg-fill')}
      <div class="btns"><button class="btn" data-action="aa-cancel">${t('cancel')}</button><button class="btn btn-primary" data-action="aa-send" data-id="${a.id}">${t('aa.send')}</button></div>
    </div>` : '';
  return `<div class="aa${sel}${editing ? ' editing' : ''}${corrected}" id="aa-${a.id}" data-ctx="aa" data-id="${a.id}" data-nav="aa:${esc(a.id)}" tabindex="-1">
    <div class="src">${sym('s-check', 'c-green')}<span>${esc(a.workerId)}, ${hhmm(a.createdAt)}</span></div>
    <div class="q">${q}</div>
    <div class="why">${esc(a.basis)}</div>
    ${a.corrected ? `<div class="fixed">${a.corrected.scope === 'preference' ? t('aa.fixedPref') : t('aa.fixedOnce')}</div>` : ''}
    ${fix}
    <span class="row-acts"><button class="btn btn-icon btn-sm btn-ghost aa-pen" data-action="aa-edit" data-id="${a.id}" data-tip="${t('aa.correct')}" aria-label="${t('aa.correct')}"><svg><use href="#s-pencil"/></svg></button>${rowXHtml('auto', a.id)}</span>
  </div>`;
}

/** "Clear all" in a list's header: every item of the list, with Undo. */
const clearAllHtml = (kind: 'result' | 'auto') => `<button type="button" class="btn btn-sm btn-ghost clear-all" data-action="clear" data-kind="${kind}">${t('ins.clearAll')}</button>`;

/** The ✕ on one row: clears that item only (Delete on the focused row does the same), with Undo. */
function rowXHtml(kind: 'result' | 'auto', id: string) {
  const label = t('ins.clearOne');
  return `<button type="button" class="btn btn-icon btn-sm btn-ghost row-x" data-action="clear-one" data-kind="${kind}" data-id="${esc(id)}" data-tip="${label}" data-tip-key="Delete" aria-label="${label}"><svg aria-hidden="true"><use href="#s-x"/></svg></button>`;
}

/** A "Remember this?" card: save as is, edit then save, or dismiss. */
export function sugHtml(sg: MemorySuggestion) {
  const editing = ui.sugEdit === sg.id;
  const where = sg.scope === 'repo' && sg.repo ? t('sug.repo', { name: sg.repo }) : t('sug.pref');
  const src = [where, sg.taskId ?? sg.workerId].filter(Boolean).join(', ');
  const body = editing
    ? `<input class="inp" data-keep="sug-${sg.id}" data-enter="sug-save" data-id="${sg.id}" value="${esc(sg.text)}" placeholder="${t('sug.placeholder')}" aria-label="${t('sug.placeholder')}">`
    : `<div class="q">${esc(sg.text)}</div>`;
  const save = `<button class="btn btn-primary" data-action="sug-save" data-id="${sg.id}">${t('save')}</button>`;
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
export function visibleAutos() {
  return S!.autoAnswers.filter((a) => !a.cleared).reverse();
}

export async function saveSug(id: string) {
  const inp = document.querySelector<HTMLInputElement>(`[data-keep="sug-${id}"]`);
  const v = inp?.value.trim();
  if (inp && !v) { inp.focus(); return; }
  document.getElementById(`sug-${id}`)?.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
  ui.sugEdit = null;
  await call('suggest:save', id, v);
}

/* ---------- while you were away (decision 122) ---------- */

export const SEEN_KEY = 'oma.lastSeen';

export let away: AwayDigest | null = null;
/** A digest that has not been drawn yet: only its first draw plays the entrance, so later redraws of the inbox leave it still. */
let awayArrive = false;

/** Sets `away` from another module, which cannot assign to an import. */
export function setAway(v: AwayDigest | null) { away = v; }

/** The user is looking now: remember when, for the next absence. */
export function markSeen() {
  try { localStorage.setItem(SEEN_KEY, new Date().toISOString()); } catch { /* not kept */ }
}

/** The window came back (or the app started): if enough happened since the user last looked, the inbox says what. */
export function checkAway() {
  if (!S) return;
  let since: string | null = null;
  try { since = localStorage.getItem(SEEN_KEY); } catch { /* none */ }
  const d = awayDigest(S, since, Date.now());
  markSeen();
  if (!d) return;
  away = d;
  awayArrive = true;
  if (ui.view === 'chat') renderChatInspector();
}

export function awayHtml() {
  if (!away) return '';
  const d = away;
  const span = d.minutes >= 60 * 24 ? t('away.since', { t: when(d.since) }) : tookText(d.minutes);
  // The counts are pills in the board's colours: red is a failure only, and "waiting for you" has the ask colour.
  const counts = ([['danger', d.failed.length, 'away.failed'], ['success', d.finished.length, 'away.finished'], ['review', d.merged.length, 'away.merged'], ['ask', d.waiting, 'away.waiting']] as const)
    .filter(([, n]) => n).map(([c, n, key]) => `<i class="pill" data-tone="${c}">${t(key, { n })}</i>`).join('');
  const arrive = awayArrive ? ' arrive' : '';
  awayArrive = false;
  const rows = awayRows(d);
  const total = new Set([...d.failed, ...d.merged, ...d.finished].map((x) => x.id)).size;
  const pill = { failed: ['danger', taskStatus('failed')], merged: ['review', t('pr.merged')], finished: ['success', taskStatus('done')] } as const;
  return `<div class="sect${arrive}" id="sec-away"><div class="ins-h"><b role="heading" aria-level="2">${t('away.title')}</b><small>${esc(span)}</small><span class="gap"></span><button class="btn btn-icon btn-sm clear-x always" data-action="away-dismiss" data-tip="${t('away.dismiss')}" aria-label="${t('away.dismiss')}"><svg><use href="#s-x"/></svg></button></div>
    <div class="group"><div class="mini away-counts">${counts}</div>${rows.map(({ task: x, kind }) => `<div tabindex="-1" role="button" class="mini away-row" data-action="open-worker" data-id="${esc(x.workerId ?? '')}" data-focus="away:${esc(x.id)}" data-nav="away:${esc(x.id)}"><b>${esc(x.title)}</b><span class="away-m"><span>${esc(x.workerId ?? '')}${x.prUrl ? ` · PR #${prNum(x.prUrl)}` : ''}</span><i class="pill" data-tone="${pill[kind][0]}">${pill[kind][1]}</i></span></div>`).join('')}${total > rows.length ? `<div class="mini"><span>${t('away.more', { n: total - rows.length })}</span></div>` : ''}</div></div>`;
}

export function renderChatInspector() {
  const s = S!;
  const root = $('#chat-ins');
  const was = document.activeElement as HTMLElement | null;
  const card = was && root.contains(was) ? was.closest<HTMLElement>('[data-dec]') : null;
  const back = card ? { id: card.dataset.dec ?? '', val: was === card ? null : was?.dataset.val ?? null } : null;
  // A focused list item (a result, an answer) is drawn again as a new element: the focus goes to the one with its key.
  const nav = was && root.contains(was) && was.matches('[data-nav]') && !card ? was.dataset.nav ?? null : null;
  keepInputs(root, () => {
    const pending = s.decisions.filter((d) => d.status === 'pending');
    // Each tab has an icon for a narrow sidebar: when the labels do not fit, the tabs not chosen show only that (data-fit).
    const tab = (v: 'inbox' | 'memo' | 'auto' | 'script', label: string, icon: string, n = 0) => `<button type="button" role="tab" id="ins-tab-${v}" aria-controls="ins-panel" data-action="ins-tab" data-v="${v}" data-tip="${label}" data-tip-clip aria-selected="${ui.insTab === v}" tabindex="${ui.insTab === v ? 0 : -1}">${sym(icon, 'ti')}<span class="tl">${label}</span>${n ? `<span class="count"${v === 'inbox' ? ' id="tab-count"' : ''}>${n}</span>` : ''}</button>`;
    // The inbox tab counts what waits for the user, so a decision is seen from the Memos tab too.
    const tabs = `<div class="seg ins-tabs" role="tablist" data-fit="tabs" aria-label="${t('ins.tabs')}">${tab('inbox', t('ins.tabInbox'), 's-bell', pending.length)}${tab('memo', t('ins.tabMemo'), 's-pencil')}${tab('auto', t('ins.tabAuto'), 's-refresh')}${tab('script', t('ins.tabScript'), 's-term')}</div>`;
    // The selected card is placed inside the draw, so the typed text and the focus go back to where it ends up.
    const draw = (list: string) => { root.innerHTML = tabs + colsHtml(list, ` role="tabpanel" id="ins-panel" aria-labelledby="ins-tab-${ui.insTab}"`); rove(root); };
    if (ui.insTab === 'memo') return draw(memosHtml());
    if (ui.insTab === 'auto') return draw(autosHtml());
    if (ui.insTab === 'script') return draw(scriptsHtml());
    // Task outcomes only (s.results). Errors without a task (accounts at their limit, Dispatcher errors) stay in the chat.
    const results = paged('results', s.results.slice().reverse(), PAGE.results);
    const autos = paged('autos', visibleAutos(), PAGE.autos);
    let html = '';
    selectedDecision();
    if (pending.length) html += `<div class="sect" id="sec-dec"><div class="ins-h"><b role="heading" aria-level="2">${t('ins.decisions')}</b><span class="count" id="dec-count">${pending.length}</span></div><div class="group">${pending.map(decisionSlot).join('')}</div></div>`;
    // Decisions stay on top; what happened meanwhile comes right under them.
    html += awayHtml();
    html += comparisonsHtml();
    html += bundlesHtml();
    if (s.memorySuggestions.length) html += `<div class="sect"><div class="ins-h" data-tip="${esc(t('sug.hint'))}"><b>${t('ins.remember')}</b></div><div class="group">${s.memorySuggestions.map(sugHtml).join('')}</div></div>`;
    if (results.items.length) {
      html += `<div class="sect"><div class="ins-h"><b role="heading" aria-level="2">${t('ins.results')}</b><span class="gap"></span>${clearAllHtml('result')}</div><div class="group">${results.items.map((c) => {
        const x = task(c.ref);
        const p = resultParts(x, c.text, `res:${c.id}`);
        return `<div class="res" data-task="${esc(c.ref ?? '')}" data-nav="res:${esc(c.id)}" data-id="${esc(c.id)}" tabindex="-1"><span class="tile">${resultGlyph(x, c.kind === 'error')}</span><span class="body"><span class="res-t"><b>${esc(x?.title ?? t('task'))}</b><time datetime="${esc(c.ts)}" data-tip="${esc(hhmm(c.ts))}">${when(c.ts)}</time></span>${resultMeta(x)}${resultSummary(c)}${p.media}${p.row}</span><span class="row-acts">${rowXHtml('result', c.id)}</span></div>`;
      }).join('')}${results.more}</div></div>`;
    }
    if (autos.items.length) html += `<div class="sect"><div class="ins-h"><b role="heading" aria-level="2">${t('ins.auto')}</b><span class="gap"></span>${clearAllHtml('auto')}</div><div class="group">${autos.items.map(aaHtml).join('')}${autos.more}</div></div>`;
    if (!html) {
      const busy = s.workers.filter((w) => w.status === 'running' || w.status === 'waiting').length;
      html = `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-check"/></svg><b>${t('ins.clearTitle')}</b>${busy ? `<button class="goto" data-action="view" data-v="worker">${ic('run')}${t('ins.busy', { n: busy })}</button>` : ''}</div>`;
    }
    draw(html);
  });
  tickDecisions(root);
  restoreCardFocus(root, back);
  if (nav && (!document.activeElement || document.activeElement === document.body)) navItems(root).find((x) => x.dataset.nav === nav)?.focus({ preventScroll: true });
  rove(root);
  syncSegs(root);
}

/**
 * One memo as a slot holding its card. The selected card opens in place with all of the text and Share / Edit /
 * Delete; the others show two lines and are selected by a click.
 */
function memoSlot(m: Memo) {
  const sel = ui.memoSel === m.id;
  return slotHtml(m.id, sel, memoHtml(m, sel));
}

export function memoHtml(m: Memo, sel = true) {
  if (ui.memoEdit === m.id) {
    return `<div class="memo${sel ? ' sel' : ''}"><textarea class="inp" data-keep="memo-${m.id}" data-enter="memo-save" data-id="${m.id}" aria-label="${t('memo.edit')}">${esc(m.text)}</textarea>
      <div class="btns"><button class="btn" data-action="memo-edit-cancel">${t('cancel')}</button><button class="btn btn-primary" data-action="memo-save" data-id="${m.id}">${t('save')}</button></div></div>`;
  }
  if (!sel) {
    return `<div class="memo" data-memo="${m.id}" data-action="pick" data-tab="memo" data-id="${m.id}" data-focus="card-memo-${m.id}" data-nav="memo:${m.id}" tabindex="-1"><p>${linkify(esc(m.text))}</p><span class="meta">${m.shared ? sym('s-pin') : ''}<time datetime="${esc(m.updatedAt)}" data-tip="${esc(hhmm(m.updatedAt))}">${when(m.updatedAt)}</time></span></div>`;
  }
  const act = (action: string, icon: string, label: string, cls = '') => `<button class="mact${cls}" data-action="${action}" data-id="${m.id}" data-tip="${label}" aria-label="${label}"><svg aria-hidden="true"><use href="#${icon}"/></svg></button>`;
  // One button for both steps, so asking is a change of its width and colour, not a new element.
  const sure = ui.memoDel === m.id;
  const del = `<button class="mact del${sure ? ' sure' : ''}" data-action="memo-remove" data-id="${m.id}" data-tip="${t('memo.remove')}" aria-label="${t(sure ? 'memo.removeSure' : 'memo.remove')}"><svg aria-hidden="true"><use href="#s-x"/></svg><span class="lbl">${t('memo.removeSure')}</span></button>`;
  return `<div class="memo" data-memo="${m.id}" data-nav="memo:${m.id}" tabindex="-1"><p>${linkify(esc(m.text))}</p><span class="meta">${m.shared ? sym('s-pin') : ''}<time datetime="${esc(m.updatedAt)}" data-tip="${esc(hhmm(m.updatedAt))}">${when(m.updatedAt)}</time>
    <span class="acts">${act('memo-share', 's-pin', t(m.shared ? 'memo.unshare' : 'memo.share'), m.shared ? ' on' : '')}${act('memo-edit', 's-pencil', t('memo.edit'))}${del}</span></span></div>`;
}

/**
 * Two attempts at one task, side by side in the inbox: each with its Worker and model, where it stands and its
 * report, a way to its changes, and "Use this one" once it has finished. Picking closes the comparison.
 */

export function comparisonsHtml() {
  const groups = openComparisons(S!.tasks);
  if (!groups.length) return '';
  const cards = groups.map((g) => `<div class="cmp">${g.tasks.map((x) => {
    const w = worker(x.workerId);
    const tn = x.status === 'failed' && !x.stopped ? 'danger' : x.status === 'running' ? 'accent' : x.status === 'done' ? 'success' : '';
    return `<div class="cmp-side"><div class="cmp-h"><b>${esc(x.workerId ?? '')}</b><small>${esc(w ? modelLabel(w.model) : '')}</small><span class="pill"${pillTone(tn)}>${taskLabel(x)}</span></div>
      ${x.summary ? `<p>${inline(oneLine(x.summary, 220))}</p>` : ''}${spendHtml(x.spend, true)}
      <div class="cmp-f">${x.workerId ? `<button type="button" class="linkbtn" data-action="cmp-changes" data-id="${esc(x.workerId)}">${t('cmp.changes')}</button>` : ''}<span class="gap"></span><button class="btn btn-primary" data-action="cmp-pick" data-id="${esc(x.id)}"${canPick(x) ? '' : ' disabled'}>${t('cmp.pick')}</button></div></div>`;
  }).join('')}</div>`).join('');
  const title = (g: (typeof groups)[number]) => esc(g.tasks[0].title.replace(/ \([^()]*\)$/, ''));
  return `<div class="sect"><div class="ins-h"><b role="heading" aria-level="2">${t('cmp.title')}</b><small>${groups.length === 1 ? title(groups[0]) : groups.length}</small></div><div class="group">${cards}</div></div>`;
}

/**
 * A request that spans repositories, in the inbox: its tasks in merge order, each with its repository, where it
 * stands and its PR, and one button that merges the PRs in that order once every one is ready.
 */

export function bundlesHtml() {
  const bundles = openBundles(S!.tasks);
  if (!bundles.length) return '';
  return bundles.map((b) => {
    const key = `b:${b.name}`;
    const sure = ui.mergeAsk === key;
    const order = bundleMergeOrder(b);
    const n = order.length;
    // Its PRs are in the merge queue already: the button says so until they are merged or one leaves.
    const queued = n > 0 && order.every((x) => queuedPrs(S!.mergeQueue).has(x.prUrl!.toLowerCase()));
    const rows = b.tasks.map((x, i) => {
      const tn = x.status === 'failed' && !x.stopped ? 'danger' : x.status === 'running' ? 'accent' : x.prState === 'MERGED' ? 'review' : x.status === 'pr_open' ? 'pr-open' : x.status === 'done' ? 'success' : '';
      const label = x.prState === 'MERGED' ? t('pr.merged') : taskLabel(x);
      return `<div class="mini bnd"><b><span class="bnd-n">${i + 1}</span>${esc(x.repo ?? t('general'))}</b><span>${esc(x.title)}</span>
        <span class="bnd-f">${x.workerId ? `<button type="button" class="linkbtn" data-action="open-worker" data-id="${esc(x.workerId)}">${esc(x.workerId)}</button>` : ''}${x.prUrl ? `<a tabindex="0" role="link" data-action="open-url" data-href="${esc(x.prUrl)}">PR #${prNum(x.prUrl)}</a>` : ''}<span class="gap"></span><i class="pill"${pillTone(tn)}>${label}</i></span></div>`;
    }).join('');
    const btn = b.ready ? `<div class="mini bnd-act"><button class="btn btn-primary" data-action="bundle-merge" data-id="${esc(b.name)}"${queued ? ' disabled' : ''}>${t(queued ? 'pr.waitQueued' : sure ? 'bundle.mergeSure' : 'bundle.merge', { n })}</button></div>` : '';
    return `<div class="sect"><div class="ins-h"><b role="heading" aria-level="2">${t('bundle.title')}</b><small>${esc(b.name)}</small></div><div class="group">${rows}${btn}</div></div>`;
  }).join('');
}

/** "Daily 09:00", "Weekdays 09:00", "When a PR merges". */
export function triggerLabel(a: Automation) {
  return a.trigger.kind === 'merged' ? t('auto.merged') : t(a.trigger.weekdays ? 'auto.weekdaysAt' : 'auto.dailyAt', { t: a.trigger.time });
}

/** When a run happens, in words: "Today 9:00 AM", "Tomorrow 9:00 AM", "Mon 9:00 AM", "Nov 30 9:00 AM"; short, no time after today. */
export function runWords(iso: string, short = false) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  const w = dayWord(d, new Date());
  if (w === 'today') return short ? time : t('time.today', { t: time });
  if (w === 'tomorrow' || w === 'yesterday') return t(`day.${w}${short ? 'Short' : ''}` as Key, { t: time });
  const day = d.toLocaleDateString(locale(), w === 'week' ? { weekday: 'short' } : { month: 'short', day: 'numeric' });
  return short ? day : `${day} ${time}`;
}

/** One automation as a slot. Selected, its card shows the whole prompt, when it runs, when it ran (a way to that message in the chat) and Delete. */
function autoSlot(a: Automation) {
  const sel = ui.autoSel === a.id;
  const off = a.enabled ? '' : ' off';
  const next = a.enabled && a.nextRunAt ? runWords(a.nextRunAt, true) : '';
  const sw = `<input class="switch" type="checkbox" data-change="auto-toggle" data-id="${a.id}"${a.enabled ? ' checked' : ''} aria-label="${esc(`${t('auto.on')}: ${a.title}`)}">`;
  const edit = ui.autoEdit?.id === a.id;
  // Being changed, its card is the form, filled in; it stays open with what was typed when another one is picked.
  if (edit) return slotHtml(a.id, sel, `<div class="memo auto open${off}">${autoFormHtml(a)}</div>`);
  if (!sel) {
    const card = `<div class="memo auto${off}" data-action="pick" data-tab="auto" data-id="${a.id}" data-focus="card-auto-${a.id}" data-nav="auto:${a.id}" tabindex="-1"><p>${esc(a.title)}</p><span class="meta"><span>${esc(triggerLabel(a))}${next ? esc(` · ${t('auto.next', { t: next })}`) : ''}</span><span class="acts">${sw}</span></span></div>`;
    return slotHtml(a.id, false, card);
  }
  const sure = ui.memoDel === a.id;
  const last = !a.lastRunAt ? esc(t('auto.never'))
    : a.lastRunChatId ? `<a tabindex="0" role="link" data-action="open-chat" data-id="${esc(a.lastRunChatId)}">${esc(runWords(a.lastRunAt))}</a>` : esc(runWords(a.lastRunAt));
  const facts = `<dl class="facts"><dt>${t('auto.when')}</dt><dd>${esc(triggerLabel(a))}</dd>${a.trigger.kind === 'daily' ? `<dt>${t('auto.nextRun')}</dt><dd>${esc(a.enabled && a.nextRunAt ? runWords(a.nextRunAt) : t('auto.off'))}</dd>` : ''}<dt>${t('auto.lastRun')}</dt><dd>${last}</dd></dl>`;
  const del = `<button class="mact del${sure ? ' sure' : ''}" data-action="auto-remove" data-id="${a.id}" data-tip="${t('memo.remove')}" aria-label="${t(sure ? 'memo.removeSure' : 'memo.remove')}"><svg aria-hidden="true"><use href="#s-x"/></svg><span class="lbl">${t('memo.removeSure')}</span></button>`;
  const pen = `<button class="mact" data-action="auto-edit" data-id="${a.id}" data-tip="${t('memo.edit')}" aria-label="${t('memo.edit')}"><svg aria-hidden="true"><use href="#s-pencil"/></svg></button>`;
  const card = `<div class="memo auto open${off}" data-nav="auto:${a.id}" tabindex="-1"><p>${esc(a.prompt)}</p>${facts}<span class="meta"><span class="gap"></span><span class="acts">${sw}${pen}${del}</span></span></div>`;
  return slotHtml(a.id, true, card);
}

/**
 * The automation form: without `a` it adds one, with it it changes that one (filled in, Cancel and Save).
 * The daily fields are always there and only fade out for "When a PR merges" (.merged), so switching
 * moves nothing and is done in place, without drawing the tab again (app.ts, "auto-kind").
 */
function autoFormHtml(a?: Automation) {
  const kind = a ? ui.autoEdit!.kind : ui.autoKind;
  const wk = a ? ui.autoEdit!.wk : ui.autoWk;
  // One form adds and one changes, so their fields have their own ids and kept values.
  const id = (name: string) => (a ? `auto-${name}-e` : `auto-${name}`);
  const keep = (name: string) => (a ? `auto-${name}-e-${a.id}` : `auto-${name}`);
  const time = a?.trigger.kind === 'daily' ? a.trigger.time : '09:00';
  const btns = a
    ? `<button class="btn" data-action="auto-edit-cancel">${t('cancel')}</button><button class="btn btn-primary" data-action="auto-save" data-id="${a.id}">${t('save')}</button>`
    : `<button class="btn btn-primary" data-action="auto-add">${t('auto.add')}</button>`;
  return `<div class="auto-add${kind === 'merged' ? ' merged' : ''}"><textarea class="inp" id="${id('prompt')}" data-keep="${keep('prompt')}" placeholder="${t('auto.prompt')}" aria-label="${t('auto.prompt')}">${a ? esc(a.prompt) : ''}</textarea>
    <div class="auto-when">${segc(id('kind'), kind, [{ value: 'daily', label: t('auto.daily') }, { value: 'merged', label: t('auto.merged') }], t('ins.tabAuto'))}<input class="inp auto-time auto-daily" id="${id('time')}" data-keep="${keep('time')}" value="${esc(time)}" inputmode="numeric" aria-label="${t('auto.time')}"></div>
    <div class="auto-when"><label class="auto-wk auto-daily">${t('auto.weekdays')}<input class="switch" type="checkbox" id="${id('wk')}"${wk ? ' checked' : ''}></label><span class="gap"></span>${btns}</div></div>`;
}

/** The Automations tab: "New automation" (the form, selected at first), then the ones set up. */
export function autosHtml() {
  const list = S!.automations;
  if (ui.autoEdit && !list.some((a) => a.id === ui.autoEdit!.id)) ui.autoEdit = null;
  const add = autoFormHtml() + formErrHtml('auto');
  // With none set up the form is all there is, open; it stays open once the first one is added.
  if (!list.length) { ui.autoSel ??= 'new'; return `${add}<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-refresh"/></svg><b>${t('auto.empty')}</b></div>`; }
  ui.autoSel = keepPick(['new', ...list.map((a) => a.id)], ui.autoSel, null);
  const isNew = ui.autoSel === 'new';
  const head = slotHtml('new', isNew, add, rowHtml('auto', 'new', isNew, `${sym('s-plus')}<span class="t"><b>${t('auto.new')}</b></span>`), ' new');
  return `${head}<div class="sect"><div class="ins-h"><b role="heading" aria-level="2">${t('ins.tabAuto')}</b><small>${list.length}</small></div><div class="group">${list.map(autoSlot).join('')}</div></div>`;
}

/** What a form says, or null after pointing at the field that is empty or not a time. `e` is '-e' for the form that changes one. */
function readAutoForm(e: '' | '-e', kind: 'daily' | 'merged', wk: boolean): { prompt: string; trigger: Automation['trigger'] } | null {
  const inp = $<HTMLTextAreaElement>(`#auto-prompt${e}`);
  const prompt = inp?.value.trim();
  if (!prompt) { inp?.focus(); return null; }
  if (kind === 'merged') return { prompt, trigger: { kind: 'merged' } };
  const time = parseTime($<HTMLInputElement>(`#auto-time${e}`)?.value ?? '');
  if (!time) { toast(t('auto.badTime'), true); $<HTMLInputElement>(`#auto-time${e}`)?.focus(); return null; }
  return { prompt, trigger: { kind: 'daily', time, weekdays: wk } };
}

export async function addAuto() {
  const f = readAutoForm('', ui.autoKind, ui.autoWk);
  if (!f) return;
  // The text stays until it is saved; a failure is shown under it (L8).
  const r = await tryCall('auto:add', f.prompt, f.trigger);
  ui.formErr.auto = r.ok ? '' : r.error;
  if (r.ok) { const now = $<HTMLTextAreaElement>('#auto-prompt'); if (now) now.value = ''; }
  renderChatInspector();
}

/** Opens an automation's card as the form, filled in with what it is now. */
export function editAuto(id: string) {
  const a = S!.automations.find((x) => x.id === id);
  if (!a) return;
  ui.autoEdit = { id, kind: a.trigger.kind, wk: a.trigger.kind === 'daily' && !!a.trigger.weekdays };
  ui.autoSel = id;
  ui.memoDel = null;
}

/** Saves the form of the automation being changed. What was typed stays when it is not saved; why is a toast. */
export async function saveAuto() {
  const e = ui.autoEdit;
  if (!e) return;
  const f = readAutoForm('-e', e.kind, e.wk);
  if (!f) return;
  const r = await tryCall('auto:update', e.id, f.prompt, f.trigger);
  if (!r.ok) { toast(r.error, true); return; }
  if (ui.autoEdit?.id === e.id) ui.autoEdit = null;
  renderChatInspector();
}

/** Why the last add failed, under its field, until it is added or dismissed. */
export function formErrHtml(key: 'memo' | 'auto') {
  const msg = ui.formErr[key];
  return msg ? `<div class="ferr" role="alert"><span>${esc(t('err.notSent', { msg }))}</span><button type="button" class="btn btn-icon btn-sm clear-x always" data-action="form-err-x" data-id="${key}" data-tip="${t('err.dismiss')}" aria-label="${t('err.dismiss')}"><svg><use href="#s-x"/></svg></button></div>` : '';
}

/** The Memos tab: a field to add one, then the memos shared with agents and the user's own; one of them is selected. */
export function memosHtml() {
  const { shared, mine } = memoSections(S!.memos);
  const ids = [...shared, ...mine].map((m) => m.id);
  ui.memoSel = keepPick(ids, ui.memoSel, ui.memoEdit ?? null);
  const sect = (title: string, list: Memo[]) => list.length ? `<div class="sect"><div class="ins-h"><b role="heading" aria-level="2">${title}</b><small>${list.length}</small></div><div class="group">${list.map(memoSlot).join('')}</div></div>` : '';
  const add = `<div class="memo-add"><textarea class="inp" id="memo-new" rows="1" data-keep="memo-new" data-enter="memo-add" placeholder="${t('memo.add')}" aria-label="${t('memo.add')}"></textarea><button class="btn btn-icon" data-action="memo-add" data-tip="${t('memo.add')}" aria-label="${t('memo.add')}"><svg aria-hidden="true"><use href="#s-plus"/></svg></button></div>`;
  const body = sect(t('memo.shared'), shared) + sect(t('memo.mine'), mine);
  return add + formErrHtml('memo') + (body || `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-doc"/></svg><b>${t('memo.empty')}</b></div>`);
}

/** Which memo's Delete is asking "Delete it?" (null: none). Changed in place, so the button can animate. */
export function askMemoDel(id: string | null) {
  ui.memoDel = id;
  document.querySelectorAll<HTMLElement>('.mact.del').forEach((b) => {
    const on = b.dataset.id === id;
    b.classList.toggle('sure', on);
    b.setAttribute('aria-label', t(on ? 'memo.removeSure' : 'memo.remove'));
  });
}

/** Delete a memo: its row closes up first, then it goes. */
export async function removeMemo(id: string) {
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

export async function addMemo() {
  const inp = $<HTMLTextAreaElement>('#memo-new');
  const text = inp?.value.trim();
  if (!text) { inp?.focus(); return; }
  const r = await tryCall('memo:add', text);
  ui.formErr.memo = r.ok ? '' : r.error;
  if (r.ok) { const now = $<HTMLTextAreaElement>('#memo-new'); if (now) now.value = ''; }
  renderChatInspector();
  $<HTMLTextAreaElement>('#memo-new')?.focus();
}

/* ---------- attachments ---------- */

export type Box = 'chat' | 'ws';

export function renderChips(box: Box) {
  const el = $(box === 'chat' ? '#chat-files' : '#ws-files');
  const files = ui.attach[box];
  el.hidden = !files.length;
  const thumb = placeAttached(files, `compose:${box}`);
  el.innerHTML = files.map((f, i) => `<span class="fchip" data-tip="${esc(f)}">${thumb(f) || sym('s-doc')}<span class="fn">${esc(middleName(base(f)))}</span><button type="button" data-action="unattach" data-box="${box}" data-i="${i}" aria-label="${t('remove')}" data-tip="${t('remove')}"><svg><use href="#s-x"/></svg></button></span>`).join('');
  updateSendButton();
}

export function addFiles(box: Box, list: FileList | null) {
  if (!list?.length) return;
  addPaths(box, Array.from(list, (f) => { try { return ide.pathForFile(f); } catch { return ''; /* not a local file */ } }));
}

/**
 * Paste into a composer. Files copied in Explorer or Finder attach exactly as a drop does;
 * a bare screenshot is saved first and its file attached. Anything else pastes as text.
 */
export function pasteFiles(box: Box, e: ClipboardEvent) {
  const cd = e.clipboardData;
  const files = Array.from(cd?.files ?? []);
  if (!cd || !files.length) return;
  const items = files.map((f) => {
    let path = '';
    try { path = ide.pathForFile(f); } catch { /* clipboard data, not a local file */ }
    return { path, type: f.type, size: f.size };
  });
  const plan = planPaste(items, !!cd.getData('text/plain'));
  if (plan.kind === 'text') return;
  e.preventDefault();
  if (plan.kind === 'paths') { addPaths(box, plan.paths); return; }
  void Promise.all(plan.files.map(async (i) => {
    const r = await tryCall<string>('attach:pasteImage', files[i].type, new Uint8Array(await files[i].arrayBuffer()));
    if (!r.ok) { toast(r.error, true); return ''; }
    return r.v;
  })).then((paths) => addPaths(box, paths.filter(Boolean)));
}

function addPaths(box: Box, paths: string[]) {
  for (const p of paths) if (p && !ui.attach[box].includes(p)) ui.attach[box].push(p);
  renderChips(box);
}
