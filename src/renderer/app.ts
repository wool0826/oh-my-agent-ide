// The window's entry: drawing every screen, what each control does, and start-up.
import type { AppState, Worker } from '../shared/types';
import { hasSpend } from '../shared/spend';
import { reviewMessage } from '../shared/diffComment';
import { readyToMerge } from '../shared/prMerge';
import { issueMessage } from '../shared/issues';
import { jiraMessage } from '../shared/jira';
import { bundleMergeOrder, openBundles } from '../shared/bundle';
import { normalizeQuickKey } from '../shared/quickKey';
import { cleanTime } from '../shared/notifyRules';
import { focusSelector } from '../shared/focusKey';
import { PAGE, pagesFor, slideOlder } from '../shared/paging';
import { FONT_SIZE_DEFAULT } from '../shared/font';
import { type Screen, type View, type WorkerFilter } from '../shared/history';
import { addAuto, addFiles, addMemo, pasteFiles, askMemoDel, away, Box, checkAway, markSeen, olderChat, removeMemo, renderChat, renderChatInspector, renderChips, saveSug, setAway, spendHtml, updateSendButton, visibleAutos, markDecision, decisionCard, moveDecision, tickDecisions } from './ui/chat';
import { closeShortcuts, openShortcuts, shortcutsOpen } from './ui/shortcuts';
import { cardKey, keyAnswer } from '../shared/decisionView';
import { closePop, markFont, openFontPicker, pop, popKeys, stepValue } from './ui/controls';
import { leaveShell, pickShellFolder, shellInput, shellKeys, shellRepo } from './ui/shell';
import { $, announce, applyStaticText, call, esc, hhmm, ide, isMac, lang, moreBtn, onScroll, Pane, playSound, renderReply, replyText, S, scrollQuietly, setS, setSendErr, shownOf, store, swapIn, t, task, toast, tryCall, ui, when, worker, skipSameHtml, userActed } from './ui/core';
import { go, navKey, navStep, readMemFile, screen, show } from './ui/history';
import { loadMemory, renderMemory, renderMemSync, searchMem } from './ui/memory';
import { closePalette, Cmd, cmdk, openPalette, paletteKeys, renderPalette, runPalette } from './ui/palette';
import { addRepo, jira, loadJira, loadPreflight, preflight, renderRepos, setJira } from './ui/repos';
import { applyFont, applyTheme, closeSettings, filterPanes, glideAll, glideSoon, hostOnly, loadModels, openModelPicker, openSettings, pickSeg, previewFont, readSettingsForm, saveSettingsNow, saveSoon, segc, showPane, syncAccRows, syncSlider, syncSoundRows } from './ui/settings';
import { applyPanels, hideUsagePop, hideUsageSoon, hoverUsage, renderSidebar, renderUsage, showUsagePop, togglePanel, usagePop } from './ui/sidebar';
import { initResize } from './ui/resize';
import { addDiffNote, archiveWorker, askRepoRemove, confirmCancel, confirmOk, olderLog, openCheckpoints, renderCancelDialog, renderComposerDecision, renderConfirmDialog, renderDiff, renderSession, renderWorkerInspector, renderWorkerList } from './ui/workers';
import { canStop } from '../shared/canStop';

/** Shows a view tab. Navigation goes through go(), which calls this. */
export function setView(v: View) {
  ui.view = v;
  document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  document.querySelectorAll<HTMLElement>('.view').forEach((el) => { el.hidden = el.dataset.view !== v; });
  if (v === 'memory') void loadMemory();
  renderAll(true);
}

export function renderAll(force = false) {
  if (!S) return;
  const langChanged = ui.langApplied !== lang();
  applyStaticText();
  // Don't overwrite the preview while Settings is open.
  applyTheme(S.settings.theme);
  if (!ui.settingsShown) applyFont(S.settings.fontFamily, S.settings.fontSize);
  if (langChanged) force = true;
  // A focused control (a row, a button, a link) is drawn again as a new element; the focus goes to the one that took its place.
  const focused = document.activeElement instanceof HTMLElement && document.activeElement.matches('[data-action]') ? document.activeElement : null;
  const focusKey = focused ? focusSelector(focused.tagName, focused.dataset) ?? '' : '';
  const focusRoot = focused?.closest<HTMLElement>('.sidebar, .view');
  applyPanels();
  renderSidebar();
  renderUsage();
  renderMemSync();
  if (ui.cancelAsk) renderCancelDialog();
  if (ui.view === 'chat') { renderChat(force); renderChatInspector(); }
  if (ui.view === 'worker') { renderWorkerList(); renderSession(force); renderWorkerInspector(); }
  if (ui.view === 'repo') renderRepos();
  if (ui.view === 'memory' && force) renderMemory();
  if (focused && focusKey && !focused.isConnected && document.activeElement === document.body) focusRoot?.querySelector<HTMLElement>(focusKey)?.focus({ preventScroll: true });
}

export function openWorker(id: string) {
  if (!id) return;
  go({ view: 'worker', wSel: id, wOpen: true });
}

/** Bring a card into view and flash it once. */
function flashCard(card: HTMLElement | null) {
  card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  card?.classList.remove('flash'); void card?.offsetWidth; card?.classList.add('flash');
}

/**
 * A task-end notification was clicked: its result card in the inbox, newest first. When the card is gone (cleared,
 * or on a later page), the task's Worker instead.
 */
export function gotoResult(taskId: string) {
  ui.insTab = 'inbox';
  if (ui.insMin) togglePanel('ins');
  go({ view: 'chat' });
  renderChatInspector();
  const card = document.querySelector<HTMLElement>(`#chat-ins .res[data-task="${CSS.escape(taskId)}"]`);
  if (card) return flashCard(card);
  const w = S?.tasks.find((x) => x.id === taskId)?.workerId;
  if (w) openWorker(w);
}

/* ---------- actions ---------- */

