// Saved prompts (decision 6A, shared/prompts.ts): "/" at the start of a composer's line lists them over the composer
// with the Dispatcher's commands; one taken puts its text in place of the "/" and its preset as chips over the chat
// composer's text. The Memos tab keeps them under its Prompts segment.
import { filterCommands, filterPrompts, insertPrompt, mergePreset, presetEmpty, presetOf, slashAt, PROMPT_CMD_MAX, PROMPT_NAME_MAX, PROMPT_TEXT_MAX, type BuiltinCommand } from '../../shared/prompts';
import { matchParts } from '../../shared/quickInput';
import type { PromptPreset, SavedPrompt } from '../../shared/types';
import { $, call, esc, modelLabel, S, sym, t, tryCall, ui } from './core';
import { openPop } from './controls';
import { modelOpts } from './settings';
import { closeCpop, cpopOpen, showCpop, type CpopList, type CpopRow } from './cpop';
import { renderChatInspector, type Box } from './chat';
import { renderConfirmDialog } from './workers';
import { togglePanel } from './sidebar';
import { drawComposerChips } from './mentions';

const inputOf = (box: Box) => $<HTMLTextAreaElement>(box === 'chat' ? '#chat-input' : '#ws-input');

// The "/" list.

const COMMAND_ICON: Record<BuiltinCommand, string> = { compact: 'e-compact', new: 's-chat' };
const COMMAND_LABEL = { compact: 'slash.compact', new: 'slash.new' } as const;

/** What the composer's "/" at the caret lists: the matching prompts, saving the text typed, then the commands (chat only). */
function slashList(box: Box, at: { start: number; query: string }): CpopList {
  const all = S?.prompts ?? [];
  const found = filterPrompts(all, at.query);
  const cmds = box === 'chat' ? filterCommands(at.query) : [];
  const q = at.query ? `/${at.query}` : '';
  const rows: CpopRow[] = [
    ...found.map((p) => ({ id: `p:${p.id}`, icon: 's-pin', label: q ? matchParts(`/${p.cmd}`, q) : `/${p.cmd}`, meta: p.name })),
    { id: 'save', icon: 's-plus', label: t('slash.saveNow') },
    ...cmds.map((c) => ({ id: `c:${c}`, icon: COMMAND_ICON[c], label: t(COMMAND_LABEL[c]), meta: `/${c}`, mono: true, group: t('slash.commands') })),
  ];
  return {
    kind: 'prompts',
    title: t('prompt.tab'),
    count: all.length ? found.length : undefined,
    rows,
    empty: '',
    note: !all.length ? t('prompt.empty') : !found.length ? t('slash.none') : undefined,
    hints: all.length ? [[['↑', '↓'], 'cpop.move'], [['↵'], 'cpop.insert'], [['Esc'], 'close']] : [],
    nav: 'list',
    none: !!at.query && !found.length && !cmds.length,
    pick: (row) => void pickSlash(box, at, row),
  };
}

/** Set while a pick changes the text, so a "/" line in what it puts in does not open the list again. */
let picking = false;

/** Puts `text` in place of the "/" being typed and tells the composer its text changed. */
function replaceSlash(box: Box, at: { start: number; query: string }, text: string) {
  const input = inputOf(box);
  const next = insertPrompt(input.value, at, text);
  input.value = next.value;
  input.setSelectionRange(next.caret, next.caret);
  picking = true;
  try { input.dispatchEvent(new Event('input', { bubbles: true })); } finally { picking = false; }
}

async function pickSlash(box: Box, at: { start: number; query: string }, row: CpopRow) {
  const input = inputOf(box);
  if (row.id.startsWith('p:')) {
    const p = S?.prompts.find((x) => `p:${x.id}` === row.id);
    if (!p) return;
    if (box === 'chat') setPreset(mergePreset(ui.presetChat, presetOf(p)));
    replaceSlash(box, at, p.text);
    return;
  }
  replaceSlash(box, at, '');
  if (row.id === 'save') { openPromptForm({ text: input.value.trim(), ...(box === 'chat' ? ui.presetChat ?? {} : {}) }); return; }
  if (row.id === 'c:compact') { await call('dispatcher:compact'); return; }
  if (row.id === 'c:new') {
    // As from the context meter's menu: the Dispatcher's context is gone for good, so it asks first.
    ui.confirmAsk = { title: t('ctx.clearTitle'), body: `<p>${esc(t('ctx.clearBody'))}</p>`, ok: t('ctx.clear'), action: 'ctx-clear', id: '' };
    renderConfirmDialog();
  }
}

