// The left sidebar: what waits for the user, what runs, PRs in review, the queue and the history.
import type { AppState, Task, Worker, AccountView } from '../../shared/types';
import { drawnMismatch } from '../../shared/currentTask';
import { isQueued } from '../../shared/queue';
import { canStop } from '../../shared/canStop';
import { doneMask, stepper, stepView } from '../../shared/steps';
import { queueLine, queueWhy, queueWhyText } from '../../shared/queueWhy';
import { slotsUsed } from '../../shared/slots';
import { askLine, lastFailed, plainStatus, stepText, workerState } from '../../shared/workerState';
import { decisionKind } from '../../shared/decisionView';
import { type Key } from '../../shared/i18n';
import { prsInReview } from '../../shared/prs';
import { reasonText } from '../../shared/askWhy';
import { RING, ringArc, untilReset } from '../../shared/usageRing';
import { USAGE_INTERVALS, limitWindow, usageFoot, usedUp, type UsageFoot } from '../../shared/usage';
import { activeOf, allPaused } from '../../shared/accountPause';
import { queuedPrs, readyToQueue } from '../../shared/mergeQueue';
import { DONE_SHOWN, groupByRepo, recentlyFinished } from '../../shared/sidebar';
import { type WorkerFilter } from '../../shared/history';
import { applyWidths } from './resize';
import { narrowLayout } from '../../shared/panelWidth';
import { ageHtml, tickDecisions } from './chat';
import { quietUntil } from '../../shared/notifyRules';
import { $, ago, awaitsDispatcher, esc, finishedToday, hhmm, ic, isMac, locale, lv, meterLevel, oneLine, pct, prNum, S, store, stored, sym, t, task, tryCall, ui, when, workerTask } from './core';
import { setTip } from './tip';
import { segc } from './settings';
import { queueCtx } from './workers';
import { shownStalled } from '../../shared/stall';

export function workerIcon(w: Worker) {
  const x = workerTask(w);
  // A Worker whose last task failed is drawn as failed, not idle (shared/workerState.ts).
  const glyph = { run: 'run', ask: 'ask', stalled: 'ask', failed: 'err', archived: 'arch', asked: 'wait', queued: 'wait', pr: 'pr', done: 'done', stopped: 'idle', idle: 'idle' } as const;
  return ic(glyph[workerState(w, x)]);
}

/**
 * A moon in the sidebar's foot while the do-not-disturb hours are on, so the missing sound has a reason on screen.
 * Its tooltip says until when, as the time is written in Settings; it opens Settings on the alerts.
 */
export function renderDnd() {
  const mark = document.getElementById('dnd-mark');
  if (!mark || !S) return;
  const until = quietUntil(S.settings.quietFrom, S.settings.quietTo, new Date());
  mark.hidden = !until;
  if (!until) return;
  const label = t('dnd.until', { t: until });
  if (mark.dataset.tip !== label) { mark.dataset.tip = label; mark.setAttribute('aria-label', label); }
}

/** Workers already logged as drawn with another task than main's, so each disagreement is logged once. */
const warned = new Set<string>();

/** A Worker drawn with an open task other than main's: the window's copy of the state disagrees with main's. */
function warnDrawn(s: AppState) {
  if (!s.openTasks) return;
  for (const w of s.workers) {
    const d = drawnMismatch(w, task, s.openTasks[w.id] ?? null);
    const key = d && `${w.id} ${d.drawn} ${d.main}`;
    if (!d || !key || warned.has(key)) continue;
    warned.add(key);
    void tryCall('app:warn', `${w.id} is drawn with open task ${d.drawn ?? 'none'}, main has ${d.main ?? 'none'}`);
  }
}

