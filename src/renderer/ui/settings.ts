// The Settings window.
import type { ClaudeInfo, ModelList, Worker, AccountView, SoundName, Lang } from '../../shared/types';
import { EFFORTS, MAX_ACCOUNTS, type Effort } from '../../shared/types';
import { ASK_RULES } from '../../shared/grants';
import { type Key } from '../../shared/i18n';
import { normalizeQuickKey, quickKeyLabel } from '../../shared/quickKey';
import { THEMES, cleanTheme } from '../../shared/theme';
import { cleanTime } from '../../shared/notifyRules';
import { DECISION_SOUNDS, DONE_SOUNDS } from '../../shared/sounds';
import { MAX_WORKERS_MAX, MAX_WORKERS_MIN, WAIT_SLOT_MAX, clampMaxWorkers, clampWaitSlot } from '../../shared/slots';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, clampFontSize, fontStack, normalizeFontFamily } from '../../shared/font';
import { away } from './chat';
import { closePop, installedFonts, markFont, openPop, Opt, pop } from './controls';
import { $, applyStaticText, call, cap1, esc, ic, isMac, k, lang, lv, modelLabel, Pane, pct, S, scrollQuietly, setCustomCache, shortPath, swapIn, sym, t, toast, ui, when } from './core';
import { nav, show } from './history';
import { renderMemSync } from './memory';
import { jira, loadPreflight, preflight, preflightRows } from './repos';
import { ms, usageWindows } from './sidebar';

/** Apply the UI font and text size as CSS variables. Also used for the live preview in Settings. */
/** Puts the chosen appearance on the page; the tokens do the rest (tokens.css). */
export function applyTheme(theme: string) {
  const v = cleanTheme(theme);
  if (document.documentElement.dataset.theme !== v) document.documentElement.dataset.theme = v;
}

export function applyFont(family: string, size: number) {
  const font = fontStack(family), px = `${clampFontSize(size)}px`;
  // Every render calls this. Re-place the pills only when the text really changed size; a placement on
  // each render turned every tab switch into a jump.
  if (ui.fontApplied === `${font}|${px}`) return;
  ui.fontApplied = `${font}|${px}`;
  const root = document.documentElement.style;
  root.setProperty('--font', font);
  root.setProperty('--ui-font-size', px);
  glideSoon(false);
}

export function previewFont() {
  applyFont($<HTMLInputElement>('#set-font').value, Number($<HTMLInputElement>('#set-fsize').value));
}

export const PANES: { id: Pane; key: Key; glyph: string }[] = [
  { id: 'accounts', key: 'set.accounts', glyph: 's-person' },
  { id: 'general', key: 'set.general', glyph: 's-gear' },
  { id: 'display', key: 'set.display', glyph: 's-textsize' },
  { id: 'alerts', key: 'set.alerts', glyph: 's-bell' },
  { id: 'memory', key: 'set.memory', glyph: 's-sparkle' },
  { id: 'models', key: 'set.models', glyph: 's-cpu' },
];

export const PLAN_OPTS: Opt[] = [{ value: 'team', label: 'Team' }, { value: 'enterprise', label: 'Enterprise' }];

export const effortOpts = (): Opt[] => EFFORTS.map((e) => ({ value: e, label: t(`effort.${e}` as Key) }));

export const AVATAR = ['var(--avatar-1)', 'var(--avatar-2)', 'var(--avatar-3)', 'var(--avatar-4)'];

/** Choices until the account's model list has been read once. */
export const FALLBACK_MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

/** Every model the accounts can use, newest first; a configured model missing from the list stays selectable. */
/** `claudeOnly`: for an agent that has to run on Claude Code (the Dispatcher). */
export function modelOpts(cur: string, claudeOnly = false): Opt[] {
  const known = ui.models.models.filter((m) => !claudeOnly || (m.provider ?? 'claude') === 'claude');
  const ids = known.length ? known.map((m) => m.id) : FALLBACK_MODELS;
  const list = cur && !ids.includes(cur) ? [cur, ...ids] : ids;
  return list.map((id) => ({ value: id, label: modelLabel(id), sub: id }));
}

/** A button that opens a model list, backed by a hidden input like segc. */
export function modelPicker(id: string, value: string, label: string) {
  return `<span class="dd"><input type="hidden" id="${id}" value="${esc(value)}"><button type="button" class="dd-btn" data-dd="${id}" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label)}"><span>${esc(modelLabel(value))}</span>${sym('s-updown')}</button></span>`;
}

