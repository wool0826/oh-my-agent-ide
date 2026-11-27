// "Sleep when done" in the window: the toolbar's moon toggle and, while it counts down, a toast with the time left and ✕.
import { countdownText } from '../../shared/autoSleep';
import { $, call, S, t } from './core';
import { setTip } from './tip';

let ticker: number | null = null;

function countdown(): HTMLElement | null {
  const until = S?.sleep?.until ?? null;
  let el = document.getElementById('sleep-toast');
  if (until === null) { el?.remove(); return null; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'sleep-toast';
    el.className = 'toast sleep';
    el.setAttribute('role', 'status');
    el.innerHTML = `<svg class="sym" aria-hidden="true"><use href="#s-moon"/></svg><span></span><button type="button" class="toast-x" data-action="sleep-cancel"><svg aria-hidden="true"><use href="#s-x"/></svg></button>`;
    $('#toasts').append(el);
  }
  const x = el.querySelector('button')!;
  x.setAttribute('aria-label', t('sleep.cancel'));
  setTip(x, t('sleep.cancel'));
  el.querySelector('span')!.textContent = t('sleep.countdown', { t: countdownText(until - Date.now()) });
  return el;
}

/** Draws the toggle and the countdown from the state; the countdown's text moves on once a second. */
export function renderSleep() {
  const armed = !!S?.sleep?.armed;
  const b = $('#sleep-btn');
  const tip = armed ? t('sleep.on') : t('sleep.toggle');
  b.setAttribute('aria-pressed', String(armed));
  b.setAttribute('aria-label', t('sleep.toggle'));
  setTip(b, tip);
  const shown = countdown();
  if (shown && ticker === null) ticker = window.setInterval(() => { if (!countdown() && ticker !== null) { clearInterval(ticker); ticker = null; } }, 1000);
  if (!shown && ticker !== null) { clearInterval(ticker); ticker = null; }
}

/** The toggle, or the countdown's ✕ (which turns it off). */
export async function setSleep(on: boolean) {
  await call('sleep:set', on);
}
