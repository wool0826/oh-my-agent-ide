// The right sidebar's Scripts tab (shared/scripts.ts): shell commands the user saved, each with its folder, run only
// with its Run button. A run is a "!" run (main/shell.ts): its block is in the chat and its end goes to the Dispatcher.
import { keepPick } from '../../shared/insPanes';
import { SCRIPT_CMD_MAX, SCRIPT_NAME_MAX, sortScripts } from '../../shared/scripts';
import type { ShellScript } from '../../shared/types';
import { esc, S, sym, t, toast, tryCall, ui, when } from './core';
import { openPop } from './controls';
import { rowHtml, rowText, slotHtml } from './panes';

/** The open form's folder for each form ('new' or a script's id), until it is saved or cancelled. */
const folders = new Map<string, string>();

/** Where a script runs, as stored: a repository removed since is still named, and its run says it is gone. */
const whereLabel = (repo: string) => repo || t('shell.home');
/** Saves and runs on their way, so a held Enter or a double click does each once. */
const busy = new Set<string>();

function formHtml(key: string, s?: ShellScript) {
  const repo = folders.get(key) ?? s?.repo ?? '';
  const where = whereLabel(repo);
  const btns = s
    ? `<button class="btn" data-action="script-edit-cancel" data-id="${esc(key)}">${t('cancel')}</button><button class="btn btn-primary" data-action="script-save" data-id="${esc(key)}">${t('save')}</button>`
    : `<button class="btn btn-primary" data-action="script-save" data-id="new">${t('script.add')}</button>`;
  return `<div class="script-form" data-form="${esc(key)}">
    <input class="inp" data-keep="script-name-${esc(key)}" data-enter="script-save" data-id="${esc(key)}" maxlength="${SCRIPT_NAME_MAX}" placeholder="${t('script.name')}" aria-label="${t('script.name')}"${s ? ` value="${esc(s.name)}"` : ''}>
    <textarea class="inp mono" data-keep="script-cmd-${esc(key)}" data-enter="script-save" data-id="${esc(key)}" maxlength="${SCRIPT_CMD_MAX}" spellcheck="false" placeholder="${t('script.cmd')}" aria-label="${t('script.cmd')}">${s ? esc(s.cmd) : ''}</textarea>
    <div class="script-f"><button type="button" class="sh-cwd" data-action="script-cwd" data-id="${esc(key)}" data-v="${esc(repo)}" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(t('shell.folderAria', { where }))}">${sym('s-term')}${t('shell.in', { where: `<b>${esc(where)}</b>` })}<svg class="chev" aria-hidden="true"><use href="#s-chev"/></svg></button><span class="gap"></span>${btns}</div></div>`;
}

/** The command as the card shows it: all of it when selected, else its first line and how many follow. */
function cmdHtml(cmd: string, all: boolean) {
  const lines = cmd.split('\n');
  if (all || lines.length === 1) return `<pre class="script-cmd">${esc(cmd)}</pre>`;
  return `<pre class="script-cmd">${esc(lines[0])}<span class="script-more">${t('script.moreLines', { n: lines.length - 1 })}</span></pre>`;
}

function runBtn(s: ShellScript) {
  return `<button class="btn btn-primary script-run" data-action="script-run" data-id="${esc(s.id)}" aria-label="${esc(t('script.runAria', { name: s.name }))}">${sym('s-play')}${t('script.run')}</button>`;
}

function scriptSlot(s: ShellScript) {
  const sel = ui.scriptSel === s.id;
  const edit = ui.scriptEdit === s.id;
  const where = whereLabel(s.repo);
  const row = rowHtml('script', s.id, sel, rowText(s.name, edit ? `${where} · ${t('memo.editing')}` : where));
  if (edit) return slotHtml(s.id, sel, row, `<div class="memo script open">${formHtml(s.id, s)}</div>`);
  if (!sel) {
    const card = `<div class="memo script" data-action="pick" data-tab="script" data-id="${esc(s.id)}" data-focus="card-script-${esc(s.id)}" data-nav="script:${esc(s.id)}" tabindex="-1"><p>${esc(s.name)}</p>${cmdHtml(s.cmd, false)}<span class="meta"><span class="script-where">${esc(where)}</span><span class="acts">${runBtn(s)}</span></span></div>`;
    return slotHtml(s.id, false, row, card);
  }
  const sure = ui.memoDel === s.id;
  const act = (action: string, icon: string, label: string) => `<button class="mact" data-action="${action}" data-id="${esc(s.id)}" data-tip="${label}" aria-label="${label}"><svg aria-hidden="true"><use href="#${icon}"/></svg></button>`;
  const del = `<button class="mact del${sure ? ' sure' : ''}" data-action="script-remove" data-id="${esc(s.id)}" data-tip="${t('memo.remove')}" aria-label="${t(sure ? 'memo.removeSure' : 'memo.remove')}"><svg aria-hidden="true"><use href="#s-x"/></svg><span class="lbl">${t('memo.removeSure')}</span></button>`;
  const facts = `<dl class="facts"><dt>${t('script.where')}</dt><dd>${esc(where)}</dd><dt>${t('auto.lastRun')}</dt><dd>${s.lastRunAt ? esc(when(s.lastRunAt)) : esc(t('auto.never'))}</dd></dl>`;
  const card = `<div class="memo script open" data-nav="script:${esc(s.id)}" tabindex="-1"><p>${esc(s.name)}</p>${cmdHtml(s.cmd, true)}${facts}<span class="meta">${runBtn(s)}<span class="gap"></span><span class="acts">${act('script-edit', 's-pencil', t('memo.edit'))}${del}</span></span></div>`;
  return slotHtml(s.id, true, row, card);
}