/** The text changed: "/" at the start of the caret's line opens the list, and anything else closes it. */
export function slashTyped(box: Box) {
  if (picking) return;
  const input = inputOf(box);
  const at = (box !== 'chat' || !ui.shell) && input.selectionStart === input.selectionEnd ? slashAt(input.value, input.selectionStart) : null;
  if (at) showCpop(box, slashList(box, at));
  else if (cpopOpen(box, 'prompts')) closeCpop(box);
}

// The preset chips over the chat composer.

export function setPreset(p: PromptPreset | null) {
  ui.presetChat = presetEmpty(p) ? null : p;
  drawPresetChips();
}

/** The preset the next chat message goes with. */
export const chatPreset = () => (presetEmpty(ui.presetChat) ? null : ui.presetChat);

/** The chat composer's chips: the preset's, then a divider and the "@" ones (ui/mentions.ts). */
export function drawPresetChips() {
  drawComposerChips('chat');
}

/** The preset's chips over the chat composer's text, with their ×. */
export function presetChipsHtml(): string {
  const p = ui.presetChat;
  if (!p || presetEmpty(p)) return '';
  const chip = (k: keyof PromptPreset, icon: string, label: string) => {
    const x = esc(t('preset.remove', { name: label }));
    return `<span class="fchip pchip">${sym(icon)}<span class="fn">${esc(label)}</span><button type="button" data-action="preset-x" data-k="${k}" aria-label="${x}" data-tip="${x}"><svg aria-hidden="true"><use href="#s-x"/></svg></button></span>`;
  };
  return [
    p.repo ? chip('repo', 's-folder', p.repo) : '',
    p.model ? chip('model', 's-cpu', modelLabel(p.model)) : '',
    p.planFirst ? chip('planFirst', 's-doc', t('prompt.planFirst')) : '',
  ].join('');
}

/** The × on a chip: that setting no longer goes with the message. */
export function dropPreset(k: string) {
  const p = ui.presetChat;
  if (!p) return;
  setPreset({ ...p, ...(k === 'repo' ? { repo: '' } : k === 'model' ? { model: '' } : k === 'planFirst' ? { planFirst: false } : {}) });
  inputOf('chat').focus();
}

// The Memos tab's Prompts segment.

/** The open forms' repository, model and plan first ('new' or a prompt's id), until saved or cancelled. */
const drafts = new Map<string, PromptPreset>();
/** Saves on their way, so a held Enter or a double click saves once. */
const busy = new Set<string>();

const presetFor = (key: string): PromptPreset => {
  const d = drafts.get(key);
  if (d) return d;
  const p = S?.prompts.find((x) => x.id === key);
  return { repo: p?.repo ?? '', model: p?.model ?? '', planFirst: !!p?.planFirst };
};

function chipsHtml(p: PromptPreset) {
  const c = (icon: string, label: string) => `<span class="pr-chip">${sym(icon)}${esc(label)}</span>`;
  const all = [p.repo ? c('s-folder', p.repo) : '', p.model ? c('s-cpu', modelLabel(p.model)) : '', p.planFirst ? c('s-doc', t('prompt.planFirst')) : ''].join('');
  return all ? `<div class="pr-chips">${all}</div>` : '';
}

