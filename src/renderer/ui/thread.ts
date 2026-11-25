/**
 * A conversation is one Tab stop. Tab from outside lands on a message (the last one, or the one left before);
 * ↑/↓/Home/End move between messages; Tab inside a message goes through its buttons and links and then leaves the
 * thread, so the composer is one Tab away however long the conversation is.
 */
import { messageTab, sameMessage, threadIndex } from '../../shared/roving';

const THREAD = '.thread';
const STOPS = 'button:not(:disabled), a[href], a[tabindex], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]';

const shown = (x: HTMLElement) => !!x.getClientRects().length;

/**
 * The messages of a thread: its children, without the date and name lines between them, or what an empty one says. A
 * branch of replies (.br) is its tag and each reply, as messages of their own.
 */
function rows(th: HTMLElement): HTMLElement[] {
  const kids = (el: Element) => [...el.children].flatMap((x): Element[] => (x.matches('.br') ? kids(x) : [x]));
  return kids(th).filter((x): x is HTMLElement => x instanceof HTMLElement && !x.matches('.stamp, .who, .new-from, .empty-view') && shown(x));
}

/** The controls inside a message. A message that is itself a button ("Earlier messages") has none. */
function stops(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>(STOPS)].filter((x) => x.tabIndex >= 0 && shown(x));
}

/** Everything Tab can stop on, in its order. */
function tabbables(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')]
    .filter((x) => x.tabIndex >= 0 && !(x as HTMLButtonElement).disabled && shown(x));
}

/** The message each thread was last on. */
const last = new WeakMap<HTMLElement, HTMLElement>();

function focusRow(th: HTMLElement, row: HTMLElement, scroll = true) {
  if (!row.hasAttribute('tabindex')) row.tabIndex = -1;
  last.set(th, row);
  row.focus({ preventScroll: true });
  if (scroll) row.scrollIntoView({ block: 'nearest' });
}

/** Puts the focus on a thread's message: the one it was last on, else the last. False for a thread without messages. */
function enter(th: HTMLElement): boolean {
  const rs = rows(th);
  const kept = last.get(th);
  const row = kept && rs.includes(kept) ? kept : rs[rs.length - 1];
  if (!row) return false;
  focusRow(th, row);
  return true;
}

/** Keys in and around a thread. True when the key was taken. */
export function threadKeys(e: KeyboardEvent): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  const el = e.target instanceof HTMLElement ? e.target : null;
  if (!el) return false;
  const th = el.closest<HTMLElement>(THREAD);
  if (!th) {
    if (e.key !== 'Tab') return false;
    // From outside: a thread the focus is about to enter or to pass takes it on one of its messages. A thread of
    // plain messages has no control to stop on, and is reached the same way.
    const all = tabbables();
    const at = all.indexOf(el);
    const back = e.shiftKey;
    const BEFORE = Node.DOCUMENT_POSITION_PRECEDING, AFTER = Node.DOCUMENT_POSITION_FOLLOWING;
    // Where the browser would go. What has the focus may be outside the Tab order itself (a row that was clicked,
    // the page): its place in the document then says what comes next.
    const next = at >= 0 ? (back ? all[at - 1] : all[at + 1])
      : back ? all.filter((x) => el.compareDocumentPosition(x) & BEFORE && !x.contains(el)).pop() : all.find((x) => el.compareDocumentPosition(x) & AFTER);
    const passed = (t: HTMLElement) => {
      if (!(t.compareDocumentPosition(el) & (back ? AFTER : BEFORE))) return false;
      return !next || t.contains(next) || !!(t.compareDocumentPosition(next) & (back ? BEFORE : AFTER));
    };
    // A thread without messages has nothing to stop on, and is not in the way of one that has.
    const ths = [...document.querySelectorAll<HTMLElement>(THREAD)].filter((t) => shown(t) && rows(t).length && passed(t));
    const into = back ? ths[ths.length - 1] : ths[0];
    if (!into) return false;
    e.preventDefault();
    return enter(into);
  }
  const rs = rows(th);
  const row = rs.find((r) => r.contains(el));
  if (!row) return false;
  if (e.key === 'Tab') {
    const ss = stops(row);
    const at = el === row ? -1 : ss.indexOf(el);
    // A control that is not one of the message's own (a text being selected): the browser's order.
    if (el !== row && at < 0) return false;
    const to = messageTab(at, ss.length, e.shiftKey);
    e.preventDefault();
    if (to !== 'out') { if (to < 0) focusRow(th, row); else ss[to].focus(); return true; }
    const out = tabbables().filter((x) => !th.contains(x));
    const after = out.find((x) => th.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING);
    const before = out.filter((x) => th.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_PRECEDING).pop();
    const dest = e.shiftKey ? before ?? out[out.length - 1] : after ?? out[0];
    // Into another conversation beside this one: on its message, as from anywhere else.
    const other = dest?.closest<HTMLElement>(THREAD);
    if (!other || !enter(other)) dest?.focus();
    return true;
  }
  // The arrows move between messages only from a message itself: inside a control they keep their own meaning.
  if (el !== row || e.shiftKey) return false;
  const to = threadIndex(rs.indexOf(row), e.key, rs.length);
  if (to === null) return false;
  e.preventDefault();
  focusRow(th, rs[to]);
  return true;
}

/**
 * A thread is drawn again as new elements. Call before; the function it returns, called after, puts the focus back
 * on the same message, or the same control in it.
 */
export function keepThreadFocus(th: HTMLElement): ((older: boolean) => void) | null {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || a === th || !th.contains(a)) return null;
  const rs = rows(th);
  const at = rs.findIndex((r) => r.contains(a));
  if (at < 0) return null;
  const stop = a === rs[at] ? -1 : stops(rs[at]).indexOf(a);
  const n = rs.length;
  return (older) => {
    if (document.activeElement !== document.body && document.activeElement !== null) return;
    const now = rows(th);
    const row = now[sameMessage(at, n, now.length, older)];
    if (!row) return;
    const s = stop >= 0 ? stops(row)[stop] : null;
    if (s) { last.set(th, row); s.focus({ preventScroll: true }); } else focusRow(th, row, false);
  };
}
