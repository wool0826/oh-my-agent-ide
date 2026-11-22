// The Memory view.
import type { MemoryFile, MemoryHits } from '../../shared/types';
import { type Key } from '../../shared/i18n';
import { PAGE } from '../../shared/paging';
import { act } from '../app';
import { $, ago, call, esc, hhmm, ic, moreBtn, S, scrollQuietly, sym, t, tone, ui } from './core';

/** What the last sync with the remote did: "Synced, 2m, 3 in · 1 out", or the failure and the commits that wait. */
export function memSyncDetail() {
  const m = S!.memorySync;
  if (m.state === 'error') return m.pending ? t('mem.sync.pending', { n: m.pending }) : '';
  if (m.state !== 'ok' || !m.at) return '';
  return m.pulled || m.pushed ? `${ago(m.at)} · ${t('mem.sync.counts', { in: m.pulled, out: m.pushed })}` : ago(m.at);
}

/** The sync status in Settings (a row under the remote's address) and in the Memory view's header (a pill). */
export function renderMemSync() {
  const m = S!.memorySync;
  const detail = memSyncDetail();
  const pill = $('#mem-sync');
  if (pill) {
    const tone = m.state === 'ok' ? ' green' : m.state === 'error' ? ' orange' : m.state === 'syncing' ? ' blue' : '';
    const label = !m.remote ? t('mem.sync.off') : m.state === 'off' ? '' : t(`mem.sync.${m.state}` as Key);
    pill.innerHTML = label ? `<span class="pill${tone}"${m.error ? ` title="${esc(m.error)}"` : ''}>${esc(detail ? `${label} · ${detail}` : label)}</span>` : '';
  }
  const row = document.getElementById('set-msync');
  if (!row) return;
  row.hidden = !m.remote || m.state === 'off';
  if (row.hidden) { row.innerHTML = ''; return; }
  const glyph = m.state === 'ok' ? sym('s-check', 'c-green') : m.state === 'error' ? sym('s-alert', 'c-orange') : ic('run');
  const busy = m.state === 'syncing';
  row.innerHTML = `<div class="srow"><span class="msync${m.state === 'error' ? ' bad' : ''}">${glyph}<b>${t(`mem.sync.${m.state}` as Key)}</b><span>${esc(detail)}</span></span><button class="btn" data-action="mem-sync"${busy ? ' disabled' : ''}>${t(m.state === 'error' ? 'mem.sync.retry' : 'mem.sync.now')}</button></div>${m.error ? `<div class="msync-err">${esc(m.error)}</div>` : ''}`;
}

export async function loadMemory() {
  ui.memFiles = (await call<MemoryFile[]>('memory:list')) ?? [];
  renderMemory();
}

/** Search memory: a new query's first page, or (`offset`, the hits shown) the page after them. */
export async function searchMem(q: string, offset = 0) {
  ui.memQ = q;
  if (!q) { ui.memHits = null; ui.memTotal = 0; renderMemory(); return; }
  const r = await call<MemoryHits>('memory:search', q, offset);
  // A newer query, or the same page asked twice: this answer is stale.
  if (ui.memQ !== q || (offset && offset !== ui.memHits?.length)) return;
  // Each page is a fresh search, so a memory file edited between pages can shift a hit into the next page: skip repeats.
  const kept = offset ? ui.memHits ?? [] : [];
  const seen = new Set(kept.map((h) => `${h.path}:${h.line}`));
  ui.memHits = [...kept, ...(r?.hits ?? []).filter((h) => !seen.has(`${h.path}:${h.line}`))];
  ui.memTotal = r?.total ?? ui.memHits.length;
  if (!offset) scrollQuietly($('#mem-list'), 0);
  renderMemory();
}

export function memIcon(kind: MemoryFile['kind']) {
  return kind === 'preference' ? ic('pref', 'star') : kind === 'repo' ? ic('repo', 'box') : kind === 'decision' ? ic('done') : ic('doc', 'doc');
}

export function renderMemory() {
  const list = $('#mem-list');
  if (ui.memHits) {
    list.innerHTML = ui.memHits.length
      ? ui.memHits.map((h) => `<div class="hit" data-action="mem-select" data-id="${esc(h.path)}"><small>${esc(h.path)}:${h.line}</small><span>${esc(h.text)}</span></div>`).join('') + moreBtn('mem-hits', ui.memTotal - ui.memHits.length, PAGE.memHits)
      : `<div class="empty-view"><span>${t('mem.noHits')}</span></div>`;
  } else {
    list.innerHTML = ui.memFiles.map((f) => `<div tabindex="0" role="button" class="li${ui.memSel === f.path ? ' sel' : ''}" data-action="mem-select" data-id="${esc(f.path)}">${memIcon(f.kind)}<span class="m"><b>${esc(f.title)}</b><span>${esc(f.path)}</span></span><span class="r">${hhmm(f.updatedAt)}</span></div>`).join('')
      || `<div class="empty-view">${sym('s-sparkle')}<b>${t('mem.emptyTitle')}</b></div>`;
  }
  const ins = $('#mem-ins');
  if (!ui.memSel) {
    ins.innerHTML = `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-sparkle"/></svg><b>${t('mem.pickTitle')}</b></div>`;
    return;
  }
  ins.innerHTML = `<div class="ins-h"><b>${esc(ui.memSel)}</b></div>
    <textarea class="inp memedit" id="mem-edit" spellcheck="false">${esc(ui.memText)}</textarea>
    <div class="ins-act">${ui.memSel.startsWith('repos/') ? `<button class="btn" data-action="mem-promote" data-id="${esc(ui.memSel.slice(6, -3))}" title="${t('mem.promoteHint')}">${t('mem.promote')}</button>` : ''}<button class="btn def" data-action="mem-save">${t('save')}</button></div>`;
}
