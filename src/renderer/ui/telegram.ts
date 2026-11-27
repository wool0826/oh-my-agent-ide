// Settings > Notifications > Telegram (decision 245): the switch, the bot token, the pairing code, the paired
// account and what it is sent (decision 246). The token goes to the main process once and is cleared from the field; the page never holds it.
import type { Key } from '../../shared/i18n';
import { codeLeft, showPairCode, type TelegramView } from '../../shared/remote';
import { REMOTE_EVENTS, type RemoteEvent } from '../../shared/remoteNotice';
import { call, esc, S, sym, t, toast, tryCall } from './core';
import { segc } from './settings';

const TONE: Record<TelegramView['status'], string> = { off: '', token: 'warning', pairing: 'accent', connected: 'success', retrying: 'warning', invalid: 'danger', elsewhere: 'danger' };

/** The warning before turning it on is open. */
let asking = false;
let tick = 0;

const view = (): TelegramView | undefined => S?.telegram;

const iconBtn = (action: string, glyph: string, label: string) =>
  `<button class="btn btn-icon btn-lg" data-action="${action}" data-tip="${esc(label)}" aria-label="${esc(label)}">${sym(glyph)}</button>`;

function rows(v: TelegramView): string {
  const row = (label: string, control: string, forId = '') => `<div class="srow">${forId ? `<label class="lbl" for="${forId}">${label}</label>` : `<span class="lbl">${label}</span>`}${control}</div>`;
  const out = [row(t('tg.on'), `<input class="switch" id="tg-on" type="checkbox" ${v.enabled ? 'checked' : ''}>`, 'tg-on')];
  if (!v.enabled) return out.join('');
  out.push(row(t('tg.token'), `<input class="inp w" id="tg-tok" type="password" placeholder="${v.tokenSet ? esc(`${t('tg.tokenSet')}${v.bot ? ` · @${v.bot}` : ''}`) : '123456:ABC…'}" autocomplete="off" spellcheck="false">${v.tokenSet ? iconBtn('tg-clear', 's-x', t('tg.tokenClear')) : ''}`, 'tg-tok'));
  if (v.owner) {
    out.push(row(t('tg.owner'), `<span class="sval" id="tg-owner">${esc(`${v.owner.name} · ${v.owner.id}`)}</span><button class="btn btn-lg" data-action="tg-disconnect">${t('tg.disconnect')}</button>`));
    out.push(row(t('tg.test'), iconBtn('tg-test', 's-up', t('tg.testSend'))));
  } else if (v.candidate) {
    out.push(row(t('tg.candidate'), `<span class="sval" id="tg-cand">${esc(`${v.candidate.name} · ${v.candidate.id}`)}</span>${iconBtn('tg-reject', 's-x', t('tg.reject'))}<button class="btn btn-lg btn-primary" data-action="tg-confirm">${t('tg.confirm')}</button>`));
  } else if (v.tokenSet && (v.status === 'pairing' || v.status === 'retrying')) {
    const code = v.code
      ? `<code class="tg-code" id="tg-code">${esc(showPairCode(v.code))}</code><span class="sval muted" id="tg-left" data-ends="${v.codeEnds ?? 0}">${codeLeft(v.codeEnds ?? 0, Date.now())}</span>${iconBtn('tg-copy', 's-doc', t('tg.codeCopy'))}${v.link ? `<button class="btn btn-icon btn-lg" data-action="open-url" data-href="${esc(v.link)}" data-tip="${t('tg.codeOpen')}" aria-label="${t('tg.codeOpen')}">${sym('s-open')}</button>` : ''}`
      : `<span class="sval muted" id="tg-code">${t('tg.codeNone')}</span>`;
    out.push(row(t('tg.code'), `${code}${iconBtn('tg-code', 's-refresh', t('tg.codeNew'))}`));
  }
  return out.join('');
}

/** What goes to the phone once paired: a switch per kind of news, and how much of it. */
function news(v: TelegramView): string {
  const sw = (e: RemoteEvent) => `<div class="srow"><label class="lbl" for="tg-ev-${e}">${t(`tg.ev.${e}` as Key)}</label><input class="switch" id="tg-ev-${e}" type="checkbox" ${v.prefs.events[e] ? 'checked' : ''}></div>`;
  const level = segc('tg-level', v.prefs.level, [{ value: 'title', label: t('tg.level.title') }, { value: 'summary', label: t('tg.level.summary') }], t('tg.level'));
  return `${REMOTE_EVENTS.map(sw).join('')}<div class="srow"><span class="lbl">${t('tg.level')}</span>${level}</div>`;
}

