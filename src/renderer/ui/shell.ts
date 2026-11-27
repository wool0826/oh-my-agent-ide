// "!" in the chat composer (T-0053 item 2): shell mode, where Enter runs the line as the user, and the run's block
// in the thread. The run itself is main/shell.ts; what is kept and handed over is shared/shell.ts.
import { outParts, SHELL_FOLDED, shellClock, shellRisky, shellTook, tailLines } from '../../shared/shell';
import type { ChatItem } from '../../shared/types';
import { $, call, esc, S, sym, t, ui } from './core';
import { openPop, pop } from './controls';
import { copyBtnHtml } from './copy';

/** The composer goes into shell mode: the "!" leaves the text and the composer gets a warn ring, with Shell and the folder. */
export function enterShell() {
  if (ui.shell) return;
  ui.shell = true;
  renderShellBar();
}

export function leaveShell() {
  if (!ui.shell) return;
  ui.shell = false;
  renderShellBar();
}

/** The folder picked is still a registered repository; else the IDE home. */
function repoNow(): string {
  return ui.shellRepo && S?.repos.some((r) => r.name === ui.shellRepo) ? ui.shellRepo : '';
}

export function renderShellBar() {
  const form = $('#chat-form');
  const bar = $('#chat-shbar');
  const input = $<HTMLTextAreaElement>('#chat-input');
  form.classList.toggle('shell', ui.shell);
  bar.hidden = !ui.shell;
  $('#chat-bang').hidden = !ui.shell;
  input.classList.toggle('mono', ui.shell);
  input.setAttribute('aria-label', t(ui.shell ? 'shell.aria' : 'aria.message'));
  input.placeholder = ui.shell ? t('shell.placeholder') : '';
  if (!ui.shell) { bar.innerHTML = ''; markRisky(input); return; }
  const repo = repoNow();
  const where = repo || t('shell.home');
  bar.innerHTML = `<span class="sh-mode">${sym('s-term')}${t('shell.mode')}</span>${cwdButton('shell-cwd', where)}${askChip()}<span class="sh-risk" hidden>${sym('s-alert')}${t('shell.risky')}</span><span class="gap"></span><span class="sh-hint"><kbd>↵</kbd>${t('shell.hintRun')}<kbd>Esc</kbd>${t('shell.hintMessage')}</span>`;
  markRisky(input);
}

/** The folder button of the shell bar and the terminal: "in <folder>" as one piece of text, then its chevron. */
export function cwdButton(action: string, where: string, id = '') {
  return `<button type="button" class="sh-cwd"${id ? ` id="${id}"` : ''} data-action="${action}" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(t('shell.folderAria', { where }))}"><span class="sh-cwd-t">${t('shell.in', { where: `<b>${esc(where)}</b>` })}</span><svg class="chev" aria-hidden="true"><use href="#s-chev"/></svg></button>`;
}

/** A line that deletes, overwrites or forces (shared/shell.ts shellRisky): the composer turns red and says so (G3). */
export function markRisky(input: HTMLTextAreaElement) {
  const risky = ui.shell && shellRisky(input.value);
  $('#chat-form').classList.toggle('risky', risky);
  const chip = document.querySelector<HTMLElement>('#chat-shbar .sh-risk');
  if (chip) chip.hidden = !risky;
}

/**
 * A run's output as shown (G2): stdout lines as they are, and each stretch of stderr in the danger colour with only its
 * first line until "+N lines" opens it. `id` names the run for what is opened (ui.errOpen); `text` is the kept output
 * from line `offset` on; `end` goes after the last line.
 */
