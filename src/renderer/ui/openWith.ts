// Opening a Worker's folder (item 3A): the split button in the Worker header, its menu, the sidebar row's menu items,
// Ctrl/Cmd+O and the error toast. The rules are in shared/openWith.ts; main runs the programs (main/openWith.ts).
import { editorLabel, menuEditors, terminalsFor, type EditorChoice, type EditorId, type TerminalId } from '../../shared/openWith';
import type { Worker } from '../../shared/types';
import { S, call, esc, ide, isMac, sym, t, toast, ui, workerTask } from './core';

type OpenResult = { ok: true } | { ok: false; why: 'gone' | 'missing' | 'failed'; name: string; prog: string; msg?: string };

/** Which editors this computer has, as main last said; read again each time a menu or Settings opens. */
export let editorsFound: Partial<Record<EditorId, boolean>> = {};

export async function loadEditors() {
  editorsFound = (await call<Record<EditorId, boolean>>('open:editors')) ?? editorsFound;
  return editorsFound;
}

export const keyLabel = () => (isMac ? '⌘ O' : 'Ctrl O');

/** The default editor's name and badge. */
export function defaultEditor() {
  const st = S!.settings;
  return { id: st.editor, ...editorLabel(st.editor, st.editorCmd) };
}

export function badge(id: EditorId, text: string) {
  return `<span class="ebadge e-${id}" aria-hidden="true">${esc(text)}</span>`;
}

export function terminalName(id: TerminalId) {
  if (id === 'cmd') return t('open.cmd');
  if (id === 'terminal' || id === 'x-terminal') return t('open.terminalApp');
  return terminalsFor(ide.platform).find((x) => x.id === id)?.name ?? id;
}

export const revealLabel = () => t(isMac ? 'open.revealMac' : ide.platform === 'win32' ? 'open.revealWin' : 'open.revealLinux');

/** The split button: open in the default editor, and the menu of the other ways. */
export function openSplitHtml(w: Worker) {
  const d = defaultEditor();
  const say = t('open.in', { name: d.name });
  const open = ui.openMenu === w.id;
  return `<button type="button" class="osplit-main" data-action="open-editor" data-id="${esc(w.id)}" aria-label="${esc(say)}" data-tip="${esc(`${say} · ${keyLabel()}`)}">${badge(d.id, d.badge)}<span class="osplit-l">${t('open.label')}</span></button><button type="button" class="osplit-more" data-action="open-menu" data-id="${esc(w.id)}" aria-haspopup="menu" aria-expanded="${open}" aria-label="${esc(t('open.menu'))}" data-tip="${esc(t('open.menu'))}">${sym('s-chev')}</button>`;
}

const item = (action: string, id: string, icon: string, label: string, extra = '', attrs = '', off = false) =>
  `<button class="menu-item" role="menuitem" data-action="${action}" data-id="${esc(id)}"${attrs}${off ? ' disabled' : ''} data-close>${icon}<span>${esc(label)}</span>${extra}</button>`;

function editorItem(wid: string, e: EditorChoice, def: EditorId, off: boolean) {
  const tag = e.id === def ? `<small class="mtag">${t('open.default')}</small><small>${keyLabel()}</small>` : '';
  return item('open-with', wid, badge(e.id, e.badge), e.name, tag, ` data-v="${e.id}"`, off);
}

/** The header menu: editors, the terminal, the file manager, then copying the path and the branch. */
export function openMenuHtml(w: Worker, gone: boolean) {
  const st = S!.settings;
  const branch = workerTask(w)?.branch ?? '';
  const eds = menuEditors(st.editor, st.editorCmd, editorsFound);
  return `${gone ? `<div class="menu-warn" role="alert">${sym('s-alert')}<span>${t('open.gone')}</span></div>` : ''}${
    eds.map((e) => editorItem(w.id, e, st.editor, gone)).join('')}${
    item('open-with', w.id, sym('s-term'), terminalName(st.terminal), '', ' data-v="terminal"', gone)}${
    item('open-with', w.id, sym('s-folder'), revealLabel(), '', ' data-v="reveal"', gone)}<div class="menu-sep"></div>${
    item('open-copy', w.id, sym('s-copy'), t('open.copyPath'), '', ' data-v="path"', gone)}${
    branch ? item('open-copy', w.id, sym('s-branch'), t('open.copyBranch'), '', ' data-v="branch"') : ''}`;
}

/** The first items of a sidebar Worker row's right-click menu: the default editor, the terminal, the file manager. */
export function rowOpenItems(w: Worker) {
  const d = defaultEditor();
  return `${item('open-with', w.id, badge(d.id, d.badge), t('open.in', { name: d.name }), `<small>${keyLabel()}</small>`, ` data-v="editor"`)}${
    item('open-with', w.id, sym('s-term'), t('open.inTerminal'), '', ' data-v="terminal"')}${
    item('open-with', w.id, sym('s-folder'), revealLabel(), '', ' data-v="reveal"')}<div class="menu-sep"></div>`;
}

/** Opens Worker `wid`'s folder; a failure is a toast, with the way to Settings when the editor is missing. */
export async function openFolder(wid: string, what: string, toSettings: () => void) {
  const w = S?.workers.find((x) => x.id === wid);
  if (!w) return;
  const r = await call<OpenResult>('open:with', what, w.cwd);
  if (!r || r.ok) return;
  if (r.why === 'gone') toast(t('open.gone'), true);
  else if (r.why === 'missing') toast(t('open.failed', { name: r.name, prog: r.prog }), true, { label: t('set.title'), run: toSettings });
  else toast(t('open.failedMsg', { name: r.name || terminalName(S!.settings.terminal), msg: r.msg ?? '' }), true);
}

/** Whether Worker `wid`'s folder is still there (gone once its worktree was cleaned up after the merge). */
export async function folderThere(wid: string) {
  const w = S?.workers.find((x) => x.id === wid);
  return !!w && !!(await call<boolean>('open:exists', w.cwd));
}

/** What "Copy path" and "Copy branch name" put on the clipboard. */
export function copyValue(wid: string, v: string) {
  const w = S?.workers.find((x) => x.id === wid);
  if (!w) return '';
  return v === 'branch' ? workerTask(w)?.branch ?? '' : w.cwd;
}
