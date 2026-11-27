// The Repositories view with its issues, Jira issues, and the launch checks shown in Settings.
import type { Repo } from '../../shared/types';
import type { Task } from '../../shared/types';
import { type Key } from '../../shared/i18n';
import { prsInReview } from '../../shared/prs';
import { ghRepoRef, type Issue } from '../../shared/issues';
import { jiraBase, type JiraIssue } from '../../shared/jira';
import { checkItem, type Check } from '../../shared/preflight';
import { PAGE } from '../../shared/paging';
import { $, call, esc, ic, ide, keepInputs, keepScroll, paged, prNum, S, shortPath, skel, sym, t, taskLabel, toast, tryCall, ui, when } from './core';
import { go } from './history';
import { onStatusRedraw, redrawKeepingFocus, statusRows } from './status';

export let jira: undefined | 'loading' | JiraIssue[] | { error: string };

/** Sets `jira` from another module, which cannot assign to an import. */
export function setJira(v: undefined | 'loading' | JiraIssue[] | { error: string }) { jira = v; }

export const jiraOn = () => !!S && !!jiraBase(S.settings.jiraUrl) && S.settings.jiraTokenSet;

export async function loadJira() {
  jira = 'loading';
  try {
    jira = (await ide.call<JiraIssue[]>('jira:issues')) ?? [];
  } catch (e) {
    jira = { error: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  }
  if (ui.view === 'repo') renderRepos();
}

/** Under the repository list: the user's open Jira issues, each with a button that hands it to the Dispatcher. */
export function jiraHtml() {
  if (!jiraOn()) return '';
  if (jira === undefined) void loadJira();
  const refresh = `<button class="btn btn-icon btn-sm clear-x always" data-action="jira-refresh" data-tip="${t('diff.refresh')}" aria-label="${t('diff.refresh')}"><svg><use href="#s-refresh"/></svg></button>`;
  const head = (n: string) => `<div class="jira-h"><b>Jira</b>${n ? `<small>${n}</small>` : ''}<span class="gap"></span>${refresh}</div>`;
  if (jira === undefined || jira === 'loading') return `${head('')}<div class="jira-list" role="status" aria-label="${t('issue.loading')}">${skel(3, 'file')}</div>`;
  if (!Array.isArray(jira)) return `${head('')}<div class="jira-list"><div class="jira-msg err">${esc(jira.error)}</div></div>`;
  if (!jira.length) return `${head('0')}<div class="jira-list"><div class="jira-msg">${t('jira.none')}</div></div>`;
  const list = paged('jira', jira, 8);
  return `${head(String(jira.length))}<div class="jira-list">${list.items.map((i) => `<div class="li jira">${ic('doc')}<span class="m"><b><a tabindex="0" role="link" data-action="open-url" data-href="${esc(i.url)}">${esc(i.key)}</a> ${esc(i.summary)}</b><span>${esc([i.type, i.updatedAt ? when(i.updatedAt) : ''].filter(Boolean).join(' · '))}</span></span>
    <span class="r">${i.status ? `<span class="pill">${esc(i.status)}</span>` : ''}<button class="btn" data-action="jira-assign" data-id="${esc(i.key)}">${t('issue.assign')}</button></span></div>`).join('')}${list.more}</div>`;
}

/** What the user allowed for the length of a task still in progress, each with a button that takes it back. */
export function grantsHtml(x: Task) {
  if (!x.grants?.length || !(x.status === 'running' || x.status === 'waiting' || x.status === 'queued' || x.status === 'blocked')) return '';
  return `<span class="grants"><em>${t('grant.title')}</em>${x.grants.map((g) => `<i class="pill">${esc(g.label)}<button type="button" class="grant-x" data-action="grant-revoke" data-id="${esc(x.id)}" data-key="${esc(g.key)}" data-tip="${t('grant.revoke')}" aria-label="${esc(`${t('grant.revoke')}: ${g.label}`)}"><svg aria-hidden="true"><use href="#s-x"/></svg></button></i>`).join('')}</span>`;
}

/* ---------- what the app needs on this computer (decision 131) ---------- */

export let preflight: undefined | 'loading' | Check[];

export async function loadPreflight() {
  preflight = 'loading';
  drawPreflight();
  preflight = (await call<Check[]>('preflight:run')) ?? [];
  drawPreflight();
}

/** The Status group: a summary line, and the checks under it when it is opened (decision 243). */
export function preflightRows() {
  if (preflight === undefined || preflight === 'loading') return `<div class="srow" role="status" aria-label="${t('pre.checking')}"><span class="skel pre"><i></i></span></div>`;
  const accounts = S?.accounts.map((a) => a.label) ?? [];
  return statusRows('pre', t('pre.title'), preflight.map((c) => checkItem(c, t, accounts)));
}

onStatusRedraw('pre', () => drawPreflight());

export function drawPreflight() {
  const el = document.getElementById('pre-rows');
  if (el) redrawKeepingFocus(el, preflightRows());
}

export function renderRepos() {
  const s = S!;
  const main = $('#repo-main');
  const addBtn = (cls: string) => `<button class="btn ${cls}" data-action="repo-add-open"${ui.repoAdd ? ' disabled' : ''}>${t('repo.add')}</button>`;
  if (!s.repos.length) {
    main.innerHTML = `<div class="vhead"><b role="heading" aria-level="1">${t('nav.repo')}</b></div><div class="empty-view">${sym('s-box')}<b>${t('repo.emptyTitle')}</b>${addBtn('btn-primary')}</div>${jiraHtml()}`;
  } else keepScroll(main, () => {
    // Columns for what tells repositories apart (B2): the default branch and where it is, which narrow widths drop.
    const cols = `<div class="li-cols repo" aria-hidden="true"><span></span><span>${t('repo.colName')}</span><span class="c-br">${t('kv.defaultBranch')}</span><span class="c-path">${t('kv.path')}</span><span></span></div>`;
    main.innerHTML = `<div class="vhead"><b role="heading" aria-level="1">${t('nav.repo')}</b><span class="vhead-r"><small>${s.repos.length}</small>${addBtn('')}</span></div><div class="lst" data-scroll="repo-list">${cols}${s.repos.map((r) => {
      const ts = s.tasks.filter((x) => x.repo === r.name);
      const run = ts.filter((x) => x.status === 'running' || x.status === 'waiting').length;
      const pr = prsInReview(ts).length;
      const local = r.local ? `<span class="pill" data-tip="${esc(t('repo.localNote'))}">${t('repo.local')}</span>` : '';
      return `<div tabindex="0" role="button" class="li repo${ui.repoSel === r.name ? ' sel' : ''}" data-action="repo-select" data-id="${esc(r.name)}">${ic('repo', 'box')}<span class="m"><b>${esc(r.name)}</b><span>${esc(r.description || r.url)}</span></span><span class="c-br">${esc(r.defaultBranch || '–')}</span><span class="c-path" data-tip="${esc(r.path)}">${esc(shortPath(r.path, 2))}</span><span class="r">${local}${run ? `<span class="pill" data-tone="accent">${t('repo.running', { n: run })}</span>` : ''}${pr ? `<span class="pill" data-tone="pr-open">PR ${pr}</span>` : ''}</span></div>`;
    }).join('')}${jiraHtml()}</div>`;
  });
  const ins = $('#repo-ins');
  if (ui.repoAdd) { keepInputs(ins, () => { ins.innerHTML = repoAddHtml(); }); return; }
  const r = s.repos.find((x) => x.name === ui.repoSel) ?? null;
  if (!r) {
    // Before a pick, the sidebar sums up every repository rather than standing empty (B2).
    if (!s.repos.length) { ins.innerHTML = `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-box"/></svg><b>${t('repo.pick')}</b></div>`; return; }
    const mine = s.tasks.filter((x) => x.repo && s.repos.some((y) => y.name === x.repo));
    const running = mine.filter((x) => x.status === 'running' || x.status === 'waiting').length;
    const local = s.repos.filter((y) => y.local).length;
    const kv = (k: string, v: number) => `<span>${k}</span><span>${v}</span>`;
    ins.innerHTML = `<div class="ins-h"><b role="heading" aria-level="2">${t('repo.sum')}</b></div>
      <div class="group kv">${kv(t('repo.sumRepos'), s.repos.length)}${kv(t('repo.sumRunning'), running)}${kv(t('repo.sumPrs'), prsInReview(mine).length)}${local ? kv(t('repo.sumLocal'), local) : ''}</div>`;
    return;
  }
  keepInputs(ins, () => {
    const all = s.tasks.filter((x) => x.repo === r.name).reverse();
    const ts = paged(`repo-tasks:${r.name}`, all, PAGE.repoTasks);
    ins.innerHTML = `<div class="ins-h"><b role="heading" aria-level="2">${esc(r.name)}</b>${r.local ? `<span class="pill">${t('repo.local')}</span>` : ''}</div>
      ${r.local ? `<div class="repo-local-note">${t('repo.localNote')}</div>` : ''}
      <div class="group kv"><span>${t('kv.path')}</span><span><a tabindex="0" role="link" data-action="reveal" data-path="${esc(r.path)}" data-tip="${esc(r.path)}">${esc(shortPath(r.path))}</a></span><span>${t('kv.url')}</span><span data-tip="${esc(r.url)}">${esc(shortPath(r.url))}</span><span>${t('kv.defaultBranch')}</span><span>${esc(r.defaultBranch)}</span></div>
      <div class="ins-h"><b role="heading" aria-level="2">${t('repo.desc')}</b></div>
      <textarea class="inp" data-keep="repo-desc-${esc(r.name)}" data-scroll="repo-desc-${esc(r.name)}" id="repo-desc" aria-label="${t('repo.desc')}">${esc(r.description)}</textarea>
      <div class="ins-h"><b role="heading" aria-level="2">${t('repo.setup')}</b></div>
      <textarea class="inp mono" rows="2" spellcheck="false" data-keep="repo-setup-${esc(r.name)}" data-scroll="repo-setup-${esc(r.name)}" id="repo-setup" placeholder="${esc(t('repo.setupPh'))}">${esc(r.setup ?? '')}</textarea>
      <div class="ins-h"><b role="heading" aria-level="2">${t('repo.run')}</b></div>
      <textarea class="inp mono" rows="2" spellcheck="false" data-keep="repo-run-${esc(r.name)}" data-scroll="repo-run-${esc(r.name)}" id="repo-run" placeholder="${esc(t('repo.runPh'))}">${esc(r.run ?? '')}</textarea>
      <div class="ins-act"><button class="btn" data-action="repo-save" data-id="${esc(r.name)}">${t('repo.save')}</button></div>
      ${issuesHtml(r)}
      <div class="ins-h"><b role="heading" aria-level="2">${t('wk.tasks')}</b><small>${all.length}</small></div>
      <div class="group">${ts.items.map((x) => `<div class="mini"><b>${esc(x.title)}</b><span>${x.workerId ? `${esc(x.workerId)} · ` : ''}${taskLabel(x)}${x.prUrl ? ` · <a tabindex="0" role="link" data-action="open-url" data-href="${esc(x.prUrl)}">PR #${prNum(x.prUrl)}</a>` : ''}</span></div>`).join('') || `<div class="mini"><span>${t('none')}</span></div>`}${ts.more}</div>
      <div class="ins-act"><button class="btn btn-danger" data-action="repo-remove" data-id="${esc(r.name)}">${t('repo.remove')}</button></div>`;
  });
}

/** A GitHub repository's open issues, each with a button that hands it to the Dispatcher as a task. */
export function issuesHtml(r: Repo) {
  if (!ghRepoRef(r.url)) return '';
  const v = ui.issues.get(r.name);
  if (v === undefined) { void loadIssues(r.name); }
  const refresh = `<button class="btn btn-icon btn-sm clear-x always" data-action="issues-refresh" data-id="${esc(r.name)}" data-tip="${t('diff.refresh')}" aria-label="${t('diff.refresh')}"><svg><use href="#s-refresh"/></svg></button>`;
  const head = (n: string) => `<div class="ins-h"><b role="heading" aria-level="2">${t('issue.title')}</b>${n ? `<small>${n}</small>` : ''}<span class="gap"></span>${refresh}</div>`;
  if (v === undefined || v === 'loading') return `${head('')}<div class="group" role="status" aria-label="${t('issue.loading')}">${skel(3, 'mini')}</div>`;
  // The error itself, not only in a tooltip, with a way to ask again (L17).
  if (!Array.isArray(v)) return `${head('')}<div class="group"><div class="mini" role="alert"><b>${t('issue.err')}</b>${v.error !== t('issue.err') ? `<span class="err">${esc(v.error)}</span>` : ''}<span><button type="button" class="linkbtn" data-action="issues-refresh" data-id="${esc(r.name)}">${t('retry')}</button></span></div></div>`;
  if (!v.length) return `${head('0')}<div class="group"><div class="mini"><span>${t('issue.none')}</span></div></div>`;
  const list = paged(`issues:${r.name}`, v, 6);
  return `${head(String(v.length))}<div class="group">${list.items.map((i) => `<div class="mini issue"><b><a tabindex="0" role="link" data-action="open-url" data-href="${esc(i.url)}">#${i.number}</a> ${esc(i.title)}</b>
    <span class="issue-f"><span class="lbls">${i.labels.slice(0, 3).map((l) => `<i class="pill">${esc(l)}</i>`).join('')}</span><button class="btn" data-action="issue-assign" data-id="${esc(r.name)}" data-n="${i.number}">${t('issue.assign')}</button></span></div>`).join('')}${list.more}</div>`;
}

export async function loadIssues(name: string) {
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
export function repoAddHtml() {
  const off = ui.repoAdding ? ' disabled' : '';
  // While it clones: git's last progress line, and Cancel stops the clone (nothing is registered).
  const progress = ui.repoAdding ? S!.repoAdding?.progress || t('repo.adding') : '';
  return `<div class="ins-h"><b role="heading" aria-level="2">${t('repo.add')}</b></div>
    <label class="fld-l" for="repo-add-url">${t('repo.addUrlLabel')}</label>
    <div class="repo-add-row"><input class="inp" id="repo-add-url" data-keep="repo-add-url" data-enter="repo-add" placeholder="${esc(t('repo.addUrl'))}" spellcheck="false"${off}><button class="btn" data-action="repo-add-pick"${off}>${t('repo.pickFolder')}</button></div>
    <label class="fld-l" for="repo-add-desc">${t('repo.descOpt')}</label>
    <textarea class="inp" id="repo-add-desc" data-keep="repo-add-desc"${off}></textarea>
    ${progress ? `<div class="repo-add-progress" role="status">${esc(progress)}</div>` : ''}
    ${!ui.repoAdding && ui.repoAddError ? `<div class="repo-add-error" role="alert">${esc(ui.repoAddError)}</div>` : ''}
    <div class="ins-act"><button class="btn" data-action="repo-add-cancel">${t('cancel')}</button><button class="btn btn-primary" data-action="repo-add"${off}>${t(ui.repoAdding ? 'repo.adding' : 'repo.addGo')}</button></div>`;
}

export async function addRepo() {
  const inp = $<HTMLInputElement>('#repo-add-url');
  const url = inp.value.trim();
  if (!url) { inp.focus(); return; }
  if (ui.repoAdding) return;
  ui.repoAdding = true;
  ui.repoAddError = '';
  renderRepos();
  // The form leaves "Adding…" however the add ends; a failure is said in the form, where it can be fixed (T-0027).
  let r: { ok: true; v: Repo | undefined } | { ok: false; error: string };
  try {
    r = await tryCall<Repo>('repo:add', url, undefined, $<HTMLTextAreaElement>('#repo-add-desc').value);
  } catch (e) {
    r = { ok: false, error: (e as Error)?.message || t('repo.err.unknown') };
  } finally {
    ui.repoAdding = false;
  }
  if (!r.ok || !r.v) {
    ui.repoAddError = r.ok ? t('repo.err.unknown') : r.error || t('repo.err.unknown');
    renderRepos();
    return;
  }
  const added = r.v;
  ui.repoAdd = false;
  toast(t(added.local ? 'repo.addedLocal' : 'repo.added', { name: added.name }));
  go({ repoSel: added.name });
  renderRepos();
}
