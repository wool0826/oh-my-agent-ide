import { handle, type IpcContext } from './handle';
import { loadSettings } from '../settings';
import { store } from '../store';
import { dispatcher } from '../agents/dispatcher';
import { closeQuick } from '../quick';
import { t } from '../i18n';
import { PAGE } from '../../shared/paging';
import { cleanPreset } from '../../shared/prompts';
import { cachedModels } from '../models';

/** The chat with the Dispatcher, the quick message box and the state the window reads. */
export function registerChatIpc(ctx: IpcContext) {
  handle('state', () => ctx.snapshot());
  // The whole state, numbered: the window asks for it when it loads and when it missed a message.
  handle('state:full', () => ctx.sender.full(ctx.snapshot()));
  handle('chat:send', (text: string, files?: string[], replyTo?: string | null, preset?: unknown) => dispatcher.send(text, files ?? [], typeof replyTo === 'string' ? replyTo : null, 'desktop', cleanPreset(preset, (n) => !!store.repo(n), (m) => { const all = cachedModels().models; return !all.length || all.some((x) => x.id === m); })));
  handle('chat:stop', () => dispatcher.stop());
  // The composers' prompt history (decision 1B): kept in main, read when Up opens it.
  handle('history:list', (key: string) => store.sentPrompts(String(key)));
  handle('history:add', (key: string, text: string) => store.addSentPrompt(String(key), String(text ?? '')));
  // The quick message box: its texts, a send (the same as typing in the chat) and putting it away.
  handle('quick:text', () => ({ ph: t('quick.ph'), sent: t('quick.sent'), files: t('quick.files'), lang: loadSettings().language, theme: loadSettings().theme, fontFamily: loadSettings().fontFamily, fontSize: loadSettings().fontSize, repos: store.data.repos.map((r) => r.name) }));
  handle('quick:send', (text: string, files?: string[]) => dispatcher.send(String(text), Array.isArray(files) ? files.map(String) : []));
  handle('quick:close', () => closeQuick());
  handle('dispatcher:compact', () => dispatcher.compact());
  handle('dispatcher:clear', () => dispatcher.clear());
  // With ids, only those items; without, the whole list.
  handle('chat:clear', (kind: 'result' | 'auto', ids?: string[]) => {
    const only = Array.isArray(ids) ? new Set(ids.map(String)) : null;
    const hit = (id: string) => !only || only.has(id);
    if (kind === 'auto') store.data.autoAnswers.forEach((a) => { if (hit(a.id)) a.cleared = true; });
    else store.data.chat.forEach((c) => { if ((c.kind === 'result' || c.kind === 'error') && hit(c.id)) c.cleared = true; });
    store.changed();
  });
  handle('chat:unclear', (kind: 'result' | 'auto', ids: string[]) => {
    const set = new Set(ids);
    if (kind === 'auto') store.data.autoAnswers.forEach((a) => { if (set.has(a.id)) a.cleared = false; });
    else store.data.chat.forEach((c) => { if (set.has(c.id)) c.cleared = false; });
    store.changed();
  });
  handle('search:text', (q: string) => store.searchText(String(q ?? '')));
  handle('chat:page', (before: string, limit?: number) => store.chatPage(before, Math.min(limit ?? PAGE.chat, 1000)));
}
