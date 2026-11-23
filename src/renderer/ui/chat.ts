// The chat with the Dispatcher and its right sidebar: decisions, comparisons, bundles, results, memos, automations, and attachments.
import type { Automation, Memo } from '../../shared/types';
import type { AutoAnswer, ChatItem, Decision, MemorySuggestion, PlanSummary, Task, Worker } from '../../shared/types';
import { ALLOW, ALLOW_TASK, DENY } from '../../shared/types';
import { stepView } from '../../shared/steps';
import { askLine, lastFailed, plainStatus } from '../../shared/workerState';
import { dayWord, keepPick } from '../../shared/insPanes';
import { type Key } from '../../shared/i18n';
import { hasSpend, spendVars, type Spend } from '../../shared/spend';
import { linkify } from '../../shared/linkify';
import { canMerge } from '../../shared/prMerge';
import { parseTime } from '../../shared/automations';
import { canPick, openComparisons } from '../../shared/compare';
import { awayDigest, awayRows, type AwayDigest } from '../../shared/away';
import { bundleMergeOrder, openBundles } from '../../shared/bundle';
import { memoSections } from '../../shared/memos';
import { CONTEXT_WINDOW } from '../../shared/context';
import { CHAT_SNAPSHOT, PAGE, threadStart } from '../../shared/paging';
import { canStop } from '../../shared/canStop';
import { threadLayout } from '../../shared/thread';
import { parseReply, replyExcerpt } from '../../shared/reply';
import { decisionKeys, decisionKind, decisionLate, keepCard, nextCard, slotClock, type DecisionKind } from '../../shared/decisionView';
import { planPaste } from '../../shared/paste';
import { act } from '../app';
import { $, ago, announce, base, call, esc, hhmm, ic, ide, inline, k, keepInputs, lang, locale, markLoading, md, modelLabel, NEW_FROM, olderBtn, oneLine, paged, prNum, replyable, ring, S, setThread, stoppedTask, store, sym, t, task, taskLabel, taskStatus, toast, tryCall, ui, unmarkLoading, userText, watchTop, when, worker } from './core';
import { go } from './history';
import { segc, syncSegs } from './settings';
import { ms } from './sidebar';
import { tookText } from './workers';
import { colsHtml, markPick, placeDetail, rowHtml, rowText, slotHtml } from './panes';

export const CI_BADGE: Record<string, [string, Key]> = { passing: ['ok', 'pr.ciPassing'], failing: ['bad', 'pr.ciFailing'], pending: ['run', 'pr.ciPending'] };

export const REVIEW_BADGE: Record<string, [string, Key]> = { approved: ['ok', 'pr.approved'], changes: ['warn', 'pr.changes'], required: ['', 'pr.reviewNeeded'] };

