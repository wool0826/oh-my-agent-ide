// Turns the URLs in escaped text into links, leaving the sentence around them out of the link.

/** A run of URL characters in HTML-escaped text: up to whitespace or a tag. */
const CANDIDATE = /https?:\/\/[^\s<>]+/g;
/** Escaped quotes and angle brackets end a URL, as the raw characters would. */
const ENDS_URL = /&(?:quot|#39|lt|gt);/;
const HANGUL_TAIL = /[ㄱ-ㆎ가-힣]+$/;
/** An entity at the very end (`&amp;`), whose `;` is not sentence punctuation. */
const ENTITY_TAIL = /&(?:[a-z]+|#\d+);$/i;

const count = (s: string, ch: string) => s.split(ch).length - 1;

/**
 * Where the URL ends inside a candidate run. Agents write "…/pull/27." and "…/pull/27을 확인하세요", so
 * sentence punctuation, a closing bracket with no opening one, and a Korean particle stuck to the end are
 * not part of the URL. A bracket pair inside the URL (…/Queue_(waiting)) stays.
 */
export function urlEnd(run: string): number {
  let s = run;
  const cut = s.search(ENDS_URL);
  if (cut >= 0) s = s.slice(0, cut);
  for (;;) {
    const before = s.length;
    s = s.replace(HANGUL_TAIL, '');
    if (!ENTITY_TAIL.test(s)) s = s.replace(/[.,;:!?]+$/, '');
    while (s.endsWith(')') && count(s, ')') > count(s, '(')) s = s.slice(0, -1);
    while (s.endsWith(']') && count(s, ']') > count(s, '[')) s = s.slice(0, -1);
    if (s.length === before) return s.length;
  }
}

/** Links for the URLs in HTML-escaped text. `data-href` is what the click opens. */
export function linkify(html: string): string {
  return html.replace(CANDIDATE, (run) => {
    const url = run.slice(0, urlEnd(run));
    // "https://" alone, or with only punctuation after it, is not a link.
    if (!/^https?:\/\/[^/.]/.test(url)) return run;
    return `<a data-action="open-url" data-href="${url}">${url}</a>${run.slice(url.length)}`;
  });
}
