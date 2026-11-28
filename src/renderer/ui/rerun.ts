// Running a finished task again from its result row (4B): run again now, edit and run again, duplicate on a new
// Worker, copy the request. What a rerun carries is shared/queue.ts rerunInput; main makes the task (task:rerun),
// which joins the back of the queue.
import { canRerun, rerunInput, type RerunMode } from '../../shared/queue';
import type { Task } from '../../shared/types';
import { leaveShell } from './shell';
import { closeDrawer } from './sidebar';
import { $, esc, modelLabel, renderReply, S, sym, t, task, toast, tryCall, ui, worker } from './core';

/** A task that can run again, or null. */
export function rerunnable(id: string | null | undefined): Task | null {
  const x = id ? task(id) : null;
  return x && canRerun(x) ? x : null;
}

/** The two buttons a result row shows over its time on hover or focus: run again now, and its menu. */
export function rerunActs(x: Task | null): string {
  if (!x || !canRerun(x)) return '';
  const btn = (action: string, icon: string, label: string, extra = '') => `<button type="button" class="btn btn-icon btn-sm btn-ghost" data-action="${action}" data-id="${esc(x.id)}" data-tip="${esc(label)}" aria-label="${esc(label)}"${extra}>${sym(icon)}</button>`;
  return btn('res-rerun', 's-refresh', t('res.rerun')) + btn('res-menu', 's-more', t('res.menu'), ' aria-haspopup="menu" aria-expanded="false"');
}

/** The result row's menu: the run actions only (the Worker header's ⋯ is for exporting). */
export function rerunMenuHtml(id: string): string {
  const item = (action: string, icon: string, label: string) => `<button class="menu-item" role="menuitem" data-action="${action}" data-id="${esc(id)}" data-close>${sym(icon, 'mi')}<span>${esc(label)}</span></button>`;
  return item('res-rerun', 's-refresh', t('res.rerun'))
    + item('res-rerun-edit', 's-edit', t('res.rerunEdit'))
    + item('res-duplicate', 's-plus', t('res.duplicate'))
    + `<div class="menu-sep"></div>${item('res-copy-request', 's-copy', t('res.copyRequest'))}`;
}

/** The repository the task ran in is gone: said before main is asked. */
function repoGone(x: Task) {
  return x.kind === 'code' && !!x.repo && !S?.repos.some((r) => r.name === x.repo);
}

/** What main said after a rerun: in the queue (with Undo, which takes it out again) or started at once. */
function ranAgain(r: { id: string; worker: string | null; status: Task['status'] }) {
  if (r.status !== 'queued' && r.status !== 'blocked') {
    toast(t('rerun.started', { id: r.id, worker: r.worker ?? '' }), false, undefined, 'run');
    return;
  }
  toast(t('rerun.queued', { id: r.id }), false, { label: t('toast.undo'), run: () => void undoRerun(r.id) }, 's-refresh');
}

async function undoRerun(id: string) {
  const r = await tryCall('task:cancel', id);
  if (r.ok) toast(t('rerun.undone', { id }), false, undefined, 's-tick');
  else toast(t('rerun.failed', { msg: r.error }), true);
}

/**
 * Runs the task again: the same request, or `text` as edited in the composer with its files. The error, if any, is
 * returned; from the result row (no `text`) it shows as a toast, from the composer above its text.
 */
export async function rerun(id: string, mode: RerunMode, text?: string, files: string[] = []): Promise<string | null> {
  const x = task(id);
  if (!x) return text === undefined ? null : t('rerun.failed', { msg: t('err.noTask', { id }) });
  const r = repoGone(x)
    ? { ok: false as const, error: t('rerun.noRepo') }
    : await tryCall<{ id: string; worker: string | null; status: Task['status'] }>('task:rerun', id, mode, text ?? null, files);
  if (r.ok) { ranAgain(r.v); return null; }
  const msg = t('rerun.failed', { msg: r.error });
  if (text === undefined) toast(msg, true);
  return msg;
}

/**
 * Edit and run again, or duplicate: the request goes into the Dispatcher's composer under a chip naming the task and
 * where it will run; sending it runs it (app.ts), and the chip's ✕ leaves an ordinary message.
 */
export function rerunInComposer(id: string, mode: RerunMode) {
  const x = task(id);
  if (!x) return;
  // A rerun chip already there takes its untouched request with it; what the user typed stays, under the request.
  leaveRerun();
  leaveShell();
  const w = x.workerId ? worker(x.workerId) : null;
  const model = x.model ?? w?.model ?? null;
  const where = [mode === 'copy' ? t('rerun.newWorker') : x.workerId, x.kind === 'code' ? x.repo : null, model ? modelLabel(model) : null].filter(Boolean).join(' · ');
  ui.reply.chat = { who: t(mode === 'copy' ? 'rerun.chipCopy' : 'rerun.chip', { id: x.id }), quote: where, icon: mode === 'copy' ? 's-plus' : 's-refresh', rerun: { of: x.id, mode } };
  renderReply('chat');
  // In a narrow window the drawer would cover the composer.
  closeDrawer(false);
  const input = $<HTMLTextAreaElement>('#chat-input');
  const typed = input.value.trim();
  const ask = rerunInput(x, mode, null).prompt;
  input.value = typed ? `${ask}

${typed}` : ask;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/** The rerun chip goes (✕): the request it brought goes with it unless it was edited (also after a reload). */
export function leaveRerun() {
  const again = ui.reply.chat?.rerun;
  const x = again ? task(again.of) : null;
  if (!again || !x) return;
  const input = $<HTMLTextAreaElement>('#chat-input');
  if (input.value === rerunInput(x, again.mode, null).prompt) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
}

/** Copy request: the task's request as it was sent. */
export function copyRequest(id: string) {
  const x = task(id);
  if (!x) return;
  void navigator.clipboard.writeText(x.prompt).then(() => toast(t('sel.copied')), () => {});
}
