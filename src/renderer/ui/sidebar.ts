// The left sidebar: what waits for the user, what runs, PRs in review, the queue and the history.
import type { Task, Worker, AccountView } from '../../shared/types';
import { isQueued } from '../../shared/queue';
import { canStop } from '../../shared/canStop';
import { doneMask, stepper, stepView } from '../../shared/steps';
import { queueLine, queueWhy, queueWhyText } from '../../shared/queueWhy';
import { slotsUsed } from '../../shared/slots';
import { askLine, lastFailed, plainStatus, workerState } from '../../shared/workerState';
import { decisionKind } from '../../shared/decisionView';
import { type Key } from '../../shared/i18n';
import { prsInReview } from '../../shared/prs';
import { reasonText } from '../../shared/askWhy';
import { RING, ringArc, untilReset } from '../../shared/usageRing';
import { readyToMerge } from '../../shared/prMerge';
import { groupByRepo, recentlyFinished } from '../../shared/sidebar';
import { History, type WorkerFilter } from '../../shared/history';
import { act } from '../app';
import { applyWidths } from './resize';
import { ageHtml, away, tickDecisions } from './chat';
import { pop } from './controls';
import { $, ago, awaitsDispatcher, bars, esc, finishedToday, hhmm, ic, isMac, locale, lv, oneLine, pct, prNum, queuedLabel, ring, S, store, sym, t, task, ui, when, worker } from './core';
import { screen } from './history';
import { cmdk } from './palette';
import { glide } from './settings';
import { queueCtx } from './workers';
import { shownStalled } from '../../shared/stall';

export function workerIcon(w: Worker) {
  const x = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
  // A Worker whose last task failed is drawn as failed, not idle (shared/workerState.ts).
  const glyph = { run: 'run', ask: 'ask', stalled: 'ask', failed: 'err', archived: 'arch', asked: 'wait', queued: 'wait', pr: 'pr', done: 'done', stopped: 'idle', idle: 'idle' } as const;
  return ic(glyph[workerState(w, x)]);
}

