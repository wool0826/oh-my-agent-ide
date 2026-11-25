// The Worker view: the list, a conversation with its Changes and Summary tabs, the inspector, and cancelling queued tasks.
import type { DiffView, LogPage, Task, Worker, WorkerLogItem } from '../../shared/types';
import { type Key } from '../../shared/i18n';
import { hasSpend, spendVars } from '../../shared/spend';
import { cancelSet, followersOf, holdsWorktree, isQueued, statusAfterCancel, type CancelReport } from '../../shared/queue';
import { overlapLine } from '../../shared/overlap';
import { queueLine, queueWhy, type QueueCtx } from '../../shared/queueWhy';
import { patchLines } from '../../shared/diffComment';
import { lastLines } from '../../shared/runOutput';
import type { Checkpoint } from '../../shared/checkpoints';
import { taskMinutes, workerTotals } from '../../shared/workerSummary';
import { scopeHtml, taskPermsHtml, taskTimeHtml, weekHtml, workerRetroStats } from './retro';
import { composerAnswers, workerDecisions } from '../../shared/inbox';
import { canStop } from '../../shared/canStop';
import { ALLOW, DENY } from '../../shared/types';
import { COMPACT_AT, CONTEXT_WINDOW } from '../../shared/context';
import { stepView, type StepView } from '../../shared/steps';
import { askLine, plainStatus, stateCounts, workerLine, workerState, type WorkerState } from '../../shared/workerState';
import { PAGE, threadStart } from '../../shared/paging';
import { type WorkerFilter } from '../../shared/history';
import { act } from '../app';
import { decisionHint, decisionHtml, olderChat, prBadges, reportLinkHtml, resultLinks, spendHtml, tickDecisions, updateSendButton } from './chat';
import { linkUrl, linkify, reportLinks, shortUrls } from '../../shared/linkify';
import { openPop } from './controls';
import { layerClose, layerOpen } from './layer';
import { shotsOf } from './shotview';
import { $, acctLabel, ago, agoText, base, call, errText, esc, finishedToday, hhmm, ic, ide, inline, k, keepInputs, keepScroll, lang, markLoading, md, modelLabel, NEW_FROM, olderBtn, oneLine, paged, pillTone, markReplyTarget, prNum, queuedLabel, renderReply, replyable, ring, S, setThread, skel, sym, t, task, taskLabel, toast, ui, unmarkLoading, userText, watchTop, when, worker } from './core';
import { go, show } from './history';
import { grantsHtml } from './repos';
import { ms, workerIcon } from './sidebar';

const lastTask = (w: Worker) => (w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null);

/**
 * The pill of a Worker: its state in a word, with how long beside it, outside the pill (shared/workerState.ts). The
 * list and the inspector header share it, so a queued Worker reads "Queued" in both and a failed one is never "Idle".
 */
export function statusPill(w: Worker) {
  const x = lastTask(w);
  const pill = (tn: string, label: string, age = '') => `<span class="pstat"><span class="pill"${pillTone(tn)}>${esc(label)}</span>${age ? `<span class="age">${esc(age)}</span>` : ''}</span>`;
  switch (workerState(w, x)) {
    case 'run': return pill('accent', t(w.status === 'starting' ? 'st.starting' : 'st.running'), x ? ago(x.updatedAt) : '');
    case 'ask': return pill('ask', t('st.waitingMe'), x ? ago(x.waitingSince ?? x.updatedAt) : '');
    case 'stalled': return pill('warning', t('st.stalled'), ago(w.lastActiveAt));
    case 'failed': return pill('danger', t('st.failed'), agoText(x?.updatedAt ?? w.lastActiveAt));
    case 'asked': return pill('warning', t('st.awaitDispatcher'), w.request ? ago(w.request.at) : '');
    case 'queued': return pill('warning', t(x?.status === 'blocked' ? 'st.afterMerge' : 'st.queued'));
    case 'pr': return pill('pr-open', t('st.prOpen'), x?.finishedAt ? agoText(x.finishedAt) : '');
    case 'done': return pill('', t('task.done'), agoText(x?.finishedAt ?? w.lastActiveAt));
    case 'stopped': return pill('', t('task.stopped'), agoText(x?.updatedAt ?? w.lastActiveAt));
    case 'archived': return pill('', t('st.archived'));
    default: return pill('', t('st.idle'), agoText(w.lastActiveAt));
  }
}

/**
 * A plan as pips before a row's sentence: done, current, to do. The current one pulses only while the Worker runs, and
 * is red where it stopped. The words beside it say the same, so it is hidden from screen readers.
 */
export function pipsHtml(v: StepView, look: '' | 'err' | 'still' = '') {
  const pip = (i: number) => (i < v.at ? ' class="d"' : i === v.at ? ' class="c"' : '');
  return `<span class="pips${look ? ` ${look}` : ''}" aria-hidden="true">${Array.from({ length: v.total }, (_, i) => `<i${pip(i)}></i>`).join('')}</span>`;
}

/** The Workers a list filter keeps: ones with a task finished today, or archived ones. */
export function filterWorkers(ws: Worker[], f: WorkerFilter | null) {
  if (f === 'archived') return ws.filter((w) => w.status === 'archived');
  if (f === 'today') {
    const ids = new Set(S!.tasks.filter(finishedToday).map((x) => x.workerId));
    return ws.filter((w) => ids.has(w.id));
  }
  return ws;
}