export function renderSidebar() {
  const s = S!;
  renderDnd();
  warnDrawn(s);
  const pending = s.decisions.filter((d) => d.status === 'pending');
  // A Worker that waits for the Dispatcher's answer is listed too: its task is open and holds a slot.
  const running = s.workers.filter((w) => canStop(w, workerTask(w)));
  // A Worker stopped by an error is not running; it waits for someone to tell it to continue. A failed turn leaves
  // its Worker idle with a failed task, which counts the same.
  const failed = s.workers.filter((w) => lastFailed(w, workerTask(w)));
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

  const sec = (title: string, rows: string, cls = '') => rows ? `<section class="side-sec ${cls}"><h4 aria-level="3">${title}</h4>${rows}</section>` : '';
  const decRows = pending.map((d) => {
    // The title names the command or the question itself (two lines at most); the second line says who and what
    // kind, beside the age. Why it is asked is on the card and in the tooltip: here it was cut after a few letters.
    const kind = t(`dec.kind.${decisionKind(d)}` as Key);
    const small = [d.workerId ?? 'Dispatcher', kind].join(' · ');
    const sel = ui.decSel === d.id;
    return `<div tabindex="0" role="button" class="row drow${sel ? ' sel' : ''}"${sel ? ' aria-current="true"' : ''} data-action="goto-decision" data-id="${d.id}"${d.reason ? ` data-tip="${esc(reasonText(d.reason))}"` : ''}>${ic('ask')}<span class="t"><b>${esc(oneLine(askLine(d), 160))}</b><small>${esc(small)}</small></span>${ageHtml(d)}</div>`;
  }).join('');
  const workerRow = (w: Worker, grouped = false) => {
    const x = workerTask(w);
    const what = x?.title ?? w.title;
    const stalled = shownStalled(w);
    const waits = w.status === 'waiting' || awaitsDispatcher(x) || stalled;
    // The steps its Worker planned for the open task, when it gave some: how far it is, under the title. A Worker
    // stopped by an error keeps them, so the row says at which step.
    const failed = lastFailed(w, x);
    const v = x && (OPEN.has(x.status) || failed) ? stepView(x) : null;
    // "W-id · repository · state" as on every screen; under a repository's heading the repository is left out.
    const where = grouped ? w.id : `${w.id} · ${w.repo ?? t('general')}`;
    const state = w.status === 'waiting' ? t('st.waitingMe') : awaitsDispatcher(x) ? t('st.awaitDispatcher') : stalled ? t('st.stalled')
      : v ? stepText(t, v, failed) : ago(x?.updatedAt ?? w.lastActiveAt);
    const small = `${where} · ${state}`;
    const tip = [failed ? plainStatus(w.status === 'error' ? w.statusText || x?.summary : x?.summary) : '', v ? stepsTip(x!) : ''].filter(Boolean).join('\n\n');
    // The row's own button and its Stop/Open are side by side, not one inside the other (L14).
    return `<div class="row split${selCls(w.id)}" data-ctx="worker" data-id="${w.id}"${tip ? ` data-tip="${esc(tip)}"` : ''}><button type="button" class="row-main" data-action="open-worker" data-id="${w.id}">${workerIcon(w)}<span class="t"><b>${esc(what)}</b><small>${esc(small)}</small>${v ? stepperHtml(x!, failed ? 'err' : waits ? 'wait' : v.allDone ? 'all' : 'run') : ''}</span></button>${workerActs(w)}</div>`;
  };
  // Running Workers get one area per repository; the heading carries the repository's name and how many run in it.
  const runRows = groupByRepo(running, (w) => w.repo).map((g) =>
    `<div class="rg"><div class="rg-h">${ic('repo', 'box')}<b>${esc(g.repo ?? t('general'))}</b><span class="n">${g.items.length}</span></div>${g.items.map((w) => workerRow(w, true)).join('')}</div>`).join('');
  const errRows = failed.map((w) => workerRow(w)).join('');
  const prRows = prs.map((x) => `<div tabindex="0" role="button" class="row${selCls(x.workerId)}" data-action="open-worker" data-id="${x.workerId ?? ''}">${ic('pr')}<span class="t"><b>${esc(x.title)}</b><small>${esc(`${x.repo ?? ''} #${prNum(x.prUrl)} · ${t('st.inReview')}`)}</small></span></div>`).join('');
  // The queue as a line: the tasks waiting for a slot in the order they start, each with its place; then the ones
  // something else holds (a merge, a usage limit). The second line says what starts each (shared/queueWhy.ts).
  const qctx = queueCtx();
  const qRow = (x: Task) => {
    const line = queueLine(t, x, qctx)!;
    const why = queueWhy(t, x, qctx);
    const mark = line.pos === null ? ic('wait') : `<span class="q-pos" aria-hidden="true">${line.pos}</span>`;
    const cls = line.pos === null ? ' held' : line.pos === 1 ? ' next' : '';
    const tip = [x.workerId, why ? queueWhyText(why) : ''].filter(Boolean).join(' · ');
    // A task with no Worker yet (T-0146) opens its own waiting card.
    const open = x.workerId ? `data-action="open-worker" data-id="${esc(x.workerId)}"` : `data-action="open-queued" data-id="${esc(x.id)}"`;
    const sel = x.workerId ? selCls(x.workerId) : ui.view === 'worker' && !ui.wSel && ui.qSel === x.id ? ' sel' : '';
    return { pos: line.pos, html: `<div class="row split q-row${cls}${sel}" data-tip="${esc(tip)}"><button type="button" class="row-main" ${open}>${mark}<span class="t"><b>${esc(x.title)}</b><small${line.cancelled ? ' class="warn"' : ''}>${esc(`${x.repo ?? t('general')} · ${line.text}`)}</small></span></button>${cancelX(x)}</div>` };
  };
  const qAll = queued.map(qRow);
  const inLine = qAll.filter((r) => r.pos !== null).sort((a, b) => a.pos! - b.pos!).map((r) => r.html).join('');
  const held = qAll.filter((r) => r.pos === null).map((r) => r.html).join('');
  const qRows = `${inLine ? `<div class="q-line">${inLine}</div>` : ''}${held && inLine ? `<div class="q-held">${t('side.queueHeld')}</div>` : ''}${held}`;
  // Two or more PRs ready at once: one button puts them in the merge queue, asked once. With nothing to add and
  // the queue at work, the button opens the Worker list, where the queue is shown.
  const ready = readyToQueue(s.tasks, s.mergeQueue);
  const inQueue = queuedPrs(s.mergeQueue).size;
  const allSure = ui.mergeAsk === '*';
  const prAct = ready.length > 1
    ? `<button class="h-act go${allSure ? ' sure' : ''}" data-action="pr-merge-all">${t(allSure ? 'pr.mergeAllSure' : 'pr.mergeAll', { n: ready.length })}</button>`
    : inQueue ? `<button class="h-act" data-action="worker-filter" data-v="">${t('pr.queueOpen', { n: inQueue })}</button>` : '';
  const prTitle = `${t('side.prs')}${prAct}`;
  // How many slots are taken, once in the heading: a dot per slot and the count.
  const used = Math.min(slotsUsed(s.tasks), s.settings.maxWorkers);
  const slotsText = esc(t('side.slots', { n: used, max: s.settings.maxWorkers }));
  // A dot per slot while they fit beside the heading; the words say the same, so the dots are decoration.
  const dots = s.settings.maxWorkers <= 6 ? `<span class="q-slots" aria-hidden="true">${'<i class="on"></i>'.repeat(used)}${'<i></i>'.repeat(s.settings.maxWorkers - used)}</span>` : '';
  const slots = `${dots}<span class="q-slots-t">${slotsText}</span>`;
  const qTitle = `${t('side.queue')}${slots}${queued.length ? `<button class="h-act" data-action="queue-clear" data-tip="${t('side.clearQueueTip')}">${t('side.clearQueue')}</button>` : ''}`;
  const any = decRows || runRows || prRows || qRows || errRows;
  const empty = any ? '' : `<div class="side-empty">${sym('s-check')}<span>${t('side.emptyTitle')}</span></div>`;
  // A filter's row is selected while the Worker list it filters is on screen.
  const filterCls = (f: WorkerFilter, n: number) => `${n ? '' : ' zero'}${ui.view === 'worker' && !ui.wOpen && ui.wFilter === f ? ' sel' : ''}`;
  const misc = `<section class="side-sec"><h4 aria-level="3">${t('side.history')}</h4>
    <div class="row split${filterCls('today', doneToday)}"><button type="button" class="row-main" data-action="worker-filter" data-v="today">${ic('done')}<span class="t"><b>${t('side.doneToday')}</b></span><span class="badge">${doneToday}</span></button>${doneToday ? `<button class="disc" data-action="done-toggle" aria-expanded="${ui.doneOpen}" data-tip="${t(ui.doneOpen ? 'side.doneHide' : 'side.doneShow')}" aria-label="${t(ui.doneOpen ? 'side.doneHide' : 'side.doneShow')}"><svg aria-hidden="true"><use href="#s-chev"/></svg></button>` : ''}</div>${doneToday && ui.doneOpen ? doneList(doneTasks) : ''}
    <div tabindex="0" role="button" class="row${filterCls('archived', archived)}" data-action="worker-filter" data-v="archived">${ic('arch')}<span class="t"><b>${t('side.archived')}</b></span><span class="badge">${archived}</span></div>
  </section>`;
  if (ui.sideMin) {
    // One glyph per section with its count; a section with nothing in it is left out, History always shows.
    const rail = (kind: string, label: string, n: number, extra = '', ask = false) =>
      `<button class="rail-b${extra}" data-action="side-toggle" data-tip="${esc(`${label} ${n}`)}" aria-label="${esc(`${label} ${n}`)}">${ic(kind)}<span class="n${ask ? ' ask' : ''}">${n}</span></button>`;
    const live = [
      pending.length ? rail('ask', t('side.decisions'), pending.length, ' sec-dec', true) : '',
      running.length ? rail('run', t('side.running'), running.length) : '',
      prs.length ? rail('pr', t('side.prs'), prs.length) : '',
      queued.length ? rail('wait', t('side.queue'), queued.length) : '',
      failed.length ? rail('err', t('side.errors'), failed.length) : '',
    ].join('');
    const hist = (f: WorkerFilter, kind: string, label: string, n: number) =>
      `<button class="rail-b${filterCls(f, n)}" data-action="worker-filter" data-v="${f}" data-tip="${esc(`${label} ${n}`)}" aria-label="${esc(`${label} ${n}`)}">${ic(kind)}${n ? `<span class="n">${n}</span>` : ''}</button>`;
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

/** Under "Done today": the DONE_SHOWN tasks finished last. A row opens its Worker; the heading row still lists them all. */
export function doneList(done: Task[]) {
  const rows = recentlyFinished(done).map((x) => {
    const line = doneLine(x);
    const at = new Date(x.finishedAt!).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
    return `<div tabindex="0" role="button" class="row" data-action="open-worker" data-id="${esc(x.workerId ?? '')}"><span class="t"><b>${esc(x.title)}</b><small>${esc(line)}</small></span><time>${at}</time></div>`;
  }).join('');
  const more = done.length > DONE_SHOWN ? `<button class="linkbtn" data-action="worker-filter" data-v="today">${t('side.doneAll', { n: done.length })}</button>` : '';
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
    `<button type="button" class="row-act ${cls}" data-action="${action}" data-id="${esc(w.id)}" data-tip="${esc(label)}" aria-label="${esc(label)}"${extra}><svg aria-hidden="true"><use href="#${icon}"/></svg></button>`;
  const x = workerTask(w);
  // While its Stop is on its way, the button waits instead of sending it twice.
  const busy = ui.stopping.has(w.id);
  const stop = canStop(w, x) ? btn('worker-stop', 's-stop16', t('wk.stopWho', { id: w.id }), 'stop', busy ? ' disabled aria-busy="true"' : '') : '';
  return `<span class="row-acts${busy ? ' on' : ''}">${stop}${btn('open-worker', 's-open', t('wk.openWho', { id: w.id }), 'open')}</span>`;
}

/** The × on a queued task's row: asks before cancelling it. */
export function cancelX(x: Task) {
  const label = esc(`${t('cancel.task')}: ${x.title}`);
  return `<button class="btn btn-icon btn-sm clear-x" data-action="task-cancel" data-id="${esc(x.id)}" data-tip="${t('cancel.task')}" aria-label="${label}"><svg><use href="#s-x"/></svg></button>`;
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
  if (a.paused) parts.push(offText(a));
  if (a.limitedUntil) parts.push(t('usage.limitedUntil', { t: hhmm(a.limitedUntil) }));
  if (a.lastError) parts.push(a.lastError);
  else if (!a.usageUpdatedAt) parts.push(t('usage.unknown'));
  return parts.join('. ');
}

/** An account switched off: "Off", or "Off until 3:00 PM" for an hour's pause. */
export function offText(a: Pick<AccountView, 'pausedUntil'>) {
  return a.pausedUntil ? t('acc.offUntil', { t: untilText(a.pausedUntil) }) : t('acc.offPill');
}

/** "7d limit · until Tue 2:30 PM": which window holds a limited account and until when ("Limited until …" when unknown). */
export function limitText(a: AccountView) {
  const win = a.provider === 'chatgpt' ? null : limitWindow(a);
  if (!a.limitedUntil) return t('usage.limited');
  const until = untilText(a.limitedUntil);
  return win ? t('usage.limitWinUntil', { w: win, t: until }) : t('usage.limitedShort', { t: until });
}

/** A time to come: "2:30 PM" today, "Tue 2:30 PM" within the week, a date after that. */
export function untilText(iso: string) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  if (d.getTime() - Date.now() < 6 * 86_400_000) return `${d.toLocaleDateString(locale(), { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString(locale(), { month: 'short', day: 'numeric' })} ${time}`;
}

/** The time left until `iso`, "2h 10m"; undefined when unknown or past. */
const leftText = (iso: string | null) => untilReset(iso)?.map((p) => t(p.unit === 'd' ? 'time.day' : p.unit === 'h' ? 'time.hour' : 'time.min', { n: p.n })).join(' ');

/** A clock time, "2:14 PM". */
const clock = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });

