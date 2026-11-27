// Copy buttons: a saved script's command, a "!" run's command and output, a code block in a message. Each is an icon
// that turns into a tick for a moment once the text is on the clipboard.
import { announce, esc, t, toast } from './core';
import { retip, setTip } from './tip';

export const COPIED_MS = 1500;

/** Buttons that copied in the last moment, by key: a redraw in that moment still draws the tick. */
const recent = new Map<string, number>();

const isOn = (key: string) => !!key && (recent.get(key) ?? 0) > Date.now();

/**
 * An icon-only copy button. `key` names what it copies across redraws (empty: the tick lives only on this element);
 * `attrs` carries what its action needs, such as data-id.
 */
export function copyBtnHtml(action: string, key: string, label: string, cls: string, attrs = '') {
  const on = isOn(key);
  const say = on ? t('sel.copied') : label;
  return `<button type="button" class="${cls} copy-b${on ? ' copied' : ''}" data-action="${action}" data-copy="${esc(key)}" data-label="${esc(label)}" data-tip="${esc(say)}" aria-label="${esc(say)}"${attrs}><svg aria-hidden="true"><use href="#${on ? 's-tick' : 's-copy'}"/></svg></button>`;
}

function draw(b: HTMLElement, on: boolean) {
  const say = on ? t('sel.copied') : b.dataset.label ?? '';
  b.classList.toggle('copied', on);
  b.querySelector('use')?.setAttribute('href', on ? '#s-tick' : '#s-copy');
  b.setAttribute('aria-label', say);
  setTip(b, say);
  retip(b);
}

function markCopied(btn: HTMLElement) {
  const key = btn.dataset.copy ?? '';
  if (key) recent.set(key, Date.now() + COPIED_MS);
  draw(btn, true);
  announce(t('sel.copied'));
  setTimeout(() => {
    if (key) recent.delete(key);
    const now = key ? [...document.querySelectorAll<HTMLElement>(`[data-copy="${CSS.escape(key)}"]`)] : [btn];
    for (const b of now) if (b.isConnected) draw(b, false);
  }, COPIED_MS);
}

/** The old way, for when the Clipboard API says no: a hidden text field, selected and copied. */
function legacyCopy(text: string): boolean {
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const sel = getSelection();
  const ranges = sel ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i)) : [];
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none';
  document.body.append(ta);
  ta.select();
  let ok: boolean;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  back?.focus({ preventScroll: true });
  // What the user had selected comes back too.
  if (sel && ranges.length) { sel.removeAllRanges(); for (const r of ranges) sel.addRange(r); }
  return ok;
}

/**
 * Puts `text` on the clipboard from a click on `btn`; call it in the click's own turn, before any await. When neither
 * way works, the text shown in `shown` (when it is all of it) is selected, so Ctrl/Cmd+C takes it.
 */
export function copyText(btn: HTMLElement, text: string, shown: HTMLElement | null = null): Promise<boolean> {
  let wrote: Promise<void>;
  try { wrote = navigator.clipboard.writeText(text); } catch (e) { wrote = Promise.reject(e); }
  return wrote.then(() => true, () => legacyCopy(text)).then((ok) => {
    if (ok) { markCopied(btn); return true; }
    if (shown?.isConnected) getSelection()?.selectAllChildren(shown);
    toast(t(shown ? 'copy.selected' : 'copy.failed'));
    return false;
  });
}