export function openModelPicker(btn: HTMLElement) {
  if (pop.owner === btn) { closePop(); return; }
  const inp = document.getElementById(btn.dataset.dd!) as HTMLInputElement | null;
  if (!inp) return;
  openPop(btn, modelOpts(inp.value), inp.value, (v) => {
    if (v === inp.value) return;
    inp.value = v;
    btn.querySelector('span')!.textContent = modelLabel(v);
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, 260);
}

/** Read the model list; 'now' asks the API even if the saved list is recent. */
export async function loadModels(mode: 'cached' | 'fresh' | 'now') {
  ui.modelsLoading = true;
  syncModelRows();
  const r = await call<ModelList>('models:list', mode);
  ui.modelsLoading = false;
  if (r) ui.models = r;
  syncModelRows();
}

export function modelsStatus() {
  const m = ui.models;
  if (ui.modelsLoading) return '…';
  if (m.error === 'no-account' && !m.models.length) return t('set.modelsNoAccount');
  if (m.error === 'no-token' && !m.models.length) return t('set.modelsNoToken');
  if (m.error && !m.models.length) return t('set.modelsFailed', { msg: m.error });
  if (!m.fetchedAt) return '–';
  return t(m.error ? 'set.modelsStale' : 'set.modelsCount', { n: m.models.length, time: when(m.fetchedAt) });
}

/** Update the list status and the picker labels in place, without re-rendering Settings. */
export function syncModelRows() {
  const st = document.getElementById('set-mlist');
  if (st) { st.textContent = modelsStatus(); st.classList.toggle('bad', !!ui.models.error); }
  document.querySelectorAll<HTMLElement>('[data-dd]').forEach((b) => {
    const v = (document.getElementById(b.dataset.dd!) as HTMLInputElement | null)?.value;
    const s = b.querySelector('span');
    if (v && s) s.textContent = modelLabel(v);
  });
}

/** Segmented control backed by a hidden input, so the form reads it like any field. */
export function segc(id: string, value: string, opts: Opt[], label: string, extra = '') {
  const cur = opts.some((o) => o.value === value) ? value : opts[0].value;
  return `<span class="segc" role="radiogroup" aria-label="${esc(label)}"><input type="hidden" id="${id}" value="${esc(cur)}" ${extra}>${opts.map((o) => `<button type="button" role="radio" data-segc="${id}" data-v="${esc(o.value)}" aria-checked="${o.value === cur}"${o.value === cur ? ' class="on"' : ''}>${esc(o.label)}</button>`).join('')}</span>`;
}

export function pickSeg(btn: HTMLButtonElement) {
  const inp = document.getElementById(btn.dataset.segc!) as HTMLInputElement | null;
  if (!inp || inp.value === btn.dataset.v) return;
  inp.value = btn.dataset.v!;
  syncSegs(btn.parentElement!);
  inp.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Make each segmented control show its hidden input's value (after restoring kept values). */
export function syncSegs(root: ParentNode = document) {
  root.querySelectorAll<HTMLButtonElement>('[data-segc]').forEach((b) => {
    const on = (document.getElementById(b.dataset.segc!) as HTMLInputElement | null)?.value === b.dataset.v;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
}

/**
 * Liquid Glass segmented controls: one glass pill (the control's ::before) sits under the chosen
 * segment. A changed choice slides and stretches it there; a new, re-shown or resized control places it
 * without motion.
 */

export function glideAll(animate: boolean) {
  document.querySelectorAll<HTMLElement>('.seg, .segc').forEach((c) => glide(c, animate));
}

/**
 * Run glideAll once in the next frame for every request made before it. Separate frame callbacks ran in
 * the order they were queued, so whichever came first decided whether a switch slid. A placement without
 * motion (new text size) wins over a slide asked for in the same frame.
 */

export let glideNext: boolean | null = null;

export function glideSoon(animate: boolean) {
  if (glideNext !== null) { glideNext &&= animate; return; }
  glideNext = animate;
  requestAnimationFrame(() => {
    const a = glideNext!;
    glideNext = null;
    glideAll(a);
  });
}

/**
 * Where each control's pill last was, by the control's name. A panel drawn again makes its controls anew (the right
 * sidebar's tabs, "Daily / When a PR merges"), and a new control has no pill to slide from: it starts from here.
 */
const lastPill = new Map<string, number[]>();
const pillName = (c: HTMLElement) => c.id || c.querySelector<HTMLElement>(':scope > input[type="hidden"]')?.id
  || `${c.closest('[id]')?.id ?? ''}/${c.getAttribute('aria-label') ?? ''}`;

export function glide(c: HTMLElement, animate: boolean) {
  const on = c.querySelector<HTMLElement>(':scope > button[aria-pressed="true"], :scope > button.on');
  if (!on || !c.offsetParent) {
    // Only a control that still shows a pill: rewriting the class of a hidden one is itself a mutation,
    // which woke the observer every frame and kept a requestAnimationFrame loop running.
    if (c.dataset.glide !== undefined || c.classList.contains('glide-on')) {
      c.classList.remove('glide-on', 'glide-ready', 'glide-move');
      delete c.dataset.glide;
    }
    return;
  }
  const box = [on.offsetLeft, on.offsetTop, on.offsetWidth, on.offsetHeight];
  const key = box.join(',');
  if (c.dataset.glide === key) return;
  const name = pillName(c);
  let from = c.dataset.glide?.split(',').map(Number);
  if (!from && animate) {
    // Drawn anew with another choice than the one before it had: put the pill where that one was, then let it travel.
    const was = lastPill.get(name);
    if (was && was.join(',') !== key) {
      c.classList.remove('glide-ready', 'glide-move');
      c.style.setProperty('--gx', `${was[0]}px`);
      c.style.setProperty('--gy', `${was[1]}px`);
      c.style.setProperty('--gw', `${was[2]}px`);
      c.style.setProperty('--gh', `${was[3]}px`);
      c.classList.add('glide-on');
      void c.offsetWidth;
      c.classList.add('glide-ready');
      from = was;
    }
  }
  lastPill.set(name, box);
  const slide = animate && !!from && c.classList.contains('glide-ready');
  c.dataset.glide = key;
  if (!slide) c.classList.remove('glide-ready', 'glide-move');
  c.style.setProperty('--gx', `${box[0]}px`);
  c.style.setProperty('--gy', `${box[1]}px`);
  c.style.setProperty('--gw', `${box[2]}px`);
  c.style.setProperty('--gh', `${box[3]}px`);
  c.classList.add('glide-on');
  if (!slide) {
    void c.offsetWidth; // place it first, then turn transitions on
    c.classList.add('glide-ready');
  } else if (from && (Math.abs(from[0] - box[0]) > 1 || Math.abs(from[1] - box[1]) > 1)) {
    c.classList.remove('glide-move');
    void c.offsetWidth; // restart the stretch
    c.classList.add('glide-move');
  }
}

export function stepper(id: string, value: number, min: number, max: number, label: string) {
  return `<span class="step" role="group" aria-label="${esc(label)}"><button type="button" data-step="-1" data-for="${id}" aria-label="-">${sym('s-minus')}</button><input id="${id}" class="step-v" inputmode="numeric" value="${value}" data-min="${min}" data-max="${max}" aria-label="${esc(label)}"><button type="button" data-step="1" data-for="${id}" aria-label="+">${sym('s-plus')}</button></span>`;
}

export function slider(id: string, value: number, label: string) {
  return `<span class="slider-wrap">${sym('s-speaker', 'slider-ic')}<input id="${id}" class="slider" type="range" min="0" max="100" step="5" value="${value}" style="--val:${value}%" aria-label="${esc(label)}"><output class="slider-out" for="${id}">${value}</output></span>`;
}

export function meter(label: string, v: number | null) {
  const w = v ?? 0;
  return `<span>${label}</span><span class="cap"><i class="${lv(v)}" style="width:${Math.min(100, w)}%"></i></span><span class="mv${w > 80 ? ' hot' : ''}">${pct(v)}</span>`;
}

export function initials(label: string) {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (!/^[A-Za-z0-9]/.test(words[0])) return [...words[0]][0]; // Hangul and other scripts: one character
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

export function accountCard(a: AccountView, i: number) {
  const gpt = a.provider === 'chatgpt';
  const kind = gpt ? t('acc.kindChatgpt') : a.kind === 'login' ? t('acc.kindLogin') : t('acc.kindToken');
  const plan = gpt ? (a.planLabel || 'ChatGPT') : a.plan === 'enterprise' ? 'Enterprise' : 'Team';
  const renaming = ui.accRename === a.id;
  const name = renaming
    ? `<span class="acc-edit"><input class="inp" id="acc-rename" value="${esc(a.label)}" aria-label="${t('acc.name')}" data-id="${a.id}"><button class="btn def" data-action="acc-rename-save" data-id="${a.id}">${t('save')}</button><button class="btn" data-action="acc-rename-cancel">${t('cancel')}</button></span>`
    : `<span class="acc-name"><b>${esc(a.label)}</b><span class="plan-badge ${gpt ? 'chatgpt' : a.plan}">${esc(plan)}</span></span>`;
  const menu = ui.accMenu === a.id ? `<div class="amenu" role="menu" aria-label="${t('acc.options')}">
      <button role="menuitem" data-action="acc-rename" data-id="${a.id}">${t('acc.rename')}</button>
      <button role="menuitem" data-action="acc-refresh">${t('acc.refresh')}</button>
      ${gpt ? '' : `<div class="amenu-sep"></div><span class="amenu-h">${t('acc.plan')}</span>
      ${PLAN_OPTS.map((o) => `<button role="menuitemradio" aria-checked="${a.plan === o.value}" data-action="acc-plan" data-id="${a.id}" data-v="${o.value}">${sym('s-tick', 'amenu-tick')}${o.label}</button>`).join('')}`}
      <div class="amenu-sep"></div>
      <button role="menuitem" class="danger" data-action="acc-remove" data-id="${a.id}">${t('acc.removeMenu')}</button>
    </div>` : '';
  return `<div class="acc-card${renaming ? ' editing' : ''}">
    <span class="avatar" style="background:${AVATAR[i % AVATAR.length]}">${esc(initials(a.label))}</span>
    <span class="acc-main">${name}<span class="acc-kind">${kind}</span>${a.lastError ? `<span class="warn">${esc(a.lastError)}</span>` : ''}</span>
    <span class="acc-meters">${usageWindows(a).map((w) => meter(w.label, w.v)).join('')}</span>
    <span class="acc-more"><button class="btn icon" data-action="acc-menu" data-id="${a.id}" aria-haspopup="menu" aria-expanded="${ui.accMenu === a.id}" aria-label="${t('acc.options')}">${sym('s-more')}</button>${menu}</span>
  </div>`;
}

export function removeDialog() {
  const a = S!.accounts.find((x) => x.id === ui.accRemove);
  if (!a) return '';
  const i = S!.accounts.indexOf(a);
  return `<div class="dlg-back" data-action="acc-remove-cancel"></div>
  <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t">
    <span class="avatar big" style="background:${AVATAR[i % AVATAR.length]}">${esc(initials(a.label))}</span>
    <h2 id="dlg-t">${esc(t('acc.removeTitle', { name: a.label }))}</h2>
    <p>${a.provider === 'chatgpt' ? t('acc.removeChatgpt') : a.kind === 'login' ? t('acc.removeLogin') : t('acc.removeToken')}</p>
    <div class="dlg-btns"><button class="btn" data-action="acc-remove-cancel">${t('cancel')}</button><button class="btn danger-fill" data-action="acc-remove-ok" data-id="${a.id}">${t('remove')}</button></div>
  </div>`;
}

export function settingsHtml() {
  const s = S!;
  const st = s.settings;
  const full = s.accounts.length >= MAX_ACCOUNTS;
  const hasLogin = s.accounts.some((a) => a.kind === 'login' && a.provider !== 'chatgpt');
  const hasChatgpt = s.accounts.some((a) => a.provider === 'chatgpt');
  // Ways to add an account that are still open: one login of this PC's Claude Code, one of its Codex.
  const methods: Opt[] = [{ value: 'token', label: t('acc.methodToken') }, ...(hasLogin ? [] : [{ value: 'login', label: t('acc.methodLogin') }]), ...(hasChatgpt ? [] : [{ value: 'chatgpt', label: t('acc.methodChatgpt') }])];
  if (!methods.some((m) => m.value === ui.accKind)) ui.accKind = 'token';
  const pane = (id: Pane, body: string) => `<section class="pane" data-pane="${id}"${ui.pane === id ? '' : ' hidden'}><h2>${t(PANES.find((p) => p.id === id)!.key)}</h2>${body}</section>`;
  const row = (label: string, forId: string, control: string, cls = '') => `<div class="srow${cls ? ` ${cls}` : ''}"><label class="lbl" for="${forId}">${label}</label>${control}</div>`;
  const grp = (rows: string, cap = '') => `<div class="sgrp-wrap">${cap ? `<h3 class="scap">${cap}</h3>` : ''}<div class="sgrp">${rows}</div></div>`;

  const accounts = `${grp(s.accounts.map(accountCard).join('') || `<div class="srow"><span class="lbl muted">${t('acc.none')}</span></div>`, `${t('acc.registered')} <small>${s.accounts.length} / ${MAX_ACCOUNTS}</small>`)}
    ${full ? '' : grp(`
      ${methods.length < 2 ? '' : row(t('acc.method'), 'acc-kind', segc('acc-kind', ui.accKind, methods, t('acc.method'), 'data-change="acc-kind"'))}
      ${row(t('acc.name'), 'acc-label', `<input class="inp w" id="acc-label" placeholder="${t('acc.namePh')}">`)}
      ${row(t('acc.plan'), 'acc-plan', segc('acc-plan', 'team', PLAN_OPTS, t('acc.plan')), 'acc-plan-row')}
      ${row(t('acc.token'), 'acc-token', `<input class="inp w" id="acc-token" type="password" placeholder="sk-ant-…" autocomplete="off" spellcheck="false">`, 'acc-token-row')}
      <div class="srow end"><button class="btn def" data-action="acc-add" id="acc-add-btn">${t('acc.addToken')}</button><button class="btn def" data-action="acc-add-login" id="acc-login-btn">${t('acc.addLogin')}</button><button class="btn def" data-action="acc-add-chatgpt" id="acc-chatgpt-btn">${t('acc.addChatgpt')}</button></div>`, t('acc.add'))}`;

  const general = `${grp(`<div id="pre-rows">${preflightRows()}</div>`, `${t('pre.title')}<button class="clear-x always" data-action="preflight-run" title="${t('diff.refresh')}" aria-label="${t('diff.refresh')}"><svg><use href="#s-refresh"/></svg></button>`)}${grp(`
      ${row(t('set.language'), 'set-lang', segc('set-lang', st.language, [{ value: 'en', label: 'English' }, { value: 'ko', label: '한국어' }], t('set.language')))}
      ${row(t('set.home'), 'set-home', `<input class="inp w" id="set-home" value="${esc(st.home)}"><button class="btn" data-action="pick-home">${t('choose')}</button>`)}
      ${row(t('set.ghHost'), 'set-gh', `<input class="inp w" id="set-gh" value="${esc(st.githubHost)}" placeholder="github.com">`)}
      ${row(t('set.archive'), 'set-arch', stepper('set-arch', st.archiveDays, 0, 90, t('set.archive')))}
      ${row(t('set.background'), 'set-bg', `<input class="switch" id="set-bg" type="checkbox" ${st.background ? 'checked' : ''}>`)}
      ${row(t('set.openAtLogin'), 'set-login', `<input class="switch" id="set-login" type="checkbox" ${st.openAtLogin ? 'checked' : ''}>`)}
      ${row(t('set.quickKey'), 'set-qkey', `<input class="inp w" id="set-qkey" value="${esc(quickKeyLabel(st.quickKey, isMac))}" spellcheck="false" autocomplete="off">`)}
      ${row(t('set.diag'), 'set-diag', `<button class="btn" id="set-diag" data-action="diag-export">${t('set.diagExport')}</button>`)}
      ${row(t('set.updateCheck'), 'set-upd', `<input class="switch" id="set-upd" type="checkbox" ${st.updateCheck ? 'checked' : ''}>`)}`)}${grp(
      `${row(t('set.jiraUrl'), 'set-jurl', `<input class="inp w" id="set-jurl" value="${esc(st.jiraUrl)}" placeholder="https://company.atlassian.net" spellcheck="false" autocomplete="off">`)}
      ${row(t('set.jiraEmail'), 'set-jmail', `<input class="inp w" id="set-jmail" value="${esc(st.jiraEmail)}" placeholder="${t('set.jiraEmailPh')}" spellcheck="false" autocomplete="off">`)}
      ${row(t('set.jiraToken'), 'set-jtok', `<input class="inp w" id="set-jtok" type="password" placeholder="${st.jiraTokenSet ? t('set.jiraTokenSet') : ''}" autocomplete="off" spellcheck="false">${st.jiraTokenSet ? `<button class="btn" data-action="jira-token-clear">${t('set.jiraTokenClear')}</button>` : ''}`)}`, 'Jira')}${grp(
      ASK_RULES.map((r) => row(cap1(t(r)), `ask-${r}`, `<input class="switch ask-rule" id="ask-${r}" data-rule="${r}" type="checkbox" ${st.askOff.includes(r) ? '' : 'checked'}>`)).join(''), t('set.alwaysAsk'))}`;

  const display = `${grp(`
      ${row(t('set.theme'), 'set-theme', segc('set-theme', st.theme, THEMES.map((v) => ({ value: v, label: t(`theme.${v}` as Key) })), t('set.theme')))}
      ${row(t('set.font'), 'set-font', `<span class="combo"><input class="inp" id="set-font" value="${esc(st.fontFamily)}" placeholder="${t('set.fontSystem')}" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false"><button type="button" class="combo-btn" data-combo="set-font" tabindex="-1" aria-label="${t('set.font')}">${sym('s-updown')}</button></span>`)}
      ${row(t('set.fontSize'), 'set-fsize', `<button class="btn" data-action="font-reset">${t('set.fontReset')}</button>${stepper('set-fsize', st.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, t('set.fontSize'))}`)}`)}
    <div class="fprev" aria-hidden="true"><span class="me">${t('set.preview1')}</span><span class="ai">${t('set.preview2')}</span></div>`;

  const alerts = grp(`
      ${row(t('set.osNoti'), 'set-noti', `<input class="switch" id="set-noti" type="checkbox" ${st.notifications ? 'checked' : ''}>`)}
      ${row(t('set.notiResults'), 'set-nres', `<input class="switch" id="set-nres" type="checkbox" ${st.notifyDone ? 'checked' : ''}>`)}
      ${row(t('set.quiet'), 'set-qfrom', `<input class="inp time" id="set-qfrom" value="${esc(st.quietFrom)}" placeholder="22:00" inputmode="numeric" aria-label="${t('set.quietFrom')}"><span class="dash" aria-hidden="true">–</span><input class="inp time" id="set-qto" value="${esc(st.quietTo)}" placeholder="07:00" inputmode="numeric" aria-label="${t('set.quietTo')}">`)}
      ${row(t('set.sound'), 'set-sound', `<button class="segico" data-action="sound-test" title="${t('set.soundTest')}" aria-label="${t('set.soundTest')}">${sym('s-play')}</button>${segc('set-sound', st.sound, DECISION_SOUNDS.map((x) => ({ value: x, label: t(`sound.${x}` as Key) })), t('set.sound'), 'data-change="sound-kind"')}`, 'wrap')}
      ${row(t('set.soundFile'), 'set-sfile', `<input class="inp w" id="set-sfile" value="${esc(st.customSound)}" placeholder="mp3, wav, ogg, m4a"><button class="btn" data-action="pick-sound">${t('choose')}</button>`, 'custom-row')}
      ${row(t('set.doneSound'), 'set-dsound', `<button class="segico" data-action="sound-test" data-v="done" title="${t('set.soundTest')}" aria-label="${t('set.soundTest')}">${sym('s-play')}</button>${segc('set-dsound', st.doneSound, DONE_SOUNDS.map((x) => ({ value: x, label: t(`sound.${x}` as Key) })), t('set.doneSound'))}`, 'wrap')}
      ${row(t('set.volume'), 'set-vol', slider('set-vol', st.soundVolume, t('set.volume')), 'vol')}`);

  const ci = ui.claude;
  const rulesText = !ci ? '…' : ci.rules.length ? ci.rules.join(', ') : t('set.claudeNoRules');
  const memory = `${grp(`
      ${row(t('set.memFolder'), 'set-memdir', `<span class="sval" id="set-memdir" title="${esc(st.home)}">${esc(shortPath(`${st.home}/memory`))}</span><button class="btn" data-action="reveal-memory">${t('set.open')}</button>`)}
      ${row(t('set.memRemote'), 'set-mem', `<input class="inp w" id="set-mem" value="${esc(st.memoryRemote)}" placeholder="https://github.com/me/agent-memory.git">`)}
      <div id="set-msync" hidden></div>
      ${row(t('set.memSuggest'), 'set-msug', `<input class="switch" id="set-msug" type="checkbox" ${st.memorySuggest ? 'checked' : ''}>`)}`, t('set.ideMemory'))}
    ${grp(`
      ${row(t('set.claudeRules'), 'set-crules', `<span class="sval${ci && !ci.rules.length ? ' muted' : ''}" title="${esc(ci ? ci.home : '')}">${esc(rulesText)}</span><input class="switch" id="set-crules" type="checkbox" ${st.claudeRules ? 'checked' : ''}>`)}
      ${row(t('set.claudeMemory'), 'set-cmem', `<input class="switch" id="set-cmem" type="checkbox" ${st.claudeMemory ? 'checked' : ''}>`)}
      ${row(t('set.claudeFolder'), 'set-cdir', `<span class="sval" id="set-cdir" title="${esc(ci ? ci.home : '')}">${esc(ci ? shortPath(ci.home, 2) : '…')}</span><button class="btn" data-action="reveal-claude">${t('set.open')}</button>`)}`, 'Claude Code')}`;

  const models = `${grp(`
      ${row(t('set.modelList'), 'set-mlist', `<span class="sval${ui.models.error ? ' bad' : ''}" id="set-mlist">${esc(modelsStatus())}</span><button class="btn" data-action="models-refresh">${t('diff.refresh')}</button>`)}`)}
    ${grp(`
      ${row(t('set.model'), 'set-dm', modelPicker('set-dm', st.dispatcherModel, 'Dispatcher'))}
      ${row(t('set.effort'), 'set-de', segc('set-de', st.dispatcherEffort, effortOpts(), t('set.effort')), 'wrap')}`, 'Dispatcher')}
    ${grp(`
      ${row(t('set.model'), 'set-wm', modelPicker('set-wm', st.workerModel, 'Worker'))}
      ${row(t('set.design'), 'set-fm', modelPicker('set-fm', st.designModel, t('set.design')))}
      ${row(t('set.defaultEffort'), 'set-we', segc('set-we', st.workerEffort, effortOpts(), t('set.effort')), 'wrap')}
      ${row(t('set.effortPerTask'), 'set-ept', `<input class="switch" id="set-ept" type="checkbox" ${st.effortPerTask ? 'checked' : ''}>`)}
      ${row(t('set.selfReview'), 'set-srev', `<input class="switch" id="set-srev" type="checkbox" ${st.selfReview ? 'checked' : ''}>`)}
      ${row(t('set.maxWorkers'), 'set-maxw', stepper('set-maxw', st.maxWorkers, MAX_WORKERS_MIN, MAX_WORKERS_MAX, t('set.maxWorkers')))}
      ${row(t('set.waitSlot'), 'set-wslot', stepper('set-wslot', st.waitSlotMinutes, 0, WAIT_SLOT_MAX, t('set.waitSlot')))}`, t('set.workers'))}`;

  return `<header class="stopbar drag">
      <button class="btn sback" data-action="close-settings">${sym('s-back')}${t('set.back')}</button>
      <h1>${t('set.title')}</h1>
    </header>
    <div class="sbody">
      <nav class="snav" aria-label="${t('set.title')}">
        <label class="ssearch">${sym('s-search')}<input id="set-q" type="search" placeholder="${t('set.search')}" aria-label="${t('set.search')}" value="${esc(ui.setQ)}"></label>
        ${PANES.map((p) => `<button class="snav-i${ui.pane === p.id ? ' on' : ''}" data-action="pane" data-id="${p.id}"${ui.pane === p.id ? ' aria-current="page"' : ''}>${sym(p.glyph)}<span>${t(p.key)}</span>${p.id === 'accounts' && s.setupNeeded ? '<i class="dot"></i>' : ''}</button>`).join('')}
        <span class="ver"><span id="ver-n">${ui.version ? `v${esc(ui.version)}` : ''}</span>${s.update ? `<a class="upd" tabindex="0" role="link" data-action="open-url" data-href="${esc(s.update.url)}">${t('upd.get', { v: s.update.version })}</a>` : ''}</span>
      </nav>
      <main class="spanes"><div class="sinner">${pane('accounts', accounts)}${pane('general', general)}${pane('display', display)}${pane('alerts', alerts)}${pane('memory', memory)}${pane('models', models)}</div></main>
    </div>
    ${ui.accMenu || ui.accRename ? '<div class="click-catch" data-action="acc-dismiss"></div>' : ''}
    ${removeDialog()}
    ${restartDialog()}`;
}

/** After the IDE home folder changes: it takes effect on the next launch. */
export function restartDialog() {
  if (!ui.restartAsk) return '';
  return `<div class="dlg-back" data-action="restart-later"></div>
  <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t">
    <h2 id="dlg-t">${t('set.restartTitle')}</h2>
    <p>${t('set.restartBody')}</p>
    <div class="dlg-btns"><button class="btn" data-action="restart-later">${t('set.restartLater')}</button><button class="btn def" data-action="restart-now">${t('set.restartNow')}</button></div>
  </div>`;
}

/** Re-render the settings window, keeping unsaved field values. */
/** Claude Code rule files for the Memory pane; read each time Settings opens. */
export async function loadClaudeInfo() {
  ui.claude = (await call<ClaudeInfo>('claude:info')) ?? null;
  if (ui.settingsShown) openSettings();
}

export let sheetTimer: number | undefined;

export function openSettings(pane?: Pane) {
  if (pane) ui.pane = pane;
  // Each time the window opens (button, shortcut or first run), not on every re-render.
  if (!ui.settingsShown) { void loadClaudeInfo(); void loadPreflight(); if (ui.pane === 'models') void loadModels('fresh'); }
  closePop();
  const root = $('#sheet');
  const keep = new Map<string, string | boolean>();
  if (ui.settingsShown) root.querySelectorAll<HTMLInputElement>('.spanes input').forEach((el) => { if (el.id && el.id !== 'acc-rename') keep.set(el.id, el.type === 'checkbox' ? el.checked : el.value); });
  const focusId = ui.settingsShown && root.contains(document.activeElement) ? (document.activeElement as HTMLElement).id : '';
  const scroll = root.querySelector('.spanes')?.scrollTop ?? 0;
  clearTimeout(sheetTimer);
  root.classList.remove('closing');
  if (!ui.settingsShown) swapIn(root);
  ui.settingsShown = true;
  root.innerHTML = settingsHtml();
  renderMemSync();
  keep.forEach((v, id) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    if (el.type === 'checkbox') el.checked = v as boolean; else el.value = v as string;
  });
  syncSegs(root);
  requestAnimationFrame(pathEnds);
  const vol = document.getElementById('set-vol') as HTMLInputElement | null;
  if (vol) syncSlider(vol);
  const ren = document.getElementById('acc-rename') as HTMLInputElement | null;
  if (ren) { ren.focus(); ren.select(); } else if (focusId) document.getElementById(focusId)?.focus();
  if (!pane) scrollQuietly(root.querySelector<HTMLElement>('.spanes')!, scroll);
  syncSoundRows();
  syncAccRows();
  filterPanes();
  root.hidden = false;
  document.body.classList.add('modal');
  if (!ui.version) void call<string>('app:version').then((v) => { if (v) { ui.version = v; const el = root.querySelector('#ver-n'); if (el) el.textContent = `v${v}`; } });
  void installedFonts().then(() => { const f = document.getElementById('set-font') as HTMLInputElement | null; if (f) markFont(f); });
}

export function syncSlider(el: HTMLInputElement) {
  el.style.setProperty('--val', `${el.value}%`);
  const out = el.parentElement?.querySelector('output');
  if (out) out.textContent = el.value;
}

export function syncAccRows() {
  const kind = ($('#acc-kind') as HTMLInputElement | null)?.value ?? 'token';
  document.querySelectorAll<HTMLElement>('.acc-token-row').forEach((el) => { el.hidden = kind !== 'token'; });
  // A ChatGPT account's plan comes from Codex.
  document.querySelectorAll<HTMLElement>('.acc-plan-row').forEach((el) => { el.hidden = kind === 'chatgpt'; });
  const show = (id: string, on: boolean) => { const el = document.getElementById(id); if (el) el.hidden = !on; };
  show('acc-add-btn', kind === 'token');
  show('acc-login-btn', kind === 'login');
  show('acc-chatgpt-btn', kind === 'chatgpt');
}

export function syncSoundRows() {
  const kind = ($('#set-sound') as HTMLInputElement | null)?.value;
  document.querySelectorAll<HTMLElement>('.custom-row').forEach((el) => { el.hidden = kind !== 'custom'; });
}

/* Settings save as they change: switches, segments, pickers and steppers at once; typed text after a
   short pause or when the field loses focus; the home folder only when it loses focus or is picked. */

export let saveTimer = 0;

export function saveSoon(delay = 600) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveSettingsNow(), delay);
}

export async function saveSettingsNow() {
  clearTimeout(saveTimer);
  if (!ui.settingsShown || !S || !document.getElementById('set-lang')) return;
  const f = readSettingsForm() as Record<string, unknown>;
  const cur = S.settings as unknown as Record<string, unknown>;
  const patch = Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== cur[k])) as Partial<ReturnType<typeof readSettingsForm>>;
  if (!Object.keys(patch).length) return;
  const langChanged = patch.language !== undefined;
  Object.assign(S.settings, patch); // the new values count before the state comes back (font, labels)
  applyTheme(S.settings.theme);
  setCustomCache(null);
  if (langChanged) { ui.settingsShown = false; applyStaticText(); openSettings(); }
  const r = await call<{ restart: boolean; quickKeyOk?: boolean }>('settings:save', patch);
  if (patch.quickKey && r?.quickKeyOk === false) { toast(t('quick.taken'), true); $('#set-qkey')?.classList.add('bad'); }
  if (r?.restart && ui.settingsShown) { ui.restartAsk = true; openSettings(); }
}