export function renderWorkerList() {
  const s = S!;
  const root = $('#wk-list');
  const f = ui.wFilter;
  const shown = filterWorkers(s.workers, f);
  const active = shown.filter((w) => w.status !== 'archived');
  const arch = shown.filter((w) => w.status === 'archived');
  const stateOf = (w: Worker) => workerState(w, lastTask(w));
  // Who needs the user comes first, then what stopped, then what runs.
  const rank: Record<WorkerState, number> = { ask: 0, stalled: 1, failed: 1, run: 2, asked: 3, queued: 3, pr: 4, done: 4, stopped: 4, idle: 4, archived: 5 };
  const order = (w: Worker) => rank[stateOf(w)];
  const qctx = queueCtx();
  // Queued Workers are in the order they will start; ones held by something else come after them.
  const place = (w: Worker) => { const x = lastTask(w); return (stateOf(w) === 'queued' && x ? queueLine(t, x, qctx)?.pos : null) ?? Infinity; };
  const byPlace = (a: Worker, b: Worker) => { const pa = place(a), pb = place(b); return pa === pb ? 0 : pa < pb ? -1 : 1; };
  active.sort((a, b) => order(a) - order(b) || byPlace(a, b) || b.lastActiveAt.localeCompare(a.lastActiveAt));
  arch.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  const li = (w: Worker) => {
    const x = lastTask(w);
    const st = stateOf(w);
    const dec = st === 'ask' ? workerDecisions(s.decisions, w.id)[0] : null;
    const about = [w.repo ?? t('general'), modelLabel(w.model), w.accountId && s.accounts.some((a) => a.id === w.accountId) ? acctLabel(w.accountId) : ''].filter(Boolean).join(', ');
    // The second line is the most useful sentence for the state: what it asks, the step it is on, why it stopped, what
    // starts it, or what it reported. A state with no news shows the repository and model.
    const line = workerLine(t, w, x, { ask: dec ? oneLine(askLine(dec), 140) : null, queue: st === 'queued' && x ? queueLine(t, x, qctx)?.text : null, about });
    // "W-id · repository · state", as the sidebar and the chat write it.
    // A finished result names the links its report gave, by their short names: the row is a button and holds no links.
    const extra = (st === 'pr' || st === 'done') ? (x?.links ?? []).filter((l) => !line.text.includes(linkUrl(l))) : [];
    const said = extra.length ? `${line.text} · ${extra.join(' ')}` : line.text;
    const text = said === about ? `${w.id} · ${about}` : [w.id, w.repo ?? t('general'), said].filter(Boolean).join(' · ');
    // The context is shown once it matters: from half the window, and in orange from where it is compacted.
    const ctx = st !== 'archived' && w.contextTokens >= CONTEXT_WINDOW / 2
      ? `<span class="ctxm${w.contextTokens >= COMPACT_AT ? ' warn' : ''}" data-tip="${esc(`${t('kv.context')} ${k(w.contextTokens)} / ${k(CONTEXT_WINDOW)}`)}">${ring(w.contextTokens / CONTEXT_WINDOW)}${k(w.contextTokens)}</span>` : '';
    // The row's own button and Continue are side by side, not one inside the other (L14).
    const more = st === 'failed' ? `<button type="button" class="btn" data-action="worker-continue" data-id="${esc(w.id)}" aria-label="${esc(t('wk.continueWho', { id: w.id }))}">${t('wk.continue')}</button>` : '';
    return `<div class="li wrow${ui.wSel === w.id ? ' sel' : ''}${st === 'archived' ? ' dim' : ''}"><div tabindex="0" role="button" class="li-main" data-action="select-worker" data-id="${w.id}">${workerIcon(w)}
      <span class="m"><b>${esc(w.id)} ${esc(x?.title ?? w.title)}</b><span class="l2${st === 'failed' ? ' err' : ''}">${line.steps ? pipsHtml(line.steps, st === 'failed' ? 'err' : st === 'run' ? '' : 'still') : ''}<span class="tx">${esc(oneLine(shortUrls(text, t('link.artifact')), 200))}</span></span></span>
      <span class="r">${ctx}${statusPill(w)}</span></div>${more}</div>`;
  };
  // The heading counts states, not Workers: how many need the user comes first.
  const countsText = () => {
    const c = stateCounts(active.map(stateOf));
    const parts = [c.ask ? t('wk.nAsk', { n: c.ask }) : '', c.run ? t('wk.nRun', { n: c.run }) : '', c.failed ? t('wk.nFailed', { n: c.failed }) : '', c.stalled ? t('wk.nStalled', { n: c.stalled }) : '', c.queued ? t('wk.nQueued', { n: c.queued }) : '', c.done ? t('wk.nDone', { n: c.done }) : ''].filter(Boolean);
    return parts.length ? parts.join(' · ') : t('wk.counts', { a: active.length, b: arch.length });
  };
  if (!s.workers.length) {
    root.innerHTML = `<div class="vhead"><b role="heading" aria-level="1">Worker</b></div><div class="empty-view">${sym('s-cpu')}<b>${t('wk.emptyTitle')}</b></div>`;
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
      const head = `<div class="vhead"><b role="heading" aria-level="1">Worker</b><span class="wf"><span class="wf-chip">${ic(f === 'today' ? 'done' : 'arch')}${label}<small>${shown.length}</small></span><button type="button" class="linkbtn wf-all" data-action="worker-filter" data-v="">${t('wk.filterAll')}</button></span></div>`;
      root.innerHTML = shown.length
        ? `${head}${lst}${active.map(li).join('')}${arch.length && active.length ? `<div class="lst-h">${t('st.archived')}</div>` : ''}${archLis}</div>`
        : `${head}<div class="empty-view">${sym(f === 'today' ? 's-check' : 's-arch')}<b>${t(f === 'today' ? 'wk.noneToday' : 'wk.noneArchived')}</b></div>`;
      return;
    }
    root.innerHTML = `<div class="vhead"><b role="heading" aria-level="1">Worker</b><small>${esc(countsText())}</small></div>
    ${lst}${active.map(li).join('')}${arch.length ? `<div class="lst-h">${t('st.archived')}</div>${archLis}` : ''}</div>`;
  });
}