/** The Scripts tab: "New script" (the form, selected at first), then the saved ones by name. */
export function scriptsHtml() {
  const list = sortScripts(S!.scripts ?? []);
  const add = formHtml('new') + formErrHtml();
  if (!list.length) { ui.scriptSel ??= 'new'; return `${add}<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-term"/></svg><b>${t('script.empty')}</b></div>`; }
  ui.scriptSel = keepPick(['new', ...list.map((s) => s.id)], ui.scriptSel, null);
  if (ui.scriptEdit && !list.some((s) => s.id === ui.scriptEdit)) ui.scriptEdit = null;
  const isNew = ui.scriptSel === 'new';
  const head = slotHtml('new', isNew, rowHtml('script', 'new', isNew, `${sym('s-plus')}<span class="t"><b>${t('script.new')}</b></span>`), add, ' new');
  return `${head}<div class="sect"><div class="ins-h"><b role="heading" aria-level="2">${t('ins.tabScript')}</b><small>${list.length}</small></div><div class="group">${list.map(scriptSlot).join('')}</div></div>`;
}

function formErrHtml() {
  const msg = ui.formErr.script;
  return msg ? `<div class="ferr" role="alert"><span>${esc(t('err.notSent', { msg }))}</span><button type="button" class="btn btn-icon btn-sm clear-x always" data-action="form-err-x" data-id="script" data-tip="${t('err.dismiss')}" aria-label="${t('err.dismiss')}"><svg><use href="#s-x"/></svg></button></div>` : '';
}

const field = <T extends HTMLElement>(name: string, key: string) => document.querySelector<T>(`#chat-ins [data-keep="script-${name}-${CSS.escape(key)}"]`);

/**
 * Saves the form `key` ('new' adds a script). The typed text stays until it is saved; why it was not is shown under
 * the new form, or as a toast for an edit. Returns whether it was saved.
 */
export async function saveScript(key: string): Promise<boolean> {
  const name = field<HTMLInputElement>('name', key);
  const cmd = field<HTMLTextAreaElement>('cmd', key);
  if (!name || !cmd) return false;
  if (!name.value.trim()) { name.focus(); return false; }
  if (!cmd.value.trim()) { cmd.focus(); return false; }
  const repo = folders.get(key) ?? (key === 'new' ? '' : S!.scripts.find((s) => s.id === key)?.repo ?? '');
  const input = { name: name.value, cmd: cmd.value, repo };
  if (busy.has(`save:${key}`)) return false;
  busy.add(`save:${key}`);
  const r = await (key === 'new' ? tryCall<string>('script:add', input) : tryCall('script:update', key, input)).finally(() => busy.delete(`save:${key}`));
  if (!r.ok) {
    if (key === 'new') ui.formErr.script = r.error; else toast(r.error, true);
    return false;
  }
  folders.delete(key);
  if (key === 'new') {
    ui.formErr.script = '';
    // A redraw while saving may have replaced the fields: clear the ones on screen now too.
    for (const el of [name, cmd, field<HTMLInputElement>('name', key), field<HTMLTextAreaElement>('cmd', key)]) if (el) el.value = '';
    ui.scriptSel = (r.v as string) ?? ui.scriptSel;
  } else ui.scriptEdit = null;
  return true;
}

export function editScript(id: string) {
  ui.scriptEdit = id;
  ui.scriptSel = id;
  ui.memoDel = null;
  folders.delete(id);
}

export function cancelScriptEdit() {
  if (ui.scriptEdit) folders.delete(ui.scriptEdit);
  ui.scriptEdit = null;
}

/** Runs a saved script: only from its button. Main runs the stored command, not one sent from here. */
export async function runScript(id: string, btn: HTMLButtonElement) {
  if (busy.has(`run:${id}`)) return;
  busy.add(`run:${id}`);
  btn.disabled = true;
  const r = await tryCall('script:run', id);
  // A second click right after the first is the same click: it does not start the script again.
  setTimeout(() => { busy.delete(`run:${id}`); btn.disabled = false; }, 800);
  if (!r.ok) toast(r.error, true);
}

/** The folder picker of a form: the IDE home, then each registered repository. Changes only the form. */
export function pickScriptFolder(owner: HTMLElement, redraw: () => void) {
  const key = owner.dataset.id ?? 'new';
  const items = [{ value: '', label: t('shell.home') }, ...(S?.repos ?? []).map((r) => ({ value: r.name, label: r.name, sub: r.path }))];
  openPop(owner, items, owner.dataset.v ?? '', (v) => {
    folders.set(key, v);
    redraw();
    field<HTMLInputElement>('name', key)?.focus();
  }, 200);
}