/** Is an open PR ready to merge: CI, conflicts, review. */
export function prBadges(x: Task) {
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

export function resultLinks(x: Task | null) {
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
export function spendHtml(s: Spend | null | undefined, short = false) {
  if (!hasSpend(s)) return '';
  const v = spendVars(s);
  const text = short ? t('spend.cost', v) : `${t('spend.cost', v)} · ${t('spend.tokens', v)}`;
  const tip = short ? `${t('spend.tokens', v)}\n${t('spend.tip', v)}` : t('spend.tip', v);
  return `<span class="spend" title="${esc(tip)}">${esc(text)}</span>`;
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
  const at = v && !v.allDone ? t('wk.stoppedAt', { n: v.at + 1, total: v.total }) : '';
  const why = still ? plainStatus(x.summary) : c.text;
  const last = w.taskIds[w.taskIds.length - 1] === x.id;
  const go = still && last && lastFailed(w, x) ? `<button type="button" class="btn" data-action="worker-continue" data-id="${esc(w.id)}" aria-label="${esc(t('wk.continueWho', { id: w.id }))}">${t('wk.continue')}</button>` : '';
  return `<div class="attach fail" data-task="${esc(x.id)}"><span class="tile">${sym('s-alert', 'c-red')}</span><span class="body"><b>${esc(x.title)}<span class="pill red">${t('st.failed')}</span></b><span class="sm">${esc([at, why].filter(Boolean).join(' · '))}</span><span class="links">${go}<a tabindex="0" role="link" data-action="open-worker" data-id="${esc(w.id)}">${t('chat.viewWorker', { id: w.id })}</a>${replyLink(x, why)}</span></span></div>`;
}

/** "Reply" on a report card: the composer's reply chip quotes the report, and the message is filed under the card. */
function replyLink(x: Task, text: string) {
  return `<a tabindex="0" role="link" data-action="reply" data-box="chat" data-who="${esc(x.workerId ?? x.id)}" data-quote="${esc(replyExcerpt(`${x.title}: ${text}`))}" data-task="${esc(x.id)}">${t('chat.reply')}</a>`;
}

export function chatItemHtml(c: ChatItem) {
  switch (c.kind) {
    case 'user': return `<div class="bub me">${userText(c.text)}</div>`;
    case 'dispatcher': return replyable(`<div class="bub ai">${md(c.text)}</div>`, 'chat', 'Dispatcher', c.text, c.replyTo);
    case 'event': return `<span class="event">${sym('s-cpu', 'c-blue')}<span>${linkify(esc(c.text))}</span></span>`;
    case 'decision': return `<span class="event mine">${sym('s-check', 'c-green')}<span><b>${t('chat.decided')}</b> ${esc(c.text)}</span></span>`;
    case 'error': return failureHtml(c) ?? `<span class="event err">${sym('s-alert', 'c-red')}<span>${esc(c.text)}</span></span>`;
    case 'auto': {
      const a = S!.autoAnswers.find((x) => x.id === c.ref);
      return `<button class="event self" data-action="aa-select" data-id="${c.ref ?? ''}" title="${t('chat.showRight')}">${sym('s-check', 'c-green')}<span><b>${a?.corrected ? t('chat.autoCorrected') : t('chat.auto')}</b> ${esc(c.text)}</span><svg class="chev" aria-hidden="true"><use href="#s-chev"/></svg></button>`;
    }
    case 'result': {
      const x = task(c.ref);
      const links = resultLinks(x);
      if (x?.workerId) links.push(`<a tabindex="0" role="link" data-action="open-worker" data-id="${x.workerId}">${t('chat.viewWorker', { id: x.workerId })}</a>`);
      if (x) links.push(replyLink(x, c.text));
      return `<div class="attach" data-task="${esc(c.ref ?? '')}"><span class="tile">${resultGlyph(x)}</span><span class="body"><b>${esc(x?.title ?? t('task'))}</b><span class="sm">${inline(c.text)}</span><span class="links">${links.join('')}</span>${spendHtml(x?.spend)}</span></div>`;
    }
  }
}

/** One reply under a report. The first Dispatcher message under a card says whose report it is about. */
function replyRow(c: ChatItem, html: string, first: string | null, quoteShown: boolean) {
  const me = c.kind === 'user';
  // Right under the card, a quote of the card itself says nothing the branch does not.
  const r = me && !quoteShown ? parseReply(c.text) : null;
  if (r && r.who === (task(c.replyTo)?.workerId ?? c.replyTo)) html = `<div class="bub me">${userText(r.body)}</div>`;
  const wid = first ? task(first)?.workerId : null;
  const who = wid && c.kind === 'dispatcher' ? `<span class="rth-who">${t('chat.onReport', { id: esc(wid) })}</span>` : '';
  return `<div class="rth-r${me ? ' me' : ''}">${who}${me ? '<i class="rth-ld" aria-hidden="true"></i>' : ''}${html}</div>`;
}

/** Over a reply that came later: the report it answers, which the chip goes back to. */
function reportRef(id: string) {
  const x = task(id);
  const what = [x?.title ?? id, x?.prUrl ? `PR #${prNum(x.prUrl)}` : ''].filter(Boolean).join(' · ');
  return `<button type="button" class="rth-ref" data-action="goto-report" data-id="${esc(id)}" title="${esc(t('chat.toReport'))}">${sym('s-reply')}<b>${esc(x?.workerId ?? id)}</b><span>${esc(what)}</span></button>`;
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
  // Only what is new is read out (L14): the last line from the app or an agent since the previous draw.
  if (seenAt >= 0 && !older) {
    const fresh = items.slice(seenAt + 1).map(({ c }) => c).filter((c) => c.kind !== 'user');
    if (fresh.length) announce(fresh[fresh.length - 1].text);
  }
  const slots = threadLayout(items.map(({ c }) => c));
  let lateGroup = false;
  for (const [i, { c, n }] of items.entries()) {
    const slot = slots[i];
    const inGroup = slot.depth === 1 && !slot.start;
    if (seenAt >= 0 && i === seenAt + 1) html += NEW_FROM;
    const ts = Date.parse(c.ts);
    // A group of replies is not cut by a time stamp; the next one at the top level gets it.
    if (ts - last > 30 * 60_000 && !inGroup) html += `<span class="stamp">${hhmm(c.ts)}</span>`;
    last = ts;
    const one = n > 1 ? chatItemHtml(c).replace(/<\/span><\/span>$/, ` <b class="times">×${n}</b></span></span>`) : chatItemHtml(c);
    if (slot.depth === 0) { html += one; continue; }
    if (slot.start) html += `${slot.late ? reportRef(slot.root!) : ''}<div class="rth${slot.late ? ' late' : ''}" role="group" aria-label="${esc(t('chat.repliesTo', { title: task(slot.root)?.title ?? slot.root! }))}">`;
    if (slot.start) lateGroup = slot.late;
    html += replyRow(c, one, slot.start && !slot.late ? slot.root! : null, lateGroup);
    if (slots[i + 1]?.depth !== 1 || slots[i + 1].start) html += '</div>';
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

/** Both composers: with nothing typed, the send button stops what is at work (the Dispatcher, or the Worker by canStop). */
export function updateSendButton() {
  const set = (btn: HTMLButtonElement | null, stop: boolean, label: string) => {
    if (!btn) return;
    if (btn.classList.contains('stop') === stop && btn.getAttribute('aria-label') === (stop ? label : t('send'))) return;
    btn.classList.toggle('stop', stop);
    btn.innerHTML = sym(stop ? 's-stop' : 's-up');
    btn.setAttribute('aria-label', stop ? label : t('send'));
    btn.title = stop ? label : '';
  };
  const empty = (box: Box) => !$<HTMLTextAreaElement>(box === 'chat' ? '#chat-input' : '#ws-input').value.trim() && !ui.attach[box].length;
  set($<HTMLButtonElement>('#chat-send'), !!S?.dispatcher.busy && empty('chat'), t('chat.stop'));
  const w = worker(ui.wSel);
  const cur = w?.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
  set($<HTMLButtonElement>('#ws-send'), !!w && canStop(w, cur) && empty('ws'), t('wk.stop'));
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

/** ↑/↓ on a card: select the one `step` away and give it the focus. */
export function moveDecision(step: number) {
  const ids = S!.decisions.filter((d) => d.status === 'pending').map((d) => d.id);
  markDecision(nextCard(ids, ui.decSel, step));
  decisionCard(ui.decSel)?.focus();
}

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

/** inWorker: in its Worker's panel, where the Worker's composer is the text field (decision 93). */
export function decisionHtml(d: Decision, inWorker = false) {
  const x = task(d.taskId);
  const who = d.workerId ?? 'Dispatcher';
  const src = [who, x?.title].filter(Boolean).join(' · ');
  // The inbox has one selected card: it shows its key hints and is the one stop for Tab (roving tabindex).
  const sel = !inWorker && ui.decSel === d.id;
  const keys = decisionKeys(d);
  const kbd = (val: string) => !inWorker && keys.has(val) ? `<kbd aria-hidden="true">${esc(keys.get(val)!)}</kbd>` : '';
  let buttons: string;
  if (d.source === 'plan') {
    buttons = `<div class="btns"><button class="btn def" data-action="answer" data-id="${d.id}" data-val="${ALLOW}">${t('plan.approve')}${kbd(ALLOW)}</button></div>`;
  } else if (d.source === 'permission') {
    // "Allow for this task" is there when the action's kind can be named; its tooltip says what the yes covers.
    const scope = d.options.find((o) => o.label === ALLOW_TASK);
    buttons = `<div class="btns perm" data-fit="stack"><button class="btn" data-action="answer" data-id="${d.id}" data-val="${DENY}">${t('deny')}${kbd(DENY)}</button>${scope ? `<button class="btn" data-action="answer" data-id="${d.id}" data-val="${ALLOW_TASK}" title="${esc(scope.description ?? '')}">${t('allowTask')}${kbd(ALLOW_TASK)}</button>` : ''}<button class="btn def" data-action="answer" data-id="${d.id}" data-val="${ALLOW}">${t('allow')}${kbd(ALLOW)}</button></div>`;
  } else {
    const col = d.options.length > 2 || d.options.some((o) => o.description);
    buttons = `<div class="btns${col ? ' col' : ''}"${col ? '' : ' data-fit="stack"'}>${d.options.map((o) => `<button class="btn" data-action="answer" data-id="${d.id}" data-val="${esc(o.label)}">${col ? kbd(o.label) : ''}${esc(o.label)}${col ? '' : kbd(o.label)}${o.description && col ? `<div class="opt-d">${esc(o.description)}</div>` : ''}</button>`).join('')}</div>`;
  }
  const custom = inWorker ? '' : `<input class="inp" data-keep="dec-${d.id}" data-enter="answer-custom" data-id="${d.id}" placeholder="${decisionHint(d)}" aria-label="${decisionHint(d)}">`;
  const sum = d.source === 'plan' ? d.summary : null;
  const label = t('dec.card', { kind: t(`dec.kind.${decisionKind(d)}` as Key), who });
  const card = inWorker ? '' : ` data-dec="${d.id}" role="group" aria-label="${esc(label)}" tabindex="${sel ? 0 : -1}"${sel ? ' aria-current="true"' : ''}`;
  return `<div class="dec${sel ? ' sel' : ''}" id="${inWorker ? 'wdec' : 'dec'}-${d.id}"${card}>
    <div class="src">${kindChip(d)}<span class="who">${esc(src)}</span>${ageHtml(d)}</div>
    <div class="q">${esc(d.title)}</div>
    ${d.reason ? `<div class="reason"><span>${esc(d.reason.what)}</span> ${esc(d.reason.why)}</div>` : ''}
    ${d.detail ? `<div class="d">${esc(d.detail)}</div>` : ''}
    ${sum ? planSummaryHtml(d, sum, inWorker) : d.code ? (d.source === 'plan' ? `<div class="plan-md" data-scroll="plan-${esc(d.id)}">${md(d.code)}</div>` : `<code>${esc(d.code)}</code>`) : ''}
    ${d.taskId ? `<div class="dhold" data-task="${esc(d.taskId)}" hidden><i><b></b></i><span></span></div>` : ''}
    ${buttons}${custom}
  </div>`;
}

/** A pending decision in the inbox: its list row (what is asked, who, the kind, the age) and its card. */
function decisionSlot(d: Decision) {
  const kind = decisionKind(d);
  const sel = ui.decSel === d.id;
  const row = `${sym(KIND_ICON[kind])}${rowText(oneLine(askLine(d), 160), `${d.workerId ?? 'Dispatcher'} · ${t(`dec.kind.${kind}` as Key)}`)}${ageHtml(d)}`;
  return slotHtml(d.id, sel, rowHtml('inbox', d.id, sel, row), decisionHtml(d));
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
    ${sum.auto ? `<div class="plan-auto" title="${esc(t('plan.autoHint'))}">${t('plan.auto')}</div>` : ''}
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
export function sugHtml(sg: MemorySuggestion) {
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
  const counts = ([['red', d.failed.length, 'away.failed'], ['green', d.finished.length, 'away.finished'], ['purple', d.merged.length, 'away.merged'], ['ask', d.waiting, 'away.waiting']] as const)
    .filter(([, n]) => n).map(([c, n, key]) => `<i class="pill ${c}">${t(key, { n })}</i>`).join('');
  const arrive = awayArrive ? ' arrive' : '';
  awayArrive = false;
  const rows = awayRows(d);
  const total = new Set([...d.failed, ...d.merged, ...d.finished].map((x) => x.id)).size;
  const pill = { failed: ['red', taskStatus('failed')], merged: ['purple', t('pr.merged')], finished: ['green', taskStatus('done')] } as const;
  return `<div class="sect${arrive}" id="sec-away"><div class="ins-h"><b>${t('away.title')}</b><small>${esc(span)}</small><span class="gap"></span><button class="clear-x always" data-action="away-dismiss" title="${t('away.dismiss')}" aria-label="${t('away.dismiss')}"><svg><use href="#s-x"/></svg></button></div>
    <div class="group"><div class="mini away-counts">${counts}</div>${rows.map(({ task: x, kind }) => `<div tabindex="0" role="button" class="mini away-row" data-action="open-worker" data-id="${esc(x.workerId ?? '')}" data-focus="away:${esc(x.id)}"><b>${esc(x.title)}</b><span class="away-m"><span>${esc(x.workerId ?? '')}${x.prUrl ? ` · PR #${prNum(x.prUrl)}` : ''}</span><i class="pill ${pill[kind][0]}">${pill[kind][1]}</i></span></div>`).join('')}${total > rows.length ? `<div class="mini"><span>${t('away.more', { n: total - rows.length })}</span></div>` : ''}</div></div>`;
}

export function renderChatInspector() {
  const s = S!;
  const root = $('#chat-ins');
  const was = document.activeElement as HTMLElement | null;
  const card = was && root.contains(was) ? was.closest<HTMLElement>('[data-dec]') : null;
  const back = card ? { id: card.dataset.dec ?? '', val: was === card ? null : was?.dataset.val ?? null } : null;
  keepInputs(root, () => {
    const pending = s.decisions.filter((d) => d.status === 'pending');
    // Each tab has an icon for a narrow sidebar: when the labels do not fit, the tabs not chosen show only that (data-fit).
    const tab = (v: 'inbox' | 'memo' | 'auto', label: string, icon: string, n = 0) => `<button type="button" role="tab" data-action="ins-tab" data-v="${v}" title="${label}" aria-selected="${ui.insTab === v}"${ui.insTab === v ? ' class="on"' : ''}>${sym(icon, 'ti')}<span class="tl">${label}</span>${n ? `<span class="count"${v === 'inbox' ? ' id="tab-count"' : ''}>${n}</span>` : ''}</button>`;
    // The inbox tab counts what waits for the user, so a decision is seen from the Memos tab too.
    const tabs = `<div class="segc ins-tabs" role="tablist" data-fit="tabs" aria-label="${t('ins.tabs')}">${tab('inbox', t('ins.tabInbox'), 's-bell', pending.length)}${tab('memo', t('ins.tabMemo'), 's-pencil')}${tab('auto', t('ins.tabAuto'), 's-refresh')}</div>`;
    // The selected card is placed inside the draw, so the typed text and the focus go back to where it ends up.
    const draw = (list: string) => { root.innerHTML = tabs + colsHtml(list); placeDetail(root); };
    if (ui.insTab === 'memo') return draw(memosHtml());
    if (ui.insTab === 'auto') return draw(autosHtml());
    // Task outcomes only (s.results). Errors without a task (accounts at their limit, Dispatcher errors) stay in the chat.
    const results = paged('results', s.results.slice().reverse(), PAGE.results);
    const autos = paged('autos', visibleAutos(), PAGE.autos);
    let html = '';
    selectedDecision();
    if (pending.length) html += `<div class="sect" id="sec-dec"><div class="ins-h"><b>${t('ins.decisions')}</b><span class="count" id="dec-count">${pending.length}</span></div><div class="group">${pending.map(decisionSlot).join('')}</div></div>`;
    // Decisions stay on top; what happened meanwhile comes right under them.
    html += awayHtml();
    html += comparisonsHtml();
    html += bundlesHtml();
    if (s.memorySuggestions.length) html += `<div class="sect"><div class="ins-h" title="${esc(t('sug.hint'))}"><b>${t('ins.remember')}</b></div><div class="group">${s.memorySuggestions.map(sugHtml).join('')}</div></div>`;
    if (results.items.length) {
      html += `<div class="sect"><div class="ins-h"><b>${t('ins.results')}</b><span class="gap"></span><button class="clear-x" data-action="clear" data-kind="result" title="${t('ins.clear')}" aria-label="${t('ins.clear')}"><svg><use href="#s-x"/></svg></button></div><div class="group">${results.items.map((c) => {
        const x = task(c.ref);
        const lk = resultLinks(x);
        return `<div class="res" data-task="${esc(c.ref ?? '')}"><span class="tile">${resultGlyph(x, c.kind === 'error')}</span><span class="body"><span class="res-t"><b>${esc(x?.title ?? t('task'))}</b><time datetime="${esc(c.ts)}" title="${esc(hhmm(c.ts))}">${when(c.ts)}</time></span>${lk.length ? `<span class="lk">${lk.join('')}</span>` : ''}<span>${inline(oneLine(c.text, 140))}</span>${spendHtml(x?.spend, true)}</span></div>`;
      }).join('')}${results.more}</div></div>`;
    }
    if (autos.items.length) html += `<div class="sect"><div class="ins-h"><b>${t('ins.auto')}</b><span class="gap"></span><button class="clear-x" data-action="clear" data-kind="auto" title="${t('ins.clear')}" aria-label="${t('ins.clear')}"><svg><use href="#s-x"/></svg></button></div><div class="group">${autos.items.map(aaHtml).join('')}${autos.more}</div></div>`;
    if (!html) {
      const busy = s.workers.filter((w) => w.status === 'running' || w.status === 'waiting').length;
      html = `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-check"/></svg><b>${t('ins.clearTitle')}</b>${busy ? `<button class="goto" data-action="view" data-v="worker">${ic('run')}${t('ins.busy', { n: busy })}</button>` : ''}</div>`;
    }
    draw(html);
  });
  tickDecisions(root);
  restoreCardFocus(root, back);
  syncSegs(root);
}

/**
 * One memo as a slot: its list row, and its card. The selected card shows all of the text and Share / Edit / Delete;
 * the others show two lines and are selected by a click.
 */
function memoSlot(m: Memo) {
  const sel = ui.memoSel === m.id;
  const edit = ui.memoEdit === m.id;
  const small = edit ? `${when(m.updatedAt)} · ${t('memo.editing')}` : when(m.updatedAt);
  const row = rowHtml('memo', m.id, sel, `${m.shared ? sym('s-pin') : ''}${rowText(oneLine(m.text, 160), small)}`);
  return slotHtml(m.id, sel, row, memoHtml(m, sel));
}

export function memoHtml(m: Memo, sel = true) {
  if (ui.memoEdit === m.id) {
    return `<div class="memo${sel ? ' sel' : ''}"><textarea class="inp" data-keep="memo-${m.id}" aria-label="${t('memo.edit')}">${esc(m.text)}</textarea>
      <div class="btns"><button class="btn" data-action="memo-edit-cancel">${t('cancel')}</button><button class="btn def" data-action="memo-save" data-id="${m.id}">${t('save')}</button></div></div>`;
  }
  if (!sel) {
    return `<div class="memo" data-memo="${m.id}" data-action="pick" data-tab="memo" data-id="${m.id}" data-focus="card-memo-${m.id}" tabindex="0"><p>${linkify(esc(m.text))}</p><span class="meta">${m.shared ? sym('s-pin') : ''}<time datetime="${esc(m.updatedAt)}" title="${esc(hhmm(m.updatedAt))}">${when(m.updatedAt)}</time></span></div>`;
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

export function comparisonsHtml() {
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

/**
 * A request that spans repositories, in the inbox: its tasks in merge order, each with its repository, where it
 * stands and its PR, and one button that merges the PRs in that order once every one is ready.
 */

export function bundlesHtml() {
  const bundles = openBundles(S!.tasks);
  if (!bundles.length) return '';
  return bundles.map((b) => {
    const key = `b:${b.name}`;
    const busy = ui.merging.has(key), sure = ui.mergeAsk === key;
    const n = bundleMergeOrder(b).length;
    const rows = b.tasks.map((x, i) => {
      const cls = x.status === 'failed' && !x.stopped ? ' red' : x.status === 'running' ? ' blue' : x.prState === 'MERGED' ? ' purple' : x.status === 'pr_open' ? ' pr-open' : x.status === 'done' ? ' green' : '';
      const label = x.prState === 'MERGED' ? t('pr.merged') : taskLabel(x);
      return `<div class="mini bnd"><b><span class="bnd-n">${i + 1}</span>${esc(x.repo ?? t('general'))}</b><span>${esc(x.title)}</span>
        <span class="bnd-f">${x.workerId ? `<button type="button" class="linkbtn" data-action="open-worker" data-id="${esc(x.workerId)}">${esc(x.workerId)}</button>` : ''}${x.prUrl ? `<a tabindex="0" role="link" data-action="open-url" data-href="${esc(x.prUrl)}">PR #${prNum(x.prUrl)}</a>` : ''}<span class="gap"></span><i class="pill${cls}">${label}</i></span></div>`;
    }).join('');
    const btn = b.ready || busy ? `<div class="mini bnd-act"><button class="btn def" data-action="bundle-merge" data-id="${esc(b.name)}"${busy ? ' disabled' : ''}>${t(busy ? 'pr.merging' : sure ? 'bundle.mergeSure' : 'bundle.merge', { n })}</button></div>` : '';
    return `<div class="sect"><div class="ins-h"><b>${t('bundle.title')}</b><small>${esc(b.name)}</small></div><div class="group">${rows}${btn}</div></div>`;
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
  const row = rowHtml('auto', a.id, sel, rowText(a.title, a.enabled ? triggerLabel(a) : `${triggerLabel(a)} · ${t('auto.off')}`));
  if (!sel) {
    const card = `<div class="memo auto${off}" data-action="pick" data-tab="auto" data-id="${a.id}" data-focus="card-auto-${a.id}" tabindex="0"><p>${esc(a.title)}</p><span class="meta"><span>${esc(triggerLabel(a))}${next ? esc(` · ${t('auto.next', { t: next })}`) : ''}</span><span class="acts">${sw}</span></span></div>`;
    return slotHtml(a.id, false, row, card);
  }
  const sure = ui.memoDel === a.id;
  const last = !a.lastRunAt ? esc(t('auto.never'))
    : a.lastRunChatId ? `<a tabindex="0" role="link" data-action="open-chat" data-id="${esc(a.lastRunChatId)}">${esc(runWords(a.lastRunAt))}</a>` : esc(runWords(a.lastRunAt));
  const facts = `<dl class="facts"><dt>${t('auto.when')}</dt><dd>${esc(triggerLabel(a))}</dd>${a.trigger.kind === 'daily' ? `<dt>${t('auto.nextRun')}</dt><dd>${esc(a.enabled && a.nextRunAt ? runWords(a.nextRunAt) : t('auto.off'))}</dd>` : ''}<dt>${t('auto.lastRun')}</dt><dd>${last}</dd></dl>`;
  const del = `<button class="mact del${sure ? ' sure' : ''}" data-action="auto-remove" data-id="${a.id}" title="${t('memo.remove')}" aria-label="${t(sure ? 'memo.removeSure' : 'memo.remove')}"><svg aria-hidden="true"><use href="#s-x"/></svg><span class="lbl">${t('memo.removeSure')}</span></button>`;
  const card = `<div class="memo auto open${off}"><p>${esc(a.prompt)}</p>${facts}<span class="meta"><span class="gap"></span><span class="acts">${sw}${del}</span></span></div>`;
  return slotHtml(a.id, true, row, card);
}

/** The Automations tab: "New automation" (the form, selected at first), then the ones set up. */
export function autosHtml() {
  // The daily fields are always there and only fade out for "When a PR merges" (.merged), so switching
  // moves nothing and is done in place, without drawing the tab again (app.ts, "auto-kind").
  const add = `<div class="auto-add${ui.autoKind === 'merged' ? ' merged' : ''}"><textarea class="inp" id="auto-prompt" data-keep="auto-prompt" placeholder="${t('auto.prompt')}" aria-label="${t('auto.prompt')}"></textarea>
    <div class="auto-when">${segc('auto-kind', ui.autoKind, [{ value: 'daily', label: t('auto.daily') }, { value: 'merged', label: t('auto.merged') }], t('ins.tabAuto'))}<input class="inp auto-daily" id="auto-time" data-keep="auto-time" value="09:00" inputmode="numeric" aria-label="${t('auto.time')}"></div>
    <div class="auto-when"><label class="auto-wk auto-daily">${t('auto.weekdays')}<input class="switch" type="checkbox" id="auto-wk"${ui.autoWk ? ' checked' : ''}></label><span class="gap"></span><button class="btn def" data-action="auto-add">${t('auto.add')}</button></div></div>${formErrHtml('auto')}`;
  const list = S!.automations;
  if (!list.length) return `${add}<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-refresh"/></svg><b>${t('auto.empty')}</b></div>`;
  ui.autoSel = keepPick(list.map((a) => a.id), ui.autoSel, 'new');
  const isNew = ui.autoSel === 'new';
  const head = slotHtml('new', isNew, rowHtml('auto', 'new', isNew, `${sym('s-plus')}<span class="t"><b>${t('auto.new')}</b></span>`), add, ' new');
  return `${head}<div class="sect"><div class="ins-h"><b>${t('ins.tabAuto')}</b><small>${list.length}</small></div><div class="group">${list.map(autoSlot).join('')}</div></div>`;
}

export async function addAuto() {
  const inp = $<HTMLTextAreaElement>('#auto-prompt');
  const prompt = inp?.value.trim();
  if (!prompt) { inp?.focus(); return; }
  let trigger: Automation['trigger'] = { kind: 'merged' };
  if (ui.autoKind === 'daily') {
    const time = parseTime($<HTMLInputElement>('#auto-time')?.value ?? '');
    if (!time) { toast(t('auto.badTime'), true); $<HTMLInputElement>('#auto-time')?.focus(); return; }
    trigger = { kind: 'daily', time, weekdays: ui.autoWk };
  }
  // The text stays until it is saved; a failure is shown under it (L8).
  const r = await tryCall('auto:add', prompt, trigger);
  ui.formErr.auto = r.ok ? '' : r.error;
  if (r.ok) { const now = $<HTMLTextAreaElement>('#auto-prompt'); if (now) now.value = ''; }
  renderChatInspector();
}

/** Why the last add failed, under its field, until it is added or dismissed. */
export function formErrHtml(key: 'memo' | 'auto') {
  const msg = ui.formErr[key];
  return msg ? `<div class="ferr" role="alert"><span>${esc(t('err.notSent', { msg }))}</span><button type="button" class="clear-x always" data-action="form-err-x" data-id="${key}" title="${t('err.dismiss')}" aria-label="${t('err.dismiss')}"><svg><use href="#s-x"/></svg></button></div>` : '';
}

/** The Memos tab: a field to add one, then the memos shared with agents and the user's own; one of them is selected. */
export function memosHtml() {
  const { shared, mine } = memoSections(S!.memos);
  const ids = [...shared, ...mine].map((m) => m.id);
  ui.memoSel = keepPick(ids, ui.memoSel, ui.memoEdit ?? ids[0] ?? null);
  const sect = (title: string, list: Memo[]) => list.length ? `<div class="sect"><div class="ins-h"><b>${title}</b><small>${list.length}</small></div><div class="group">${list.map(memoSlot).join('')}</div></div>` : '';
  const add = `<div class="memo-add"><input class="inp" id="memo-new" data-keep="memo-new" data-enter="memo-add" placeholder="${t('memo.add')}" aria-label="${t('memo.add')}"><button class="btn" data-action="memo-add" title="${t('memo.add')}" aria-label="${t('memo.add')}"><svg aria-hidden="true"><use href="#s-plus"/></svg></button></div>`;
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
  const inp = $<HTMLInputElement>('#memo-new');
  const text = inp?.value.trim();
  if (!text) { inp?.focus(); return; }
  const r = await tryCall('memo:add', text);
  ui.formErr.memo = r.ok ? '' : r.error;
  if (r.ok) { const now = $<HTMLInputElement>('#memo-new'); if (now) now.value = ''; }
  renderChatInspector();
  $<HTMLInputElement>('#memo-new')?.focus();
}

/* ---------- attachments ---------- */

export type Box = 'chat' | 'ws';

export function renderChips(box: Box) {
  const el = $(box === 'chat' ? '#chat-files' : '#ws-files');
  const files = ui.attach[box];
  el.hidden = !files.length;
  el.innerHTML = files.map((f, i) => `<span class="fchip" title="${esc(f)}">${sym('s-doc')}<span>${esc(base(f))}</span><button type="button" data-action="unattach" data-box="${box}" data-i="${i}" aria-label="${t('remove')}"><svg><use href="#s-x"/></svg></button></span>`).join('');
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
