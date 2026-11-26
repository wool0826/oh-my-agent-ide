// What a search found, marked in its thread (decision 228): every match, the current one ringed and centred, a bar
// to step through them, and ticks beside the scroll bar. The state outlives a redraw, which marks the thread again.
import { findCount, firstFrom, matchRanges, tickAt } from '../../shared/findMarks';
import { stepIndex } from '../../shared/palette';
import { searchWords } from '../../shared/textSearch';
import { esc, sym, t } from './core';

type ThreadId = 'chat-thread' | 'ws-thread';

const find = {
  /** The thread searched; null while no search is shown. */
  th: null as ThreadId | null,
  q: '',
  words: [] as string[],
  cur: -1,
  /** The current match by its message and its place in it, so a redraw that adds or drops messages keeps it. */
  at: null as { msg: string; nth: number } | null,
  /** Until the first marking: the id of the message whose first match becomes current ('' for the last match). */
  anchor: null as string | null,
};

/** Message boxes a match can be in: text the user reads, not buttons or code. */
const SKIP = 'button, script, style, svg, .stamp, .older, mark.find';

export function findOpen() { return find.th !== null; }

const thread = () => (find.th ? document.getElementById(find.th) : null);

/**
 * Shows a search in a thread. `anchor`: the chat message whose first match becomes current; '' for the last match
 * (a Worker's newest line).
 */
export function startFind(th: ThreadId, q: string, anchor: string) {
  if (find.th && find.th !== th) clearMarks(thread());
  find.th = th;
  find.q = q.trim();
  find.words = searchWords(find.q);
  find.cur = -1;
  find.at = null;
  find.anchor = anchor;
  refreshFind(th, true);
}

export function closeFind() {
  const el = thread();
  clearMarks(el);
  find.th = null;
  find.cur = -1;
  find.at = null;
  bar(el)?.remove();
  ticks(el)?.remove();
}

/** Marks the thread again after it was drawn. `arrive`: centre the current match and pulse it. */
export function refreshFind(th: ThreadId, arrive = false) {
  if (find.th !== th) return;
  const el = thread();
  if (!el) return;
  clearMarks(el);
  const marks = markAll(el);
  if (find.anchor !== null || find.cur < 0) {
    const box = find.anchor ? el.querySelector(`[data-msg="${CSS.escape(find.anchor)}"]`) : null;
    const inBox = box ? marks.findIndex((m) => box.contains(m)) : -1;
    find.cur = firstFrom(marks.length, inBox);
    find.anchor = null;
    arrive = true;
  } else find.cur = again(el, marks);
  setCur(marks);
  drawBar(el, marks.length);
  if (arrive && marks[find.cur]) centre(el, marks[find.cur]);
  drawTicks(el, marks);
}

/** The next or previous match, wrapping round. */
export function stepFind(delta: 1 | -1) {
  const el = thread();
  if (!el) return;
  const marks = [...el.querySelectorAll<HTMLElement>('mark.find')];
  if (!marks.length) return;
  find.cur = stepIndex(find.cur, delta, marks.length);
  setCur(marks);
  drawBar(el, marks.length);
  centre(el, marks[find.cur]);
  drawTicks(el, marks);
}

function setCur(marks: HTMLElement[]) {
  marks.forEach((m, i) => m.classList.toggle('cur', i === find.cur));
  const m = marks[find.cur];
  const box = m?.closest<HTMLElement>('[data-msg]');
  find.at = m && box ? { msg: box.dataset.msg ?? '', nth: [...box.querySelectorAll('mark.find')].indexOf(m) } : null;
}

/** The current match found again after a redraw: in its message when that is still shown, else by its number. */
function again(el: HTMLElement, marks: HTMLElement[]): number {
  const box = find.at ? el.querySelector(`[data-msg="${CSS.escape(find.at.msg)}"]`) : null;
  const inBox = box ? [...box.querySelectorAll<HTMLElement>('mark.find')] : [];
  if (find.at && inBox.length) return marks.indexOf(inBox[Math.min(find.at.nth, inBox.length - 1)]);
  return Math.min(find.cur, marks.length - 1);
}

function markAll(el: HTMLElement): HTMLElement[] {
  if (!find.words.length) return [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) || !n.nodeValue?.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const texts: Text[] = [];
  for (let n = walk.nextNode(); n; n = walk.nextNode()) texts.push(n as Text);
  for (const node of texts) {
    const text = node.nodeValue ?? '';
    const ranges = matchRanges(text, find.words);
    if (!ranges.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const [a, b] of ranges) {
      if (a > at) frag.append(text.slice(at, a));
      const m = document.createElement('mark');
      m.className = 'find';
      m.textContent = text.slice(a, b);
      frag.append(m);
      at = b;
    }
    if (at < text.length) frag.append(text.slice(at));
    node.replaceWith(frag);
  }
  return [...el.querySelectorAll<HTMLElement>('mark.find')];
}

function clearMarks(el: HTMLElement | null) {
  if (!el) return;
  const parents = new Set<Node>();
  for (const m of el.querySelectorAll('mark.find')) {
    if (m.parentNode) parents.add(m.parentNode);
    m.replaceWith(m.textContent ?? '');
  }
  for (const p of parents) p.normalize();
}

/** Puts the match in the middle of the thread, clear of the fade at its top, and pulses it once more. */
function centre(el: HTMLElement, m: HTMLElement) {
  const top = m.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  el.scrollTop = Math.max(0, top - el.clientHeight / 2);
  m.classList.remove('arrive');
  void m.offsetWidth;
  m.classList.add('arrive');
}

const bar = (el: HTMLElement | null) => el?.parentElement?.querySelector<HTMLElement>(':scope > .findbar') ?? null;
const ticks = (el: HTMLElement | null) => el?.parentElement?.querySelector<HTMLElement>(':scope > .find-ticks') ?? null;

function drawBar(el: HTMLElement, count: number) {
  let b = bar(el);
  if (!b) {
    b = document.createElement('div');
    b.className = 'findbar';
    b.setAttribute('role', 'search');
    b.setAttribute('aria-label', t('find.bar'));
    el.before(b);
  }
  // Over the thread's top, below whatever heads the view (a Worker's title and tabs).
  b.style.top = `calc(${el.offsetTop}px + var(--space-8))`;
  const ib = (action: string, icon: string, label: string, cls = '') => `<button type="button" class="btn btn-icon btn-sm btn-ghost${cls}" data-action="${action}" aria-label="${label}" data-tip="${label}">${sym(icon)}</button>`;
  b.innerHTML = `${sym('s-search')}<b>${esc(find.q)}</b><span class="cnt" aria-live="polite">${findCount(find.cur, count)}</span>${ib('find-prev', 's-up', t('find.prev'))}${ib('find-next', 's-up', t('find.next'), ' flip')}${ib('find-close', 's-x', t('find.close'))}`;
}

function drawTicks(el: HTMLElement, marks: HTMLElement[]) {
  let k = ticks(el);
  if (!k) {
    k = document.createElement('div');
    k.className = 'find-ticks';
    k.setAttribute('aria-hidden', 'true');
    el.after(k);
  }
  k.style.top = `${el.offsetTop}px`;
  k.style.height = `${el.clientHeight}px`;
  const box = el.getBoundingClientRect();
  k.innerHTML = marks.map((m, i) => `<i${i === find.cur ? ' class="on"' : ''} style="top:${tickAt(m.getBoundingClientRect().top - box.top + el.scrollTop, el.scrollHeight)}%"></i>`).join('');
}