/** One account in the usage popover: its rings and name, a bar per window with the time to its reset, and how fresh the numbers are. */
export function usageCard(a: AccountView) {
  const wins = [
    ...(a.provider !== 'chatgpt' || a.windowMins?.[0] ? [{ label: a.provider === 'chatgpt' ? winLabel(a.windowMins?.[0], '5h') : '5h', w: a.fiveHour }] : []),
    { label: a.provider === 'chatgpt' ? winLabel(a.windowMins?.[1], '7d') : '7d', w: a.sevenDay },
  ];
  const rows = wins.map(({ label, w }) => {
    const left = leftText(w.resetsAt);
    // A window without a figure looks unknown (a hatched track), never like 0%.
    const none = w.utilization === null;
    const note = none ? (a.usageUpdatedAt ? t('usage.noFigure') : '') : left ? t('usage.resetsIn', { t: left }) : '';
    return `<div class="uw"><span class="wl">${label}</span><span class="meter${none ? ' none' : ''}"${meterLevel(w.utilization)}><i style="width:${Math.min(100, w.utilization ?? 0)}%"></i></span><b>${pct(w.utilization)}</b><small>${esc(note)}</small></div>`;
  }).join('');
  // A failed account keeps its last figures, dimmed, with the time they are from.
  const old = !!a.lastError && !!a.usageUpdatedAt;
  const fresh = a.usageUpdatedAt
    ? a.kind === 'login' && a.provider === 'claude' ? t('usage.fromSessions', { t: when(a.usageUpdatedAt) }) : t('usage.asOf', { t: when(a.usageUpdatedAt) })
    : '';
  const state = a.limited
    ? `<span class="pill" data-tone="danger">${esc(limitText(a))}</span>`
    : old ? `<time class="old">${esc(t('usage.figuresAt', { t: clock(a.usageUpdatedAt!) }))}</time>`
    : `<time>${esc(fresh)}</time>`;
  const note = a.lastError ? `<p class="err">${esc(a.lastError)}</p>` : !a.usageUpdatedAt ? `<p>${t('usage.unknown')}</p>` : '';
  const how = a.provider === 'claude' ? ` · ${t(a.kind === 'token' ? 'usage.token' : 'usage.login')}` : '';
  const cls = `ua${a.id === usagePop.hover ? ' on' : ''}${a.limited ? ' limited' : ''}${old ? ' old' : ''}`;
  return `<section class="${cls}" data-id="${esc(a.id)}"><header>${ringsSvg(a)}<span class="who"><b>${esc(a.label)}</b><small>${esc(planName(a) + how)}</small></span>${state}</header>${rows}${note}</section>`;
}