export function outHtml(id: string, text: string, err: readonly number[] | undefined, offset = 0, end = '') {
  const parts = outParts(text, err, offset);
  return parts.map((p, i) => {
    const tail = i === parts.length - 1 ? end : '';
    if (!p.err) return `<span class="o-seg">${esc(p.lines.join('\n'))}${tail}</span>`;
    // Opened by where it starts in the kept output, so two stretches with the same first line open apart.
    const key = `${id}:${offset + p.at}`;
    const open = ui.errOpen.has(key);
    const rest = p.lines.length - 1;
    const shown = open ? p.lines : p.lines.slice(0, 1);
    const more = rest ? `<button type="button" class="o-more" data-action="out-err" data-k="${esc(key)}" aria-expanded="${open}">${open ? t('shell.errLess') : t('shell.errMore', { n: rest })}</button>` : '';
    return `<span class="o-seg o-err">${esc(shown.join('\n'))}${tail}</span>${more}`;
  }).join('');
}

/** Whether a run hands its result to the Dispatcher for a turn of its own (Settings shellAsk), switched on the bar. */
function askChip() {
  const on = S?.settings.shellAsk !== false;
  return `<button type="button" class="sh-ask" data-action="shell-ask" aria-pressed="${on}" data-tip="${esc(t(on ? 'shell.askOnTip' : 'shell.askOffTip'))}">${on ? sym('s-check') : ''}${t('shell.ask')}</button>`;
}

/** The ask chip was pressed: saved as the setting, and the bar shows it at once. */
export function toggleShellAsk() {
  if (!S) return;
  S.settings.shellAsk = S.settings.shellAsk === false;
  void call('settings:save', { shellAsk: S.settings.shellAsk });
  renderShellBar();
  $('#chat-input').focus();
}

/** The folder picker on the shell bar: the IDE home, then each registered repository. */
export function pickShellFolder(owner: HTMLElement) {
  const items = [{ value: '', label: t('shell.home') }, ...(S?.repos ?? []).map((r) => ({ value: r.name, label: r.name, sub: r.path }))];
  openPop(owner, items, repoNow(), (v) => {
    ui.shellRepo = v;
    localStorage.setItem('oma.shellRepo', v);
    renderShellBar();
    $('#chat-input').focus();
  }, 200);
}

/** The repository a line runs in now ('' for the IDE home). */
export function shellRepo() {
  return repoNow();
}

/**
 * Keys in the chat composer for shell mode: "!" typed first enters it; Esc, or Backspace on an empty line, leaves.
 * Returns true when the key was taken.
 */
export function shellKeys(e: KeyboardEvent, input: HTMLTextAreaElement): boolean {
  if (!ui.shell) return false;
  // A key that ends or edits an IME composition (Korean, Japanese) is the composition's, not the mode's.
  if (pop.el || e.isComposing || e.keyCode === 229) return false;
  if (e.key === 'Escape' || (e.key === 'Backspace' && !input.value && input.selectionStart === 0)) {
    e.preventDefault();
    e.stopPropagation();
    leaveShell();
    return true;
  }
  return false;
}

/** After the text changed: a "!" at the start of the text moves into the mode. */
export function shellInput(input: HTMLTextAreaElement) {
  if (ui.shell || !input.value.startsWith('!')) { markRisky(input); return; }
  const at = input.selectionStart;
  input.value = input.value.slice(1);
  input.setSelectionRange(Math.max(0, at - 1), Math.max(0, at - 1));
  enterShell();
}