function formHtml(key: string, p?: SavedPrompt) {
  const d = presetFor(key);
  const k = esc(key);
  const dd = (action: string, value: string, label: string, aria: string) => `<button type="button" class="dd-btn" data-action="${action}" data-id="${k}" data-v="${esc(value)}" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(aria)}"><span>${esc(label)}</span>${sym('s-updown')}</button>`;
  return `<div class="memo prompt-form" data-form="${k}">
    <label class="pf-r"><span>${t('prompt.name')}</span><input class="inp" data-keep="prompt-name-${k}" data-enter="prompt-save" data-id="${k}" maxlength="${PROMPT_NAME_MAX}"${p ? ` value="${esc(p.name)}"` : ''}></label>
    <label class="pf-r"><span>${t('prompt.cmd')}</span><input class="inp mono" data-keep="prompt-cmd-${k}" data-enter="prompt-save" data-id="${k}" maxlength="${PROMPT_CMD_MAX + 1}" spellcheck="false"${p ? ` value="/${esc(p.cmd)}"` : ''}></label>
    <label class="pf-r top"><span>${t('prompt.text')}</span><textarea class="inp" data-keep="prompt-text-${k}" data-id="${k}" maxlength="${PROMPT_TEXT_MAX}" rows="2">${p ? esc(p.text) : ''}</textarea></label>
    <div class="pf-r"><span>${t('prompt.repo')}</span>${dd('prompt-repo', d.repo, d.repo || t('prompt.none'), t('prompt.repo'))}</div>
    <div class="pf-r"><span>${t('prompt.model')}</span>${dd('prompt-model', d.model, d.model ? modelLabel(d.model) : t('prompt.none'), t('prompt.model'))}</div>
    <label class="pf-r"><span>${t('prompt.planFirst')}</span><input class="switch" type="checkbox" data-change="prompt-plan" data-id="${k}"${d.planFirst ? ' checked' : ''}></label>
    <div class="btns"><button class="btn" data-action="prompt-cancel" data-id="${k}">${t('cancel')}</button><button class="btn btn-primary" data-action="prompt-save" data-id="${k}">${t('save')}</button></div></div>`;
}

function cardHtml(p: SavedPrompt) {
  if (ui.promptEdit === p.id) return formHtml(p.id, p);
  const id = esc(p.id);
  const act = (action: string, icon: string, label: string) => `<button class="mact" data-action="${action}" data-id="${id}" data-tip="${label}" aria-label="${label}"><svg aria-hidden="true"><use href="#${icon}"/></svg></button>`;
  const sure = ui.memoDel === p.id;
  const del = `<button class="mact del${sure ? ' sure' : ''}" data-action="prompt-remove" data-id="${id}" data-tip="${t('memo.remove')}" aria-label="${t(sure ? 'memo.removeSure' : 'memo.remove')}"><svg aria-hidden="true"><use href="#s-x"/></svg><span class="lbl">${t('memo.removeSure')}</span></button>`;
  return `<div class="memo prompt" data-prompt="${id}"><div class="pr-h"><b>${esc(p.name)}</b><code class="pr-cmd">/${esc(p.cmd)}</code><span class="gap"></span><span class="acts">${act('prompt-use', 's-play', t('prompt.use'))}${act('prompt-edit', 's-pencil', t('memo.edit'))}${del}</span></div><p class="pr-t">${esc(p.text.split('\n')[0])}</p>${chipsHtml(p)}</div>`;
}

function errHtml() {
  const msg = ui.formErr.prompt;
  return msg ? `<div class="ferr" role="alert"><span>${esc(t('err.notSent', { msg }))}</span><button type="button" class="btn btn-icon btn-sm clear-x always" data-action="form-err-x" data-id="prompt" data-tip="${t('err.dismiss')}" aria-label="${t('err.dismiss')}"><svg><use href="#s-x"/></svg></button></div>` : '';
}

const newBtn = () => `<button type="button" class="btn pr-new" data-action="prompt-new">${sym('s-plus')}${t('prompt.new')}</button>`;

/** The Memos tab: its two segments, then the memos or the prompts. */
export function memoTabHtml(memos: () => string) {
  const n = S?.prompts.length ?? 0;
  const tab = (v: 'memo' | 'prompt', label: string) => `<button type="button" data-action="memo-seg" data-v="${v}" aria-pressed="${ui.memoSeg === v}">${label}</button>`;
  const seg = `<div class="seg memo-seg" role="group" aria-label="${t('ins.tabMemo')}">${tab('memo', t('ins.tabMemo'))}${tab('prompt', `${t('prompt.tab')}${n ? ` <span class="count">${n}</span>` : ''}`)}</div>`;
  return seg + (ui.memoSeg === 'prompt' ? promptsHtml() : memos());
}