/** The foot's line: when the figures were read and when they are read next, or why not. */
export function footText(f: UsageFoot) {
  switch (f.kind) {
    case 'sessions': return t('usage.foot.sessions');
    case 'running': return f.was ? t('usage.foot.running', { t: clock(f.was) }) : t('usage.foot.runningFirst');
    case 'paused': return t('usage.foot.paused', { t: clock(f.until) });
    case 'failed': return f.last ? t('usage.foot.failed', { t: clock(f.last) }) : t('usage.foot.failedNever');
    case 'ok': {
      const parts = [f.at ? t('usage.foot.at', { t: clock(f.at) }) : t('usage.foot.never')];
      if (f.failed) parts.push(t('usage.foot.someFailed', { n: f.failed, total: f.total }));
      else if (f.next) parts.push(t('usage.foot.next', { t: clock(f.next) }));
      return parts.join(' · ');
    }
  }
}

/** The popover's foot: the state of the rounds, a refresh button, and how often they run. */
function usageFootHtml() {
  const f = usageFoot(S!.usageClock, S!.accounts);
  const every = String(S!.settings.usageRefreshMins);
  const opts = USAGE_INTERVALS.map((n) => ({ value: String(n), label: n ? t('usage.mins', { n }) : t('usage.byHand') }));
  // Off while the server asked to wait, and while a round runs (its arrow turns).
  const off = f.kind === 'paused' || f.kind === 'running';
  const btn = `<button type="button" class="ubtn${f.kind === 'running' ? ' spin' : ''}" data-action="usage-refresh" data-focus="usage-refresh" data-tip="${esc(t('usage.refresh'))}" aria-label="${esc(t('usage.refresh'))}"${off ? ' disabled' : ''}><svg aria-hidden="true"><use href="#s-refresh"/></svg></button>`;
  const line = `<span class="uft${f.kind === 'failed' || (f.kind === 'ok' && f.failed) ? ' bad' : ''}" role="status">${esc(footText(f))}</span>`;
  const chips = f.kind === 'sessions' ? '' : segc('usage-every', every, opts, t('usage.every'));
  return `<footer class="ufoot"><div class="ufl">${line}${f.kind === 'sessions' ? '' : btn}</div>${chips}</footer>`;
}

