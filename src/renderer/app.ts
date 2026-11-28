// The window's entry: drawing every screen, what each control does, and start-up.
import { panelsFor, type Panel, type Part, type StateMsg } from '../shared/stateSync';
import { hasSpend } from '../shared/spend';
import { parseBasePort } from '../shared/runEnv';
import { reviewMessage } from '../shared/diffComment';
import { readyToQueue } from '../shared/mergeQueue';
import { issueMessage } from '../shared/issues';
import { jiraMessage } from '../shared/jira';
import { bundleMergeOrder, openBundles } from '../shared/bundle';
import { normalizeQuickKey } from '../shared/quickKey';
import { cleanTime, typedTime } from '../shared/notifyRules';
import { rovingIndex } from '../shared/roving';
import { focusAfter, listStep } from '../shared/insPanes';
import { threadKeys } from './ui/thread';
import { focusSelector } from '../shared/focusKey';
import { PAGE, pagesFor, slideOlder } from '../shared/paging';
import { FONT_SIZE_DEFAULT } from '../shared/font';
import { DISPATCHER_DRAFT, Drafts, parseDraft } from '../shared/drafts';
import { readReply } from '../shared/reply';
import { restoreScreen, type Screen, type View, type WorkerFilter } from '../shared/history';
import { menuPlace } from '../shared/menu';
import { addAuto, cancelAddAuto, pickAutoField, addFiles, addMemo, editAuto, saveAuto, pasteFiles, askMemoDel, Box, checkAway, markSeen, olderChat, removeMemo, bindBranches, renderChat, renderChatInspector, rootEl, renderChips, renderDispatcherStatus, tickDispatcher, saveSug, setAway, spendHtml, updateSendButton, visibleAutos, markDecision, decisionCard, tickDecisions } from './ui/chat';
import { closeShortcuts, openShortcuts, shortcutsOpen } from './ui/shortcuts';
import { closeShot, markBrokenShot, openShot, pickAxis, shotOpen, showShot, stepShot } from './ui/shotview';
import { cardKey, keyAnswer } from '../shared/decisionView';
import { closePop, markFont, openFontPicker, pop, popKeys, stepValue, syncStep } from './ui/controls';
import { leaveShell, pickShellFolder, shellInput, shellKeys, shellRepo, toggleShellAsk } from './ui/shell';
import { closeCpop, cpopKeys, historyKeys, historyTyped, rememberSent } from './ui/cpop';
import { $, ACTS, announce, applyStaticText, call, esc, hhmm, ide, lang, markBad, onScroll, Pane, playSound, readState, actedSinceWholeDraw, renderReply, replyText, S, scrollQuietly, setS, setSendErr, shownOf, store, swapIn, sym, t, toast, tryCall, ui, worker, workerTask, skipSameHtml, userActed } from './ui/core';
import { midPath } from '../shared/pathText';
import { go, navKey, navStep, readMemFile, screen, show } from './ui/history';
import { loadMemory, renderMemory, renderMemSync, searchMem } from './ui/memory';
import { closeFind, findOpen, stepFind } from './ui/find';
import { closePalette, cmdk, findSeed, jumpToChat, openPalette, paletteKeys, renderPalette, runPalette } from './ui/palette';
import { addRepo, jira, loadJira, loadPreflight, renderRepos, setJira, syncPorts } from './ui/repos';
import { copyStatus, toggleStatus } from './ui/status';
import { applyFont, applyTheme, closeSettings, drawUpdate, filterPanes, glideAll, glideSoon, hostOnly, loadModels, markQuiet, openModelPicker, openSettings, openWorkspacePicker, pickSeg, previewFont, readSettingsForm, saveSettingsNow, saveSoon, showPane, syncAccRows, syncSlider, syncSoundRows } from './ui/settings';
import { drawTelegram, telegramAction, telegramChange } from './ui/telegram';
import { renderSleep, setSleep } from './ui/sleep';
import { copyValue, folderThere, loadEditors, openFolder, openMenuHtml, rowOpenItems } from './ui/openWith';
import { applyPanels, closeDrawer, hideUsagePop, hideUsageSoon, hoverUsage, renderAccountsOff, renderSidebar, renderUsage, showUsagePop, togglePanel, toggleUsagePin, usagePop } from './ui/sidebar';
import { initResize } from './ui/resize';
import { initSwipe } from './ui/swipe';
import { initTip } from './ui/tip';
import { copyText } from './ui/copy';
import { cancelScriptEdit, editScript, pickScriptFolder, runScript, saveScript } from './ui/scripts';
import { cancelPromptEdit, chatPreset, dropPreset, editPrompt, openPromptForm, pickPromptSetting, savePrompt, setPreset, setPromptPlan, slashTyped, usePrompt } from './ui/prompts';
import { bindDock } from './ui/dock';
import { bindTerm, hideTerm, newTermTab, openTerm, pickTermFolder, renderTerm, setTermView, term, toggleTerm } from './ui/terminal';
import { clearPty, closeTab, closeTermFind, openTermFind, pty, ptyOn, restartTab, selectTab, termFindStep } from './ui/xterm';
import { bindSide, closeSide, minimiseSide, openSide, pickSideFolder, pickSideModel, renderSide, setSideView, sideToDispatcher, sideToMemo, sq, toggleSide } from './ui/side';
import { navItem, navItems, noteNav, rove, waitingStop } from './ui/panes';
import { addDiffNote, archiveWorker, askRepoRemove, confirmCancel, confirmOk, olderLog, openCheckpoints, renderCancelDialog, renderComposerDecision, renderConfirmDialog, renderDiff, renderSession, renderWorkerInspector, renderWorkerList } from './ui/workers';
import { canStop } from '../shared/canStop';

/**
 * The message field of the view: the open Worker's in the Worker view, the Dispatcher's otherwise (the chat is shown
 * for it). An open drawer closes, so it does not cover the field.
 */
export function focusComposer() {
  closeDrawer(false);
  if (ui.view === 'worker' && ui.wOpen) { $('#ws-input').focus(); return; }
  if (ui.view !== 'chat') go({ view: 'chat' });
  $('#chat-input').focus();
}

/** Shows a view tab. Navigation goes through go(), which calls this. */
export function setView(v: View) {
  ui.view = v;
  // One Tab stop (K1): the chosen view's tab; ←/→, Home and End choose another (the tablist keys below).
  document.querySelectorAll<HTMLButtonElement>('#views button').forEach((b) => { b.setAttribute('aria-selected', String(b.dataset.v === v)); b.tabIndex = b.dataset.v === v ? 0 : -1; });
  document.querySelectorAll<HTMLElement>('.view').forEach((el) => { el.hidden = el.dataset.view !== v; });
  if (v === 'memory') void loadMemory();
  renderAll(true);
}

/**
 * Draws the screen from the state. `parts`: only these parts changed since the last draw, so only the panels that
 * read them are drawn (shared/stateSync.ts); without it every panel is.
 */
export function renderAll(force = false, parts: ReadonlySet<Part> | null = null) {
  if (!S) return;
  const langChanged = ui.langApplied !== lang();
  applyStaticText();
  // Don't overwrite the preview while Settings is open.
  applyTheme(S.settings.theme);
  if (!ui.settingsShown) applyFont(S.settings.fontFamily, S.settings.fontSize);
  if (langChanged) force = true;
  const due = parts && !force ? panelsFor(parts) : null;
  const draw = (p: Panel) => !due || due.has(p);
  // A focused control (a row, a button, a link) is drawn again as a new element; the focus goes to the one that took its place.
  const focused = document.activeElement instanceof HTMLElement && document.activeElement.matches('[data-action]') ? document.activeElement : null;
  const focusKey = focused ? focusSelector(focused.tagName, focused.dataset) ?? '' : '';
  const focusRoot = focused?.closest<HTMLElement>('.sidebar, .view');
  if (draw('frame')) { applyPanels(); renderSidebar(); renderSleep(); }
  if (draw('usage')) renderUsage();
  // The chat's line for every account switched off counts the queue too: drawn with any change (it writes only a change).
  renderAccountsOff();
  if (draw('dispatcher')) renderDispatcherStatus();
  if (draw('memSync')) renderMemSync();
  if (ui.cancelAsk && draw('cancel')) renderCancelDialog();
  if (ui.view === 'chat') {
    if (draw('chat')) renderChat(force);
    if (draw('chatIns')) renderChatInspector();
    if (draw('side')) renderSide();
    if (draw('term')) renderTerm();
  }
  if (ui.view === 'worker' && draw('workers')) { renderWorkerList(); renderSession(force); renderWorkerInspector(); }
  if (ui.view === 'repo' && draw('repos')) renderRepos();
  if (ui.view === 'memory' && force) renderMemory();
  if (focused && focusKey && !focused.isConnected && document.activeElement === document.body) focusRoot?.querySelector<HTMLElement>(focusKey)?.focus({ preventScroll: true });
}

