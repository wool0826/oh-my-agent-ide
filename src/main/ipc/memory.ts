import { handle } from './handle';
import { store } from '../store';
import { listMemory, readMemory, writeMemory, searchMemoryPage, syncMemory } from '../memory';
import { dispatcher, createTask, assignedEvent } from '../agents/dispatcher';
import { t } from '../i18n';
import { nowIso, uid } from '../util';
import { cleanMemo } from '../../shared/memos';
import { PAGE } from '../../shared/paging';
import { addPrompt, removePrompt, updatePrompt } from '../prompts';
import type { PromptInput } from '../../shared/prompts';

/** IDE memory and memos. */
export function registerMemoryIpc() {
  handle('memory:list', () => listMemory());
  handle('memory:read', (p: string) => readMemory(p));
  handle('memory:write', (p: string, c: string) => { writeMemory(p, c); dispatcher.refreshContext(); });
  // Memos. A change to what is shared reaches the Dispatcher with its next message.
  handle('memo:add', (text: string) => {
    const clean = cleanMemo(text);
    if (!clean) return null;
    const at = nowIso();
    const memo = { id: uid(), text: clean, shared: false, createdAt: at, updatedAt: at };
    (store.data.memos ??= []).push(memo);
    store.changed();
    return memo.id;
  });
  handle('memo:update', (id: string, patch: { text?: string; shared?: boolean }) => {
    const memo = store.data.memos?.find((m) => m.id === id);
    if (!memo) return;
    const wasShared = memo.shared;
    if (patch.text !== undefined) {
      const clean = cleanMemo(patch.text);
      if (clean && clean !== memo.text) { memo.text = clean; memo.updatedAt = nowIso(); }
    }
    if (patch.shared !== undefined) memo.shared = !!patch.shared;
    store.changed();
    if (wasShared || memo.shared) dispatcher.refreshContext();
  });
  handle('memo:remove', (id: string) => {
    const memo = store.data.memos?.find((m) => m.id === id);
    if (!memo) return;
    store.data.memos = store.data.memos!.filter((m) => m.id !== id);
    store.changed();
    if (memo.shared) dispatcher.refreshContext();
  });
  // Saved prompts, kept in the Memos tab and put into a composer with "/" (main/prompts.ts).
  handle('prompt:add', (input: Partial<PromptInput>) => addPrompt(input));
  handle('prompt:update', (id: string, input: Partial<PromptInput>) => updatePrompt(id, input));
  handle('prompt:remove', (id: string) => removePrompt(id));
  handle('memory:sync', () => syncMemory());
  handle('memory:search', (q: string, offset?: number) => searchMemoryPage(q, Math.max(0, offset ?? 0), PAGE.memHits));
  handle('memory:promote', async (repoName: string) => {
    const repo = store.repo(repoName);
    if (!repo) throw new Error(t('err.noRepo', { name: repoName }));
    const notes = readMemory(`repos/${repo.name}.md`);
    // Goes to an idle Worker that knows the repository (src/shared/routing.ts), or a new one.
    const { task, worker, reused } = await createTask({
      title: t('task.promote', { name: repo.name }),
      kind: 'code',
      repo: repo.name,
      prompt: [
        `Below are notes about the ${repo.name} repository collected in IDE memory. Pick only the rules and conventions useful to anyone working in this repository and open a PR adding them to its CLAUDE.md.`,
        'Leave out personal preferences, one-off records, and anything already in CLAUDE.md. Follow the structure and tone of the existing CLAUDE.md; create one if it does not exist.',
        '',
        notes,
      ].join('\n'),
    });
    store.handout(assignedEvent(task, worker, !!reused), task.id);
    return task.id;
  });
}