export async function act(el: HTMLElement, e: Event) {
  const a = el.dataset.action!;
  const id = el.dataset.id ?? '';
  switch (a) {
    case 'view': go({ view: el.dataset.v as View }); break;
    case 'worker-filter': go({ view: 'worker', wOpen: false, wFilter: (el.dataset.v || null) as WorkerFilter | null }); break;
    case 'open-settings': openSettings(); break;
    case 'side-toggle': togglePanel('side'); break;
    case 'reply': {
      const box = el.dataset.box === 'ws' ? 'ws' : 'chat';
      const r = { who: el.dataset.who ?? '', quote: el.dataset.quote ?? '', ...(box === 'chat' && el.dataset.task ? { task: el.dataset.task } : {}) };
      if (box === 'ws') ui.reply.ws = { ...r, wid: ui.wSel ?? '' }; else ui.reply.chat = r;
      renderReply(box);
      $(box === 'chat' ? '#chat-input' : '#ws-input').focus();
      break;
    }
    // The chip over a late reply: back to the report it answers.
    // A task can have several cards (a result, then a follow-up): the one the group answers is the last one above it.
    case 'goto-report': flashCard([...document.querySelectorAll<HTMLElement>(`#chat-thread .attach[data-task="${CSS.escape(id)}"]`)].filter((c) => c.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).pop() ?? null); break;
    case 'shell-cwd': pickShellFolder(el); break;
    case 'shell-stop': (el as HTMLButtonElement).disabled = true; void tryCall('shell:stop', id); break;
    case 'shell-fold': if (!ui.shellOpen.delete(id)) ui.shellOpen.add(id); renderChat(true); break;
    case 'shell-copy': {
      const r = S?.chat.find((c) => c.id === id)?.shell;
      if (r) void navigator.clipboard.writeText(`$ ${r.cmd}\n${r.out}`).then(() => toast(t('sel.copied')), () => {});
      break;
    }
    case 'shell-again': {
      const r = S?.chat.find((c) => c.id === id)?.shell;
      if (r) void tryCall('shell:run', r.cmd, r.repo || null).then((x) => { if (!x.ok) toast(x.error, true); });
      break;
    }
    case 'reply-cancel': {
      const box = el.dataset.box === 'ws' ? 'ws' : 'chat';
      ui.reply[box] = null;
      renderReply(box);
      $(box === 'chat' ? '#chat-input' : '#ws-input').focus();
      break;
    }
    case 'ins-tab': ui.insTab = el.dataset.v === 'memo' ? 'memo' : el.dataset.v === 'auto' ? 'auto' : 'inbox'; ui.memoEdit = null; ui.memoDel = null; renderChatInspector(); swapIn($('#chat-ins')); break;
    case 'send-err-x': { const box = el.dataset.box === 'ws' ? 'ws' : 'chat'; setSendErr(box, ''); $(box === 'chat' ? '#chat-input' : '#ws-input').focus(); break; }
    case 'form-err-x': if (id === 'memo' || id === 'auto') { ui.formErr[id] = ''; renderChatInspector(); } break;
    // The Worker composer: send a normal message past the open decision, or answer it after all (M7).
    case 'dec-as-message': if (id) { ui.decAsMessage.add(id); renderComposerDecision(); $('#ws-input').focus(); } break;
    case 'dec-answer-it': if (id) { ui.decAsMessage.delete(id); renderComposerDecision(); $('#ws-input').focus(); } break;
    case 'memo-add': await addMemo(); break;
    case 'auto-add': await addAuto(); break;
    case 'cmp-changes': if (id) go({ view: 'worker', wSel: id, wOpen: true, wTab: 'changes' }); break;
    case 'cmp-pick': (el as HTMLButtonElement).disabled = true; await call('compare:pick', id); break;
    case 'auto-remove': if (ui.memoDel === id) { ui.memoDel = null; await call('auto:remove', id); } else askMemoDel(id ?? null); break;
    case 'memo-share': { const m = S!.memos.find((x) => x.id === id); if (m) await call('memo:update', id, { shared: !m.shared }); break; }
    case 'memo-edit': ui.memoEdit = id; ui.memoDel = null; renderChatInspector(); document.querySelector<HTMLTextAreaElement>(`[data-keep="memo-${id}"]`)?.focus(); break;
    case 'memo-edit-cancel': ui.memoEdit = null; renderChatInspector(); break;
    case 'memo-save': {
      const text = document.querySelector<HTMLTextAreaElement>(`[data-keep="memo-${id}"]`)?.value ?? '';
      ui.memoEdit = null;
      if (text.trim()) await call('memo:update', id, { text });
      renderChatInspector();
      break;
    }
    case 'memo-remove': if (ui.memoDel === id) await removeMemo(id!); else askMemoDel(id ?? null); break;
    case 'done-toggle': ui.doneOpen = !ui.doneOpen; store('oma.doneOpen', ui.doneOpen); renderSidebar(); break;
    case 'ins-toggle': togglePanel('ins'); break;
    case 'away-dismiss': setAway(null); renderChatInspector(); break;
    case 'cmdk-open': openPalette(); break;
    case 'cmdk-close': closePalette(); break;
    case 'cmdk-run': runPalette(Number(el.dataset.i)); break;
    case 'reveal-memory': await call('open:path', `${S!.settings.home}/memory`); break;
    case 'reveal-claude': if (ui.claude) await call('open:path', ui.claude.home); break;
    case 'ctx-menu': {
      const menu = $('#ctxmenu');
      if (!menu.hidden && menu.dataset.for === 'ctx') { menu.hidden = true; break; }
      const empty = !S!.dispatcher.contextTokens;
      menu.dataset.for = 'ctx';
      const spent = hasSpend(S!.dispatcher.spend) ? `<div class="note">${t('spend.dispatcher')}<br>${spendHtml(S!.dispatcher.spend)}</div><hr>` : '';
      menu.innerHTML = `${spent}<button data-action="ctx-compact"${empty ? ' disabled' : ''}>${t('ctx.compact')}</button><button data-action="ctx-clear"${empty ? ' disabled' : ''}>${t('ctx.clear')}</button>`;
      menu.hidden = false;
      const r = el.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${r.top - menu.offsetHeight - 6}px`;
      menu.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
      break;
    }
    case 'ctx-compact': $('#ctxmenu').hidden = true; await call('dispatcher:compact'); break;
    case 'ctx-clear': $('#ctxmenu').hidden = true; await call('dispatcher:clear'); break;
    case 'close-settings': closeSettings(); break;
    case 'pane': showPane(id as Pane); break;
    case 'goto-decision': {
      // In the view of the Worker that asks, its own panel shows the card.
      const here = ui.view === 'worker' && ui.wOpen && !!document.getElementById(`wdec-${id}`);
      if (!here) {
        // The card is in the inbox tab of the right sidebar: show both before looking for it.
        ui.insTab = 'inbox';
        if (ui.insMin) togglePanel('ins');
        go({ view: 'chat' });
        renderChatInspector();
        // The card becomes the selected one and takes the focus, so its keys work at once.
        markDecision(id);
        decisionCard(id)?.focus({ preventScroll: true });
      }
      flashCard(document.getElementById(`${here ? 'wdec' : 'dec'}-${id}`));
      break;
    }
    case 'open-worker': openWorker(id); break;
    case 'select-worker': openWorker(id); break;
    case 'close-session': go({ wOpen: false }); break;
    case 'ws-tab': go({ wTab: el.dataset.v as Screen['wTab'] }); break;
    case 'diff-refresh': ui.diffs.delete(id); renderSession(true); break;
    case 'issues-refresh': if (id) { ui.issues.delete(id); renderRepos(); } break;
    case 'issue-assign': {
      const list = id ? ui.issues.get(id) : undefined;
      const issue = Array.isArray(list) ? list.find((i) => i.number === Number(el.dataset.n)) : undefined;
      if (!id || !issue) break;
      (el as HTMLButtonElement).disabled = true;
      await call('chat:send', issueMessage(id, issue), []);
      toast(t('issue.sent', { n: issue.number }));
      go({ view: 'chat' });
      break;
    }
    case 'grant-revoke': await call('task:revoke', id, el.dataset.key); break;
    case 'diag-export': {
      (el as HTMLButtonElement).disabled = true;
      const file = await call<string | null>('diag:export');
      (el as HTMLButtonElement).disabled = false;
      if (file) toast(t('set.diagSaved'));
      break;
    }
    case 'preflight-run': void loadPreflight(); break;
    case 'jira-token-clear': await call('jira:token', ''); setJira(undefined); S!.settings.jiraTokenSet = false; openSettings(); break;
    case 'jira-refresh': void loadJira(); renderRepos(); break;
    case 'jira-assign': {
      const issue = Array.isArray(jira) ? jira.find((i) => i.key === id) : undefined;
      if (!issue) break;
      (el as HTMLButtonElement).disabled = true;
      await call('chat:send', jiraMessage(issue), []);
      toast(t('jira.sent', { key: issue.key }));
      go({ view: 'chat' });
      break;
    }
    case 'run-start': await call('run:start', id); break;
    case 'run-stop': await call('run:stop', id); break;
    case 'run-clear': await call('run:clear', id); break;
    case 'pr-merge': {
      if (!id) break;
      if (ui.mergeAsk !== id) { ui.mergeAsk = id; renderAll(true); break; }
      ui.mergeAsk = null;
      ui.merging.add(id);
      renderAll(true);
      await call('pr:merge', id);
      ui.merging.delete(id);
      renderAll(true);
      break;
    }
    case 'bundle-merge': {
      const b = openBundles(S!.tasks).find((x) => x.name === id);
      if (!b || !b.ready) break;
      const key = `b:${b.name}`;
      if (ui.mergeAsk !== key) { ui.mergeAsk = key; renderAll(true); break; }
      ui.mergeAsk = null;
      ui.merging.add(key);
      renderAll(true);
      // In the order the tasks were made, and no further once one fails: a later PR may depend on it.
      const list = bundleMergeOrder(b);
      let merged = 0;
      for (const x of list) {
        try { await ide.call('pr:merge', x.id); merged++; } catch (e) { toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); break; }
      }
      ui.merging.delete(key);
      if (merged === list.length) toast(t('pr.mergedAll', { n: merged }));
      else if (merged) toast(t('bundle.stopped', { n: merged, m: list.length - merged }), true);
      renderAll(true);
      break;
    }
    case 'pr-merge-all': {
      if (ui.mergeAsk !== '*') { ui.mergeAsk = '*'; renderAll(true); break; }
      ui.mergeAsk = null;
      const list = readyToMerge(S!.tasks);
      ui.merging.add('*');
      for (const x of list) ui.merging.add(x.id);
      renderAll(true);
      // One after another: each merge can change whether the next is still ready, and the app checks again before each.
      let merged = 0;
      for (const x of list) {
        try { await ide.call('pr:merge', x.id); merged++; } catch { /* counted below */ }
        ui.merging.delete(x.id);
        renderAll(true);
      }
      ui.merging.delete('*');
      toast(merged === list.length ? t('pr.mergedAll', { n: merged }) : t('pr.mergedSome', { n: merged, m: list.length - merged }), merged !== list.length);
      renderAll(true);
      break;
    }
    case 'diff-note': {
      // Selecting text in the diff is not a click on its line.
      if (String(getSelection() ?? '')) break;
      const w = worker(ui.wSel);
      if (!w || !id) break;
      ui.diffDraft = { wid: w.id, path: id.slice(w.id.length + 1), at: Number(el.dataset.i) };
      renderDiff(w);
      $<HTMLTextAreaElement>('#dnote-in')?.focus();
      break;
    }
    case 'ckpt-menu': if (id) await openCheckpoints(el, id); break;
    case 'ckpt-cancel': { ui.ckptAsk = null; const w = worker(ui.wSel); if (w) renderDiff(w); break; }
    case 'ckpt-restore': {
      const a = ui.ckptAsk;
      if (!a) break;
      (el as HTMLButtonElement).disabled = true;
      const done = await call('worker:restore', a.wid, a.ref).then(() => true, () => false);
      ui.ckptAsk = null;
      ui.diffs.delete(a.wid);
      if (done !== false) toast(t('ckpt.done', { t: hhmm(a.at) }));
      renderSession(true);
      break;
    }
    case 'diff-note-add': addDiffNote(); break;
    case 'diff-note-cancel': { ui.diffDraft = null; const w = worker(ui.wSel); if (w) renderDiff(w); break; }
    case 'diff-note-del': {
      const w = worker(ui.wSel);
      if (!w || !id) break;
      const path = id.slice(w.id.length + 1), at = Number(el.dataset.i);
      ui.diffNotes.set(w.id, (ui.diffNotes.get(w.id) ?? []).filter((n) => !(n.path === path && n.at === at)));
      renderDiff(w);
      break;
    }
    case 'diff-notes-send': {
      const w = worker(ui.wSel);
      const msg = w ? reviewMessage(ui.diffNotes.get(w.id) ?? []) : '';
      if (!w || !msg) break;
      (el as HTMLButtonElement).disabled = true;
      // A failed send keeps the notes to send again (L8).
      const r = await tryCall('worker:send', w.id, msg, []);
      if (!r.ok) { (el as HTMLButtonElement).disabled = false; toast(r.error, true); break; }
      ui.diffNotes.delete(w.id);
      ui.diffDraft = null;
      go({ wTab: 'chat' });
      break;
    }
    case 'diff-file': {
      if (ui.diffOpen.has(id)) ui.diffOpen.delete(id); else ui.diffOpen.add(id);
      const w = worker(ui.wSel);
      if (w) renderDiff(w);
      break;
    }
    case 'answer': {
      if (el.closest('[data-dec]')) ui.decAnswered = { id, at: Date.now() };
      el.closest('.dec')?.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
      await call('decision:answer', id, el.dataset.val);
      break;
    }
    case 'queue-prompt': {
      if (!ui.qOpen.delete(id)) ui.qOpen.add(id);
      renderWorkerInspector();
      document.querySelector<HTMLButtonElement>(`[data-action="queue-prompt"][data-id="${CSS.escape(id)}"]`)?.focus();
      break;
    }
    case 'plan-toggle': {
      if (!ui.planOpen.delete(id)) ui.planOpen.add(id);
      renderChatInspector();
      document.querySelector<HTMLButtonElement>(`[data-action="plan-toggle"][data-id="${CSS.escape(id)}"]`)?.focus();
      break;
    }
    case 'open-url': e.preventDefault();
      // A drag that selected text and ended on the link copies it; it does not open it.
      if (String(getSelection() ?? '')) break;
      await call('open:external', el.dataset.href); break;
    case 'open-file': e.preventDefault(); await call('open:path', el.dataset.path); break;
    case 'reveal': e.preventDefault(); await call('reveal:path', el.dataset.path); break;
    case 'unattach': {
      const box = el.dataset.box as Box;
      ui.attach[box].splice(Number(el.dataset.i), 1);
      renderChips(box);
      break;
    }
    case 'page-more': {
      // A "Show more" button (moreBtn): the next page of its list. Focus moves to the button that replaces it,
      // below the new items, without scrolling there, so the list stays where the new items start.
      const key = el.dataset.page ?? '';
      if (key === 'mem-hits') await searchMem(ui.memQ, ui.memHits?.length ?? 0);
      else {
        const n = Number(el.dataset.n) || 1;
        ui.pages.set(key, shownOf(key, n) + n);
        renderAll();
      }
      document.querySelector<HTMLElement>(`[data-action="page-more"][data-page="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
      break;
    }
    case 'page-older': if (el.dataset.v === 'chat') void olderChat(); else if (ui.wSel) void olderLog(ui.wSel); break;
    case 'clear': {
      const kind = el.dataset.kind as 'result' | 'auto';
      const ids = kind === 'auto' ? S!.autoAnswers.filter((x) => !x.cleared).map((x) => x.id) : S!.results.map((c) => c.id);
      ui.undo.push({ kind, ids });
      await call('chat:clear', kind);
      toast(t(kind === 'auto' ? 'toast.clearedAuto' : 'toast.clearedResults', { key: isMac ? '⌘Z' : 'Ctrl+Z' }));
      break;
    }
    case 'aa-select': {
      if (ui.view !== 'chat') go({ view: 'chat' });
      ui.aaSel = id;
      // An older one may be past the pages shown.
      const at = visibleAutos().findIndex((x) => x.id === id);
      if (at >= 0) ui.pages.set('autos', pagesFor(at, shownOf('autos', PAGE.autos), PAGE.autos));
      renderChatInspector();
      document.getElementById(`aa-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      break;
    }
    case 'aa-edit': ui.aaEdit = id; ui.aaSel = id; renderChatInspector(); (document.querySelector(`[data-keep="aa-${id}"]`) as HTMLInputElement | null)?.focus(); break;
    case 'aa-cancel': ui.aaEdit = null; renderChatInspector(); break;
    case 'sug-edit': ui.sugEdit = id; renderChatInspector(); document.querySelector<HTMLInputElement>(`[data-keep="sug-${id}"]`)?.focus(); break;
    case 'sug-cancel': ui.sugEdit = null; renderChatInspector(); break;
    case 'sug-save': await saveSug(id); break;
    case 'sug-dismiss': await call('suggest:dismiss', id); break;
    case 'aa-send': {
      const inp = document.querySelector<HTMLInputElement>(`[data-keep="aa-${id}"]`);
      const v = inp?.value.trim();
      if (!v) { inp?.focus(); return; }
      const scope = (document.querySelector<HTMLInputElement>(`input[name="scope-${id}"]:checked`)?.value ?? 'once') as 'once' | 'preference';
      ui.aaEdit = null;
      await call('auto:correct', id, v, scope);
      break;
    }
    case 'worker-stop':
      if (ui.stopping.has(id)) break;
      ui.stopping.add(id); renderSidebar();
      try { await call('worker:stop', id); } finally { ui.stopping.delete(id); renderSidebar(); }
      break;
    case 'worker-continue': {
      // A message to a Worker whose last task failed reopens that task (workers.ts, reopenLast). Once it is sent the
      // Worker runs and the screen is drawn again without the button, so only a failed send gives it back.
      (el as HTMLButtonElement).disabled = true;
      const r = await tryCall('worker:send', id, t('wk.continueMsg'), []);
      if (!r.ok) { (el as HTMLButtonElement).disabled = false; toast(r.error, true); }
      break;
    }
    case 'task-cancel': ui.cancelAsk = { ids: [id], all: false }; renderCancelDialog(); break;
    case 'queue-clear': ui.cancelAsk = { ids: [], all: true }; renderCancelDialog(); break;
    case 'cancel-dismiss': ui.cancelAsk = null; renderCancelDialog(); break;
    case 'cancel-ok': await confirmCancel(); break;
    case 'worker-archive': await archiveWorker(id); break;
    case 'confirm-dismiss': ui.confirmAsk = null; renderConfirmDialog(); break;
    case 'keys-close': closeShortcuts(); break;
    case 'confirm-ok': await confirmOk(); break;
    case 'worker-unarchive': await call('worker:unarchive', id); break;
    case 'worker-msg': openWorker(id); setTimeout(() => $('#ws-input').focus(), 30); break;
    case 'repo-select': if (!ui.repoAdding) ui.repoAdd = false; go({ repoSel: id }); renderRepos(); break;
    case 'repo-add-open': ui.repoAdd = true; ui.repoAddError = ''; renderRepos(); $('#repo-add-url').focus(); break;
    case 'repo-add-cancel':
      // During a clone, Cancel stops it; the form stays with what was typed.
      if (ui.repoAdding) { await call('repo:addCancel'); break; }
      ui.repoAdd = false; renderRepos(); break;
    case 'repo-add-pick': {
      const p = await call<string | null>('repo:pickFolder');
      if (p) { $<HTMLInputElement>('#repo-add-url').value = p; $<HTMLInputElement>('#repo-add-url').focus(); }
      break;
    }
    case 'repo-add': await addRepo(); break;
    case 'repo-save': await call('repo:update', id, $<HTMLTextAreaElement>('#repo-desc').value, $<HTMLTextAreaElement>('#repo-setup').value, $<HTMLTextAreaElement>('#repo-run').value); toast(t('toast.descSaved')); break;
    case 'repo-remove': askRepoRemove(id); break;
    // Picking the open file again reads it again (a Worker may have changed it).
    case 'mem-select': if (ui.memSel === id) void readMemFile(id); else go({ memSel: id }); break;
    case 'mem-sync': await call('memory:sync'); break;
    case 'mem-save': {
      if (!ui.memSel) return;
      ui.memText = $<HTMLTextAreaElement>('#mem-edit').value;
      await call('memory:write', ui.memSel, ui.memText);
      toast(t('toast.memSaved'));
      void loadMemory();
      break;
    }
    case 'mem-promote': {
      if (!S!.repos.some((r) => r.name === id)) { toast(t('err.noRepo', { name: id }), true); return; }
      const tid = await call<string>('memory:promote', id);
      if (tid) toast(t('toast.promoted', { id: tid }));
      break;
    }
    case 'acc-add': {
      const r = await call('account:add', $<HTMLInputElement>('#acc-label').value, 'token', $<HTMLInputElement>('#acc-token').value, $<HTMLInputElement>('#acc-plan').value);
      if (r) { $<HTMLInputElement>('#acc-token').value = ''; $<HTMLInputElement>('#acc-label').value = ''; toast(t('toast.accAdded')); }
      break;
    }
    case 'acc-add-login': {
      const r = await call('account:add', $<HTMLInputElement>('#acc-label').value || t('acc.loginName'), 'login', '', $<HTMLInputElement>('#acc-plan').value);
      if (r) { $<HTMLInputElement>('#acc-label').value = ''; ui.accKind = 'token'; toast(t('toast.loginAdded')); }
      break;
    }
    case 'acc-add-chatgpt': {
      const r = await call('account:addChatgpt', $<HTMLInputElement>('#acc-label').value);
      if (r) { $<HTMLInputElement>('#acc-label').value = ''; ui.accKind = 'token'; toast(t('toast.chatgptAdded')); void loadModels('now'); }
      break;
    }
    case 'acc-menu': ui.accMenu = ui.accMenu === id ? null : id; ui.accRename = null; openSettings(); break;
    case 'acc-dismiss': ui.accMenu = null; ui.accRename = null; openSettings(); break;
    case 'acc-rename': ui.accMenu = null; ui.accRename = id; openSettings(); break;
    case 'acc-rename-cancel': ui.accRename = null; openSettings(); break;
    case 'acc-rename-save': {
      const nv = ($('#acc-rename') as HTMLInputElement | null)?.value.trim();
      ui.accRename = null;
      if (nv) await call('account:rename', id, nv);
      openSettings();
      break;
    }
    case 'acc-refresh': ui.accMenu = null; openSettings(); await call('usage:refresh'); break;
    case 'usage-refresh': await call('usage:refresh'); break;
    case 'acc-plan': ui.accMenu = null; openSettings(); await call('account:plan', id, el.dataset.v); break;
    case 'acc-remove': ui.accMenu = null; ui.accRemove = id; openSettings(); break;
    case 'acc-remove-cancel': ui.accRemove = null; openSettings(); break;
    case 'acc-remove-ok': ui.accRemove = null; openSettings(); await call('account:remove', id); break;
    case 'pick-home': {
      const p = await call<string | null>('settings:pickHome');
      if (p) { $<HTMLInputElement>('#set-home').value = p; void saveSettingsNow(); }
      break;
    }
    case 'pick-sound': {
      const p = await call<string | null>('sound:pick');
      if (p) { $<HTMLInputElement>('#set-sfile').value = p; void saveSettingsNow(); }
      break;
    }
    case 'restart-later': ui.restartAsk = false; openSettings(); break;
    case 'restart-now': await call('app:relaunch'); break;
    case 'models-refresh': void loadModels('now'); break;
    case 'font-reset': {
      $<HTMLInputElement>('#set-font').value = '';
      $<HTMLInputElement>('#set-fsize').value = String(FONT_SIZE_DEFAULT);
      previewFont();
      void saveSettingsNow();
      break;
    }
    case 'sound-test': {
      const f = readSettingsForm();
      await playSound(el.dataset.v === 'done' ? f.doneSound : f.sound, f.soundVolume, f.customSound);
      break;
    }
  }
}

/** Shows the context menu at (x, y) and moves the focus into it; closing gives the focus back (L14). */
let ctxReturn: HTMLElement | null = null;
function openCtxMenu(x: number, y: number, h: number) {
  const menu = $('#ctxmenu');
  ctxReturn = document.activeElement as HTMLElement | null;
  menu.style.left = `${Math.min(x, innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, innerHeight - h)}px`;
  menu.hidden = false;
  menu.querySelector<HTMLElement>('button')?.focus();
}
export function closeCtxMenu(refocus = false) {
  const menu = $('#ctxmenu');
  if (menu.hidden) return;
  menu.hidden = true;
  if (refocus && ctxReturn?.isConnected) ctxReturn.focus();
  ctxReturn = null;
}

/** The composer grows with its text up to half the window; past that it scrolls with no visible bar. */
export function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = Math.min(Math.round(window.innerHeight * 0.5), el.scrollHeight) + 'px';
}

/** `send` resolves to null once the text went, or to why it did not; then the text, files and reply stay (L8). */
export function bindComposer(box: Box, formSel: string, inputSel: string, send: (text: string, files: string[]) => Promise<string | null>) {
  let sending = false;
  const form = $<HTMLFormElement>(formSel);
  const input = $<HTMLTextAreaElement>(inputSel);
  // The composer floats over the end of its thread, so the thread keeps that much room below the last message.
  const host = form.parentElement!;
  const thread = host.querySelector<HTMLElement>('.thread');
  new ResizeObserver(() => {
    const h = `${form.offsetHeight}px`;
    if (host.style.getPropertyValue('--composer-h') === h) return;
    const atEnd = !!thread && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
    host.style.setProperty('--composer-h', h);
    if (thread && atEnd) scrollQuietly(thread, thread.scrollHeight);
  }).observe(form);
  input.addEventListener('input', () => { if (box === 'chat') shellInput(input); autosize(input); updateSendButton(); });
  // Files copied in Explorer or Finder attach as if dropped here.
  input.addEventListener('paste', (e) => pasteFiles(box, e));
  input.addEventListener('keydown', (e) => {
    if (box === 'chat' && shellKeys(e, input)) { updateSendButton(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending) return;
    // A shell line takes no files and no reply: they stay for the next message.
    const sh = box === 'chat' && ui.shell;
    const files = sh ? [] : [...ui.attach[box]];
    const typed = input.value;
    const text = typed.trim() || (files.length ? t('attach.defaultText') : '');
    if (!text) return;
    // The Worker composer is shared: what comes after the send belongs to the Worker it went to.
    const target = box === 'ws' ? ui.wSel : null;
    const reply = ui.reply[box];
    sending = true;
    // Sending goes to the end of the thread, scrolled up or not, and follows what comes after it.
    if (thread) {
      if (box === 'chat') renderChat(true); else renderSession(true);
      scrollQuietly(thread, thread.scrollHeight);
    }
    const err = await send(text, files);
    sending = false;
    if (box === 'ws' && ui.wSel !== target) { if (err) toast(err, true); return; }
    setSendErr(box, err ?? '');
    if (err) return;
    if (thread) scrollQuietly(thread, thread.scrollHeight);
    if (!sh && ui.reply[box] === reply) { ui.reply[box] = null; renderReply(box); }
    // What was typed while it went stays.
    if (input.value === typed) input.value = '';
    ui.attach[box] = ui.attach[box].filter((f) => !files.includes(f));
    renderChips(box);
    autosize(input);
    updateSendButton();
    if (box === 'ws') renderComposerDecision();
  });
}

/** Files dropped anywhere go to the visible composer; never let the window navigate to them. */
export function bindDrop() {
  let depth = 0;
  const target = (): Box | null => (ui.settingsShown ? null : ui.view === 'chat' ? 'chat' : ui.view === 'worker' && ui.wOpen && ui.wSel ? 'ws' : null);
  const setHot = (on: boolean) => {
    const box = target();
    document.querySelectorAll('.composer').forEach((c) => c.classList.remove('drop'));
    if (on && box) $(box === 'chat' ? '#chat-form' : '#ws-form').classList.add('drop');
  };
  document.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; setHot(true); } });
  document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) setHot(false); });
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = target() ? 'copy' : 'none';
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    setHot(false);
    const box = target();
    if (!box) { toast(t('attach.where'), true); return; }
    addFiles(box, e.dataTransfer?.files ?? null);
    $(box === 'chat' ? '#chat-input' : '#ws-input').focus();
  });
}

export function init() {
  // The panels a state update draws again. Each skips a write of what it already shows (ui/core.ts).
  for (const id of ['side', 'usage', 'chat-ins', 'wk-list', 'wk-ins', 'repo-main', 'repo-ins']) {
    const el = document.getElementById(id);
    if (el) skipSameHtml(el);
  }
  // Anything the user does makes the next draw a real one. Capture, so it counts before the handlers run.
  for (const type of ['click', 'keydown', 'input', 'change', 'drop', 'contextmenu']) document.addEventListener(type, userActed, true);
  document.body.classList.add(`platform-${ide.platform}`);
  ide.onFullScreen((on) => document.body.classList.toggle('fullscreen', on));
  // Before the first paint, so a sidebar that was put away does not animate shut at launch.
  applyPanels();
  initResize();
  document.addEventListener('click', (e) => {
    const tgt = e.target as HTMLElement;
    const segBtn = tgt.closest<HTMLButtonElement>('[data-segc]');
    if (segBtn) { pickSeg(segBtn); return; }
    const dd = tgt.closest<HTMLElement>('[data-dd]');
    if (dd) { openModelPicker(dd); return; }
    const combo = tgt.closest<HTMLElement>('[data-combo]');
    if (combo) {
      const inp = document.getElementById(combo.dataset.combo!) as HTMLInputElement;
      if (pop.owner === inp) closePop(); else { inp.focus(); void openFontPicker(inp, false); }
      return;
    }
    if (tgt.id === 'set-font' && pop.owner !== tgt) { void openFontPicker(tgt as HTMLInputElement, false); return; }
    const step = tgt.closest<HTMLElement>('[data-step]');
    if (step) { stepValue(step.dataset.for!, Number(step.dataset.step)); return; }
    if (pop.el && !pop.el.contains(tgt) && tgt !== pop.owner) closePop();
    if (ui.memoDel && !tgt.closest('.mact.del.sure')) askMemoDel(null);
    if (ui.mergeAsk && !tgt.closest('.prmerge.sure, .h-act.sure, [data-action="bundle-merge"]')) { ui.mergeAsk = null; renderAll(true); }
    const el = tgt.closest<HTMLElement>('[data-action]');
    if (el) void act(el, e);
    if (!(e.target as HTMLElement).closest('#ctxmenu, #chat-ctx') || el?.hasAttribute('data-close')) $('#ctxmenu').hidden = true;
  });
  document.addEventListener('change', async (e) => {
    const el = e.target as HTMLSelectElement;
    if (el.dataset.change === 'sound-kind') syncSoundRows();
    // The Jira token goes to the main process by itself and is cleared from the field: it is never part of the page's state.
    if (el.id === 'set-jtok') {
      const tok = (el as unknown as HTMLInputElement).value.trim();
      if (!tok) return;
      (el as unknown as HTMLInputElement).value = '';
      await call('jira:token', tok);
      setJira(undefined);
      S!.settings.jiraTokenSet = true;
      openSettings();
      toast(t('set.jiraSaved'));
      return;
    }
    if (el.dataset.change === 'auto-toggle') { void call('auto:toggle', el.dataset.id, (el as unknown as HTMLInputElement).checked); return; }
    if (el.id === 'auto-wk') { ui.autoWk = (el as unknown as HTMLInputElement).checked; return; }
    if (el.id === 'auto-kind') { ui.autoKind = el.value === 'merged' ? 'merged' : 'daily'; el.closest('.auto-add')?.classList.toggle('merged', ui.autoKind === 'merged'); return; }
    if (el.dataset.change === 'acc-kind') { ui.accKind = el.value as typeof ui.accKind; syncAccRows(); }
    if (el.id === 'usage-every') { void call('settings:save', { usageRefreshMins: Number(el.value) }); return; }
    if (el.id === 'set-gh') el.value = hostOnly(el.value);
    if (el.closest?.('#sheet')) void saveSettingsNow();
  });
  document.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'cmdk-q') { renderPalette(el.value); return; }
    if (el.id === 'set-qkey') el.classList.toggle('bad', normalizeQuickKey(el.value) === null);
    if (el.id === 'set-qfrom' || el.id === 'set-qto') el.classList.toggle('bad', !!el.value.trim() && !cleanTime(el.value));
    if (el.id === 'set-vol') syncSlider(el);
    if (el.id === 'set-fsize') previewFont();
    if (el.id === 'set-font') { markFont(el); previewFont(); void openFontPicker(el, false); }
    if (el.id === 'set-q') { ui.setQ = el.value; filterPanes(); return; }
    if (el.closest('#sheet') && el.id !== 'set-home') saveSoon(el.matches('.step-v, .slider') ? 300 : 600);
  });
  document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.addEventListener('click', () => go({ view: b.dataset.v as View })));
  // Mouse side buttons step through the screen history. Their default (the page's own history) is blocked.
  const sideButton = (e: MouseEvent) => e.button === 3 || e.button === 4;
  document.addEventListener('mousedown', (e) => { if (sideButton(e)) e.preventDefault(); });
  document.addEventListener('auxclick', (e) => { if (sideButton(e)) e.preventDefault(); });
  document.addEventListener('mouseup', (e) => {
    if (!sideButton(e)) return;
    e.preventDefault();
    navStep(e.button === 3 ? 'back' : 'forward', 'mouse');
  });
  ide.onNav((dir) => navStep(dir, 'os'));
  // Liquid Glass pills follow every change of selection, however the control was updated.
  // Controls that follow their width (pills, compact tabs and button rows) are picked up as they appear.
  new MutationObserver(() => glideSoon(true)).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-pressed', 'aria-checked', 'aria-selected', 'hidden'] });
  window.addEventListener('resize', () => glideAll(false));
  void document.fonts.ready.then(() => glideAll(false));
  glideAll(false);
  void loadModels('cached');
  $('#sheet').addEventListener('scroll', () => closePop(), true);
  const usage = $('#usage');
  usage.addEventListener('mouseover', (e) => {
    if (!usage.classList.contains('usage')) return;
    showUsagePop();
    hoverUsage((e.target as HTMLElement).closest<HTMLElement>('.uacct')?.dataset.id ?? null);
  });
  // The popover holds a refresh button and the interval: the pointer may cross to it, and the keyboard goes in with ↓.
  const upop = $('#usage-pop');
  usage.addEventListener('mouseleave', hideUsageSoon);
  upop.addEventListener('mouseenter', showUsagePop);
  upop.addEventListener('mouseleave', hideUsageSoon);
  usage.addEventListener('focus', () => { if (!usagePop.quiet && usage.matches(':focus-visible')) showUsagePop(); });
  usage.addEventListener('blur', (e) => { if (!upop.contains(e.relatedTarget as Node | null)) hideUsagePop(); });
  upop.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && (upop.contains(to) || to === usage)) return;
    // The focus left with a redraw of the popover (refreshUsagePop puts it back), or went elsewhere.
    if (!to) return;
    hideUsagePop();
  });
  usage.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'Enter') return;
    if (!usage.classList.contains('usage')) return;
    e.preventDefault();
    showUsagePop();
    upop.querySelector<HTMLElement>('.ubtn:not(:disabled), [data-segc][aria-checked="true"]')?.focus();
  });
  window.addEventListener('resize', () => { closePop(); hideUsagePop(); });
  // Scroll events don't bubble; capturing on document sees every scrolling element.
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  // A card that gets the focus (a click, Tab, a button in it) becomes the selected one.
  document.addEventListener('focusin', (e) => {
    const card = (e.target as HTMLElement).closest?.<HTMLElement>('#chat-ins [data-dec]');
    if (card && card.dataset.dec !== ui.decSel) markDecision(card.dataset.dec ?? null);
  });

  // Enter in an input runs the action named in data-enter.
  document.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    // Ctrl/Cmd+K opens the palette from anywhere, and closes it.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyK') { e.preventDefault(); if (cmdk.open) closePalette(); else openPalette(); return; }
    if (cmdk.open) { paletteKeys(e); return; }
    // Ctrl/Cmd+/ opens the list of keys, and closes it.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'Slash') { e.preventDefault(); if (shortcutsOpen()) closeShortcuts(); else if (!ui.settingsShown) openShortcuts(); return; }
    // A dialog that asks keeps the keyboard inside it: Tab goes round its own controls.
    if (e.key === 'Tab') {
      // A dialog over the Settings sheet first, then the sheet itself (L14).
      const shown = (d: HTMLElement) => !!d.getClientRects().length;
      const dlg = [...document.querySelectorAll<HTMLElement>('.dlg[aria-modal="true"]')].find(shown) ?? [...document.querySelectorAll<HTMLElement>('#sheet[aria-modal="true"]')].find((d) => !d.hidden && shown(d));
      if (dlg) {
        const stops = [...dlg.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(shown);
        const at = stops.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
        return;
      }
    }
    if (popKeys(e)) return;
    // K1: the focused inbox card answers to keys while no text field has the focus. Enter on one of its buttons is
    // left to that button.
    const card = el.closest?.<HTMLElement>('#chat-ins [data-dec]');
    if (card && !el.matches('input, textarea, [contenteditable="true"]')) {
      const k = cardKey(e);
      if (k && (k.act === 'next' || k.act === 'prev')) { e.preventDefault(); moveDecision(k.act === 'next' ? 1 : -1); return; }
      // A held key repeats: it must not go on to answer the card that takes the focus next.
      if (k && e.repeat) { e.preventDefault(); return; }
      const d = k && !(k.act === 'enter' && el !== card) ? S?.decisions.find((x) => x.id === card.dataset.dec) : null;
      const val = d && k ? keyAnswer(d, k) : null;
      const btn = val ? card.querySelector<HTMLButtonElement>(`button[data-action="answer"][data-val="${CSS.escape(val)}"]`) : null;
      if (btn) { e.preventDefault(); if (!btn.disabled) void act(btn, e); return; }
    }
    // A row that acts on a click does the same on Enter or Space; a link does on Enter.
    if ((e.key === 'Enter' || e.key === ' ') && !e.isComposing && el.matches?.('div[data-action][tabindex], span[role="button"][data-action][tabindex]')) { e.preventDefault(); void act(el, e); return; }
    if (e.key === 'Enter' && !e.isComposing && el.matches?.('a[data-action][tabindex]')) { e.preventDefault(); void act(el, e); return; }
    // Ctrl/Cmd+B puts the left sidebar away, with Alt the right one. Not while Settings covers them.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyB' && !ui.settingsShown) { e.preventDefault(); togglePanel(e.altKey ? 'ins' : 'side'); return; }
    if (el.id === 'set-font' && e.key === 'ArrowDown') { e.preventDefault(); void openFontPicker(el as HTMLInputElement, true); return; }
    if (el.classList.contains('step-v') && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); stepValue(el.id, e.key === 'ArrowUp' ? 1 : -1); return; }
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && el.dataset?.enter && !(e.shiftKey && el.tagName === 'TEXTAREA')) {
      e.preventDefault();
      if (el.dataset.enter === 'answer-custom') {
        const v = (el as HTMLInputElement).value.trim();
        if (v && el.closest('[data-dec]')) ui.decAnswered = { id: el.dataset.id!, at: Date.now() };
        if (v) void call('decision:answer', el.dataset.id, v);
      } else if (el.dataset.enter === 'repo-add') {
        void addRepo();
      } else if (el.dataset.enter === 'diff-note-add') {
        addDiffNote();
      } else if (el.dataset.enter === 'memo-add') {
        void addMemo();
      } else if (el.dataset.enter === 'sug-save') {
        void saveSug(el.dataset.id ?? '');
      } else if (el.dataset.enter === 'aa-send') {
        void act(Object.assign(document.createElement('button'), { dataset: { action: 'aa-send', id: el.dataset.id } }) as HTMLElement, e);
      }
      return;
    }
    if (el.id === 'acc-rename' && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void act(Object.assign(document.createElement('button'), { dataset: { action: 'acc-rename-save', id: el.dataset.id } }) as HTMLElement, e);
      return;
    }
    // Escape closes one layer at a time, the top one first (L14).
    if (e.key === 'Escape') {
      if (pop.el) { closePop(true); return; }
      if (shortcutsOpen()) { closeShortcuts(); return; }
      if (!$('#ctxmenu').hidden) { closeCtxMenu(true); return; }
      if (ui.cancelAsk) { ui.cancelAsk = null; renderCancelDialog(); return; }
      if (ui.confirmAsk) { ui.confirmAsk = null; renderConfirmDialog(); return; }
      if (usagePop.shown) {
        // From inside the popover, the focus goes back to the rings without opening it again.
        if ($('#usage-pop').contains(document.activeElement)) { usagePop.quiet = true; $('#usage').focus(); usagePop.quiet = false; }
        hideUsagePop();
        return;
      }
      if (ui.settingsShown && (ui.accRemove || ui.accMenu || ui.accRename)) { ui.accRemove = ui.accMenu = ui.accRename = null; openSettings(); return; }
      if (ui.settingsShown) { closeSettings(); return; }
      if (ui.memoDel) { askMemoDel(null); return; }
      if (ui.mergeAsk) { ui.mergeAsk = null; renderAll(true); return; }
      if (ui.diffDraft) { ui.diffDraft = null; const w = worker(ui.wSel); if (w) renderDiff(w); return; }
      if (ui.aaEdit) { ui.aaEdit = null; renderChatInspector(); return; }
      if (ui.sugEdit) { ui.sugEdit = null; renderChatInspector(); return; }
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (el.matches('input, textarea')) return;
      const u = ui.undo.pop();
      if (u) { e.preventDefault(); void call('chat:unclear', u.kind, u.ids); toast(t('toast.undone')); }
    }
    // Under an open dialog or the Settings sheet, the view does not change behind it (L14).
    const covered = ui.settingsShown || !$('#dlg').hidden;
    if (mod && e.key === ',') { e.preventDefault(); if ($('#dlg').hidden) openSettings(); }
    if (mod && /^[1-4]$/.test(e.key) && covered) e.preventDefault();
    else if (mod && /^[1-4]$/.test(e.key)) { e.preventDefault(); go({ view: (['chat', 'worker', 'repo', 'memory'] as const)[Number(e.key) - 1] }); }
    const dir = navKey(e);
    if (dir) { e.preventDefault(); navStep(dir, 'key'); }
  });

  // Context menu on auto-answers and sidebar Worker rows
  document.addEventListener('contextmenu', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-ctx="aa"], [data-ctx="worker"]');
    const menu = $('#ctxmenu');
    if (!el) { menu.hidden = true; return; }
    e.preventDefault();
    const id = el.dataset.id!;
    // Opened from the keyboard (the Menu key, Shift+F10), it shows at the row instead of at the pointer.
    const r = el.getBoundingClientRect();
    const x = e.clientX || r.left + 16, y = e.clientY || r.bottom;
    if (el.dataset.ctx === 'worker') {
      const w = worker(id);
      const cur = w?.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
      menu.dataset.for = 'worker';
      menu.innerHTML = `<button role="menuitem" data-action="open-worker" data-id="${esc(id)}" data-close>${t('wk.open')}</button>${w && canStop(w, cur) ? `<button role="menuitem" data-action="worker-stop" data-id="${esc(id)}" data-close>${t('wk.stop')}</button>` : ''}`;
      openCtxMenu(x, y, 70);
      return;
    }
    menu.dataset.for = 'aa';
    menu.innerHTML = `<button role="menuitem" data-action="aa-edit" data-id="${id}">${t('aa.correct')}…</button><button role="menuitem" data-action="view" data-v="memory">${t('aa.viewMemory')}</button>`;
    openCtxMenu(x, y, 90);
  });
  // The menu keeps the keyboard: arrows move between its items, Tab closes it (L14).
  $('#ctxmenu').addEventListener('keydown', (e) => {
    const items = [...$('#ctxmenu').querySelectorAll<HTMLElement>('button')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
    else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeCtxMenu(true); }
  });

  bindComposer('chat', '#chat-form', '#chat-input', async (text, files) => {
    if (ui.shell) {
      const r = await tryCall<string>('shell:run', text, shellRepo());
      if (r.ok) leaveShell();
      return r.ok ? null : r.error;
    }
    const r = await tryCall('chat:send', replyText('chat', text), files, ui.reply.chat?.task ?? null);
    return r.ok ? null : r.error;
  });
  // Text selected in a conversation is copied when the mouse is let go, as in a terminal; Ctrl/Cmd+C still works.
  // A click (nothing selected) on a link or button does nothing extra.
  for (const sel of ['#chat-thread', '#ws-thread']) {
    const th = $(sel);
    th.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      setTimeout(() => {
        const s = getSelection();
        const text = s && !s.isCollapsed ? String(s) : '';
        if (!text.trim() || !s!.anchorNode || !th.contains(s!.anchorNode)) return;
        void navigator.clipboard.writeText(text).then(() => toast(t('sel.copied')), () => {});
      });
    });
  }
  $('#chat-send').addEventListener('click', (e) => {
    if ($('#chat-send').classList.contains('stop')) { e.preventDefault(); void call('chat:stop'); }
  });
  bindComposer('ws', '#ws-form', '#ws-input', async (text, files) => {
    if (!ui.wSel) return null;
    // The decision the strip above the text names, if any; otherwise a normal message (M7). Main answers it only
    // while it is still open.
    const answers = ui.decShown?.wid === ui.wSel ? ui.decShown.id : null;
    const r = await tryCall('worker:send', ui.wSel, replyText('ws', text), files, answers);
    return r.ok ? null : r.error;
  });
  // The same button as the chat's: with nothing typed, it stops the Worker (L3).
  $('#ws-send').addEventListener('click', (e) => {
    if ($('#ws-send').classList.contains('stop') && ui.wSel) { e.preventDefault(); void call('worker:stop', ui.wSel); }
  });
  bindDrop();

  let memTimer: number | undefined;
  $<HTMLInputElement>('#mem-q').addEventListener('input', (e) => {
    clearTimeout(memTimer);
    const q = (e.target as HTMLInputElement).value.trim();
    memTimer = window.setTimeout(() => void searchMem(q), 200);
  });

  ide.onState((s) => {
    const firstSetup = !S && s.setupNeeded;
    const langChanged = S && S.settings.language !== s.settings.language;
    if (S) ui.chatOlder = slideOlder(ui.chatOlder, S.chat, s.chat, ui.chatFrom);
    const first = !S;
    setS(s);
    // At launch: what happened since the app was last looked at, a quit included.
    if (first) checkAway();
    renderAll();
    // The settings sheet only depends on accounts; re-render it only when they change.
    const accKey = JSON.stringify(s.accounts) + s.setupNeeded;
    const accChanged = accKey !== ui.accKey;
    ui.accKey = accKey;
    if (firstSetup && !ui.settingsShown) openSettings('accounts');
    else if (ui.settingsShown && accChanged && !langChanged) openSettings();
  });
  ide.onWorkerLog((id, item) => {
    const l = ui.logs.get(id);
    if (l) l.push(item);
    // The open Worker's new messages are read out; its thread is not a live region (L14).
    if (ui.view === 'worker' && ui.wOpen && ui.wSel === id && item.from !== 'user') announce(item.text);
    if (ui.view === 'worker' && ui.wSel === id) renderSession();
  });
  ide.onOpenResult(gotoResult);
  // A task ended: its own sound, not the decision's, so the two are told apart by ear.
  ide.onDoneAlert(() => { if (S) void playSound(S.settings.doneSound, S.settings.soundVolume); });
  ide.onDecisionAlert((loud) => {
    // Quiet hours, or one more of a burst from the same Worker: it shows without the sound.
    if (S && loud) void playSound(S.settings.sound, S.settings.soundVolume, S.settings.customSound);
    document.querySelector('.sec-dec')?.classList.add('blink');
    $('#dec-count')?.classList.add('pulse');
    // The right sidebar stays hidden when a decision arrives; its button's count pulses instead.
    const badge = $('#ins-count');
    badge.classList.remove('pulse');
    void badge.offsetWidth;
    badge.classList.add('pulse');
    setTimeout(() => { document.querySelector('.sec-dec')?.classList.remove('blink'); }, 3500);
  });
  window.addEventListener('focus', () => { checkAway(); renderAll(); });
  // Looking away starts the clock; while the window has the focus it is kept current.
  window.addEventListener('blur', markSeen);
  setInterval(() => { if (document.hasFocus()) markSeen(); }, 60_000);
  setInterval(() => { if (S) { renderSidebar(); if (ui.view === 'worker') renderWorkerList(); } }, 60_000);
  // The age and slot clock of decisions: their text only, so nothing is drawn again.
  setInterval(() => tickDecisions(), 15_000);

  void ide.call<AppState>('state').then((s) => {
    setS(s);
    renderAll(true);
    if (s.setupNeeded) openSettings('accounts');
  });
}

init();