/** The popover: a block per account that is on, one line naming those switched off, and the foot. */
function usagePopHtml() {
  const off = S!.accounts.filter((a) => a.paused);
  const offRow = off.length
    ? `<section class="ua off"><header><span class="who"><b>${esc(t('usage.offRow', { n: off.length }))}</b><small>${esc(off.map((a) => a.label).join(', '))}</small></span></header></section>`
    : '';
  return activeOf(S!.accounts).map(usageCard).join('') + offRow + usageFootHtml();
}

/**
 * The usage popover: every account's numbers while the pointer or the focus is on the rings or on the popover.
 * `keys`: the focus in it came with the keyboard, so it holds the popover open; a click's focus does not.
 */
export const usagePop = { shown: false, hover: null as string | null, timer: 0, hideTimer: 0, html: '', quiet: false, keys: false };

/** Opens the popover. Once it is open, moving between the rings only moves the mark (hoverUsage): nothing is drawn again. */
export function showUsagePop() {
  clearTimeout(usagePop.hideTimer);
  if (usagePop.shown || !S?.accounts.length) return;
  const el = $('#usage-pop');
  clearTimeout(usagePop.timer);
  usagePop.html = usagePopHtml();
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
  clearTimeout(usagePop.hideTimer);
  if (!usagePop.shown) return;
  usagePop.shown = false;
  usagePop.hover = null;
  usagePop.keys = false;
  const el = $('#usage-pop');
  clearTimeout(usagePop.timer);
  el.classList.remove('opening');
  el.classList.add('out');
  usagePop.timer = window.setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, ms('--dur-fast'));
}

