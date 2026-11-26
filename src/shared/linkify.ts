// Turns the URLs in escaped text into links, leaving the sentence around them out of the link.

/** A run of URL characters in HTML-escaped text: up to whitespace or a tag. */
const CANDIDATE = /https?:\/\/[^\s<>]+/g;
/**
 * Escaped quotes and angle brackets end a URL, as the raw characters would. So does full-width punctuation
 * ("（https://…）", "…/abc、다음"): a URL holds it only percent-encoded.
 */
const ENDS_URL = /&(?:quot|#39|lt|gt);|[\u3001\u3002\u3008-\u3011\uff01\uff08\uff09\uff0c\uff1a\uff1b\uff1f]/;
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
    return `<a tabindex="0" role="link" data-action="open-url" data-href="${url}">${url}</a>${run.slice(url.length)}`;
  });
}

/** A URL a report names, with what its short name is made of: a pull request's number, an artifact, or the host. */
export interface ReportLink {
  url: string;
  kind: 'pr' | 'artifact' | 'link';
  /** The words a Markdown link gave it ("[Release notes](…)"), or the PR's number, or the host. */
  name: string;
}

const MD_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
const ARTIFACT = /^https:\/\/claude\.ai\/(?:code\/)?artifacts?\/[\w-]+/;

/**
 * The URLs a report names, once each and in order, as the links a result card lists before its own: a pull request
 * reads "PR #158", an artifact its Markdown title or "Artifact", anything else its title or host. URLs in `skip` (the
 * task's own PR, already on the card) are left out.
 */
export function reportLinks(text: string | null | undefined, skip: (string | null | undefined)[] = []): ReportLink[] {
  const s = String(text ?? '');
  const named = new Map<string, string>();
  const norm = (u: string) => u.replace(/\/+$/, '');
  for (const m of s.matchAll(MD_LINK)) named.set(norm(m[2].slice(0, urlEnd(m[2]))), m[1].trim());
  const seen = new Set(skip.filter(Boolean).map((u) => norm(String(u))));
  const out: ReportLink[] = [];
  for (const m of s.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    // Markdown emphasis around a URL ("**https://…**") is not part of it.
    const run = m[0].replace(/[*~]+$/, '');
    const url = run.slice(0, urlEnd(run));
    if (!/^https?:\/\/[^/.]/.test(url)) continue;
    const key = norm(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const pr = url.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
    const title = named.get(key);
    if (pr) out.push({ url, kind: 'pr', name: pr[1] });
    else if (ARTIFACT.test(url)) out.push({ url, kind: 'artifact', name: title ?? '' });
    else out.push({ url, kind: 'link', name: title ?? hostOf(url) });
  }
  return out;
}

/** The URL of a kept link: "[title](url)" or the bare URL. */
export const linkUrl = (l: string) => /^\[[^\]]*\]\((https?:\/\/[^)\s]+)\)$/.exec(l)?.[1] ?? l;

/**
 * A task's links after another report: they add up over the task's turns, once each by URL (a later "[title](url)"
 * takes an earlier one's place), and without the task's own PR.
 */
export function mergeLinks(kept: readonly string[] | null | undefined, added: readonly string[], own: string | null | undefined): string[] {
  const byUrl = new Map<string, string>();
  for (const l of [...(kept ?? []), ...added]) if (linkUrl(l) !== own) byUrl.set(linkUrl(l), l);
  return [...byUrl.values()];
}

/** Report lines whose URLs are all results, whatever they point at. */
const LINK_LINE = /^(?:LINK|FILE):/i;

/**
 * The links a Worker's final report names, to keep with its result (T-0089): every URL on a LINK: or FILE: line, and
 * the artifacts and pull requests named anywhere in it ("아티팩트: https://claude.ai/artifact/…" under RESULT:).
 * Each is the URL, or "[title](url)" when the report gave it a Markdown title, so reportLinks reads the name back.
 * The task's own PR (`skip`) is left out.
 */
export function resultLinkList(text: string, skip: (string | null | undefined)[] = []): string[] {
  const own = new Set(String(text ?? '').split('\n').filter((l) => LINK_LINE.test(l.trim())).flatMap((l) => reportLinks(l).map((x) => x.url)));
  const named = new Map<string, string>();
  for (const m of String(text ?? '').matchAll(MD_LINK)) named.set(m[2].slice(0, urlEnd(m[2])), m[1].trim());
  return reportLinks(text, skip)
    .filter((l) => l.kind !== 'link' || own.has(l.url))
    .map((l) => (named.has(l.url) ? `[${named.get(l.url)!.replace(/[[\]]/g, '')}](${l.url})` : l.url));
}

function hostOf(url: string) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; }
}

/**
 * Text with each URL replaced by its short name (reportLinks), for a line that is itself a button and cannot hold
 * links: "Published https://claude.ai/artifact/…" reads "Published Artifact". `artifact` names an untitled one.
 * A Markdown link keeps its words.
 */
export function shortUrls(text: string, artifact: string): string {
  let s = text.replace(MD_LINK, '$1');
  for (const l of reportLinks(s)) s = s.split(l.url).join(l.kind === 'pr' ? `PR #${l.name}` : l.name || artifact);
  return s;
}
