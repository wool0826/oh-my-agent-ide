import { handle, type IpcContext } from './handle';
import { cancelPublish, exportSource, publishExport, saveExport } from '../exportMd';
import { exportShots, publishTitle } from '../../shared/exportMd';
import { userAnswer } from './decisions';
import { store } from '../store';
import { workers } from '../agents/workers';
import { runs } from '../runs';
import { attachmentBlock, registerAttachments } from '../attachments';
import { checkPrsNow, queueMerge, unqueueMerge } from '../prmonitor';
import { t } from '../i18n';
import { PICK_MESSAGE, canPick } from '../../shared/compare';
import { answerTarget } from '../../shared/inbox';
import { PAGE } from '../../shared/paging';
import { canRerun, parseQueueMove, parseRerunMode, rerunInput } from '../../shared/queue';
import { assignedEvent, createTask } from '../agents/dispatcher';

/** A Worker's conversation, its tasks, checkpoints and archive, and the merge queue. */
export function registerWorkerIpc(ctx: IpcContext) {
  // A page of a Worker's conversation: the latest, or the one before line `before` (decision 85).
  handle('worker:log', (id: string, opts?: { before?: number; limit?: number }) => store.readLog(id, opts?.before, Math.min(opts?.limit ?? PAGE.log, 1000)));
  handle('worker:send', (id: string, text: string, files?: string[], answerId?: string | null) => {
    const body = text + attachmentBlock(registerAttachments(files ?? []));
    // It answers a decision only when the composer said so above the text (decision 93, M7); a permission never.
    const open = answerTarget(store.data.decisions, id, answerId);
    if (!open) return workers.send(id, 'user', body);
    userAnswer(open.id, body);
    return 'answered';
  });
  handle('worker:stop', (id: string) => workers.stop(id, 'user'));
  handle('task:cancel', (id: string) => workers.cancelTask(id, 'user'));
  handle('queue:clear', () => workers.clearQueue('user'));
  handle('queue:move', (id: string, move: unknown) => {
    const m = parseQueueMove(move);
    return m ? workers.moveInQueue(String(id), m) : false;
  });
  // Running a finished task again (4B): to the back of the queue, on its Worker ("again") or a new one ("copy"). The
  // text the composer edited, and its files, replace the request; without them it is the same request.
  handle('task:rerun', async (id: string, mode: unknown, text?: string | null, files?: string[]) => {
    const x = store.task(String(id));
    const how = parseRerunMode(mode);
    if (!x) throw new Error(t('err.noTask', { id: String(id) }));
    if (!how || !canRerun(x)) throw new Error(t('err.rerun', { id: x.id }));
    if (x.kind === 'code' && x.repo && !store.repo(x.repo)) throw new Error(t('err.noRepo', { name: x.repo }));
    const body = typeof text === 'string' && text.trim() ? text + attachmentBlock(registerAttachments(files ?? [])) : null;
    const model = x.model ?? (x.workerId ? store.worker(x.workerId)?.model : null) ?? null;
    const { task, worker } = await createTask(rerunInput(x, how, model, body));
    store.handout(assignedEvent(task, worker, false), task.id);
    store.pushUpdate(`The user ran ${x.id} again as ${task.id}${how === 'copy' ? ' on a new Worker' : ''}${body ? ', with an edited request' : ''}.`);
    return { id: task.id, worker: worker?.id ?? null, status: task.status };
  });
  handle('worker:diff', (id: string) => workers.diff(id));
  // Exporting a Worker's work (item 12A): the window writes the Markdown from this, then copies, saves or publishes it.
  handle('worker:export', (id: string) => exportSource(id));
  handle('worker:exportSave', (name: string, md: string) => saveExport(ctx.win(), name, md));
  // The images to upload are the ones the Worker's reports named, looked up here rather than taken from the window.
  // The title is the Markdown's heading, where secrets are already hidden.
  handle('worker:publish', async (id: string, md: string, shots?: boolean) => {
    const src = shots ? await exportSource(id) : null;
    return publishExport(String(md), publishTitle(String(md)), src ? exportShots(src) : []);
  });
  handle('worker:publishCancel', () => cancelPublish());
  handle('worker:checkpoints', (id: string) => workers.checkpoints(id));
  handle('worker:restore', (id: string, ref: string) => workers.restore(id, ref));
  handle('mq:add', (taskIds: string[]) => queueMerge(Array.isArray(taskIds) ? taskIds.map(String) : []));
  handle('mq:remove', (taskId: string) => unqueueMerge(String(taskId)));
  handle('pr:refresh', () => checkPrsNow());
  handle('task:revoke', (taskId: string, key: string) => workers.revokeGrant(taskId, key));
  // The user picked one of two attempts: it is told to open its PR, and the comparison is closed for both.
  handle('compare:pick', (taskId: string) => {
    const picked = store.task(taskId);
    if (!picked?.compare || picked.compare.picked || !canPick(picked) || !picked.workerId) return;
    for (const x of store.data.tasks) if (x.compare?.group === picked.compare.group) x.compare.picked = picked.id;
    store.event(t('ev.comparePicked', { id: picked.workerId, title: picked.title }), { k: 'picked', task: picked.id, worker: picked.workerId ?? undefined, title: picked.title });
    store.changed();
    return workers.send(picked.workerId, 'user', PICK_MESSAGE);
  });
  // Refused while the Worker works; its dev server stops only once it may go.
  handle('worker:archive', (id: string) => { workers.checkArchive(id); runs.stop(id); return workers.archive(id); });
  handle('worker:unarchive', async (id: string) => { const w = store.worker(id); if (w) await workers.unarchive(w); });
}
