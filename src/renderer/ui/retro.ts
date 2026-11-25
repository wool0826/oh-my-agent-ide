// The look back, inside a Worker's Summary tab (T-0108 option A): a switch between the Worker and the last seven
// days, a time line on each task card, the task's permission decisions, and the week's tiles and lists. The numbers
// come from shared/retro.ts; tasks are read through core's accessors.

import type { Task } from '../../shared/types';
import {
  filterPerms, lastWeek, percent, permissionRows, retroTotals, spanTasks, taskAt, taskTimes, totalMinutes,
  type PermFilter, type PermKind, type PermRow, type TaskTimes,
} from '../../shared/retro';
import { hasSpend, spendVars } from '../../shared/spend';
import type { Key } from '../../shared/i18n';
import { allTasks, esc, locale, pillTone, t, taskLabel, ui } from './core';
import { tookText } from './workers';

const dur = (mins: number) => tookText(Math.round(mins));

const PARTS = [['queue', 'q', 'sum.tlQueue'], ['run', 'r', 'sum.tlRun'], ['you', 'y', 'sum.tlYou'], ['dispatcher', 'p', 'sum.tlDispatcher']] as const;
const shown = (tm: TaskTimes) => PARTS.filter(([k]) => tm[k] > 0 || k === 'run');

/** The time line: one bar split by state, `width` percent of the row when given. */
function bar(tm: TaskTimes, width?: number) {
  const label = shown(tm).map(([k, , key]) => t(key, { t: dur(tm[k]) })).join(' · ');
  // Shares out of 1000: flex-grow below 1 in all would leave the bar part empty.
  const all = totalMinutes(tm) || 1;
  const parts = PARTS.filter(([k]) => tm[k] > 0).map(([k, c]) => `<i class="${c}" style="flex:${Math.max(1, Math.round((tm[k] / all) * 1000))}"></i>`).join('');
  return `<div class="tl"${width === undefined ? '' : ` style="width:${width.toFixed(1)}%"`} role="img" aria-label="${esc(label)}">${parts}</div>`;
}

const keyHtml = (tm: TaskTimes) => `<div class="tl-k">${shown(tm).map(([k, c, key]) => `<span><i class="${c}"></i>${esc(t(key, { t: dur(tm[k]) }))}</span>`).join('')}</div>`;

/** A task card's time line and its key; nothing for a task that never started. */
export function taskTimeHtml(x: Task) {
  const tm = taskTimes(x);
  return tm && totalMinutes(tm) > 0 ? `${bar(tm)}${keyHtml(tm)}` : '';
}