function promptsHtml() {
  const list = S?.prompts ?? [];
  if (ui.promptEdit && ui.promptEdit !== 'new' && !list.some((p) => p.id === ui.promptEdit)) ui.promptEdit = null;
  const form = ui.promptEdit === 'new' ? `<div class="group pr-list">${formHtml('new')}</div>` : '';
  if (!list.length) return form + errHtml() + (form ? '' : `<div class="pr-empty"><b>${t('prompt.empty')}</b>${newBtn()}</div>`);
  return form + errHtml() + `<div class="group pr-list">${list.map(cardHtml).join('')}</div>${form ? '' : `<div class="pr-foot">${newBtn()}</div>`}`;
}

const field = <T extends HTMLElement>(name: string, key: string) => document.querySelector<T>(`#chat-ins [data-keep="prompt-${name}-${CSS.escape(key)}"]`);

/** Opens the new prompt's form in the Memos tab, filled with what was typed (and its chips). */
export function openPromptForm(fill: Partial<PromptPreset> & { text?: string } = {}) {
  ui.insTab = 'memo';
  ui.memoSeg = 'prompt';
  ui.promptEdit = 'new';
  ui.formErr.prompt = '';
  drafts.set('new', { repo: fill.repo ?? '', model: fill.model ?? '', planFirst: !!fill.planFirst });
  if (ui.insMin) togglePanel('ins', false);
  renderChatInspector();
  for (const [name, v] of [['name', ''], ['cmd', ''], ['text', fill.text ?? '']] as const) { const el = field<HTMLInputElement>(name, 'new'); if (el) el.value = v; }
  field<HTMLInputElement>('name', 'new')?.focus();
}

export function editPrompt(id: string) {
  ui.promptEdit = id;
  ui.memoDel = null;
  drafts.delete(id);
}

export function cancelPromptEdit() {
  if (ui.promptEdit) drafts.delete(ui.promptEdit);
  ui.promptEdit = null;
  ui.formErr.prompt = '';
}

/** Saves the form `key` ('new' adds a prompt). What was typed stays when it is not saved, with why under the list. */
export async function savePrompt(key: string): Promise<boolean> {
  const name = field<HTMLInputElement>('name', key);
  const cmd = field<HTMLInputElement>('cmd', key);
  const text = field<HTMLTextAreaElement>('text', key);
  if (!name || !cmd || !text) return false;
  for (const el of [name, cmd, text]) if (!el.value.trim() || el.value.trim() === '/') { el.focus(); return false; }
  if (busy.has(key)) return false;
  busy.add(key);
  const input = { name: name.value, cmd: cmd.value, text: text.value, ...presetFor(key) };
  const r = await (key === 'new' ? tryCall<string>('prompt:add', input) : tryCall('prompt:update', key, input)).finally(() => busy.delete(key));
  if (!r.ok) { ui.formErr.prompt = r.error; return false; }
  drafts.delete(key);
  ui.formErr.prompt = '';
  ui.promptEdit = null;
  return true;
}

/** The repository or model picker of a form: none, then each choice. Changes only the form. */
export function pickPromptSetting(owner: HTMLElement, redraw: () => void) {
  const key = owner.dataset.id ?? 'new';
  const repo = owner.dataset.action === 'prompt-repo';
  const cur = owner.dataset.v ?? '';
  const none = { value: '', label: t('prompt.none') };
  const items = repo ? [none, ...(S?.repos ?? []).map((r) => ({ value: r.name, label: r.name, sub: r.path }))] : [none, ...modelOpts(cur)];
  openPop(owner, items, cur, (v) => {
    drafts.set(key, { ...presetFor(key), ...(repo ? { repo: v } : { model: v }) });
    redraw();
  }, 220);
}

export function setPromptPlan(key: string, on: boolean) {
  drafts.set(key, { ...presetFor(key), planFirst: on });
}

/** ▶ on a card: its text goes into the chat composer (after what is there), and its preset over it. */
export function usePrompt(id: string) {
  const p = S?.prompts.find((x) => x.id === id);
  if (!p) return;
  const input = inputOf('chat');
  const before = input.value.replace(/\s+$/, '');
  input.value = before ? `${before}\n${p.text}` : p.text;
  setPreset(mergePreset(ui.presetChat, presetOf(p)));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  picking = true;
  try { input.dispatchEvent(new Event('input', { bubbles: true })); } finally { picking = false; }
}