/** Search box: keep only the sections whose labels match, and show the first match. */
export function filterPanes() {
  const q = ui.setQ.trim().toLowerCase();
  const hits: Pane[] = [];
  document.querySelectorAll<HTMLButtonElement>('.snav-i').forEach((b) => {
    const id = b.dataset.id as Pane;
    const sec = document.querySelector(`.pane[data-pane="${id}"]`);
    const words = [b.textContent ?? '', ...[...(sec?.querySelectorAll('.lbl, .scap, h2') ?? [])].map((x) => x.textContent ?? '')].join(' ').toLowerCase();
    const hit = !q || words.includes(q);
    b.hidden = !hit;
    if (hit) hits.push(id);
  });
  if (q && hits.length && !hits.includes(ui.pane)) showPane(hits[0]);
}

export function showPane(id: Pane) {
  ui.pane = id;
  document.querySelectorAll<HTMLElement>('.pane').forEach((p) => { p.hidden = p.dataset.pane !== id; if (!p.hidden) swapIn(p); });
  document.querySelectorAll<HTMLButtonElement>('.snav-i').forEach((b) => {
    const on = b.dataset.id === id;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const sp = document.querySelector('.spanes');
  if (sp instanceof HTMLElement) scrollQuietly(sp, 0);
  pathEnds();
  if (id === 'models') void loadModels('fresh');
}

/** Long folder paths in Settings show their end, which is the part that differs. Runs once the pane is visible. */
export function pathEnds() {
  const home = document.querySelector<HTMLInputElement>('#set-home');
  if (home && document.activeElement !== home) home.scrollLeft = home.scrollWidth;
}

export function closeSettings() {
  void saveSettingsNow(); // reads the form before it goes away
  closePop();
  ui.settingsShown = false;
  ui.accMenu = ui.accRename = ui.accRemove = null;
  ui.restartAsk = false;
  ui.setQ = '';
  const sheet = $('#sheet');
  const gone = () => { sheet.hidden = true; sheet.innerHTML = ''; sheet.classList.remove('closing'); };
  const d = ms('--dur-fast');
  clearTimeout(sheetTimer);
  if (d) { sheet.classList.add('closing'); sheetTimer = window.setTimeout(gone, d); } else gone();
  document.body.classList.remove('modal');
  if (S) applyFont(S.settings.fontFamily, S.settings.fontSize);
}

/** The company GitHub host keeps only the host name: no scheme, path or capitals. */
export const hostOnly = (v: string) => v.trim().replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();

export function readSettingsForm() {
  const v = (id: string) => ($(`#${id}`) as HTMLInputElement).value.trim();
  return {
    language: v('set-lang') as Lang,
    home: v('set-home') || S!.settings.home,
    githubHost: hostOnly(v('set-gh')),
    // 0 = never.
    archiveDays: Math.min(90, Math.max(0, Math.round(Number(v('set-arch'))))) || 0,
    notifications: ($('#set-noti') as HTMLInputElement).checked,
    notifyDone: ($('#set-nres') as HTMLInputElement).checked,
    quietFrom: cleanTime(v('set-qfrom')),
    quietTo: cleanTime(v('set-qto')),
    background: ($('#set-bg') as HTMLInputElement).checked,
    openAtLogin: ($('#set-login') as HTMLInputElement).checked,
    updateCheck: ($('#set-upd') as HTMLInputElement).checked,
    // An unreadable shortcut keeps the one in use; the field shows it is not taken.
    quickKey: normalizeQuickKey(($('#set-qkey') as HTMLInputElement).value) ?? S!.settings.quickKey,
    jiraUrl: v('set-jurl'),
    jiraEmail: v('set-jmail'),
    askOff: [...document.querySelectorAll<HTMLInputElement>('.ask-rule')].filter((x) => !x.checked).map((x) => x.dataset.rule ?? ''),
    sound: v('set-sound') as SoundName,
    doneSound: v('set-dsound') as SoundName,
    customSound: v('set-sfile'),
    soundVolume: Number(v('set-vol')),
    memoryRemote: v('set-mem'),
    memorySuggest: ($('#set-msug') as HTMLInputElement).checked,
    dispatcherModel: v('set-dm'),
    workerModel: v('set-wm'),
    designModel: v('set-fm'),
    dispatcherEffort: v('set-de') as Effort,
    workerEffort: v('set-we') as Effort,
    effortPerTask: ($('#set-ept') as HTMLInputElement).checked,
    selfReview: ($('#set-srev') as HTMLInputElement).checked,
    maxWorkers: clampMaxWorkers(v('set-maxw')),
    waitSlotMinutes: clampWaitSlot(v('set-wslot')),
    fontFamily: normalizeFontFamily(v('set-font')),
    fontSize: clampFontSize(v('set-fsize')),
    theme: cleanTheme(v('set-theme')),
    claudeRules: ($('#set-crules') as HTMLInputElement).checked,
    claudeMemory: ($('#set-cmem') as HTMLInputElement).checked,
  };
}
