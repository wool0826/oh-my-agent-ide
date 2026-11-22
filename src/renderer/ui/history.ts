// Screen history: every navigation goes through go(), so Back and Forward can retrace it.
import type { Worker } from '../../shared/types';
import { History, NavInput, sameScreen, type NavDir, type NavSource, type Screen } from '../../shared/history';
import { setView } from '../app';
import { closePop } from './controls';
import { $, call, isMac, S, ui, worker } from './core';
import { renderMemory } from './memory';
import { closeSettings } from './settings';
import { loadLog, renderCancelDialog } from './workers';

export const nav = new History<Screen>(sameScreen);

export const navInput = new NavInput();

export function screen(): Screen {
  return { view: ui.view, wSel: ui.wSel, wOpen: ui.wOpen, wTab: ui.wTab, repoSel: ui.repoSel, memSel: ui.memSel, wFilter: ui.wFilter };
}

/**
 * Every user navigation goes through here: a view tab, a Worker's conversation opened or closed, its
 * Chat/Changes tab, a repository or memory file picked, a Worker list filter. The screen it leaves goes
 * on the Back stack. A new view (a tab, a list filter) adds its field to Screen and navigates with go().
 */

export function go(next: Partial<Screen>) {
  const from = screen();
  const to = { ...from, ...next };
  nav.push(from, to);
  show(to, from);
}

/** Puts a screen on the window, loading what it needs that `from` did not show. */
export function show(to: Screen, from: Screen) {
  const conv = (s: Screen) => (s.view === 'worker' && s.wOpen ? s.wSel : null);
  Object.assign(ui, to);
  const opened = conv(to);
  if (opened && opened !== conv(from)) { ui.lastLogKey = ''; void loadLog(opened); }
  if (to.wTab !== from.wTab) ui.lastLogKey = '';
  // Fresh changes each time a Worker's Changes tab comes on screen.
  if (to.wTab === 'changes' && to.wSel && (from.wTab !== 'changes' || from.wSel !== to.wSel)) ui.diffs.delete(to.wSel);
  if (to.memSel !== from.memSel) {
    ui.memText = '';
    if (to.memSel) void readMemFile(to.memSel);
  }
  setView(to.view);
}

export async function readMemFile(id: string) {
  const text = await call<string>('memory:read', id);
  if (ui.memSel === id) { ui.memText = text ?? ''; renderMemory(); }
}

/** What a saved screen looks like now: a removed repository is deselected; a Worker that is gone too, and its conversation dropped. */
export function stillThere(s: Screen): Screen | null {
  if (s.repoSel && !S?.repos.some((r) => r.name === s.repoSel)) s = { ...s, repoSel: null };
  if (!s.wSel || worker(s.wSel)) return s;
  return s.view === 'worker' && s.wOpen ? null : { ...s, wSel: null, wOpen: false };
}

/** Back or Forward, from a mouse side button, the OS, or a shortcut. */
export function navStep(dir: NavDir, src: NavSource) {
  if (!navInput.accept(src, dir, performance.now())) return;
  closePop();
  $('#ctxmenu').hidden = true;
  // A sheet or dialog on top: Back closes it first, Forward waits until it is gone. Neither is a history entry.
  if (ui.settingsShown || ui.cancelAsk) {
    if (dir === 'forward') return;
    if (ui.cancelAsk) { ui.cancelAsk = null; renderCancelDialog(); } else closeSettings();
    return;
  }
  const cur = screen();
  const to = dir === 'back' ? nav.goBack(cur, stillThere) : nav.goForward(cur, stillThere);
  if (to) show(to, cur);
}

/** The Back/Forward shortcut: ⌘[ and ⌘] on macOS; Alt+← and Alt+→ elsewhere, but not while typing in a field. */
export function navKey(e: KeyboardEvent): NavDir | null {
  if (e.isComposing || e.shiftKey || e.ctrlKey) return null;
  if (isMac) return e.metaKey && !e.altKey ? (e.code === 'BracketLeft' ? 'back' : e.code === 'BracketRight' ? 'forward' : null) : null;
  if (!e.altKey || e.metaKey || (e.target as HTMLElement).matches?.('input, textarea, select, [contenteditable]')) return null;
  return e.key === 'ArrowLeft' ? 'back' : e.key === 'ArrowRight' ? 'forward' : null;
}