/** The pointer left the rings: close unless it reaches the popover in a moment (its buttons are in there). */
export function hideUsageSoon() {
  clearTimeout(usagePop.hideTimer);
  usagePop.hideTimer = window.setTimeout(() => {
    if ($('#usage-pop').matches(':hover') || (usagePop.keys && $('#usage-pop').contains(document.activeElement))) return;
    hideUsagePop();
  }, 200);
}

/** New numbers while the popover is open: written in place, with no opening motion, and only if something changed. */
function refreshUsagePop() {
  if (!usagePop.shown || !S?.accounts.length) return;
  const html = usagePopHtml();
  if (html === usagePop.html) return;
  usagePop.html = html;
  const el = $('#usage-pop');
  el.classList.remove('opening');
  // A button that had the focus keeps it.
  const active = document.activeElement as HTMLElement | null;
  const key = active && el.contains(active) ? (active.dataset.focus ?? (active.dataset.segc ? `seg:${active.dataset.v}` : null)) : null;
  el.innerHTML = html;
  if (key) {
    const next = key.startsWith('seg:') ? el.querySelector<HTMLElement>(`[data-segc][data-v="${CSS.escape(key.slice(4))}"]`) : el.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`);
    // A disabled refresh button can't hold the focus: the chips take it.
    (next && !(next as HTMLButtonElement).disabled ? next : el.querySelector<HTMLElement>('[data-segc][aria-checked="true"]'))?.focus({ preventScroll: true });
  }
}

/** Marks the account whose ring the pointer is on. */
export function hoverUsage(id: string | null) {
  if (usagePop.hover === id) return;
  usagePop.hover = id;
  // The mark is part of what was drawn; keep the record of it in step, so a refresh compares like with like.
  if (usagePop.shown && S?.accounts.length) usagePop.html = usagePopHtml();
  document.querySelectorAll<HTMLElement>('#usage-pop .ua').forEach((s) => s.classList.toggle('on', s.dataset.id === id));
}

/** Every account switched off: a warning above the chat's composer with how many tasks wait, and the way to Accounts. */
export function renderAccountsOff() {
  const el = document.getElementById('chat-off');
  if (!el || !S) return;
  const html = allPaused(S.accounts)
    ? `${sym('s-alert')}<span>${esc(t('acc.noneOnWait', { n: S.tasks.filter((x) => x.status === 'queued').length }))}</span><button type="button" class="cbtn" data-action="open-settings" data-v="accounts">${sym('s-person')}<span>${esc(t('acc.accountsBtn'))}</span></button>`
    : '';
  if (el.innerHTML === html && el.hidden === !html) return;
  el.innerHTML = html;
  el.hidden = !html;
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
  // Every account switched off: nothing can start, and the toolbar says so in place of the rings.
  if (allPaused(accs)) {
    el.className = 'usage-off nodrag';
    el.removeAttribute('tabindex');
    el.removeAttribute('role');
    el.removeAttribute('aria-label');
    el.innerHTML = `<a class="uwarn" tabindex="0" role="link" data-action="open-settings" data-v="accounts">${sym('s-alert')}<span>${esc(t('acc.noneOn'))}</span></a>`;
    hideUsagePop();
    return;
  }
  // One ring per account that is on, in the order of Settings; those switched off are a count after them. The names
  // and the numbers are in the popover (#usage-pop).
  const off = accs.filter((a) => a.paused).length;
  el.className = 'usage nodrag';
  el.tabIndex = 0;
  // A picture of the numbers; the popover it describes has them as text (L14).
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', accs.map(usageTip).join('\n'));
  el.innerHTML = activeOf(accs).map(toolbarAccount).join('') + (off ? `<span class="ucount">+${off}</span>` : '');
  refreshUsagePop();
}

/**
 * One account in the toolbar: its rings, and only for an account whose usage is used up, when it comes back
 * ("Resets in 2h 10m"); a narrow window keeps the rings alone. A failed read fades the rings and adds a dot.
 */
function toolbarAccount(a: AccountView) {
  const failed = !!a.lastError;
  const out = usedUp(a);
  const left = out && leftText(out.at);
  const side = out ? `<span class="pill ulim" data-tone="danger">${esc(left ? t('usage.resetsIn', { t: left }) : t('usage.limited'))}</span>` : '';
  return `<span class="uacct${out ? ' limited' : ''}${failed ? ' failed' : ''}" data-id="${esc(a.id)}"><span class="ur">${ringsSvg(a)}</span>${side}</span>`;
}

/** Put the sidebars away or back, and say so on their buttons. The right one's button counts open decisions while it is hidden. */
export function applyPanels() {
  const win = $('#win');
  win.classList.toggle('side-min', ui.sideMin);
  win.classList.toggle('ins-min', ui.insMin);
  win.classList.toggle('ins-over', ui.drawer);
  applyWidths();
  const left = $('#side-toggle');
  const leftTip = t(ui.sideMin ? 'side.expand' : 'side.collapse');
  setTip(left, leftTip, isMac ? '⌘B' : 'Ctrl+B');
  left.setAttribute('aria-label', leftTip);
  left.setAttribute('aria-expanded', String(!ui.sideMin));
  const n = ui.insMin ? (S?.decisions.filter((d) => d.status === 'pending').length ?? 0) : 0;
  $('#fake-badge').hidden = !S?.fake;
  // A failed check comes before a newer release: the gear's dot is red for it.
  document.querySelector('.side-foot [data-action="open-settings"]')?.classList.toggle('has-issue', !!S?.preflightFailed);
  // The gear carries a dot while a newer release waits.
  document.querySelector('.side-foot [data-action="open-settings"]')?.classList.toggle('has-update', !!S?.update?.version);
  const find = $('#cmdk-btn');
  setTip(find, t('cmdk.tip'), isMac ? '⌘K' : 'Ctrl+K');
  find.setAttribute('aria-label', t('cmdk.tip'));
  const right = $('#ins-toggle');
  const key = isMac ? '⌥⌘B' : 'Ctrl+Alt+B';
  const rightTip = !ui.insMin ? t('ins.collapse') : n ? t('ins.expandDec', { n }) : t('ins.expand');
  setTip(right, rightTip, key);
  right.setAttribute('aria-label', rightTip);
  right.setAttribute('aria-expanded', String(!ui.insMin));
  // As a drawer the right sidebar is opened from here: the button says what it holds, with its count.
  $('#ins-lbl').textContent = t('ins.tabInbox');
  const badge = $('#ins-count');
  badge.hidden = !n;
  badge.textContent = n ? String(n) : '';
}

export let sideAnim: number | undefined;

/** `keep`: the choice is remembered for the next start; a drawer closing by itself is not. */
export function togglePanel(which: 'side' | 'ins', keep = true) {
  if (which === 'side') {
    ui.sideMin = !ui.sideMin;
    if (!ui.rail) store('oma.sideMin', ui.sideMin);
    // The sidebar's new content fades in only for this change: every later state update rebuilds it and must not fade.
    const win = $('#win');
    win.classList.add('side-anim');
    clearTimeout(sideAnim);
    sideAnim = window.setTimeout(() => win.classList.remove('side-anim'), 400);
  } else {
    ui.insMin = !ui.insMin;
    if (keep && !ui.drawer) store('oma.insMin', ui.insMin);
  }
  applyPanels();
  if (S) renderSidebar();
}

/**
 * Follows the window's width (I1): narrower than 1100 the right sidebar becomes a drawer over the chat, closed until
 * its toolbar button opens it; narrower than 960 the left sidebar folds to its rail. Each panel goes back to the
 * user's stored choice when the window is wide again. Returns whether anything changed.
 */
export function applyNarrow(): boolean {
  const n = narrowLayout($('#win').clientWidth || window.innerWidth);
  let changed = false;
  if (n.drawer !== ui.drawer) {
    ui.drawer = n.drawer;
    const min = n.drawer || stored('oma.insMin');
    ui.insMin = min;
    changed = true;
  }
  if (n.rail !== ui.rail) {
    ui.rail = n.rail;
    ui.sideMin = n.rail || stored('oma.sideMin');
    changed = true;
  }
  if (changed) { applyPanels(); if (S) renderSidebar(); }
  return changed;
}

/**
 * Closes the right sidebar's drawer; from the keyboard the focus goes back to its button when it was inside. A reply
 * thread in it stays, with its draft, for when the drawer opens again.
 */
export function closeDrawer(refocus = true): boolean {
  if (!ui.drawer || ui.insMin) return false;
  const inside = !!document.activeElement?.closest('.inspector');
  togglePanel('ins', false);
  if (inside && refocus) $('#ins-toggle').focus();
  return true;
}