/** Puts back a cleared list: the one given (its toast's Undo), else the last one cleared (Ctrl/Cmd+Z). */
function undoClear(u?: (typeof ui.undo)[number]) {
  const i = u ? ui.undo.indexOf(u) : ui.undo.length - 1;
  if (i < 0) return false;
  const [x] = ui.undo.splice(i, 1);
  void call('chat:unclear', x.kind, x.ids);
  toast(t('toast.undone'));
  return true;
}

export function openWorker(id: string) {
  if (!id) return;
  ui.qSel = null;
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

/**
 * Selects an item of the right sidebar's Inbox, Memos, Automations or Scripts: a click on its card, or on the row of
 * "New automation" / "New script". A switch, a link or a button inside a card does its own thing.
 */
async function pick(el: HTMLElement, e: Event) {
  const tgt = e.target as HTMLElement;
  if (tgt !== el && tgt.closest('input, a, button, textarea')) return;
  const id = el.dataset.id ?? '';
  const row = el.classList.contains('li');
  if (el.dataset.tab === 'inbox') { markDecision(id); (row ? el : decisionCard(id))?.focus(); return; }
  if (el.dataset.tab === 'memo') {
    if (ui.memoSel === id) return;
    // A memo being edited stays open with its draft; it is only no longer the selected one.
    ui.memoSel = id;
  } else if (el.dataset.tab === 'script') {
    if (ui.scriptSel === id) return;
    ui.scriptSel = id;
  } else {
    if (ui.autoSel === id) return;
    ui.autoSel = id;
  }
  ui.memoDel = null;
  renderChatInspector();
  const slot = document.querySelector<HTMLElement>(`#chat-ins .pk[data-pick="${CSS.escape(id)}"]`);
  const card = slot?.querySelector<HTMLElement>(':scope > .pk-c');
  (row ? slot?.querySelector<HTMLElement>(':scope > .li') : card?.querySelector<HTMLElement>('textarea, input, button, a'))?.focus({ preventScroll: !row });
}

/** Focuses the list item with key `nav`. */
function focusNav(nav: string | null) {
  const el = navItems().find((x) => x.dataset.nav === nav);
  el?.focus();
  el?.scrollIntoView({ block: 'nearest' });
}

/**
 * Keys on an item of the right sidebar's list: ↑/↓, Home and End go to another item, which is selected when it can
 * be; on one that can be and is not selected yet, ↑/↓ select it first. Delete or Backspace clears a result or an auto-answer. True when the key was used.
 */
function listKeys(e: KeyboardEvent, el: HTMLElement): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return false;
  const item = navItem(el);
  if (!item) return false;
  const nav = item.dataset.nav ?? '';
  const del = (e.key === 'Delete' || e.key === 'Backspace') && /^(res|aa):/.test(nav);
  // On the row itself; Delete also on the row's own ✕.
  if (el !== item && !(del && el.matches('.row-x'))) return false;
  if (del) {
    e.preventDefault();
    if (!e.repeat) void clearOne(nav.startsWith('aa:') ? 'auto' : 'result', nav.slice(nav.indexOf(':') + 1));
    return true;
  }
  const items = navItems();
  const at = items.indexOf(item);
  let to = listStep(items.length, at, e.key);
  if (to === null) return false;
  e.preventDefault();
  const can = (x: HTMLElement) => x.matches('[data-action="pick"], [data-dec]');
  const chosen = (x: HTMLElement) => x.classList.contains('sel') || x.getAttribute('aria-current') === 'true' || !!x.closest('.pk.sel');
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && can(item) && !chosen(item)) to = at;
  const next = items[to];
  if (!can(next)) { if (next !== item) focusNav(next.dataset.nav ?? null); return true; }
  if (!chosen(next)) {
    if (next.matches('[data-dec]')) markDecision(next.dataset.dec ?? null);
    else void act(next, e);
  }
  focusNav(next.dataset.nav ?? null);
  return true;
}

/** Clears one result or auto-answer, with Undo; the focus on it goes to the next item (the one before it at the end). */
async function clearOne(kind: 'result' | 'auto', id: string) {
  const key = `${kind === 'auto' ? 'aa' : 'res'}:${id}`;
  if (navItem(document.activeElement)?.dataset.nav === key) {
    const next = focusAfter(navItems().map((x) => x.dataset.nav ?? ''), key);
    // The last one gone: the focus waits on the sidebar's tab rather than being lost.
    if (next) focusNav(next); else document.querySelector<HTMLElement>('#chat-ins [role="tab"][aria-selected="true"]')?.focus();
  }
  const u = { kind, ids: [id] };
  await call('chat:clear', kind, [id]);
  ui.undo.push(u);
  toast(t(kind === 'auto' ? 'toast.clearedOneAuto' : 'toast.clearedOneResult'), false, { label: t('toast.undo'), run: () => undoClear(u) });
}

/* ---------- actions ---------- */

/**
 * Next (dir 1) or previous (dir -1) waiting decision: its card is selected and takes the focus, in the inbox (the
 * drawer opens when the window is narrow) or in the asking Worker's own panel. With nothing waiting, a toast says so.
 */
export function goWaiting(dir: 1 | -1) {
  const id = waitingStop(dir);
  if (!id) { toast(t('next.none'), false, undefined, 'done'); return; }
  ui.decSel = id;
  const row = document.createElement('i');
  row.dataset.action = 'goto-decision';
  row.dataset.id = id;
  void act(row, new Event('click'));
}

