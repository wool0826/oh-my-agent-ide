// "@" in a composer (decision 7C): the list of repositories, files, PRs, tasks and Workers over the composer, and the
// chips the picked ones become over its text. The rules are in shared/mentions.ts.

import { addMention, chipFold, dropMention, mentionAt, mentionBlock, mentionRows, MENTION_KINDS, type MentionRow } from '../../shared/mentions';
import { matchParts } from '../../shared/quickInput';
import type { Mention, MentionKind, Task } from '../../shared/types';
import { $, call, esc, MENTION_ICON, mentionChip, S, t, ui } from './core';
import { closeCpop, cpopOpen, showCpop, type CpopList, type CpopRow } from './cpop';
import type { Box } from './chat';
import { presetChipsHtml } from './prompts';
import type { Key } from '../../shared/i18n';

interface Index { state: 'ready' | 'indexing' | 'error'; count: number; repos: { name: string; where: string; files: string[] }[] }

/** The last file index main sent; the list draws from it while a newer one is read. */
let index: Index | null = null;
/** Set while a pick changes the text, so what it leaves does not open the list again. */
let picking = false;

const inputOf = (box: Box) => $<HTMLTextAreaElement>(box === 'chat' ? '#chat-input' : '#ws-input');

const GROUP: Record<MentionKind, Key> = { repo: 'mention.repos', file: 'mention.files', pr: 'mention.prs', task: 'mention.tasks', worker: 'mention.workers' };

function taskIcon(status: string | undefined): string {
  const s = status as Task['status'] | undefined;
  if (s === 'done') return 's-check';
  if (s === 'failed') return 'e-failed';
  if (s === 'cancelled') return 'e-cancel';
  if (s === 'queued' || s === 'blocked') return 'e-queued';
  return MENTION_ICON.task;
}

function rowLabel(r: MentionRow, q: string) {
  const m = r.mention;
  const text = m.title ? `${m.label} ${m.title}` : m.label;
  return q ? matchParts(text, q) : text;
}

/** What "@" at the caret lists, group by group. */
function mentionList(box: Box, at: { start: number; query: string }, retry: () => void): CpopList {
  const files = (index?.repos ?? []).flatMap((r) => r.files.map((path) => ({ repo: r.name, path })));
  const repos = index?.repos ?? (S?.repos ?? []).map((r) => ({ name: r.name, where: '' }));
  const groups = mentionRows({ repos, files, tasks: S?.tasks ?? [], workers: S?.workers ?? [] }, at.query, {
    done: t('mention.done'), merged: t('mention.merged'), closed: t('mention.closed'),
  });
  const picks = new Map<string, Mention>();
  const rows: CpopRow[] = [];
  for (const k of MENTION_KINDS) {
    groups[k].forEach((r, i) => {
      const id = `${k}:${i}`;
      picks.set(id, r.mention);
      rows.push({ id, icon: k === 'task' ? taskIcon(r.state) : MENTION_ICON[k], label: rowLabel(r, at.query), meta: r.meta, group: t(GROUP[k]) });
    });
  }
  const st = index?.state;
  return {
    kind: 'mentions',
    rows,
    empty: t('slash.none'),
    hints: [[['↑', '↓'], 'cpop.move'], [['↵', 'Tab'], 'cpop.insert'], [['Esc'], 'close']],
    nav: 'list',
    tab: true,
    status: st === 'indexing' ? { icon: 'e-refresh', busy: true, text: t('mention.indexing', { n: (index?.count ?? 0).toLocaleString() }) }
      : st === 'error' ? { icon: 's-alert', text: t('mention.indexErr'), retry } : undefined,
    pick: (row) => { const m = picks.get(row.id); if (m) pickMention(box, at, m); },
  };
}

/** The list again for what is typed now, if it is still open. */
function redraw(box: Box) {
  if (!cpopOpen(box, 'mentions')) return;
  const input = inputOf(box);
  const at = mentionAt(input.value, input.selectionStart);
  if (at) showCpop(box, mentionList(box, at, () => void readIndex(box, true)));
}

/** Asks main for the files; while it reads them for the first time, the list says so and fills in once it is done. */
async function readIndex(box: Box, retry = false) {
  const now = await call<Index>('mention:index', { retry });
  if (!now) return;
  index = now;
  redraw(box);
  if (now.state === 'indexing') {
    index = (await call<Index>('mention:index', { wait: true })) ?? now;
    redraw(box);
  }
}