function groupInner(v: TelegramView): string {
  const chip = v.status === 'off' ? '' : `<span class="pill" id="tg-st" role="status" data-tone="${TONE[v.status]}">${t(`tg.status.${v.status}` as Key)}</span>`;
  return `<h3 class="scap">Telegram${chip}</h3><div class="sgrp">${rows(v)}</div>${v.enabled && v.owner ? `<div class="sgrp" id="tg-news">${news(v)}</div>` : ''}`;
}

/** The group in the Notifications pane. */
export function telegramGroup(): string {
  const v = view();
  if (!v) return '';
  syncTick();
  return `<div class="sgrp-wrap" id="tg-grp">${groupInner(v)}</div>`;
}

/** The status, code or account changed while Settings is open: the group is drawn again in place. */
export function drawTelegram() {
  const el = document.getElementById('tg-grp');
  const v = view();
  if (!el || !v) return;
  const html = groupInner(v);
  if (el.innerHTML === html) return;
  const focus = document.activeElement instanceof HTMLElement && el.contains(document.activeElement) ? document.activeElement : null;
  const sel = focus?.id ? `#${focus.id}` : focus?.dataset.action ? `[data-action="${focus.dataset.action}"]` : '';
  el.innerHTML = html;
  if (sel) el.querySelector<HTMLElement>(sel)?.focus();
  syncTick();
}

/** The time left on the code counts down once a second while it shows. */
function syncTick() {
  if (tick) return;
  tick = window.setInterval(() => {
    const left = document.getElementById('tg-left');
    if (!left) { clearInterval(tick); tick = 0; return; }
    left.textContent = codeLeft(Number(left.dataset.ends), Date.now());
  }, 1000);
}

/** The warning before the switch goes on: what leaves the computer, and that Telegram can read it. */
export function telegramDialog(): string {
  if (!asking) return '';
  return `<div class="dlg-back" data-action="tg-warn-no"></div>
  <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="tg-dlg-t">
    <h2 id="tg-dlg-t">${t('tg.warnTitle')}</h2>
    <ul class="dlg-list"><li>${t('tg.warn1')}</li><li>${t('tg.warn2')}</li></ul>
    <div class="dlg-btns"><button class="btn btn-lg" data-action="tg-warn-no">${t('cancel')}</button><button class="btn btn-lg btn-primary" data-action="tg-warn-yes">${t('tg.warnOn')}</button></div>
  </div>`;
}

/** A change in the group; true when it was one of its fields. `redraw` draws Settings again (for the dialog). */
export async function telegramChange(el: HTMLInputElement, redraw: () => void): Promise<boolean> {
  if (el.id === 'tg-on') {
    if (el.checked) { el.checked = false; asking = true; redraw(); } else await call('telegram:enable', false);
    return true;
  }
  if (el.id.startsWith('tg-ev-')) { await call('telegram:prefs', { event: el.id.slice(6), on: el.checked }); return true; }
  if (el.id === 'tg-level') { await call('telegram:prefs', { level: el.value }); return true; }
  if (el.id === 'tg-tok') {
    const tok = el.value.trim();
    el.value = '';
    if (!tok) return true;
    const r = await tryCall('telegram:token', tok);
    toast(r.ok ? t('tg.saved') : r.error, !r.ok);
    return true;
  }
  return false;
}

/** A button in the group or its dialog; true when it was one. */
export async function telegramAction(a: string, el: HTMLElement, redraw: () => void): Promise<boolean> {
  const v = view();
  switch (a) {
    case 'tg-warn-yes': asking = false; redraw(); await call('telegram:enable', true); return true;
    case 'tg-warn-no': asking = false; redraw(); return true;
    case 'tg-clear': case 'tg-disconnect': await call('telegram:disconnect'); return true;
    case 'tg-code': await call('telegram:code'); return true;
    case 'tg-confirm': await call('telegram:confirm'); return true;
    case 'tg-reject': await call('telegram:reject'); return true;
    case 'tg-copy': if (v?.code) void navigator.clipboard.writeText(v.code).then(() => toast(t('sel.copied')), () => {}); return true;
    case 'tg-test': {
      (el as HTMLButtonElement).disabled = true;
      const r = await tryCall('telegram:test');
      (el as HTMLButtonElement).disabled = false;
      toast(r.ok ? t('tg.testSent') : r.error, !r.ok);
      return true;
    }
  }
  return false;
}

/** Settings closed: no dialog is left open for next time. */
export function telegramClosed() { asking = false; }