export async function act(el: HTMLElement, e: Event) {
  const a = el.dataset.action!;
  const id = el.dataset.id ?? '';
  if (a.startsWith('tg-') && await telegramAction(a, el, () => openSettings())) return;
  switch (a) {
    case 'view': go({ view: el.dataset.v as View }); break;
    case 'worker-filter': go({ view: 'worker', wOpen: false, wFilter: (el.dataset.v || null) as WorkerFilter | null }); break;
    case 'open-settings': openSettings(el.dataset.v as Pane | undefined); break;
    case 'side-toggle': togglePanel('side'); break;
    case 'reply': {
      const box = el.dataset.box === 'ws' ? 'ws' : 'chat';
      const r = { who: el.dataset.who ?? '', quote: el.dataset.quote ?? '', ...(box === 'chat' && el.dataset.task ? { task: el.dataset.task } : {}), ...(el.dataset.src ? { src: el.dataset.src } : {}) };
      if (box === 'ws') ui.reply.ws = { ...r, wid: ui.wSel ?? '' }; else ui.reply.chat = r;
      renderReply(box);
      $(box === 'chat' ? '#chat-input' : '#ws-input').focus();
      break;
    }
    case 'shell-cwd': pickShellFolder(el); break;
    case 'shell-ask': toggleShellAsk(); break;
    case 'shell-stop': (el as HTMLButtonElement).disabled = true; void tryCall('shell:stop', id); break;
    case 'shell-fold': if (!ui.shellOpen.delete(id)) ui.shellOpen.add(id); renderChat(true); break;
    case 'shell-copy': {
      const r = S?.chat.find((c) => c.id === id)?.shell;
      if (r) void copyText(el, `$ ${r.cmd}\n${r.out}`);
      break;
    }
    case 'code-copy': {
      const pre = el.closest('.code')?.querySelector('pre');
      if (pre) void copyText(el, pre.textContent ?? '', pre);
      break;
    }
    case 'shell-again': {
      const r = S?.chat.find((c) => c.id === id)?.shell;
      if (r) void tryCall('shell:run', r.cmd, r.repo || null).then((x) => { if (!x.ok) toast(x.error, true); });
      break;
    }
    case 'sq-toggle': toggleSide(); break;
    // The side terminal (ui/terminal.ts).
    case 'tm-toggle': toggleTerm(); break;
    // The dock under the chat (ui/dock.ts): its tabs, and putting it away.
    case 'dock-tab': if (el.dataset.v === 'sq') openSide(); else openTerm(); break;
    case 'dock-hide': if (sq.open) minimiseSide(); else hideTerm(); break;
    // A stretch of stderr opened past its first line, or folded back (G2): in the chat's runs and the terminal's.
    case 'out-err': {
      const k = el.dataset.k ?? '';
      if (!ui.errOpen.delete(k)) ui.errOpen.add(k);
      renderChat(true);
      renderTerm();
      document.querySelector<HTMLElement>(`[data-action="out-err"][data-k="${CSS.escape(k)}"]`)?.focus({ preventScroll: true });
      break;
    }
    case 'tm-clear': if (ptyOn()) clearPty(); else { await call('term:clear'); $('#tm-input').focus(); } break;
    // The real terminal's tabs (ui/xterm.ts).
    case 'pty-new': void newTermTab(id); break;
    case 'pty-shells': {
      const menu = $('#ctxmenu');
      if (!menu.hidden && menu.dataset.for === 'pty') { menu.hidden = true; break; }
      menu.dataset.for = 'pty';
      menu.innerHTML = pty.shells.map((s) => `<button class="menu-item" role="menuitem" data-action="pty-new" data-id="${esc(s.id)}" data-close>${esc(s.name)}</button>`).join('');
      // Below the button, its left edge on the button's.
      const r = el.getBoundingClientRect();
      openCtxMenu(r.left, r.bottom + 4, el);
      break;
    }
    case 'pty-tab': selectTab(id); break;
    case 'pty-close': void closeTab(id); break;
    case 'pty-restart': void restartTab(id); break;
    case 'tm-find': openTermFind(); break;
    case 'tm-find-prev': termFindStep(-1); break;
    case 'tm-find-next': termFindStep(1); break;
    case 'tm-find-close': closeTermFind(); break;
    case 'tm-stop': (el as HTMLButtonElement).disabled = true; void tryCall('term:stop', id); break;
    case 'tm-cwd': pickTermFolder(el); break;
    case 'sq-close': void closeSide(); break;
    case 'sq-model': pickSideModel(el); break;
    case 'sq-folder': pickSideFolder(el); break;
    case 'sq-to-dispatcher': sideToDispatcher(); break;
    case 'sq-memo': void sideToMemo(); break;
    case 'reply-cancel': {
      const box = el.dataset.box === 'ws' ? 'ws' : 'chat';
      ui.reply[box] = null;
      renderReply(box);
      $(box === 'chat' ? '#chat-input' : '#ws-input').focus();
      break;
    }
    case 'ins-tab': ui.insTab = el.dataset.v === 'memo' || el.dataset.v === 'auto' || el.dataset.v === 'script' ? el.dataset.v : 'inbox'; ui.memoEdit = null; cancelScriptEdit(); cancelPromptEdit(); ui.memoDel = null; renderChatInspector(); swapIn($('#chat-ins')); break;
    case 'memo-seg': ui.memoSeg = el.dataset.v === 'prompt' ? 'prompt' : 'memo'; ui.memoEdit = null; cancelPromptEdit(); ui.memoDel = null; renderChatInspector(); break;
    case 'prompt-new': openPromptForm(); break;
    case 'prompt-save': await savePrompt(id ?? 'new'); renderChatInspector(); break;
    case 'prompt-cancel': cancelPromptEdit(); renderChatInspector(); break;
    case 'prompt-edit': if (id) { editPrompt(id); renderChatInspector(); document.querySelector<HTMLInputElement>(`#chat-ins [data-keep="prompt-name-${CSS.escape(id)}"]`)?.focus(); } break;
    case 'prompt-remove': if (ui.memoDel === id) { ui.memoDel = null; await call('prompt:remove', id); } else askMemoDel(id ?? null); break;
    case 'prompt-use': if (id) usePrompt(id); break;
    case 'prompt-repo': case 'prompt-model': pickPromptSetting(el, renderChatInspector); break;
    case 'preset-x': dropPreset(el.dataset.k ?? ''); break;
    case 'send-err-x': { const box = el.dataset.box === 'ws' ? 'ws' : 'chat'; setSendErr(box, ''); $(box === 'chat' ? '#chat-input' : '#ws-input').focus(); break; }
    case 'form-err-x': if (id === 'memo' || id === 'auto' || id === 'script' || id === 'prompt') { ui.formErr[id] = ''; renderChatInspector(); } break;
    // The Worker composer: send a normal message past the open decision, or answer it after all (M7).
    case 'dec-as-message': if (id) { ui.decAsMessage.add(id); renderComposerDecision(); $('#ws-input').focus(); } break;
    case 'dec-answer-it': if (id) { ui.decAsMessage.delete(id); renderComposerDecision(); $('#ws-input').focus(); } break;
    case 'memo-add': await addMemo(); break;
    case 'pick': await pick(el, e); break;
    case 'open-chat': if (id && !(await jumpToChat(id))) toast(t('auto.runGone')); break;
    case 'auto-add': await addAuto(); break;
    case 'auto-cancel': cancelAddAuto(); break;
    case 'auto-trig': case 'auto-repo': case 'auto-day': pickAutoField(el); break;
    case 'auto-run': if (id) await call('auto:run', id); break;
    case 'auto-edit': if (id) { editAuto(id); renderChatInspector(); $<HTMLTextAreaElement>('#auto-prompt-e')?.focus(); } break;
    case 'auto-edit-cancel': ui.autoEdit = null; renderChatInspector(); break;
    case 'auto-save': await saveAuto(); break;
    // Saved scripts (ui/scripts.ts). Run is the only way one starts.
    case 'script-save': await saveScript(id ?? 'new'); renderChatInspector(); break;
    case 'script-run': if (id) await runScript(id, el as HTMLButtonElement); break;
    case 'script-copy': {
      const cmd = S?.scripts?.find((x) => x.id === id)?.cmd;
      // The open card shows all of it, so its text can be selected when the clipboard says no.
      if (cmd != null) void copyText(el, cmd, el.closest('.memo.script.open')?.querySelector<HTMLElement>('.script-cmd') ?? null);
      break;
    }
    case 'script-cwd': pickScriptFolder(el, renderChatInspector); break;
    case 'script-edit': if (id) { editScript(id); renderChatInspector(); document.querySelector<HTMLInputElement>(`#chat-ins [data-keep="script-name-${CSS.escape(id)}"]`)?.focus(); } break;
    case 'script-edit-cancel': cancelScriptEdit(); renderChatInspector(); break;
    case 'script-remove': if (ui.memoDel === id) { ui.memoDel = null; await call('script:remove', id); } else askMemoDel(id ?? null); break;
    case 'cmp-changes': if (id) go({ view: 'worker', wSel: id, wOpen: true, wTab: 'changes' }); break;
    case 'cmp-pick': (el as HTMLButtonElement).disabled = true; await call('compare:pick', id); break;
    case 'auto-remove': if (ui.memoDel === id) { ui.memoDel = null; await call('auto:remove', id); } else askMemoDel(id ?? null); break;
    case 'memo-share': { const m = S!.memos.find((x) => x.id === id); if (m) await call('memo:update', id, { shared: !m.shared }); break; }
    case 'memo-edit': ui.memoEdit = id; ui.memoSel = id; ui.memoDel = null; renderChatInspector(); document.querySelector<HTMLTextAreaElement>(`[data-keep="memo-${id}"]`)?.focus(); break;
    case 'memo-edit-cancel': ui.memoEdit = null; renderChatInspector(); break;
    case 'memo-save': {
      const field = document.querySelector<HTMLTextAreaElement>(`[data-keep="memo-${id}"]`);
      const text = field?.value ?? '';
      // An emptied memo is not saved: the field stays open for the text, and Delete is the way to remove it.
      if (!text.trim()) { field?.focus(); break; }
      ui.memoEdit = null;
      await call('memo:update', id, { text });
      renderChatInspector();
      break;
    }
    case 'memo-remove': if (ui.memoDel === id) await removeMemo(id!); else askMemoDel(id ?? null); break;
    case 'done-toggle': ui.doneOpen = !ui.doneOpen; store('oma.doneOpen', ui.doneOpen); renderSidebar(); break;
    case 'ins-toggle': togglePanel('ins'); break;
    case 'sleep-toggle': await setSleep(!S?.sleep?.armed); break;
    case 'sleep-cancel': await setSleep(false); break;
    case 'away-dismiss': setAway(null); renderChatInspector(); break;
    case 'cmdk-open': openPalette(); break;
    case 'cmdk-close': closePalette(); break;
    case 'find-prev': stepFind(-1); break;
    case 'find-next': stepFind(1); break;
    case 'find-close': closeFind(); break;
    case 'cmdk-run': runPalette(Number(el.dataset.i)); break;
    case 'reveal-memory': await call('open:path', `${S!.settings.home}/memory`); break;
    case 'reveal-claude': if (ui.claude) await call('open:path', ui.claude.home); break;
    case 'ctx-menu': {
      const menu = $('#ctxmenu');
      if (!menu.hidden && menu.dataset.for === 'ctx') { menu.hidden = true; break; }
      menu.dataset.for = 'ctx';
      const spent = hasSpend(S!.dispatcher.spend) ? `<div class="note">${t('spend.dispatcher')}<br>${spendHtml(S!.dispatcher.spend)}</div>` : '';
      // With no context there is nothing to compact or to start again: only what was spent is left to show.
      const items = S!.dispatcher.contextTokens ? `<button class="menu-item" role="menuitem" data-action="ctx-compact">${t('ctx.compact')}</button><button class="menu-item" role="menuitem" data-action="ctx-clear">${t('ctx.clear')}…</button>` : '';
      menu.innerHTML = `${spent}${spent && items ? '<div class="menu-sep"></div>' : ''}${items}`;
      // Above the meter, its right edge on the meter's.
      const r = el.getBoundingClientRect();
      openCtxMenu((w) => r.right - w, (h) => r.top - h - 6, el);
      break;
    }
    case 'ctx-compact': closeCtxMenu(); await call('dispatcher:compact'); break;
    case 'ctx-clear':
      // The Dispatcher's context is gone for good: ask first (B2). The meter has the focus again, for the dialog to
      // give back.
      closeCtxMenu(true);
      ui.confirmAsk = { title: t('ctx.clearTitle'), body: `<p>${esc(t('ctx.clearBody'))}</p>`, ok: t('ctx.clear'), action: 'ctx-clear', id: '' };
      renderConfirmDialog();
      break;
    case 'close-settings': closeSettings(); break;
    case 'pane': showPane(id as Pane); break;
    case 'next-waiting': goWaiting(1); break;
    // The usage warning chip (T-0180): the popover, held open; from the keyboard the focus goes into it.
    case 'usage-warn': toggleUsagePin(e instanceof MouseEvent && e.detail === 0); break;
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
    // A Worker's folder in the editor, a terminal or the file manager (item 3A).
    case 'open-editor': closeCtxMenu(); void openFolder(id, 'editor', () => openSettings('general')); break;
    case 'open-with': void openFolder(id, el.dataset.v ?? 'editor', () => openSettings('general')); break;
    case 'open-copy': {
      const text = copyValue(id, el.dataset.v ?? 'path');
      if (text) await navigator.clipboard.writeText(text).then(() => toast(t('sel.copied')), () => toast(t('copy.failed'), true));
      break;
    }
    case 'open-menu': {
      const menu = $('#ctxmenu');
      if (!menu.hidden && menu.dataset.for === 'open') { closeCtxMenu(true); break; }
      const w = worker(id);
      if (!w) break;
      const [, there] = await Promise.all([loadEditors(), folderThere(id)]);
      menu.dataset.for = 'open';
      menu.innerHTML = openMenuHtml(w, !there);
      ui.openMenu = id;
      el.setAttribute('aria-expanded', 'true');
      // Below the split button, its left edge on the button's.
      const r = (el.closest('.osplit') ?? el).getBoundingClientRect();
      openCtxMenu(r.left, r.bottom + 4, el);
      break;
    }
    case 'open-queued': ui.qSel = id; go({ view: 'worker', wSel: null, wOpen: false }); renderWorkerInspector(); break;
    case 'chat-stop': {
      const b = el as HTMLButtonElement;
      b.disabled = true;
      void Promise.resolve(call('chat:stop')).finally(() => { b.disabled = false; });
      break;
    }
    case 'chat-start': {
      // A start fills the composer for the user to finish; it is not sent.
      const input = $<HTMLTextAreaElement>('#chat-input');
      input.value = `${el.dataset.text ?? ''}: `;
      input.dispatchEvent(new Event('input'));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      break;
    }
    // A reply's tag or line: back to the message it answers, which flashes once.
    case 'reply-root': {
      const at = rootEl(id);
      if (at) flashCard(at); else toast(t('reply.gone'));
      break;
    }
    // A quote at the top of a reply: back to the message it quotes, the nearest one above with those words.
    case 'goto-quote': {
      const th = el.closest('.thread');
      const src = [...(th?.querySelectorAll<HTMLElement>('[data-action="reply"]') ?? [])]
        .filter((b) => b.dataset.who === el.dataset.who && b.dataset.quote === el.dataset.quote && b.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
      const msg = src?.closest<HTMLElement>('.attach') ?? src?.closest('.bline')?.querySelector<HTMLElement>('.bub') ?? null;
      if (msg) flashCard(msg); else toast(t('reply.gone'));
      break;
    }
    case 'evs-fold': {
      if (!ui.evOpen.delete(id)) ui.evOpen.add(id);
      renderChat();
      document.querySelector<HTMLElement>(`.evs-h[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
      break;
    }
    case 'hand-fold': {
      if (!ui.handToggled.delete(id)) ui.handToggled.add(id);
      renderChat();
      document.querySelector<HTMLElement>(`.hand-h[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
      break;
    }
    case 'res-more': {
      if (!ui.resOpen.delete(id)) ui.resOpen.add(id);
      renderChatInspector();
      document.querySelector<HTMLElement>(`[data-action="res-more"][data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
      break;
    }
    case 'select-worker': openWorker(id); break;
    case 'close-session': go({ wOpen: false }); break;
    case 'ws-tab': go({ wTab: el.dataset.v as Screen['wTab'] }); break;
    case 'sum-scope': ui.sumScope = el.dataset.v === 'week' ? 'week' : 'worker'; renderSession(); break;
    case 'perm-filter': ui.permFilter = el.dataset.v === 'allowed' || el.dataset.v === 'denied' ? el.dataset.v : 'all'; renderSession(); break;
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
    case 'status-fold': toggleStatus(el.dataset.v ?? ''); break;
    case 'status-copy': copyStatus(el); break;
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
      // Into the merge queue: with nothing ahead of it and the base in its branch, it is merged at once.
      await call('mq:add', [id]);
      renderAll(true);
      break;
    }
    case 'bundle-merge': {
      const b = openBundles(S!.tasks).find((x) => x.name === id);
      if (!b || !b.ready) break;
      const key = `b:${b.name}`;
      if (ui.mergeAsk !== key) { ui.mergeAsk = key; renderAll(true); break; }
      ui.mergeAsk = null;
      // In the order the tasks were made; once one leaves the queue, the later ones leave with it.
      await call('mq:add', bundleMergeOrder(b).map((x) => x.id));
      renderAll(true);
      break;
    }
    case 'pr-merge-all': {
      if (ui.mergeAsk !== '*') { ui.mergeAsk = '*'; renderAll(true); break; }
      ui.mergeAsk = null;
      // One after another, each on the base the one before it left (shared/mergeQueue.ts).
      await call('mq:add', readyToQueue(S!.tasks, S!.mergeQueue).map((x) => x.id));
      renderAll(true);
      break;
    }
    case 'mq-remove': if (id) await call('mq:remove', id); break;
    case 'mq-again': if (id) await call('mq:add', [id]); break;
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
    case 'dec-fold': {
      // In place, without a redraw: the card's details, its whole command, or its text field (then focused).
      const fold = el.dataset.fold ?? '';
      const key = `${fold}:${id}`;
      const open = !ui.decOpen.delete(key);
      if (open) ui.decOpen.add(key);
      el.setAttribute('aria-expanded', String(open));
      const card = el.closest('.dec');
      if (fold === 'more') { const more = card?.querySelector<HTMLElement>(':scope > .more'); if (more) more.hidden = !open; }
      if (fold === 'cmd') card?.querySelector(':scope > .cmd')?.classList.toggle('open', open);
      if (fold === 'reply') {
        const inp = card?.querySelector<HTMLInputElement>(':scope > input.inp');
        if (inp) { inp.hidden = !open; if (open) inp.focus(); }
      }
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
    case 'clear-one': void clearOne(el.dataset.kind === 'auto' ? 'auto' : 'result', id); break;
    case 'clear': {
      const kind = el.dataset.kind as 'result' | 'auto';
      const ids = kind === 'auto' ? S!.autoAnswers.filter((x) => !x.cleared).map((x) => x.id) : S!.results.map((c) => c.id);
      const u = { kind, ids };
      ui.undo.push(u);
      await call('chat:clear', kind);
      toast(t(kind === 'auto' ? 'toast.clearedAuto' : 'toast.clearedResults'), false, { label: t('toast.undo'), run: () => undoClear(u) });
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
      const scope = ((document.getElementById(`scope-${id}`) as HTMLInputElement | null)?.value ?? 'once') as 'once' | 'preference';
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
    case 'shot-open': openShot(el); break;
    case 'shot-pick': showShot(Number(el.dataset.i)); break;
    case 'shot-axis': pickAxis(el); break;
    case 'shot-close': closeShot(); break;
    case 'confirm-ok': await confirmOk(); break;
    case 'worker-unarchive': await call('worker:unarchive', id); break;
    case 'worker-msg': openWorker(id); setTimeout(() => $('#ws-input').focus(), 30); break;
    case 'repo-select': if (!ui.repoAdding) ui.repoAdd = false; go({ repoSel: id }); renderRepos(); break;
    case 'repo-add-open': ui.repoAdd = true; ui.repoAddError = ''; renderRepos(); $('#repo-add-url').focus(); break;
    // The first-run step: the Repositories view with its add form open, in a right sidebar that shows.
    case 'setup-repo':
      ui.repoAdd = true; ui.repoAddError = '';
      go({ view: 'repo' });
      if (ui.insMin) togglePanel('ins');
      renderRepos(); $('#repo-add-url').focus(); break;
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
    case 'repo-save': {
      const port = $<HTMLInputElement>('#repo-port');
      if (parseBasePort(port.value) === 'bad') { port.focus(); break; }
      await call('repo:update', id, $<HTMLTextAreaElement>('#repo-desc').value, $<HTMLTextAreaElement>('#repo-setup').value, $<HTMLTextAreaElement>('#repo-run').value, { basePort: port.value, portStep: Number($<HTMLInputElement>('#repo-step').value) });
      toast(t('toast.descSaved'));
      break;
    }
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
    case 'acc-resume-all': await call('account:resumeAll'); break;
    case 'acc-remove': ui.accMenu = null; ui.accRemove = id; openSettings(); break;
    case 'acc-remove-cancel': ui.accRemove = null; openSettings(); break;
    case 'acc-remove-ok': ui.accRemove = null; openSettings(); await call('account:remove', id); break;
    case 'pick-home': {
      const p = await call<string | null>('settings:pickHome');
      if (p) {
        $<HTMLInputElement>('#set-home').value = p;
        const v = $('#set-home-v');
        v.textContent = midPath(p);
        v.dataset.tip = p;
        void saveSettingsNow();
      }
      break;
    }
    case 'pick-sound': {
      const p = await call<string | null>('sound:pick');
      if (p) { $<HTMLInputElement>('#set-sfile').value = p; void saveSettingsNow(); }
      break;
    }
    case 'restart-later': ui.restartAsk = false; openSettings(); break;
    case 'restart-now': await call('app:relaunch'); break;
    case 'update-apply': await call('update:apply'); break;
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

/**
 * Shows the context menu and moves the focus into it; closing gives the focus back (L14). It goes at (x, y), each a
 * number or worked out from the menu's measured size, and stays inside the window.
 */
let ctxReturn: HTMLElement | null = null;
type MenuAt = number | ((size: number) => number);
function openCtxMenu(x: MenuAt, y: MenuAt, back = document.activeElement as HTMLElement | null) {
  const menu = $('#ctxmenu');
  ctxReturn = back;
  // Measured at the corner: where it was last, near an edge, it would be squeezed.
  menu.style.left = '0';
  menu.style.top = '0';
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const p = menuPlace(typeof x === 'number' ? x : x(w), typeof y === 'number' ? y : y(h), w, h, innerWidth, innerHeight);
  menu.style.left = `${p.left}px`;
  menu.style.top = `${p.top}px`;
  menu.querySelector<HTMLElement>('button')?.focus();
}
/** The open menu's button reads as closed again. */
function menuGone() {
  ui.openMenu = null;
  document.querySelector('[data-action="open-menu"][aria-expanded="true"]')?.setAttribute('aria-expanded', 'false');
}
export function closeCtxMenu(refocus = false) {
  const menu = $('#ctxmenu');
  menuGone();
  if (menu.hidden) return;
  menu.hidden = true;
  if (refocus && ctxReturn?.isConnected) ctxReturn.focus();
  ctxReturn = null;
}

/** What is written for each Worker that is not on screen: the Worker composer is one field for all of them. */
const wsDrafts = new Drafts<NonNullable<typeof ui.reply.ws>>();

/**
 * Another Worker is selected: the composer's text, files and reply stay with the Worker it leaves, and what was
 * written for the one it comes to is back.
 */
export function swapDraft(from: string | null, to: string | null) {
  if (from === to) return;
  closeCpop('ws');
  const input = $<HTMLTextAreaElement>('#ws-input');
  if (from) wsDrafts.put(from, { text: input.value, files: ui.attach.ws, reply: ui.reply.ws });
  wsDrafts.keep((id) => !!worker(id));
  const d = to ? wsDrafts.take(to) : { text: '', files: [], reply: null };
  input.value = d.text;
  ui.attach.ws = d.files;
  ui.reply.ws = d.reply;
  // A failed send is said where it failed; what was not sent is in that Worker's draft.
  setSendErr('ws', '');
  renderReply('ws');
  renderChips('ws');
}

/** The screen and the drafts as the next start opens them (5A), with what the composers on screen hold now. */
function sessionNow() {
  const shown: Record<string, { text: string; files: string[]; reply: unknown }> = {
    [DISPATCHER_DRAFT]: { text: $<HTMLTextAreaElement>('#chat-input').value, files: ui.attach.chat, reply: ui.reply.chat },
  };
  if (ui.wSel) shown[ui.wSel] = { text: $<HTMLTextAreaElement>('#ws-input').value, files: ui.attach.ws, reply: ui.reply.ws };
  return { screen: screen(), drafts: wsDrafts.saved(shown as Parameters<typeof wsDrafts.saved>[0]) };
}

let sessionKept = '';
/** Sends the session to main when it changed since it was last sent; main writes it with the state. */
export function keepSession() {
  if (!S) return;
  const s = sessionNow();
  const json = JSON.stringify(s);
  if (json === sessionKept) return;
  sessionKept = json;
  ide.call('session:save', s).catch(() => { sessionKept = ''; });
}

/**
 * At launch: the last run's drafts go back into their composers and its screen comes back (5A). A Worker that is gone
 * loses its draft and is deselected; an archived one opens as it was.
 */
async function restoreSession() {
  const saved = await ide.call<{ screen?: unknown; drafts?: Record<string, unknown> } | null>('session:get').catch(() => null);
  if (!S || !saved) return;
  const wsReply = (r: unknown) => {
    const x = readReply(r);
    const wid = (r as { wid?: unknown }).wid;
    return x && typeof wid === 'string' ? { ...x, wid } : null;
  };
  wsDrafts.load(saved.drafts, (id) => id !== DISPATCHER_DRAFT && !!worker(id), wsReply);
  const chat = parseDraft(saved.drafts?.[DISPATCHER_DRAFT], readReply);
  const input = $<HTMLTextAreaElement>('#chat-input');
  if (chat && !input.value) {
    input.value = chat.text;
    ui.attach.chat = chat.files;
    ui.reply.chat = chat.reply;
    renderReply('chat');
    renderChips('chat');
    autosize(input);
  }
  const to = restoreScreen(saved.screen, { worker: (id) => !!worker(id), repo: (name) => !!S?.repos.some((r) => r.name === name) });
  if (to) show(to, { ...screen(), wSel: null });
  sessionKept = JSON.stringify(sessionNow());
}

/** A stand-in button for an action started from the keyboard: `dataset` has no setter, so it is filled key by key. */
function actionAs(action: string, id?: string) {
  const b = document.createElement('button');
  b.dataset.action = action;
  if (id !== undefined) b.dataset.id = id;
  return b;
}

/** The composer grows with its text up to half the window; past that it scrolls with no visible bar. */
export function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = Math.min(Math.round(window.innerHeight * 0.5), el.scrollHeight) + 'px';
}

/** `send` resolves to null once the text went, or to why it did not; then the text, files and reply stay (L8). */
export function bindComposer(box: Box, formSel: string, inputSel: string, send: (text: string, files: string[]) => Promise<string | null>) {
  // Who a send is on its way to ('' for the Dispatcher): a second Enter for the same one waits, another Worker's does not.
  const sending = new Set<string>();
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
  input.addEventListener('input', () => { if (box === 'chat') shellInput(input); autosize(input); updateSendButton(); historyTyped(box); slashTyped(box); });
  // The list over the composer goes with the focus; a press on one of its rows keeps the focus here.
  input.addEventListener('blur', () => closeCpop(box));
  // Files copied in Explorer or Finder attach as if dropped here.
  input.addEventListener('paste', (e) => pasteFiles(box, e));
  input.addEventListener('keydown', (e) => {
    if (cpopKeys(e, box)) return;
    if (box === 'chat' && shellKeys(e, input)) { updateSendButton(); return; }
    if (historyKeys(e, box, box === 'chat' && ui.shell)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', (e) => void (async () => {
    e.preventDefault();
    // The Worker composer is shared: what comes after the send belongs to the Worker it went to.
    const target = box === 'ws' ? ui.wSel : null;
    const to = target ?? '';
    if (sending.has(to)) return;
    // A shell line takes no files and no reply: they stay for the next message.
    const sh = box === 'chat' && ui.shell;
    const files = sh ? [] : [...ui.attach[box]];
    const typed = input.value;
    const text = typed.trim() || (files.length ? t('attach.defaultText') : '');
    if (!text) return;
    const reply = ui.reply[box];
    closeCpop(box);
    sending.add(to);
    // Sending goes to the end of the thread, scrolled up or not, and follows what comes after it.
    if (thread) {
      if (box === 'chat') renderChat(true); else renderSession(true);
      scrollQuietly(thread, thread.scrollHeight);
    }
    const err = await send(text, files);
    sending.delete(to);
    if (!err && !sh) void rememberSent(box, target, typed);
    if (box === 'ws' && ui.wSel !== target) {
      // Another Worker is on screen by now: what went leaves the draft kept for the one it went to.
      if (err) toast(err, true); else if (target) wsDrafts.sent(target, typed, files, reply as typeof ui.reply.ws);
      return;
    }
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
  })());
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
  for (const type of ACTS) document.addEventListener(type, userActed, true);
  document.body.classList.add(`platform-${ide.platform}`);
  ide.onFullScreen((on) => document.body.classList.toggle('fullscreen', on));
  // Before the first paint, so a sidebar that was put away does not animate shut at launch.
  applyPanels();
  initResize();
  initSwipe($('#chat-ins'), (nav) => clearOne(nav.startsWith('aa:') ? 'auto' : 'result', nav.slice(nav.indexOf(':') + 1)));
  initTip();
  // An image that fails to load does not bubble its error: listen while it goes down.
  document.addEventListener('error', markBrokenShot, true);
  document.addEventListener('click', (e) => {
    const tgt = e.target as HTMLElement;
    const segBtn = tgt.closest<HTMLButtonElement>('[data-segc]');
    if (segBtn) { pickSeg(segBtn); return; }
    const dd = tgt.closest<HTMLElement>('[data-dd]');
    if (dd) { if (dd.dataset.pick) openWorkspacePicker(dd); else openModelPicker(dd); return; }
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
    if (!(e.target as HTMLElement).closest('#ctxmenu, #chat-ctx, #tm-shell, .osplit') || el?.hasAttribute('data-close')) { $('#ctxmenu').hidden = true; menuGone(); }
  });
  document.addEventListener('change', (e) => void (async () => {
    const el = e.target as HTMLSelectElement;
    if (el.id === 'repo-step') syncPorts();
    if (el.dataset.change === 'sound-kind') syncSoundRows();
    if (el.classList?.contains('step-v')) syncStep(el as unknown as HTMLInputElement, true);
    // The Jira token goes to the main process by itself and is cleared from the field: it is never part of the page's state.
    if (el.id?.startsWith('tg-') && await telegramChange(el as unknown as HTMLInputElement, () => openSettings())) return;
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
    if (el.dataset.change === 'prompt-plan') { setPromptPlan(el.dataset.id ?? 'new', (el as unknown as HTMLInputElement).checked); return; }
    if (el.dataset.change === 'acc-kind') { ui.accKind = el.value as typeof ui.accKind; syncAccRows(); }
    if (el.dataset.change === 'acc-assign') { void call('account:assign', el.dataset.id, el.value); return; }
    if (el.id === 'usage-every') { void call('settings:save', { usageRefreshMins: Number(el.value) }); return; }
    if (el.id === 'set-gh') el.value = hostOnly(el.value);
    // A time that does not read as one gives way to the one in use, which is what stays saved.
    if ((el.id === 'set-qfrom' || el.id === 'set-qto') && S) { el.value = typedTime(el.value, el.id === 'set-qfrom' ? S.settings.quietFrom : S.settings.quietTo); markBad(el, false); markQuiet(); }
    if (el.id === 'set-nres') syncSoundRows();
    if (el.closest?.('#sheet')) void saveSettingsNow();
  })());
  document.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'cmdk-q') { renderPalette(el.value); return; }
    if (el.id === 'set-qkey') markBad(el, normalizeQuickKey(el.value) === null);
    if (el.id === 'repo-port') syncPorts();
    if (el.id === 'set-qfrom' || el.id === 'set-qto') markBad(el, !!el.value.trim() && !cleanTime(el.value));
    if (el.id === 'set-vol') syncSlider(el);
    if (el.classList.contains('step-v')) syncStep(el, false);
    if (el.id === 'set-fsize') previewFont();
    if (el.id === 'set-font') { markFont(el); previewFont(); void openFontPicker(el, false); }
    if (el.id === 'set-q') { ui.setQ = el.value; filterPanes(); return; }
    if (el.closest('#sheet') && el.id !== 'set-home') saveSoon(el.matches('.step-v, .slider') ? 300 : 600);
  });
  document.querySelectorAll<HTMLButtonElement>('#views button').forEach((b) => b.addEventListener('click', () => go({ view: b.dataset.v as View })));
  // A press outside the right sidebar's drawer closes it, as a menu would; layers over it (dialogs, menus) keep it.
  document.addEventListener('pointerdown', (e) => {
    const at = e.target as Element | null;
    if (!at?.closest || at.closest('.inspector, #ins-toggle')) return;
    if (at.closest('.content, .sidebar, .toolbar')) closeDrawer(false);
  }, true);
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
  usage.addEventListener('focus', () => { if (!usagePop.quiet && usage.matches(':focus-visible')) { showUsagePop(); usagePop.keys = true; } });
  usage.addEventListener('blur', (e) => { if (!upop.contains(e.relatedTarget as Node | null)) hideUsagePop(); });
  upop.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && (upop.contains(to) || to === usage)) return;
    // The focus left with a redraw of the popover (refreshUsagePop puts it back), or went elsewhere.
    if (!to) return;
    hideUsagePop();
  });
  // A click in the popover (its refresh button, say) leaves the focus there; the pointer still closes it as it leaves.
  upop.addEventListener('pointerdown', () => { usagePop.keys = false; });
  upop.addEventListener('keydown', (e) => { if (usagePop.shown && e.key !== 'Escape') usagePop.keys = true; });
  // A press anywhere else closes it, focused or not (a press on nothing focusable moves no focus to close it with).
  document.addEventListener('pointerdown', (e) => {
    const at = e.target as Node | null;
    if (usagePop.shown && !(at && (upop.contains(at) || usage.contains(at) || $('#usage-warn').contains(at)))) hideUsagePop();
  }, true);
  usage.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'Enter') return;
    if (!usage.classList.contains('usage')) return;
    e.preventDefault();
    showUsagePop();
    usagePop.keys = true;
    upop.querySelector<HTMLElement>('.ubtn:not(:disabled), [data-segc][aria-checked="true"]')?.focus();
  });
  window.addEventListener('resize', () => { closePop(); hideUsagePop(); });
  // A zoom changes the pixel ratio: the window's buttons over the strip are resized to match it (windowButtons).
  // Once at load too, for a page that comes back already zoomed (a reload keeps the zoom).
  let ratio = window.devicePixelRatio;
  void call('window:zoom');
  window.addEventListener('resize', () => { if (window.devicePixelRatio === ratio) return; ratio = window.devicePixelRatio; void call('window:zoom'); });
  // Scroll events don't bubble; capturing on document sees every scrolling element.
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  // The focus in the right sidebar's list selects nothing; it only makes that item the list's Tab stop.
  document.addEventListener('focusin', (e) => {
    const item = navItem(e.target as HTMLElement);
    if (!item) return;
    noteNav(item.dataset.nav ?? null);
    if (item.tabIndex !== 0) rove();
  });

  // Enter in an input runs the action named in data-enter.
  document.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    // Ctrl/Cmd+K opens the palette from anywhere, and closes it.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyK') { e.preventDefault(); if (cmdk.open) closePalette(); else openPalette(); return; }
    // Ctrl/Cmd+F opens the same palette to find something said, with a short text selected on the page already in it.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyF') { e.preventDefault(); if (cmdk.open) $('#cmdk-q').focus(); else openPalette(findSeed()); return; }
    if (cmdk.open) { paletteKeys(e); return; }
    // Ctrl/Cmd+I: the next waiting decision, with Shift the previous one (T-0180). Not while Settings covers the window.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyI' && !ui.settingsShown && $('#dlg').hidden && !shotOpen()) { e.preventDefault(); goWaiting(e.shiftKey ? -1 : 1); return; }
    // Ctrl/Cmd+Shift+U: the usage popover, held open with the focus in it (T-0180), and closed again.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyU' && !ui.settingsShown && $('#dlg').hidden) { e.preventDefault(); toggleUsagePin(true); return; }
    // An open screenshot goes to the report's previous or next one with the arrow keys.
    if (shotOpen() && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); stepShot(e.key === 'ArrowLeft' ? -1 : 1); return; }
    // Ctrl/Cmd+/ opens the list of keys, and closes it.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'Slash') { e.preventDefault(); if (shortcutsOpen()) closeShortcuts(); else if (!ui.settingsShown) openShortcuts(); return; }
    // Ctrl/Cmd+J: the side question, over the chat. Again from inside it, it goes back behind its button.
    // Ctrl+` opens the side terminal, and hides it from inside; Ctrl on the Mac too, as in other editors.
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.code === 'Backquote' && !ui.settingsShown) {
      e.preventDefault();
      if (term.open && $('#dock').contains(document.activeElement)) hideTerm();
      else { if (ui.view !== 'chat') go({ view: 'chat' }); openTerm(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyJ' && !ui.settingsShown) {
      e.preventDefault();
      if (sq.open && $('#dock').contains(document.activeElement)) minimiseSide();
      else { if (ui.view !== 'chat') go({ view: 'chat' }); openSide(); }
      return;
    }
    // A dialog that asks keeps the keyboard inside it: Tab goes round its own controls.
    if (e.key === 'Tab') {
      // A dialog over the Settings sheet first, then the sheet itself (L14).
      const shown = (d: HTMLElement) => !!d.getClientRects().length;
      const dlg = [...document.querySelectorAll<HTMLElement>('.dlg[aria-modal="true"]')].find(shown) ?? [...document.querySelectorAll<HTMLElement>('#sheet[aria-modal="true"]')].find((d) => !d.hidden && shown(d));
      if (dlg) {
        const stops = [...dlg.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter((x) => x.tabIndex >= 0 && shown(x));
        const at = stops.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
        return;
      }
    }
    if (popKeys(e)) return;
    // A tab list or a group of choices is one Tab stop: ←/→, Home and End move in it and choose (↑/↓ too among choices).
    const set = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && el.matches?.('button[role="tab"], button[role="radio"]') ? el.closest<HTMLElement>('[role="tablist"], [role="radiogroup"]') : null;
    if (set) {
      const all = [...set.querySelectorAll<HTMLButtonElement>('button[role="tab"], button[role="radio"]')].filter((b) => !b.disabled);
      const to = rovingIndex(all.indexOf(el as HTMLButtonElement), e.key, all.length, set.matches('[role="radiogroup"]'));
      if (to !== null) {
        e.preventDefault();
        const next = all[to];
        if (next === el) return;
        // Choosing may draw the list again: the choice is then found by what it is.
        const again = next.dataset.segc ? `[data-segc="${next.dataset.segc}"][data-v="${CSS.escape(next.dataset.v ?? '')}"]` : focusSelector(next.tagName, next.dataset);
        next.focus();
        next.click();
        if (document.activeElement !== next && again) document.querySelector<HTMLElement>(again)?.focus();
        return;
      }
    }
    // A conversation is one Tab stop, and ↑/↓ move between its messages.
    if (threadKeys(e)) return;
    // The right sidebar's list: ↑/↓, Home and End move between its items at any width and select one that can be.
    if (listKeys(e, el)) return;
    // K1: the selected inbox card answers to keys while no text field has the focus. Enter on one of its buttons is
    // left to that button. A card that is not selected is selected first, by Enter or Space.
    const card = el.closest?.<HTMLElement>('#chat-ins [data-dec]');
    if (card && card.dataset.dec !== ui.decSel && el === card && (e.key === 'Enter' || e.key === ' ') && !e.isComposing) {
      e.preventDefault();
      if (!e.repeat) markDecision(card.dataset.dec ?? null);
      return;
    }
    if (card && card.dataset.dec === ui.decSel && !el.matches('input, textarea, [contenteditable="true"]')) {
      const k = cardKey(e);
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
      } else if (el.dataset.enter === 'script-save') {
        void act(actionAs('script-save', el.dataset.id), e);
      } else if (el.dataset.enter === 'prompt-save') {
        void act(actionAs('prompt-save', el.dataset.id), e);
      } else if (el.dataset.enter === 'memo-save') {
        void act(actionAs('memo-save', el.dataset.id), e);
      } else if (el.dataset.enter === 'sug-save') {
        void saveSug(el.dataset.id ?? '');
      } else if (el.dataset.enter === 'aa-send') {
        void act(actionAs('aa-send', el.dataset.id), e);
      }
      return;
    }
    if (el.id === 'acc-rename' && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void act(actionAs('acc-rename-save', el.dataset.id), e);
      return;
    }
    // Escape closes one layer at a time, the top one first (L14).
    if (e.key === 'Escape') {
      if (pop.el) { closePop(true); return; }
      if (shortcutsOpen()) { closeShortcuts(); return; }
      if (shotOpen()) { closeShot(); return; }
      if (!$('#ctxmenu').hidden) { closeCtxMenu(true); return; }
      if (ui.cancelAsk) { ui.cancelAsk = null; renderCancelDialog(); return; }
      if (ui.confirmAsk) { ui.confirmAsk = null; renderConfirmDialog(); return; }
      if (usagePop.shown) {
        // From inside the popover, the focus goes back to the rings without opening it again.
        // Opened with the warning chip, it goes back to the chip.
        const back = usagePop.pinned && !$('#usage-warn').hidden ? $('#usage-warn') : $('#usage');
        if ($('#usage-pop').contains(document.activeElement)) { usagePop.quiet = true; back.focus(); usagePop.quiet = false; }
        hideUsagePop();
        return;
      }
      if (ui.settingsShown && (ui.accRemove || ui.accMenu || ui.accRename)) { ui.accRemove = ui.accMenu = ui.accRename = null; openSettings(); return; }
      if (ui.settingsShown) { closeSettings(); return; }
      if (findOpen()) { closeFind(); return; }
      if (ui.memoDel) { askMemoDel(null); return; }
      if (ui.mergeAsk) { ui.mergeAsk = null; renderAll(true); return; }
      if (ui.diffDraft) { ui.diffDraft = null; const w = worker(ui.wSel); if (w) renderDiff(w); return; }
      if (ui.aaEdit) { ui.aaEdit = null; renderChatInspector(); return; }
      if (ui.sugEdit) { ui.sugEdit = null; renderChatInspector(); return; }
      // Then the right sidebar's drawer in a narrow window (I1).
      if (closeDrawer()) return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (el.matches('input, textarea')) return;
      if (undoClear()) e.preventDefault();
    }
    // Under an open dialog or the Settings sheet, the view does not change behind it (L14).
    const covered = ui.settingsShown || !$('#dlg').hidden;
    if (mod && e.key === ',') { e.preventDefault(); if ($('#dlg').hidden) openSettings(); }
    // Ctrl/Cmd+L: to the message field of the view (K1).
    if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyL') { e.preventDefault(); if (!covered) focusComposer(); return; }
    // Ctrl/Cmd+O: the sidebar Worker row with the focus, or the Worker on screen, in the default editor (item 3A).
    if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyO') {
      e.preventDefault();
      const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-ctx="worker"]')?.dataset.id;
      const id = row ?? (ui.view === 'worker' && ui.wOpen ? ui.wSel : null);
      if (!covered && id) void openFolder(id, 'editor', () => openSettings('general'));
      return;
    }
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
      const cur = w ? workerTask(w) : null;
      menu.dataset.for = 'worker';
      menu.innerHTML = `${w ? rowOpenItems(w) : ''}<button class="menu-item" role="menuitem" data-action="open-worker" data-id="${esc(id)}" data-close>${sym('s-open')}<span>${t('open.worker')}</span></button>${w && canStop(w, cur) ? `<button class="menu-item is-danger" role="menuitem" data-action="worker-stop" data-id="${esc(id)}" data-close>${sym('s-stop16')}<span>${t('wk.stop')}</span></button>` : ''}`;
      openCtxMenu(x, y);
      return;
    }
    menu.dataset.for = 'aa';
    menu.innerHTML = `<button class="menu-item" role="menuitem" data-action="aa-edit" data-id="${id}">${t('aa.correct')}…</button><button class="menu-item" role="menuitem" data-action="view" data-v="memory">${t('aa.viewMemory')}</button>`;
    openCtxMenu(x, y);
  });
  // The menu keeps the keyboard: arrows move between its items, Tab closes it (L14).
  $('#ctxmenu').addEventListener('keydown', (e) => {
    const items = [...$('#ctxmenu').querySelectorAll<HTMLElement>('.menu-item')];
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
    const r = await tryCall('chat:send', replyText('chat', text), files, ui.reply.chat?.task ?? null, chatPreset());
    // The chips went with it.
    if (r.ok) setPreset(null);
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

  // The main process sends the parts of the state that changed; the panels that read them are drawn again.
  const gotState = (msg: StateMsg) => {
    const got = readState(msg, gotState);
    if (!got) return;
    const { state: s } = got;
    const parts = S && !actedSinceWholeDraw() ? got.parts : null;
    const has = (...ps: Part[]) => !parts || ps.some((p) => parts.has(p));
    const firstSetup = !S && s.setupNeeded;
    const langChanged = S && S.settings.language !== s.settings.language;
    if (S && has('chat')) ui.chatOlder = slideOlder(ui.chatOlder, S.chat, s.chat, ui.chatFrom);
    const first = !S;
    setS(s);
    // At launch: what happened since the app was last looked at, a quit included.
    if (first) checkAway();
    renderAll(false, parts);
    if (ui.settingsShown && has('update', 'settings')) drawUpdate();
    if (ui.settingsShown && has('telegram')) drawTelegram();
    if (!has('accounts', 'setupNeeded', 'settings')) return;
    // The settings sheet only depends on accounts; re-render it only when they change.
    const accKey = JSON.stringify(s.accounts) + s.setupNeeded;
    const accChanged = accKey !== ui.accKey;
    ui.accKey = accKey;
    if (firstSetup && !ui.settingsShown) openSettings('accounts');
    else if (ui.settingsShown && accChanged && !langChanged) openSettings();
  };
  ide.onState(gotState);
  bindSide();
  bindTerm();
  bindDock((tab) => { if (tab === 'sq') openSide(); else openTerm(); });
  bindBranches();
  ide.onTermState(setTermView);
  void call('term:state').then((v) => { if (v) setTermView(v); });
  ide.onSideState(setSideView);
  void call('side:state').then((v) => { if (v) setSideView(v); });
  ide.onWorkerLog((id, item) => {
    const l = ui.logs.get(id);
    if (l) l.push(item);
    // The open Worker's new messages are read out; its thread is not a live region (L14).
    if (ui.view === 'worker' && ui.wOpen && ui.wSel === id && item.from !== 'user') announce(item.text);
    if (ui.view === 'worker' && ui.wSel === id) renderSession();
  });
  ide.onOpenResult(gotoResult);
  ide.onUsageOpen(() => { if (!usagePop.pinned) toggleUsagePin(false); });
  // A task ended: its own sound, not the decision's, so the two are told apart by ear.
  ide.onDoneAlert(() => { if (S) void playSound(S.settings.doneSound, S.settings.soundVolume); });
  ide.onDecisionAlert((loud) => {
    // Quiet hours, or one more of a burst from the same Worker: it shows without the sound.
    if (S && loud) void playSound(S.settings.sound, S.settings.soundVolume, S.settings.customSound);
    document.querySelector('.sec-dec')?.classList.add('blink');
    $('#dec-count')?.classList.add('pulse');
    // The right sidebar stays as it is when a decision arrives; the Next button's count pulses.
    const badge = $('#next-count');
    badge.classList.remove('pulse');
    void badge.offsetWidth;
    badge.classList.add('pulse');
    setTimeout(() => { document.querySelector('.sec-dec')?.classList.remove('blink'); }, 3500);
  });
  window.addEventListener('focus', () => { checkAway(); renderAll(); });
  // Looking away starts the clock; while the window has the focus it is kept current.
  window.addEventListener('blur', markSeen);
  setInterval(() => { if (document.hasFocus()) markSeen(); }, 60_000);
  setInterval(() => { if (S?.dispatcher.busy) tickDispatcher(); }, 1000);
  setInterval(() => { if (S) { renderSidebar(); if (ui.view === 'worker') renderWorkerList(); } }, 60_000);
  // The age and slot clock of decisions: their text only, so nothing is drawn again.
  setInterval(() => tickDecisions(), 15_000);

  void ide.call<StateMsg>('state:full').then(async (msg) => {
    const got = readState(msg, gotState);
    if (got) setS(got.state);
    if (!S) return;
    renderAll(true);
    await restoreSession();
    setInterval(keepSession, 1000);
    window.addEventListener('beforeunload', keepSession);
    if (!S) return;
    if (S.setupNeeded) openSettings('accounts');
    // The app starts where its main work is: the message field (K1), unless the last screen it opened on has none.
    else if ((!document.activeElement || document.activeElement === document.body) && (ui.view === 'chat' || (ui.view === 'worker' && ui.wOpen))) focusComposer();
  });
}

init();