const KIND: Record<PermKind, [Key, string]> = {
  allow: ['sum.pAllow', 'success'], task: ['sum.pTask', 'success'], rule: ['sum.pRule', ''], deny: ['sum.pDeny', 'danger'], note: ['sum.pNote', 'danger'],
};
const time = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
/** Within the last seven days the weekday names the day. */
const dayTime = (iso: string) => new Date(iso).toLocaleString(locale(), { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** One permission decision: when, the action, the answer and how long it took. `short` leaves out the day and the task, for a task's own list. */
function permRow(r: PermRow, short: boolean) {
  const [label, tone] = KIND[r.kind];
  const who = short ? '' : `<small>${esc([r.workerId, `${r.taskId} ${r.title}`].filter(Boolean).join(' · '))}</small>`;
  return `<div class="prow"><span class="when">${esc(short ? time(r.at) : dayTime(r.at))}</span><span class="what"><code data-tip="${esc(r.code)}">${esc(r.code)}</code>${who}${r.note ? `<small>“${esc(r.note)}”</small>` : ''}</span><span class="ans"><span class="pill"${pillTone(tone)}>${t(label)}</span>${r.wait === null ? '' : `<small>${esc(tookText(r.wait))}</small>`}</span></div>`;
}

/** A task card's permission decisions, folded. */
export function taskPermsHtml(x: Task) {
  const rows = permissionRows([x]);
  if (!rows.length) return '';
  return `<details class="sum-ask sum-perms"><summary><svg aria-hidden="true"><use href="#s-chev"/></svg>${t('sum.permsN', { n: rows.length })}</summary><div class="perm-list">${rows.map((r) => permRow(r, true)).join('')}</div></details>`;
}

const stat = (label: string, value: string) => `<div class="sum-stat"><small>${esc(label)}</small><b>${esc(value) || '–'}</b></div>`;

/** The Worker's Time and Permissions tiles, after its others. */
export function workerRetroStats(tasks: readonly Task[]) {
  const tot = retroTotals(tasks, permissionRows(tasks));
  return stat(t('sum.time'), tot.run || tot.you ? t('sum.timeVal', { run: dur(tot.run), you: dur(tot.you) }) : '')
    + stat(t('sum.perms'), tot.allowed || tot.denied ? t('sum.permsVal', { a: tot.allowed, d: tot.denied }) : '');
}

/** The switch between the open Worker and the week, above everything else in the tab. */
export function scopeHtml(wid: string) {
  const b = (v: 'worker' | 'week', label: string) => `<button type="button" data-action="sum-scope" data-v="${v}" aria-pressed="${ui.sumScope === v}">${esc(label)}</button>`;
  return `<div class="seg-h"><span class="seg" role="group" aria-label="${t('sum.scope')}" id="sum-scope">${b('worker', wid)}${b('week', t('sum.week'))}</span></div>`;
}

const FILTERS: [PermFilter, Key][] = [['all', 'sum.fAll'], ['allowed', 'sum.fAllowed'], ['denied', 'sum.fDenied']];

/** The last seven days of every Worker: tiles, each task's time line, and the permission decisions with a filter. */
export function weekHtml() {
  const s = lastWeek();
  const tasks = spanTasks(allTasks(), s);
  const perms = permissionRows(allTasks(), s);
  const tot = retroTotals(tasks, perms);
  const tiles = [
    stat(t('sum.spend'), hasSpend(tot.spend) ? t('spend.cost', spendVars(tot.spend)) : ''),
    stat(t('sum.succeeded'), tot.finished ? t('sum.ofPct', { n: tot.succeeded, total: tot.finished, p: percent(tot.succeeded, tot.finished) }) : ''),
    stat(t('sum.ci'), tot.ciRetries ? t('sum.ciVal', { n: tot.ciRetries, k: tot.ciTasks }) : '0'),
    stat(t('sum.again'), tot.finished ? t('sum.ofPct', { n: tot.again, total: tot.finished, p: percent(tot.again, tot.finished) }) : ''),
    stat(t('sum.waitedYou'), tot.you ? dur(tot.you) : ''),
    stat(t('sum.perms'), t('sum.permsVal', { a: tot.allowed, d: tot.denied })),
  ].join('');
  const times = tasks.map((x) => taskTimes(x));
  const longest = Math.max(1, ...times.map((tm) => (tm ? totalMinutes(tm) : 0)));
  const rows = tasks.map((x, i) => {
    const tm = times[i];
    const meta = [x.workerId, dayTime(new Date(taskAt(x)).toISOString()), taskLabel(x)].filter(Boolean).join(' · ');
    return `<div class="trow" data-task="${esc(x.id)}"><span class="m"><b>${esc(x.id)} ${esc(x.title)}</b><small>${esc(meta)}</small></span><span class="bar">${tm ? bar(tm, (totalMinutes(tm) / longest) * 100) : ''}</span><span class="tot">${tm ? esc(dur(totalMinutes(tm))) : '–'}</span></div>`;
  }).join('');
  const shownPerms = filterPerms(perms, ui.permFilter);
  const seg = `<span class="seg" role="group" aria-label="${t('sum.perms')}" id="perm-filter">${FILTERS.map(([v, key]) => `<button type="button" data-action="perm-filter" data-v="${v}" aria-pressed="${ui.permFilter === v}">${t(key)}</button>`).join('')}</span>`;
  return `<div class="sum-stats">${tiles}</div>
    <div class="sec-h"><h5>${t('sum.weekTasks', { n: tasks.length })}</h5></div>
    <div class="group" id="week-tasks">${rows || `<div class="trow"><span class="m"><small>${t('none')}</small></span></div>`}</div>
    <div class="sec-h"><h5>${t('sum.weekPerms', { n: perms.length })}</h5>${seg}</div>
    <div class="group" id="week-perms">${shownPerms.map((r) => permRow(r, false)).join('') || `<div class="prow"><span class="when"></span><span class="what"><small>${t('none')}</small></span></div>`}</div>`;
}
