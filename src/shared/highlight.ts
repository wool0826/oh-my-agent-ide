// Syntax colours for one line of code in a diff (item 10A): keywords, strings, comments, numbers and calls. A small
// tokenizer, not a parser: it reads a line at a time and carries only whether a block comment is still open.

export type Tok = 'kw' | 'str' | 'com' | 'num' | 'fn' | '';
export type Lang = 'c' | 'hash' | 'css' | 'plain';

const C_KW = new Set(('abstract as async await break case catch class const continue debugger declare default delete do else enum export '
  + 'extends false finally for from function get if implements import in instanceof interface let new null of package private '
  + 'protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while '
  + 'with yield fn func go impl mut pub struct trait use match loop where crate self Self defer chan map range val fun object when '
  + 'override sealed data lateinit internal suspend inline final native synchronized throws transient volatile char int long '
  + 'short float double boolean byte unsigned signed sizeof struct union typedef extern auto register goto').split(' '));
const HASH_KW = new Set(('and as assert async await break class continue def del elif else except False finally for from global if '
  + 'import in is lambda None nonlocal not or pass raise return True try while with yield then fi do done esac case function '
  + 'local export echo true false null').split(' '));
const CSS_KW = new Set('important media supports keyframes import layer container font-face from to and not only'.split(' '));

const EXT: Record<string, Lang> = {
  ts: 'c', tsx: 'c', js: 'c', jsx: 'c', mjs: 'c', cjs: 'c', mts: 'c', cts: 'c', json: 'c', jsonc: 'c', java: 'c', kt: 'c', kts: 'c',
  go: 'c', rs: 'c', c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cs: 'c', swift: 'c', dart: 'c', scala: 'c', php: 'c',
  py: 'hash', rb: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', ps1: 'hash', yml: 'hash', yaml: 'hash', toml: 'hash', r: 'hash',
  css: 'css', scss: 'css', less: 'css',
};

export function langOf(path: string): Lang {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m && EXT[m[1].toLowerCase()]) || 'plain';
}

/** What a line leaves open for the next: a block comment. */
export interface HlState { block: boolean }

/** A line as coloured pieces, and the state the next line starts in. Pieces join back to the line exactly. */
export function highlightLine(text: string, lang: Lang, state: HlState = { block: false }): { toks: [Tok, string][]; state: HlState } {
  const out: [Tok, string][] = [];
  const push = (t: Tok, s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last[0] === t) last[1] += s; else out.push([t, s]);
  };
  if (lang === 'plain') { push('', text); return { toks: out, state: { block: false } }; }
  const kw = lang === 'hash' ? HASH_KW : lang === 'css' ? CSS_KW : C_KW;
  const blocks = lang !== 'hash';
  let block = state.block;
  let i = 0;
  while (i < text.length) {
    if (block) {
      const end = text.indexOf('*/', i);
      if (end < 0) { push('com', text.slice(i)); break; }
      push('com', text.slice(i, end + 2));
      i = end + 2;
      block = false;
      continue;
    }
    const ch = text[i];
    const rest = text.slice(i);
    if (blocks && rest.startsWith('/*')) { block = true; push('com', '/*'); i += 2; continue; }
    if ((lang === 'c' && rest.startsWith('//')) || (lang === 'hash' && ch === '#')) { push('com', rest); break; }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      push('str', text.slice(i, Math.min(j + 1, text.length)));
      i = Math.min(j + 1, text.length);
      continue;
    }
    const num = /^(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
    if (num && !/[\w$]/.test(text[i - 1] ?? '')) { push('num', num[0]); i += num[0].length; continue; }
    const id = (lang === 'css' ? /^[A-Za-z_$@-][\w$-]*/ : /^[A-Za-z_$][\w$]*/).exec(rest);
    if (id) {
      const word = id[0].replace(/^@/, '');
      const next = text.slice(i + id[0].length).trimStart()[0];
      push(kw.has(word) ? 'kw' : next === '(' && lang !== 'css' ? 'fn' : '', id[0]);
      i += id[0].length;
      continue;
    }
    push('', ch);
    i++;
  }
  return { toks: out, state: { block } };
}

/**
 * Colours a diff's lines: a removed line goes on from the old side's state, an added one from the new side's, and
 * a line on both sides from the new side's (and sets both). Each hunk starts over; other header lines are plain.
 */
export function highlightDiff(lines: { kind: 'h' | 'ctx' | 'add' | 'del'; text: string }[], lang: Lang): [Tok, string][][] {
  let old: HlState = { block: false }, now: HlState = { block: false };
  return lines.map((l) => {
    if (l.kind === 'h') {
      if (l.text.startsWith('@@')) old = now = { block: false };
      return [['', l.text]];
    }
    const r = highlightLine(l.text, lang, l.kind === 'del' ? old : now);
    if (l.kind !== 'add') old = r.state;
    if (l.kind !== 'del') now = r.state;
    return r.toks;
  });
}