/** A Worker's final report starts with RESULT:/PR:/FILE: lines; show them as a result header instead of raw protocol. */
export function workerReport(text: string) {
  const lines = text.split('\n');
  const head: string[] = [];
  let i = 0;
  while (i < lines.length && (/^(RESULT|PR|FILE|LINK):/i.test(lines[i].trim()) || (head.length && !lines[i].trim()))) { if (lines[i].trim()) head.push(lines[i].trim()); i++; }
  if (!head.some((l) => /^RESULT:/i.test(l))) return md(text);
  const val = (l: string) => l.slice(l.indexOf(':') + 1).trim().replace(/^`|`$/g, '');
  const summary = val(head.find((l) => /^RESULT:/i.test(l))!);
  const pr = head.filter((l) => /^PR:/i.test(l)).map(val).map((v) => v.match(/https?:\/\/\S+\/pull\/\d+/)?.[0]).find(Boolean);
  // Image files show as before/after thumbnails under the header; the rest stay file links.
  const shots = shotsOf(head.filter((l) => /^FILE:/i.test(l)).map(val).filter((v) => v && !/^https?:\/\//i.test(v)));
  const files = shots.rest;
  // LINK: lines, and a URL a FILE: line gave instead of a path, open in the browser.
  const urls = reportLinks(head.filter((l) => /^(LINK|FILE):/i.test(l)).join('\n'), [pr]);
  const links = [
    pr ? `<a tabindex="0" role="link" data-action="open-url" data-href="${esc(pr)}">${sym('s-pr')}PR #${prNum(pr)}</a>` : '',
    ...urls.map(reportLinkHtml),
    ...files.map((f) => `<a tabindex="0" role="link" data-action="open-file" data-path="${esc(f)}" data-tip="${esc(f)}">${sym('s-doc')}${esc(base(f))}</a>`),
  ].filter(Boolean).join('');
  const rest = lines.slice(i).join('\n').trim();
  const title = inline(summary);
  return `<div class="rep-h"><b>${title}</b>${links ? `<span class="rep-l">${links}</span>` : ''}${shots.html}</div>${rest ? md(rest) : ''}`;
}

export function logItemHtml(it: WorkerLogItem, wid: string, prev: WorkerLogItem | null) {
  switch (it.from) {
    case 'dispatcher': return `${prev?.from === 'dispatcher' ? '' : '<span class="who">Dispatcher</span>'}${replyable(`<div class="bub ai">${md(it.text)}</div>`, 'ws', 'Dispatcher', it.text, undefined, `log:${it.ts}`)}`;
    case 'worker': return `${prev?.from === 'worker' ? '' : `<span class="who">${esc(wid)}</span>`}${replyable(`<div class="bub wk">${workerReport(it.text)}</div>`, 'ws', wid, it.text, undefined, `log:${it.ts}`)}`;
    case 'user': return `<div class="bub me">${userText(it.text)}</div>`;
    case 'auto': return `<span class="event self">${sym('s-check', 'c-green')}<span>${esc(it.text)}</span></span>`;
    default: return `<span class="event">${sym('s-cpu', 'c-blue')}<span>${linkify(esc(it.text))}</span></span>`;
  }
}

/** `older`: a page of the conversation went in above, so the reader's place is kept from the end. */
export function renderSession(force = false, older = false) {
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
  $('#ws-tabs').innerHTML = tabs.map((v) => `<button type="button" role="tab" id="ws-tab-${v}" aria-controls="${v === 'chat' ? 'ws-thread' : v === 'changes' ? 'ws-diff' : 'ws-sum'}" aria-selected="${ui.wTab === v}" tabindex="${ui.wTab === v ? 0 : -1}" data-action="ws-tab" data-v="${v}">${t(v === 'chat' ? 'ws.tabChat' : v === 'changes' ? 'ws.tabChanges' : 'ws.tabSummary')}</button>`).join('');
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
  markReplyTarget('ws');
  watchTop(th, () => { if (ui.wSel) void olderLog(ui.wSel); });
}

/** A file's diff. Each line takes a click to comment on it; the comments and the one being written sit under their lines. */
export function diffLines(wid: string, path: string, patch: string) {
  const key = esc(`${wid}:${path}`);
  const notes = (ui.diffNotes.get(wid) ?? []).filter((n) => n.path === path);
  const draft = ui.diffDraft?.wid === wid && ui.diffDraft.path === path ? ui.diffDraft.at : -1;
  return patchLines(patch).map((l, i) => {
    const c = l.kind === 'ctx' ? '' : l.kind;
    const line = l.kind === 'h'
      ? `<span class="dl h">${esc(l.text) || ' '}</span>`
      : `<span class="dl ${c} can" role="button" tabindex="0" data-action="diff-note" data-id="${key}" data-i="${i}" data-tip="${t('diff.note')}">${esc(l.text) || ' '}</span>`;
    const said = notes.filter((n) => n.at === i).map((n) => `<div class="dnote"><p>${esc(n.text)}</p><button class="btn btn-icon btn-sm clear-x" data-action="diff-note-del" data-id="${key}" data-i="${i}" data-tip="${t('diff.noteDel')}" aria-label="${t('diff.noteDel')}"><svg><use href="#s-x"/></svg></button></div>`).join('');
    const box = draft === i ? `<div class="dnote edit"><textarea class="inp" id="dnote-in" data-keep="dnote-${key}-${i}" data-enter="diff-note-add" placeholder="${t('diff.note')}" aria-label="${t('diff.note')}"></textarea><div class="btns"><button class="btn" data-action="diff-note-cancel">${t('cancel')}</button><button class="btn btn-primary" data-action="diff-note-add">${t('diff.noteAdd')}</button></div></div>` : '';
    return line + said + box;
  }).join('');
}

/** "12m", "1h 5m": how long something took. */
export function tookText(mins: number) {
  if (mins < 60) return t('time.min', { n: Math.max(1, mins) });
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${t('time.hour', { n: h })} ${t('time.min', { n: m })}` : t('time.hour', { n: h });
}

/**
 * The Summary tab: what the Worker has done without reading its conversation. Totals first (tasks, PRs, files,
 * spend, time, permissions), then each task, newest first: where its time went, what was asked, where it stands, its
 * report in full, its PR and files, its permission decisions. A switch above turns it to the last seven days (ui/retro.ts).
 */
export function renderSummary(w: Worker) {
  const root = $('#ws-sum');
  const scope = scopeHtml(w.id);
  if (ui.sumScope === 'week') { keepScroll(root, () => { root.innerHTML = `${scope}${weekHtml()}`; }); return; }
  const tasks = w.taskIds.map((id) => task(id)).filter((x): x is Task => !!x);
  if (!tasks.length) { root.innerHTML = `${scope}<div class="empty-view"><b>${t('sum.none')}</b></div>`; return; }
  const tot = workerTotals(tasks);
  const stat = (label: string, parts: string[]) => `<div class="sum-stat"><small>${label}</small><b>${parts.filter(Boolean).join(' · ') || '–'}</b></div>`;
  const stats = [
    stat(t('sum.tasks'), [tot.done ? t('sum.done', { n: tot.done }) : '', tot.open ? t('sum.open', { n: tot.open }) : '', tot.failed ? t('sum.failed', { n: tot.failed }) : '']),
    stat(t('sum.prs'), [tot.prsOpen ? t('sum.prOpen', { n: tot.prsOpen }) : '', tot.prsMerged ? t('sum.prMerged', { n: tot.prsMerged }) : '']),
    stat(t('sum.files'), [tot.files ? String(tot.files) : '']),
    stat(t('sum.spend'), [hasSpend(tot.spend) ? t('spend.cost', spendVars(tot.spend)) : '']),
  ].join('') + workerRetroStats(tasks);
  const cards = tasks.slice().reverse().map((x) => {
    const mins = taskMinutes(x);
    const sv = stepView(x);
    const meta = [x.finishedAt ? hhmm(x.finishedAt) : x.startedAt ? hhmm(x.startedAt) : '', mins !== null ? t('sum.took', { t: tookText(mins) }) : '', sv ? t('sum.steps', { done: sv.done, total: sv.total }) : ''].filter(Boolean).join(' · ');
    const links = resultLinks(x);
    const tn = x.status === 'failed' && !x.stopped ? 'danger' : x.status === 'running' ? 'accent' : x.status === 'pr_open' ? 'pr-open' : x.status === 'done' ? 'success' : '';
    return `<article class="sum-task" data-task="${esc(x.id)}">
      <header><b>${esc(x.id)} ${esc(x.title)}</b><span class="pill"${pillTone(tn)}>${taskLabel(x)}</span></header>
      ${meta ? `<small class="sum-meta">${esc(meta)}</small>` : ''}
      ${taskTimeHtml(x)}
      <details class="sum-ask"><summary><svg aria-hidden="true"><use href="#s-chev"/></svg>${t('sum.asked')}</summary><div class="sum-prompt">${esc(x.prompt.trim())}</div></details>
      ${x.summary ? `<div class="sum-report">${md(x.summary)}</div>` : ''}
      ${links.length ? `<div class="sum-links">${links.join('')}</div>` : ''}
      ${taskPermsHtml(x)}
      ${spendHtml(x.spend)}
    </article>`;
  }).join('');
  // Folds stay open over a re-render: each by its task and its place on the card.
  const foldKey = (d: HTMLDetailsElement) => { const a = d.closest('article'); return `${a?.dataset.task}:${a ? [...a.querySelectorAll('details')].indexOf(d) : -1}`; };
  keepScroll(root, () => {
    const open = new Set([...root.querySelectorAll<HTMLDetailsElement>('details[open]')].map(foldKey));
    root.innerHTML = `${scope}<div class="sum-stats">${stats}</div>${cards}`;
    root.querySelectorAll<HTMLDetailsElement>('details').forEach((d) => { if (open.has(foldKey(d))) d.open = true; });
  });
}

/** "Put the files back to 14:02?" under the Changes tab's header, once a checkpoint is picked. */
export function ckptAskHtml(w: Worker) {
  const a = ui.ckptAsk;
  if (!a || a.wid !== w.id) return '';
  return `<div class="ckpt-ask" role="alertdialog" aria-label="${t('ckpt.title')}"><span><b>${esc(t('ckpt.ask', { t: hhmm(a.at) }))}</b><small>${esc(a.label)}</small></span><button class="btn" data-action="ckpt-cancel">${t('cancel')}</button><button class="btn btn-danger-fill" data-action="ckpt-restore">${t('ckpt.restore')}</button></div>`;
}

/** The Worker's checkpoints as a list under the button: picking one asks before anything changes. */
export async function openCheckpoints(owner: HTMLElement, wid: string) {
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
export function addDiffNote() {
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

export function renderDiff(w: Worker) {
  const root = $('#ws-diff');
  const v = ui.diffs.get(w.id);
  if (v === undefined) { void loadDiff(w.id); }
  if (v === undefined || v === 'loading') { root.innerHTML = `<div class="skel-list" role="status" aria-label="${t('diff.loading')}">${skel(3, 'file')}</div>`; return; }
  if (v === null) { root.innerHTML = `<div class="empty-view"><span>${t('diff.noRepo')}</span></div>`; return; }
  if (v.error === 'missing') { root.innerHTML = `<div class="empty-view"><span>${t('diff.missing')}</span></div>`; return; }
  // Any other failure says what went wrong, with a way to ask again (L17).
  if (v.error) { root.innerHTML = `<div class="empty-view" role="alert"><span>${esc(t('diff.failed', { msg: v.error }))}</span><button class="btn" data-action="diff-refresh" data-id="${w.id}">${t('retry')}</button></div>`; return; }
  const add = v.files.reduce((n, f) => n + f.added, 0), del = v.files.reduce((n, f) => n + f.removed, 0);
  const nNotes = ui.diffNotes.get(w.id)?.length ?? 0;
  const head = `<div class="diff-h"><span class="br">${esc(v.branch || 'HEAD')} <small>→ ${esc(v.base)}</small></span><span class="sum">${t('diff.files', { n: v.files.length })} <b class="plus">+${add}</b> <b class="minus">−${del}</b></span>${nNotes ? `<button class="btn btn-primary" data-action="diff-notes-send">${t('diff.noteSend', { n: nNotes })}</button>` : ''}<button class="btn" data-action="ckpt-menu" data-id="${w.id}" aria-haspopup="listbox">${t('ckpt.title')}</button><button class="btn" data-action="diff-refresh" data-id="${w.id}">${t('diff.refresh')}</button></div>`;
  if (!v.files.length) { root.innerHTML = `${head}${ckptAskHtml(w)}<div class="empty-view"><span>${t('diff.none', { base: v.base })}</span></div>`; return; }
  const files = v.files.map((f) => {
    const key = `${w.id}:${f.path}`;
    const open = ui.diffOpen.has(key);
    const st = f.status === '?' ? 'A' : f.status;
    return `<div class="df${open ? ' open' : ''}">
      <button class="df-h" data-action="diff-file" data-id="${esc(key)}" aria-expanded="${open}"><svg class="chev" aria-hidden="true"><use href="#s-chev"/></svg><span class="st st-${st}">${st}</span><span class="p">${esc(f.path)}</span>${f.status === '?' ? `<small>${t('diff.untracked')}</small>` : ''}<span class="n"><b class="plus">+${f.added}</b> <b class="minus">−${f.removed}</b></span></button>
      ${open ? `<pre class="df-b" data-scroll="diff-${esc(key)}">${f.patch ? diffLines(w.id, f.path, f.patch) : `<span class="dl h">${t('diff.binary')}</span>`}</pre>` : ''}
    </div>`;
  }).join('');
  keepInputs(root, () => { root.innerHTML = `${head}${ckptAskHtml(w)}${v.truncated ? `<div class="diff-note">${t('diff.truncated')}</div>` : ''}<div class="dfs">${files}</div>`; });
}

export async function loadDiff(id: string) {
  if (ui.diffs.get(id) === 'loading') return;
  ui.diffs.set(id, 'loading');
  try {
    ui.diffs.set(id, (await ide.call<DiffView | null>('worker:diff', id)) ?? null);
  } catch (e) {
    // Kept as an error, not as "no repository" (L17).
    ui.diffs.set(id, { base: '', branch: '', files: [], truncated: false, error: errText(e) || 'error' });
  }
  const w = worker(id);
  if (w && ui.wSel === id && ui.wTab === 'changes') renderDiff(w);
}

/** A Worker's conversation opens on its last page. */
export async function loadLog(id: string) {
  const r = await call<LogPage>('worker:log', id, { limit: PAGE.log });
  if (r) { ui.logs.set(id, r.items); ui.logFrom.set(id, r.start); }
  renderSession(true);
}

/** Load the page of a Worker's conversation before the first one loaded. */
export async function olderLog(id: string) {
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
export function queueCtx(): QueueCtx {
  return { tasks: S!.tasks, accounts: S!.accounts, maxWorkers: S!.settings.maxWorkers, time: (ms) => hhmm(new Date(ms).toISOString()) };
}

/** One card per queued or blocked task of the Worker: why it waits, what starts it, its request and the tasks waiting on it. */
export function waitingCardsHtml(w: Worker) {
  const ctx = queueCtx();
  return w.taskIds.map((id) => task(id)).filter((x): x is Task => !!x && isQueued(x)).map((x) => {
    const q = queueWhy(t, x, ctx);
    if (!q) return '';
    // When it entered the queue; later updates of the task do not move it (L13).
    const since = x.queuedSince ?? x.updatedAt;
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
    return `<div class="ins-h"><b role="heading" aria-level="2">${t('q.title')}</b><span class="pill" data-tone="warning">${x.status === 'blocked' ? t('st.afterMerge') : queuedLabel(x)}</span></div>
    <div class="group qcard">
      <div class="mini"><b>${esc(x.id)} ${esc(x.title)}</b><span>${esc([x.repo ?? t('general'), x.planFirst && !x.planApproved ? t('plan.badge') : ''].filter(Boolean).join(' · '))} · <time datetime="${esc(since)}" data-tip="${esc(hhmm(since))}">${t('q.since', { t: Date.now() - Date.parse(since) < 60_000 ? t('time.now') : t('time.ago', { d: ago(since) }) })}</time></span></div>
      <dl class="plan-sum q-sum"><dt>${t('q.why')}</dt><dd>${esc(q.why)}</dd><dt>${t('q.starts')}</dt><dd${q.cancelled ? ' class="warn"' : ''}>${esc(q.starts)}</dd>${q.again ? `<dt></dt><dd>${esc(q.again)}</dd>` : ''}</dl>
      ${prompt ? `<div class="q-prompt${long && !open ? ' clip' : ''}" data-scroll="qp-${esc(x.id)}"><small>${t('q.prompt')}</small>${esc(prompt)}</div>` : ''}
      ${follow ? `<div class="q-follow"><small>${t('q.followers')}</small>${follow}</div>` : ''}
      <div class="plan-links q-links">${links}</div>
    </div>`;
  }).join('');
}

/** The repository's run command in this Worker's worktree: start and stop it, the address it printed, and the end of its output. */
export function runHtml(w: Worker) {
  const repo = w.repo ? S!.repos.find((r) => r.name === w.repo) : null;
  if (!repo?.run?.trim() || w.status === 'archived') return '';
  const r = S!.runs.find((x) => x.workerId === w.id);
  const state = !r ? '' : r.running ? `<span class="pill" data-tone="accent">${t('run.running')}</span>` : r.stopped ? `<span class="pill">${t('run.stopped')}</span>` : `<span class="pill"${pillTone(r.code ? 'danger' : '')}>${t('run.exited', { code: r.code ?? '' })}</span>`;
  const btns = r?.running
    ? `<button class="btn" data-action="run-stop" data-id="${w.id}">${t('run.stop')}</button>`
    : `${r ? `<button class="btn" data-action="run-clear" data-id="${w.id}">${t('run.clear')}</button>` : ''}<button class="btn" data-action="run-start" data-id="${w.id}">${t(r ? 'run.again' : 'run.start')}</button>`;
  const url = r?.url && r.running ? `<a class="run-url" tabindex="0" role="link" data-action="open-url" data-href="${esc(r.url)}">${esc(r.url)}</a>` : '';
  const out = r?.tail.trim() ? `<pre class="run-out" data-scroll="run-${w.id}">${esc(lastLines(r.tail, 14))}</pre>` : '';
  return `<div class="ins-h"><b role="heading" aria-level="2">${t('run.title')}</b>${state}</div>
    <div class="group run"><code class="run-cmd" data-tip="${esc(repo.run)}">${esc(oneLine(repo.run, 80))}</code>${url}${out}<div class="ins-act">${btns}</div></div>`;
}

/**
 * The strip above the Worker composer while a decision is open (M7): the question or plan the text answers, with a
 * way to send a normal message instead. A permission is never answered by text: the strip offers Deny and Allow.
 */
export function renderComposerDecision() {
  const el = $('#ws-dec');
  const inp = $<HTMLTextAreaElement>('#ws-input');
  const w = worker(ui.wSel);
  const pending = new Set(S!.decisions.filter((d) => d.status === 'pending').map((d) => d.id));
  for (const id of [...ui.decSeen]) if (!pending.has(id)) { ui.decSeen.delete(id); ui.decAsMessage.delete(id); }
  const open = w ? workerDecisions(S!.decisions, w.id) : [];
  // One that comes while something is being typed does not take that text over: it starts as a normal message.
  for (const d of open) {
    if (ui.decSeen.has(d.id)) continue;
    ui.decSeen.add(d.id);
    if (inp.value.trim()) ui.decAsMessage.add(d.id);
  }
  const target = composerAnswers(open, ui.decAsMessage);
  // Enter answers the one named here, not whichever comes first by then.
  ui.decShown = w && target ? { wid: w.id, id: target.id } : null;
  const skipped = target ? null : open.find((d) => d.source !== 'permission') ?? null;
  const perm = open.find((d) => d.source === 'permission') ?? null;
  const q = (d: (typeof open)[number]) => esc(oneLine(d.summary?.what || d.title, 90));
  let html = '';
  let cls = 'cstrip';
  if (target) {
    cls += ' answers';
    html = `${sym(target.source === 'plan' ? 's-doc' : 's-chat', target.source === 'plan' ? 'c-blue' : 'c-orange')}<span>${t('dec.answers', { q: q(target) })}</span><button type="button" class="linkbtn" data-action="dec-as-message" data-id="${esc(target.id)}">${t('dec.asMessage')}</button>`;
  } else if (skipped) {
    html = `${sym('s-chat', 'c-gray')}<span>${t('dec.openNote', { q: q(skipped) })}</span><button type="button" class="linkbtn" data-action="dec-answer-it" data-id="${esc(skipped.id)}">${t('dec.answerIt')}</button>`;
  } else if (perm) {
    // The command itself, on one line: the right sidebar with its card may be hidden or narrow.
    const what = perm.code ? oneLine(perm.code.split('\n')[0], 300) : '';
    const label = what ? `<span class="cs-lbl">${t('dec.permShort')}</span><code>${esc(what)}</code>` : `<span>${t('dec.permWaits', { q: q(perm) })}</span>`;
    html = `${sym(perm.code?.startsWith('$ ') ? 's-term' : 's-edit', 'c-gray')}${label}<button type="button" class="linkbtn" data-action="answer" data-id="${esc(perm.id)}" data-val="${DENY}">${t('deny')}</button><button type="button" class="linkbtn" data-action="answer" data-id="${esc(perm.id)}" data-val="${ALLOW}">${t('allow')}</button>${perm.purpose ? `<span class="cs-why">${esc(oneLine(perm.purpose, 240))}</span>` : ''}`;
  }
  if (el.innerHTML !== html) el.innerHTML = html;
  if (el.className !== cls) el.className = cls;
  el.hidden = !html;
  // The hint says how the text answers; with a normal message there is none.
  const ph = target ? decisionHint(target) : '';
  if (inp.placeholder !== ph) inp.placeholder = ph;
  updateSendButton();
}

/**
 * The plan its Worker declared for the task, every step with its label: done ones ticked, the current one marked,
 * and a cross on the step it stopped at. The sidebar shows a window on the same plan (sidebar.ts, stepperHtml).
 */
export function planCardHtml(x: Task | null | undefined, failed = false) {
  const v = stepView(x);
  if (!x || !v) return '';
  const mark = { done: t('plan.stepDone'), cur: t('plan.stepNow'), err: t('plan.stepStopped'), todo: '' };
  const glyph = { done: '<svg viewBox="0 0 10 10"><path d="M1.8 5.3l2.1 2.1 4.2-4.6"/></svg>', err: '<svg viewBox="0 0 10 10"><path d="M2.4 2.4l5.2 5.2M7.6 2.4l-5.2 5.2"/></svg>', cur: '', todo: '' };
  const rows = (x.steps ?? []).map((s, i) => {
    const st = s.doneAt ? 'done' : i !== v.at ? 'todo' : failed ? 'err' : 'cur';
    return `<li class="${st}"><i aria-hidden="true">${glyph[st]}</i><span>${esc(s.title)}</span>${mark[st] ? `<span class="sr-only">${mark[st]}</span>` : ''}</li>`;
  }).join('');
  return `<div class="ins-h"><b role="heading" aria-level="2">${t('plan.steps')}</b><small>${t('sum.steps', { done: v.done, total: v.total })}</small></div>
    <ol class="group plan-steps">${rows}</ol>`;
}

export function renderWorkerInspector() {
  const root = $('#wk-ins');
  const w = worker(ui.wSel);
  if (!w) {
    root.innerHTML = `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-cpu"/></svg><b>${t('wk.pickTitle')}</b></div>`;
    return;
  }
  const tasks = w.taskIds.map((id) => task(id)).filter(Boolean).reverse() as Task[];
  const cur = tasks[0];
  const open = workerDecisions(S!.decisions, w.id);
  renderComposerDecision();
  const failed = workerState(w, cur) === 'failed';
  // What stopped it, in words: the sidebar row has it only as a tooltip.
  const failText = failed ? plainStatus(w.status === 'error' ? w.statusText || cur?.summary : cur?.summary).split('\n')[0].trim() : '';
  keepScroll(root, () => { root.innerHTML = `
    ${open.length ? `<div class="ins-h"><b role="heading" aria-level="2">${t('ins.decisions')}</b><span class="count">${open.length}</span></div><div class="group">${open.map((d) => decisionHtml(d, true)).join('')}</div>` : ''}
    <div class="ins-h"><b role="heading" aria-level="2">${esc(w.id)}</b>${statusPill(w)}</div>
    ${waitingCardsHtml(w)}
    ${planCardHtml(cur, failed)}
    <div class="group kv">
      <span>${t('kv.task')}</span><span>${esc(cur?.title ?? w.title)}</span>
      <span>${t('kv.repo')}</span><span>${esc(w.repo ?? t('general'))}</span>
      ${cur?.branch ? `<span>${t('kv.branch')}</span><span>${esc(cur.branch)}</span>` : ''}
      ${cur?.status === 'blocked' ? `<span>${t('kv.startsAfter')}</span><span>${esc(cur.afterTaskId ?? '')} ${t('pr.merged')}</span>` : ''}
      ${cur && overlapLine(cur) ? `<span>${t('kv.overlap')}</span><span class="warn" data-tip="${esc(cur.overlaps!.map((o) => `${o.taskId}: ${o.files.join(', ')}`).join('\n'))}">${esc(overlapLine(cur))}</span>` : ''}
      <span>${t('kv.folder')}</span><span><a tabindex="0" role="link" data-action="reveal" data-path="${esc(w.cwd)}" data-tip="${esc(w.cwd)}">${esc(base(w.cwd))}</a></span>
      <span>${t('kv.model')}</span><span>${modelLabel(w.model)} · ${t(`effort.${(S!.settings.effortPerTask && cur?.effort) || S!.settings.workerEffort}` as Key)}</span>
      <span>${t('kv.account')}</span><span>${esc(acctLabel(w.accountId))}</span>
      <span>${t('kv.context')}</span><span>${k(w.contextTokens)} / ${k(CONTEXT_WINDOW)}</span>
      ${failText ? `<span>${t('kv.error')}</span><span class="err">${esc(oneLine(failText, 200))}</span>` : ''}
      ${!failText && w.statusText && (w.status === 'running' || w.status === 'waiting' || w.status === 'error') ? `<span>${t('kv.now')}</span><span>${esc(oneLine(plainStatus(w.statusText), 140))}</span>` : ''}
      ${w.request && w.status !== 'archived' ? `<span>${t('kv.request')}</span><span data-tip="${esc(w.request.text)}">${esc(oneLine(w.request.text, 140))}</span>` : ''}
    </div>
    ${runHtml(w)}
    <div class="ins-h"><b role="heading" aria-level="2">${t('wk.tasks')}</b><small>${tasks.length}</small></div>
    <div class="group">${tasks.map((x) => `<div class="mini"><b>${esc(x.id)} ${esc(x.title)}</b><span>${taskLabel(x)}${isQueued(x) ? ` · <button type="button" class="linkbtn danger" data-action="task-cancel" data-id="${esc(x.id)}">${t('cancel.task')}</button>` : ''}${x.planFirst && !x.planApproved ? ` · ${t('plan.badge')}` : ''}${x.prUrl ? ` · <a tabindex="0" role="link" data-action="open-url" data-href="${esc(x.prUrl)}">PR #${prNum(x.prUrl)}${x.prState === 'MERGED' ? ` ${t('pr.merged')}` : ''}</a> ${prBadges(x)}` : ''}${reportLinks((x.links ?? []).join('\n'), [x.prUrl]).map((l) => ` · ${reportLinkHtml(l)}`).join('')}${x.files.map((f) => ` · <a tabindex="0" role="link" data-action="open-file" data-path="${esc(f)}">${esc(base(f))}</a>`).join('')}</span>${x.summary ? `<span>${esc(oneLine(x.summary, 160))}</span>` : ''}${grantsHtml(x)}</div>`).join('') || `<div class="mini"><span>${t('none')}</span></div>`}</div>
    <div class="ins-act">
      ${canStop(w, cur) ? `<button class="btn" data-action="worker-stop" data-id="${w.id}">${t('wk.stop')}</button>` : ''}
      ${failed ? `<button class="btn" data-action="worker-continue" data-id="${w.id}">${t('wk.continue')}</button>` : ''}
      ${w.status === 'archived' ? `<button class="btn" data-action="worker-unarchive" data-id="${w.id}">${t('wk.restore')}</button>` : workerBusy(w, tasks) ? '' : `<button class="btn" data-action="worker-archive" data-id="${w.id}">${t('wk.archive')}</button>`}
      <button class="btn btn-primary" data-action="worker-msg" data-id="${w.id}">${t('wk.message')}</button>
    </div>`; });
  tickDecisions(root);
}

/** The Worker is at work (a turn, or a task running or waiting): it cannot be archived until it stops. */
export function workerBusy(w: Worker, tasks: Task[]) {
  return w.status === 'running' || w.status === 'waiting' || w.status === 'starting' || tasks.some((x) => x.status === 'running' || x.status === 'waiting');
}

/* ---------- asking before archiving a Worker or removing a repository ---------- */

/** Archive a Worker; first ask when its folder would be removed (a repository Worker no open task needs). */
export async function archiveWorker(id: string, asked = false) {
  const w = S!.workers.find((x) => x.id === id);
  if (!w) return;
  const tasks = w.taskIds.map((x) => task(x)).filter(Boolean) as Task[];
  if (!asked && w.repo && !tasks.some(holdsWorktree)) {
    ui.confirmAsk = { title: t('arch.title', { id: w.id }), body: `<p>${esc(t('arch.body', { folder: base(w.cwd) }))}</p>`, ok: t('wk.archive'), action: 'archive', id };
    renderConfirmDialog();
    return;
  }
  const r = await call<{ kept: 'task' | 'dirty' | null }>('worker:archive', id);
  if (r?.kept === 'dirty') toast(t('arch.keptDirty'));
}

/** Remove a repository: what is affected is listed first, and it is refused while its tasks are open. */
export function askRepoRemove(name: string) {
  const tasks = S!.tasks.filter((x) => x.repo === name);
  const open = tasks.filter((x) => x.status === 'running' || x.status === 'waiting' || isQueued(x));
  const prs = tasks.filter((x) => x.status === 'pr_open');
  const ws = S!.workers.filter((w) => w.repo === name && w.status !== 'archived');
  const list = (xs: string[]) => `<ul class="dlg-list">${xs.slice(0, 5).map((x) => `<li>${esc(x)}</li>`).join('')}${xs.length > 5 ? `<li class="more">${t('cancel.more', { n: xs.length - 5 })}</li>` : ''}</ul>`;
  ui.confirmAsk = open.length
    ? { title: t('repoRm.busyTitle', { name }), body: `<p>${esc(t('repoRm.busy'))}</p>${list(open.map((x) => `${x.id} ${x.title}`))}`, ok: null, action: 'repo-remove', id: name }
    : {
      title: t('repoRm.title', { name }),
      body: `<p>${esc(t('repoRm.body'))}</p>${ws.length ? `<p>${esc(t('repoRm.workers'))}</p>${list(ws.map((w) => w.id))}` : ''}${prs.length ? `<p>${esc(t('repoRm.prs'))}</p>${list(prs.map((x) => `${x.id} ${x.title}`))}` : ''}`,
      ok: t('remove'), action: 'repo-remove', id: name,
    };
  renderConfirmDialog();
}

/** The confirm dialog for archiving, removing and starting a new conversation (ui.confirmAsk); without an OK label it only explains. */
export function renderConfirmDialog() {
  const root = $('#dlg');
  const ask = ui.confirmAsk;
  if (!ask) {
    root.hidden = true;
    root.innerHTML = '';
    root.dataset.key = '';
    layerClose('confirm');
    return;
  }
  const key = JSON.stringify(ask);
  if (!root.hidden && root.dataset.key === key) return;
  const opening = root.hidden === true;
  if (opening) layerOpen('confirm');
  root.dataset.key = key;
  root.innerHTML = `<div class="dlg-back" data-action="confirm-dismiss"></div>
  <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="xdlg-t">
    <h2 id="xdlg-t">${esc(ask.title)}</h2>${ask.body}
    <div class="dlg-btns"><button class="btn btn-lg${ask.ok ? '' : ' btn-primary'}" data-action="confirm-dismiss">${t(ask.ok ? 'cancel' : 'close')}</button>${ask.ok ? `<button class="btn btn-lg btn-danger-fill" data-action="confirm-ok">${esc(ask.ok)}</button>` : ''}</div>
  </div>`;
  root.classList.toggle('opening', opening);
  root.hidden = false;
  if (opening) root.querySelector<HTMLButtonElement>('.dlg-btns .btn')?.focus();
}

export async function confirmOk() {
  const ask = ui.confirmAsk;
  ui.confirmAsk = null;
  renderConfirmDialog();
  if (!ask?.ok) return;
  if (ask.action === 'archive') return archiveWorker(ask.id, true);
  if (ask.action === 'ctx-clear') { await call('dispatcher:clear'); return; }
  const kept = await call<string[]>('repo:remove', ask.id);
  if (kept === undefined) return;
  if (ui.repoSel === ask.id) ui.repoSel = null;
  toast(kept?.length ? t('repoRm.kept', { ids: kept.join(', ') }) : t('repoRm.done', { name: ask.id }));
}

/* ---------- cancelling queued tasks ---------- */

/** Ask before cancelling: what goes, what only loses its queued work, and which waiting tasks go with it. */
export function renderCancelDialog() {
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
    layerClose('cancel');
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
  if (opening) layerOpen('cancel');
  root.dataset.key = key;
  root.innerHTML = `<div class="dlg-back" data-action="cancel-dismiss"></div>
  <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="cdlg-t">
    <h2 id="cdlg-t">${esc(title)}</h2>${body}
    <div class="dlg-btns"><button class="btn btn-lg" data-action="cancel-dismiss">${t('cancel.keep')}</button><button class="btn btn-lg btn-danger-fill" data-action="cancel-ok">${esc(ok)}</button></div>
  </div>`;
  root.classList.toggle('opening', root.hidden === true);
  root.hidden = false;
  if (opening) root.querySelector<HTMLButtonElement>('.dlg-btns .btn')?.focus();
}

export async function confirmCancel() {
  const ask = ui.cancelAsk;
  ui.cancelAsk = null;
  renderCancelDialog();
  if (!ask) return;
  const rs = ask.all ? await call<CancelReport[]>('queue:clear') : await call<CancelReport[]>('task:cancel', ask.ids[0]);
  if (rs?.length) toast(rs.some((r) => r.kept) ? t('toast.cancelKept') : t('toast.cancelled', { n: rs.length }));
}