/** The text changed: "@" after a space at the caret opens the list (or narrows it), anything else closes it. */
export function mentionTyped(box: Box) {
  if (picking) return;
  if (ui.mentionSel[box] >= 0) { ui.mentionSel[box] = -1; drawComposerChips(box); }
  const input = inputOf(box);
  const at = (box !== 'chat' || !ui.shell) && input.selectionStart === input.selectionEnd ? mentionAt(input.value, input.selectionStart) : null;
  if (!at) { if (cpopOpen(box, 'mentions')) closeCpop(box); return; }
  const opening = !cpopOpen(box, 'mentions');
  showCpop(box, mentionList(box, at, () => void readIndex(box, true)));
  if (opening) void readIndex(box);
}

function pickMention(box: Box, at: { start: number; query: string }, m: Mention) {
  const input = inputOf(box);
  const next = dropMention(input.value, at);
  input.value = next.value;
  input.setSelectionRange(next.caret, next.caret);
  ui.mentions[box] = addMention(ui.mentions[box], m);
  drawComposerChips(box);
  picking = true;
  try { input.dispatchEvent(new Event('input', { bubbles: true })); } finally { picking = false; }
}

// The chips over the text.

function mentionChipsHtml(box: Box): string {
  const list = ui.mentions[box];
  if (!list.length) return '';
  const { shown, more } = chipFold(list, ui.mentionOpen[box]);
  const chips = shown.map((m, i) => {
    const x = esc(t('preset.remove', { name: m.label }));
    const tip = m.kind === 'file' ? `${m.repo ? `${m.repo}: ` : ''}${m.id}` : m.title ? `${m.label} ${m.title}` : '';
    return `<span class="fchip mchip${ui.mentionSel[box] === i ? ' on' : ''}"${tip ? ` data-tip="${esc(tip)}"` : ''}>${mentionChip(m, `<button type="button" data-action="mention-x" data-box="${box}" data-i="${i}" aria-label="${x}" data-tip="${x}"><svg aria-hidden="true"><use href="#s-x"/></svg></button>`)}</span>`;
  }).join('');
  const rest = list.slice(shown.length).map((m) => m.label).join(', ');
  return chips + (more ? `<button type="button" class="fchip more" data-action="mention-more" data-box="${box}" aria-label="${esc(rest)}" data-tip="${esc(rest)}">+${more}</button>` : '');
}

/** One row over the composer's text: the preset's chips (chat), a divider, then the "@" ones. */
export function drawComposerChips(box: Box) {
  const el = $(box === 'chat' ? '#chat-preset' : '#ws-preset');
  const pre = box === 'chat' ? presetChipsHtml() : '';
  const men = mentionChipsHtml(box);
  el.innerHTML = pre + (pre && men ? '<span class="chip-sep" aria-hidden="true"></span>' : '') + men;
  el.hidden = !pre && !men;
}

/** The × on a chip. */
export function dropMentionChip(box: Box, i: number) {
  ui.mentions[box] = ui.mentions[box].filter((_, j) => j !== i);
  ui.mentionSel[box] = -1;
  if (ui.mentions[box].length <= 1) ui.mentionOpen[box] = false;
  drawComposerChips(box);
  inputOf(box).focus();
}

/** "+N": all the chips are shown. */
export function openMentionChips(box: Box) {
  ui.mentionOpen[box] = true;
  drawComposerChips(box);
  inputOf(box).focus();
}

/**
 * Keys over the chips: Backspace with the caret at the start of the text chooses the last "@" chip (a ring), and
 * again removes it; Delete removes the one chosen. Any other key lets it go. The preset's chips have their × only.
 */
export function mentionKeys(e: KeyboardEvent, box: Box): boolean {
  const list = ui.mentions[box];
  if (!list.length || e.isComposing || e.keyCode === 229) return false;
  const input = e.target as HTMLTextAreaElement;
  const sel = ui.mentionSel[box];
  const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
  if ((e.key === 'Backspace' && atStart && !e.altKey && !e.ctrlKey && !e.metaKey) || (e.key === 'Delete' && sel >= 0)) {
    e.preventDefault();
    if (sel < 0) {
      ui.mentionSel[box] = list.length - 1;
      ui.mentionOpen[box] = true;
      drawComposerChips(box);
    } else dropMentionChip(box, sel);
    return true;
  }
  if (sel >= 0 && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
    ui.mentionSel[box] = -1;
    drawComposerChips(box);
  }
  return false;
}

/** The text a message goes with: what was typed and the "[Mentioned]" block of its chips. */
export const withMentions = (text: string, list: readonly Mention[]) => text + mentionBlock(list);

/** The chips that went with a message are gone; those added while it went stay. */
export function mentionsSent(box: Box, sent: readonly Mention[]) {
  ui.mentions[box] = ui.mentions[box].filter((m) => !sent.includes(m));
  ui.mentionSel[box] = -1;
  ui.mentionOpen[box] = false;
  drawComposerChips(box);
}