export function renderSidebar() {
  const s = S!;
  const pending = s.decisions.filter((d) => d.status === 'pending');
  const lastTask = (w: Worker) => (w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null);
  // A Worker that waits for the Dispatcher's answer is listed too: its task is open and holds a slot.
  const running = s.workers.filter((w) => canStop(w, lastTask(w)));
  // A Worker stopped by an error is not running; it waits for someone to tell it to continue. A failed turn leaves
  // its Worker idle with a failed task, which counts the same.
  const failed = s.workers.filter((w) => lastFailed(w, lastTask(w)));
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
    // The title names the command or the question itself (two lines at most); the second line says who, what kind,
    // and why it is asked, the same text as on the card and in the notification; the whole of it in the tooltip.
    const kind = t(`dec.kind.${decisionKind(d)}` as Key);
    const small = [d.workerId ?? 'Dispatcher', kind, d.reason?.why ?? x?.title].filter(Boolean).join(' · ');
    const sel = ui.decSel === d.id;
    return `<div tabindex="0" role="button" class="row drow${sel ? ' sel' : ''}"${sel ? ' aria-current="true"' : ''} data-action="goto-decision" data-id="${d.id}"${d.reason ? ` title="${esc(reasonText(d.reason))}"` : ''}>${ic('ask')}<span class="t"><b>${esc(oneLine(askLine(d), 160))}</b><small>${esc(small)}</small></span>${ageHtml(d)}</div>`;
  }).join('');
  const workerRow = (w: Worker, grouped = false) => {
    const x = lastTask(w);
    const what = x?.title ?? w.title;
    const stalled = shownStalled(w);
    const waits = w.status === 'waiting' || awaitsDispatcher(x) || stalled;
    // The steps its Worker planned for the open task, when it gave some: how far it is, under the title. A Worker
    // stopped by an error keeps them, so the row says at which step.
    const failed = lastFailed(w, x);
    const v = x && (OPEN.has(x.status) || failed) ? stepView(x) : null;
    const where = `${grouped ? '' : `${w.repo ?? t('general')}, `}${w.id}`;
    const small = w.status === 'waiting' ? `${w.id}, ${t('st.waitingMe')}` : awaitsDispatcher(x) ? `${w.id}, ${t('st.awaitDispatcher')}` : stalled ? `${w.id}, ${t('st.stalled')}`
      : v ? `${where} · ${t(v.allDone ? 'side.stepsDone' : failed ? 'side.stoppedAt' : 'side.stepsCount', { done: v.done, total: v.total })}`
      : `${where}, ${ago(x?.updatedAt ?? w.lastActiveAt)}`;
    const tip = [failed ? plainStatus(w.status === 'error' ? w.statusText || x?.summary : x?.summary) : '', v ? stepsTip(x!) : ''].filter(Boolean).join('\n\n');
    // The row's own button and its Stop/Open are side by side, not one inside the other (L14).
    return `<div class="row split${selCls(w.id)}" data-ctx="worker" data-id="${w.id}"${tip ? ` title="${esc(tip)}"` : ''}><button type="button" class="row-main" data-action="open-worker" data-id="${w.id}">${workerIcon(w)}<span class="t"><b>${esc(what)}</b><small>${esc(small)}</small>${v ? stepperHtml(x!, failed ? 'err' : waits ? 'wait' : v.allDone ? 'all' : 'run') : ''}</span></button>${workerActs(w)}</div>`;
  };
  // Running Workers get one area per repository; the heading carries the repository's name and how many run in it.
  const runRows = groupByRepo(running, (w) => w.repo).map((g) =>
    `<div class="rg"><div class="rg-h">${ic('repo', 'box')}<b>${esc(g.repo ?? t('general'))}</b><span class="n">${g.items.length}</span></div>${g.items.map((w) => workerRow(w, true)).join('')}</div>`).join('');
  const errRows = failed.map((w) => workerRow(w)).join('');
  const prRows = prs.map((x) => `<div tabindex="0" role="button" class="row${selCls(x.workerId)}" data-action="open-worker" data-id="${x.workerId ?? ''}">${ic('pr')}<span class="t"><b>${esc(x.title)}</b><small>${esc(`${x.repo ?? ''} #${prNum(x.prUrl)}, ${t('st.inReview')}`)}</small></span></div>`).join('');
  // The queue as a line: the tasks waiting for a slot in the order they start, each with its place; then the ones
  // something else holds (a merge, a usage limit). The second line says what starts each (shared/queueWhy.ts).
  const qctx = queueCtx();
  const qRow = (x: Task) => {
    const line = queueLine(t, x, qctx)!;
    const why = queueWhy(t, x, qctx);
    const mark = line.pos === null ? ic('wait') : `<span class="q-pos" aria-hidden="true">${line.pos}</span>`;
    const cls = line.pos === null ? ' held' : line.pos === 1 ? ' next' : '';
    const tip = [x.workerId, why ? queueWhyText(why) : ''].filter(Boolean).join(' · ');
    return { pos: line.pos, html: `<div class="row split q-row${cls}${selCls(x.workerId)}" title="${esc(tip)}"><button type="button" class="row-main" data-action="open-worker" data-id="${x.workerId ?? ''}">${mark}<span class="t"><b>${esc(x.title)}</b><small${line.cancelled ? ' class="warn"' : ''}>${esc(`${x.repo ?? t('general')} · ${line.text}`)}</small></span></button>${cancelX(x)}</div>` };
  };
  const qAll = queued.map(qRow);
  const inLine = qAll.filter((r) => r.pos !== null).sort((a, b) => a.pos! - b.pos!).map((r) => r.html).join('');
  const held = qAll.filter((r) => r.pos === null).map((r) => r.html).join('');
  const qRows = `${inLine ? `<div class="q-line">${inLine}</div>` : ''}${held && inLine ? `<div class="q-held">${t('side.queueHeld')}</div>` : ''}${held}`;
  // Two or more PRs ready at once: one button merges them in turn, asked once.
  const ready = readyToMerge(s.tasks);
  const allBusy = ui.merging.has('*'), allSure = ui.mergeAsk === '*';
  const prTitle = `${t('side.prs')}${ready.length > 1 || allBusy ? `<button class="h-act go${allSure ? ' sure' : ''}" data-action="pr-merge-all"${allBusy ? ' disabled' : ''}>${t(allBusy ? 'pr.merging' : allSure ? 'pr.mergeAllSure' : 'pr.mergeAll', { n: ready.length })}</button>` : ''}`;
  // How many slots are taken, once in the heading: a dot per slot and the count.
  const used = Math.min(slotsUsed(s.tasks), s.settings.maxWorkers);
  const slotsText = esc(t('side.slots', { n: used, max: s.settings.maxWorkers }));
  // A dot per slot while they fit beside the heading; the words say the same, so the dots are decoration.
  const dots = s.settings.maxWorkers <= 6 ? `<span class="q-slots" aria-hidden="true">${'<i class="on"></i>'.repeat(used)}${'<i></i>'.repeat(s.settings.maxWorkers - used)}</span>` : '';
  const slots = `${dots}<span class="q-slots-t">${slotsText}</span>`;
  const qTitle = `${t('side.queue')}${slots}${queued.length ? `<button class="h-act" data-action="queue-clear" title="${t('side.clearQueueTip')}">${t('side.clearQueue')}</button>` : ''}`;
  const any = decRows || runRows || prRows || qRows || errRows;
  const empty = any ? '' : `<div class="side-empty">${sym('s-check')}<span>${t('side.emptyTitle')}</span></div>`;
  // A filter's row is selected while the Worker list it filters is on screen.
  const filterCls = (f: WorkerFilter, n: number) => `${n ? '' : ' zero'}${ui.view === 'worker' && !ui.wOpen && ui.wFilter === f ? ' sel' : ''}`;
  const misc = `<section class="side-sec"><h4>${t('side.history')}</h4>
    <div class="row split${filterCls('today', doneToday)}"><button type="button" class="row-main" data-action="worker-filter" data-v="today">${ic('done')}<span class="t"><b>${t('side.doneToday')}</b></span><span class="badge">${doneToday}</span></button>${doneToday ? `<button class="disc" data-action="done-toggle" aria-expanded="${ui.doneOpen}" title="${t(ui.doneOpen ? 'side.doneHide' : 'side.doneShow')}" aria-label="${t(ui.doneOpen ? 'side.doneHide' : 'side.doneShow')}"><svg aria-hidden="true"><use href="#s-chev"/></svg></button>` : ''}</div>${doneToday && ui.doneOpen ? doneList(doneTasks) : ''}
    <div tabindex="0" role="button" class="row${filterCls('archived', archived)}" data-action="worker-filter" data-v="archived">${ic('arch')}<span class="t"><b>${t('side.archived')}</b></span><span class="badge">${archived}</span></div>
  </section>`;
  if (ui.sideMin) {
    // One glyph per section with its count; a section with nothing in it is left out, History always shows.
    const rail = (kind: string, label: string, n: number, extra = '', ask = false) =>
      `<button class="rail-b${extra}" data-action="side-toggle" title="${esc(`${label} ${n}`)}" aria-label="${esc(`${label} ${n}`)}">${ic(kind)}<span class="n${ask ? ' ask' : ''}">${n}</span></button>`;
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
  // Forget the plans of tasks that are gone.
  for (const id of seen.keys()) if (!s.tasks.some((x) => x.id === id)) seen.delete(id);
  $('#side').innerHTML = sec(t('side.decisions'), decRows, 'sec-dec') + sec(t('side.running'), runRows) + sec(prTitle, prRows) + sec(qTitle, qRows) + sec(t('side.errors'), errRows) + empty + misc;
  tickDecisions($('#side'));
}

/** What a finished task did, in one line: its PR and state, then the summary its Worker reported. */
export function doneLine(x: Task) {
  const pr = x.prUrl ? `#${prNum(x.prUrl)} ${x.prState === 'MERGED' ? t('pr.merged') : x.prState === 'CLOSED' ? t('pr.closed') : t('st.inReview')}` : t('side.noPr');
  return x.summary ? `${pr} · ${oneLine(x.summary, 140)}` : pr;
}

/** Under "Done today": the five tasks finished last. A row opens its Worker; the heading row still lists them all. */
export function doneList(done: Task[]) {
  const rows = recentlyFinished(done).map((x) => {
    const line = doneLine(x);
    const at = new Date(x.finishedAt!).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
    return `<div tabindex="0" role="button" class="row" data-action="open-worker" data-id="${esc(x.workerId ?? '')}" title="${esc(`${x.title}\n${line}`)}"><span class="t"><b>${esc(x.title)}</b><small>${esc(line)}</small></span><time>${at}</time></div>`;
  }).join('');
  const more = done.length > 5 ? `<button class="linkbtn" data-action="worker-filter" data-v="today">${t('side.doneAll', { n: done.length })}</button>` : '';
  return `<div class="sub">${rows}${more}</div>`;
}


const OPEN = new Set(['running', 'waiting', 'queued']);

/** The steps the sidebar drew last time, by task, so a step done since then plays once (shared/steps.ts, stepper). */
const seen = new Map<string, string>();

const TICK = '<svg viewBox="0 0 10 10"><path d="M1.8 5.3l2.1 2.1 4.2-4.6"/></svg>';
const CROSS = '<svg viewBox="0 0 10 10"><path d="M2.4 2.4l5.2 5.2M7.6 2.4l-5.2 5.2"/></svg>';

/**
 * The Stepper under a Worker's row: the whole plan when it is short, else a window on the current step with the hidden
 * steps counted above and below, rolling up a line when a step is done. Colour is the state: running, waiting (for the user or the Dispatcher), all done, or stopped by an error.
 * The row's small line and tooltip carry the same in words, so it is hidden from screen readers.
 */
function stepperHtml(x: Task, state: 'run' | 'wait' | 'all' | 'err') {
  const steps = x.steps ?? [];
  const v = stepper(steps, seen.get(x.id) ?? null);
  seen.set(x.id, doneMask(steps));
  const lines = v.lines.map((l) => {
    const glyph = l.seg === 'done' ? TICK : l.seg === 'cur' && state === 'err' ? CROSS : '';
    return `<span class="s ${l.seg}${l.just ? ' just' : ''}"><i>${glyph}</i><em>${esc(l.title)}</em></span>`;
  }).join('');
  // The small line gives the count only; the current step's name is read from here.
  const cur = stepView(x)!;
  const said = cur.allDone ? '' : `<span class="sr-only">${esc(t('side.stepAria', { n: cur.at + 1, total: cur.total, title: cur.current }))}</span>`;
  // Steps the window hides are counted above and below it, so a long plan does not look like three steps. Both lines
  // are kept (empty when nothing is hidden there) so the row keeps its height as the window moves.
  const long = v.size < steps.length;
  const more = (text: string) => (long ? `<span class="stp-more" aria-hidden="true">${esc(text)}</span>` : '');
  const above = more(v.before ? t('side.stepsAbove', { n: v.before }) : '');
  const below = more(v.after ? t(v.afterDone ? 'side.stepsBelowDone' : 'side.stepsBelow', { n: v.after, done: v.afterDone }) : '');
  return `${above}<span class="stp ${state}" style="--n:${v.size}" aria-hidden="true"><span class="stp-in${v.rolled ? ' adv' : ''}">${lines}</span></span>${below}${said}`;
}

/** The row's tooltip: every step, done ones ticked, the current one marked. */
function stepsTip(x: Task) {
  const v = stepView(x)!;
  const head = v.allDone ? t('side.stepsDone', { total: v.total }) : t('side.stepAria', { n: v.at + 1, total: v.total, title: v.current });
  return `${head}\n${(x.steps ?? []).map((s, i) => `${s.doneAt ? '✓' : i === v.at ? '▸' : '·'} ${i + 1}. ${s.title}`).join('\n')}`;
}

/** Stop and Open on a sidebar Worker row, shown on hover, focus and on the selected row (its context menu has them too). */
export function workerActs(w: Worker) {
  const btn = (action: string, icon: string, label: string, cls: string, extra = '') =>
    `<button type="button" class="row-act ${cls}" data-action="${action}" data-id="${esc(w.id)}" title="${esc(label)}" aria-label="${esc(label)}"${extra}><svg aria-hidden="true"><use href="#${icon}"/></svg></button>`;
  const x = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
  // While its Stop is on its way, the button waits instead of sending it twice.
  const busy = ui.stopping.has(w.id);
  const stop = canStop(w, x) ? btn('worker-stop', 's-stop16', t('wk.stopWho', { id: w.id }), 'stop', busy ? ' disabled aria-busy="true"' : '') : '';
  return `<span class="row-acts${busy ? ' on' : ''}">${stop}${btn('open-worker', 's-open', t('wk.openWho', { id: w.id }), 'open')}</span>`;
}

/** The × on a queued task's row: asks before cancelling it. */
export function cancelX(x: Task) {
  const label = esc(`${t('cancel.task')}: ${x.title}`);
  return `<button class="clear-x" data-action="task-cancel" data-id="${esc(x.id)}" title="${t('cancel.task')}" aria-label="${label}"><svg><use href="#s-x"/></svg></button>`;
}

/** "5h", "7d", "30d": how long a usage window is. */
export function winLabel(mins: number | null | undefined, fallback: string) {
  if (!mins) return fallback;
  return mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
}

/** The account's usage windows with their labels: two for a Claude account, one or two for a ChatGPT plan. */
export function usageWindows(a: AccountView): { label: string; v: number | null }[] {
  if (a.provider !== 'chatgpt') return [{ label: '5h', v: a.fiveHour.utilization }, { label: '7d', v: a.sevenDay.utilization }];
  const [short, long] = a.windowMins ?? [null, null];
  return [...(short ? [{ label: winLabel(short, '5h'), v: a.fiveHour.utilization }] : []), { label: winLabel(long, '7d'), v: a.sevenDay.utilization }];
}

/** A token duration in ms, as it is now: 0 while motion is reduced. */
export function ms(token: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return v.endsWith('ms') ? parseFloat(v) : v.endsWith('s') ? parseFloat(v) * 1000 : 0;
}

/** An account's two rings on the 24×24 grid: 5h outside, 7d inside, so the popover's rows (5h, then 7d) read from the outside in. */
export function ringsSvg(a: AccountView) {
  const arc = (v: number | null, r: number) => {
    const d = ringArc(v, r);
    return `<circle class="trk" cx="12" cy="12" r="${r}"/>${d ? `<circle class="${lv(v)}" cx="12" cy="12" r="${r}" stroke-dasharray="${d}"/>` : ''}`;
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${arc(a.fiveHour.utilization, RING.fiveHour)}${arc(a.sevenDay.utilization, RING.sevenDay)}</svg>`;
}

/** "Claude Team", "ChatGPT Free": whose account it is and its plan. */
export function planName(a: AccountView) {
  const plan = a.provider === 'chatgpt' ? a.planLabel ?? '' : a.plan;
  return `${a.provider === 'chatgpt' ? 'ChatGPT' : 'Claude'}${plan ? ` ${plan[0].toUpperCase()}${plan.slice(1)}` : ''}`;
}

/** The same facts as the popover in one string, for screen readers. */
export function usageTip(a: AccountView) {
  const parts = [`${a.label}, ${planName(a)}`, usageWindows(a).map((w) => `${w.label} ${pct(w.v)}`).join(' · ')];
  if (a.limitedUntil) parts.push(t('usage.limitedUntil', { t: hhmm(a.limitedUntil) }));
  if (a.lastError) parts.push(a.lastError);
  else if (!a.usageUpdatedAt) parts.push(t('usage.unknown'));
  return parts.join('. ');
}

/** One account in the usage popover: its rings and name, a bar per window with the time to its reset, and how fresh the numbers are. */
export function usageCard(a: AccountView) {
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
export const usagePop = { shown: false, hover: null as string | null, timer: 0, html: '' };

/** Opens the popover. Once it is open, moving between the rings only moves the mark (hoverUsage): nothing is drawn again. */
export function showUsagePop() {
  if (usagePop.shown || !S?.accounts.length) return;
  const el = $('#usage-pop');
  clearTimeout(usagePop.timer);
  usagePop.html = S.accounts.map(usageCard).join('');
  el.innerHTML = usagePop.html;
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

export function hideUsagePop() {
  if (!usagePop.shown) return;
  usagePop.shown = false;
  usagePop.hover = null;
  const el = $('#usage-pop');
  clearTimeout(usagePop.timer);
  el.classList.remove('opening');
  el.classList.add('out');
  usagePop.timer = window.setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, ms('--dur-fast'));
}

/** New numbers while the popover is open: written in place, with no opening motion, and only if something changed. */
function refreshUsagePop() {
  if (!usagePop.shown || !S?.accounts.length) return;
  const html = S.accounts.map(usageCard).join('');
  if (html === usagePop.html) return;
  usagePop.html = html;
  const el = $('#usage-pop');
  el.classList.remove('opening');
  el.innerHTML = html;
}

/** Marks the account whose ring the pointer is on. */
export function hoverUsage(id: string | null) {
  if (usagePop.hover === id) return;
  usagePop.hover = id;
  // The mark is part of what was drawn; keep the record of it in step, so a refresh compares like with like.
  if (usagePop.shown && S?.accounts.length) usagePop.html = S.accounts.map(usageCard).join('');
  document.querySelectorAll<HTMLElement>('#usage-pop .ua').forEach((s) => s.classList.toggle('on', s.dataset.id === id));
}

export function renderUsage() {
  const accs = S!.accounts;
  const el = $('#usage');
  if (!accs.length) {
    el.className = 'usage-empty nodrag';
    el.removeAttribute('tabindex');
    el.removeAttribute('role');
    el.innerHTML = `<a tabindex="0" role="link" data-action="open-settings">${t('usage.addAccount')}</a>`;
    hideUsagePop();
    return;
  }
  // One ring per account, in the order of Settings. The names and the numbers are in the popover (#usage-pop).
  el.className = 'usage nodrag';
  el.tabIndex = 0;
  // A picture of the numbers; the popover it describes has them as text (L14).
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', accs.map(usageTip).join('\n'));
  el.innerHTML = accs.map((a: AccountView) => `<span class="uacct${a.limited ? ' limited' : ''}" data-id="${esc(a.id)}">${ringsSvg(a)}</span>`).join('');
  refreshUsagePop();
}

/** Put the sidebars away or back, and say so on their buttons. The right one's button counts open decisions while it is hidden. */
export function applyPanels() {
  const win = $('#win');
  win.classList.toggle('side-min', ui.sideMin);
  win.classList.toggle('ins-min', ui.insMin);
  applyWidths();
  const left = $('#side-toggle');
  const leftTip = t(ui.sideMin ? 'side.expand' : 'side.collapse', { key: isMac ? '⌘B' : 'Ctrl+B' });
  left.title = leftTip;
  left.setAttribute('aria-label', leftTip);
  left.setAttribute('aria-expanded', String(!ui.sideMin));
  const n = ui.insMin ? (S?.decisions.filter((d) => d.status === 'pending').length ?? 0) : 0;
  $('#fake-badge').hidden = !S?.fake;
  // A failed check comes before a newer release: the gear's dot is red for it.
  document.querySelector('.foot-btn[data-action="open-settings"]')?.classList.toggle('has-issue', !!S?.preflightFailed);
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

export let sideAnim: number | undefined;

export function togglePanel(which: 'side' | 'ins') {
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
