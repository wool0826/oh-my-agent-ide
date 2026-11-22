// The left sidebar: what waits for the user, what runs, PRs in review, the queue and the history.
import type { Task, Worker, AccountView } from '../../shared/types';
import { isQueued } from '../../shared/queue';
import { canStop } from '../../shared/canStop';
import { queueWhy, queueWhyText } from '../../shared/queueWhy';
import { prsInReview } from '../../shared/prs';
import { reasonText } from '../../shared/askWhy';
import { RING, ringArc, untilReset } from '../../shared/usageRing';
import { readyToMerge } from '../../shared/prMerge';
import { groupByRepo, recentlyFinished } from '../../shared/sidebar';
import { History, type WorkerFilter } from '../../shared/history';
import { act } from '../app';
import { applyWidths } from './resize';
import { away } from './chat';
import { pop } from './controls';
import { $, ago, awaitsDispatcher, bars, esc, finishedToday, hhmm, ic, isMac, locale, lv, oneLine, pct, prNum, queuedLabel, ring, S, store, sym, t, task, ui, when, worker } from './core';
import { screen } from './history';
import { cmdk } from './palette';
import { glide } from './settings';
import { queueCtx } from './workers';

export function workerIcon(w: Worker) {
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

export function renderSidebar() {
  const s = S!;
  const pending = s.decisions.filter((d) => d.status === 'pending');
  const lastTask = (w: Worker) => (w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null);
  // A Worker that waits for the Dispatcher's answer is listed too: its task is open and holds a slot.
  const running = s.workers.filter((w) => canStop(w, lastTask(w)));
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
    // The row's own button and its Stop/Open are side by side, not one inside the other (L14).
    return `<div class="row split${selCls(w.id)}" data-ctx="worker" data-id="${w.id}"${w.status === 'error' ? ` title="${esc(w.statusText)}"` : ''}><button type="button" class="row-main" data-action="open-worker" data-id="${w.id}">${workerIcon(w)}<span class="t"><b>${esc(what)}</b><small>${esc(small)}</small></span></button>${workerActs(w)}</div>`;
  };
  // Running Workers get one area per repository; the heading carries the repository's name and how many run in it.
  const runRows = groupByRepo(running, (w) => w.repo).map((g) =>
    `<div class="rg"><div class="rg-h">${ic('repo', 'box')}<b>${esc(g.repo ?? t('general'))}</b><span class="n">${g.items.length}</span></div>${g.items.map((w) => workerRow(w, true)).join('')}</div>`).join('');
  const errRows = failed.map((w) => workerRow(w)).join('');
  const prRows = prs.map((x) => `<div tabindex="0" role="button" class="row${selCls(x.workerId)}" data-action="open-worker" data-id="${x.workerId ?? ''}">${ic('pr')}<span class="t"><b>${esc(x.title)}</b><small>${esc(`${x.repo ?? ''} #${prNum(x.prUrl)}, ${t('st.inReview')}`)}</small></span></div>`).join('');
  const qRows = queued.map((x) => {
    const small = x.status === 'blocked' ? t('side.afterMerge', { id: x.afterTaskId ?? '' }) : `${x.repo ?? t('general')}, ${x.workerId ?? ''}, ${queuedLabel(x)}`;
    const why = queueWhy(t, x, queueCtx());
    return `<div class="row split${selCls(x.workerId)}"${why ? ` title="${esc(queueWhyText(why))}"` : ''}><button type="button" class="row-main" data-action="open-worker" data-id="${x.workerId ?? ''}">${ic('wait')}<span class="t"><b>${esc(x.title)}</b><small>${esc(small)}</small></span></button>${cancelX(x)}</div>`;
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
    <div class="row split${filterCls('today', doneToday)}"><button type="button" class="row-main" data-action="worker-filter" data-v="today">${ic('done')}<span class="t"><b>${t('side.doneToday')}</b></span><span class="badge">${doneToday}</span></button>${doneToday ? `<button class="disc" data-action="done-toggle" aria-expanded="${ui.doneOpen}" title="${t(ui.doneOpen ? 'side.doneHide' : 'side.doneShow')}" aria-label="${t(ui.doneOpen ? 'side.doneHide' : 'side.doneShow')}"><svg aria-hidden="true"><use href="#s-chev"/></svg></button>` : ''}</div>${doneToday && ui.doneOpen ? doneList(doneTasks) : ''}
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


/** Stop and Open on a sidebar Worker row, shown on hover (the row's context menu has them too). */
export function workerActs(w: Worker) {
  const btn = (action: string, icon: string, label: string) => `<button class="clear-x" data-action="${action}" data-id="${esc(w.id)}" title="${label}" aria-label="${esc(`${label}: ${w.id}`)}"><svg><use href="#${icon}"/></svg></button>`;
  const x = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
  return `<span class="row-acts">${canStop(w, x) ? btn('worker-stop', 's-stop', t('wk.stop')) : ''}${btn('open-worker', 's-chev', t('wk.open'))}</span>`;
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

/** An account's two rings on the 24×24 grid: 7d outside, 5h inside. */
export function ringsSvg(a: AccountView) {
  const arc = (v: number | null, r: number) => {
    const d = ringArc(v, r);
    return `<circle class="trk" cx="12" cy="12" r="${r}"/>${d ? `<circle class="${lv(v)}" cx="12" cy="12" r="${r}" stroke-dasharray="${d}"/>` : ''}`;
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${arc(a.sevenDay.utilization, RING.sevenDay)}${arc(a.fiveHour.utilization, RING.fiveHour)}</svg>`;
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