/** A shell run in the thread: command, where, state, time, the end of its output and where its hand-over stands. */
export function shellBlockHtml(c: ChatItem) {
  const r = c.shell;
  if (!r) return '';
  const open = ui.shellOpen.has(c.id);
  const kept = r.out.replace(/\n+$/, '');
  const keptLines = kept ? kept.split('\n').length : 0;
  const shown = open ? kept : tailLines(kept, SHELL_FOLDED);
  const shownLines = open ? keptLines : Math.min(keptLines, SHELL_FOLDED);
  // Folded: its last lines, with a button for the rest that is kept. Lines past what is kept are only counted.
  const more = keptLines > SHELL_FOLDED;
  const above = Math.max(0, r.lines - shownLines);
  const where = r.repo || t('shell.home');
  // A saved script can be several lines: its name, then its first line here, all of it in the tooltip.
  const lines = r.cmd.split('\n');
  const pill = r.running ? `<span class="pill" data-tone="accent"><i class="sh-spin" aria-hidden="true"></i>${t('shell.running')}</span>`
    : r.stopped ? `<span class="pill">${t('shell.stopped')}</span>`
    : `<span class="pill" data-tone="${r.code === 0 ? 'success' : 'danger'}">${t('shell.exit', { n: r.code ?? '?' })}</span>`;
  const time = r.running ? `<time data-start="${esc(r.startedAt)}">${shellClock(Date.now() - Date.parse(r.startedAt))}</time>` : `<time>${shellTook(r.ms)}</time>`;
  const stop = r.running ? `<button type="button" class="btn btn-sm" data-action="shell-stop" data-id="${esc(c.id)}" aria-label="${esc(t('shell.stopAria', { cmd: r.cmd }))}">${t('shell.stop')}</button>` : '';
  const fold = (more ? `<button type="button" class="sh-fold" data-action="shell-fold" data-id="${esc(c.id)}" aria-expanded="${open}">${open ? t('shell.fewer') : t('shell.earlier', { n: above })}</button>` : '')
    + ((open || !more) && above > 0 ? `<span class="sh-cut">${t('shell.cut', { n: above })}</span>` : '');
  const dlv = r.sent === 'sent' ? `<span class="sh-dlv ok">${sym('s-check')}${t('shell.sent')}</span>`
    : r.sent === 'queued' ? `<span class="sh-dlv wait"><i></i>${t('shell.queued')}</span>`
    : r.sent === 'off' ? `<span class="sh-dlv off">${t('shell.notSent')}</span>`
    : `<span class="sh-dlv wait"><i></i>${t(r.ask ? 'shell.willAsk' : 'shell.willSend')}</span>`;
  const acts = r.running ? '' : `<span class="gap"></span>${copyBtnHtml('shell-copy', `shell:${c.id}`, t('shell.copyAll'), 'mact', ` data-id="${esc(c.id)}"`)}<a tabindex="0" role="link" data-action="shell-again" data-id="${esc(c.id)}">${t('shell.again')}</a>`;
  const out = shown ? `<pre class="sh-out">${outHtml(c.id, shown, r.err, keptLines - shownLines, r.running ? '<span class="sh-caret" aria-hidden="true"></span>' : '')}</pre>` : '';
  return `<div class="sh-run${r.running ? ' live' : ''}" data-id="${esc(c.id)}" role="group" aria-label="${esc(t('shell.blockAria', { cmd: r.cmd }))}"><header><span class="sh-bang" aria-hidden="true">!</span>${r.script ? `<b class="sh-name">${esc(r.script)}</b>` : ''}<code${lines.length > 1 ? ` data-tip="${esc(r.cmd)}"` : ''}>${esc(lines[0])}${lines.length > 1 ? ` <span class="sh-more">${t('script.moreLines', { n: lines.length - 1 })}</span>` : ''}</code><span class="sh-in">${t('shell.in', { where: esc(where) })}</span>${pill}${time}${stop}</header>${fold}${out}<footer>${dlv}${acts}</footer></div>`;
}

/** What makes a run's block change: drawn again when it does. */
export function shellKey(items: ChatItem[]) {
  return items.filter((c) => c.shell).map((c) => `${c.id}${c.shell!.running}${c.shell!.sent}${c.shell!.lines}${c.shell!.out.length}${c.shell!.err?.length ?? 0}${ui.shellOpen.has(c.id)}${[...ui.errOpen].filter((k) => k.startsWith(`${c.id}:`)).join('|')}`).join();
}

/** The time on running blocks goes on by itself, without drawing the thread again. */
setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>('#chat-thread .sh-run.live time[data-start]')) {
    el.textContent = shellClock(Date.now() - Date.parse(el.dataset.start!));
  }
}, 1000);
