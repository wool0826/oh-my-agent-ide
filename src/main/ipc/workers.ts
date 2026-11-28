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
