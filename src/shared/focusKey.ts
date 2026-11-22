// Keeping the keyboard's place when a screen is drawn again (decision 137).
// The app re-renders by replacing HTML, so the focused element is gone afterwards; this names it well enough
// to find the one that took its place.

/** The data attributes that tell one control from another of the same action, in the order they are tried. */
const PARTS = ['id', 'v', 'key', 'n', 'i', 'kind', 'path', 'href'] as const;

const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * A selector for "the same control" after a re-render: its tag, its action and what it acts on.
 * Null for an element that is not one of the app's controls (no data-action), which is left to the browser.
 */
export function focusSelector(tag: string, data: Readonly<Record<string, string | undefined>>): string | null {
  const action = data.action;
  if (!action) return null;
  let sel = `${tag.toLowerCase()}[data-action=${quote(action)}]`;
  for (const p of PARTS) {
    const v = data[p];
    if (v !== undefined) sel += `[data-${p}=${quote(v)}]`;
  }
  return sel;
}

/** A control has a name a screen reader can say: a label, a title, or its own text. */
export function hasName(el: { ariaLabel: string | null; title: string; text: string; labelled: boolean; placeholder?: string }): boolean {
  return !!(el.ariaLabel?.trim() || el.title.trim() || el.text.trim() || el.labelled || el.placeholder?.trim());
}
