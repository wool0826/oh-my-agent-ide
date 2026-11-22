// The small markdown agents write in reports and chat: code blocks, headings, lists, tables, bold, italics, links,
// quotes and rules.
// Shared so it can be tested; the renderer's md() (ui/core.ts) is this.

import { linkify } from './linkify';

export function escHtml(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Bold and italics in escaped text. */
function emphasis(h: string) {
  let x = h.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<b><i>$1</i></b>');
  x = x.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  // *italic* opens after a space, a bracket or the start, so a * inside a URL or a path stays as it is.
  x = x.replace(/(^|[\s(\[;>])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, '$1<i>$2</i>');
  // _italic_ only between spaces or punctuation, so snake_case names and URLs stay as they are.
  x = x.replace(/(^|[\s(])_(?=\S)([^_\n]*?\S)_(?=$|[\s.,;:!?)])/g, '$1<i>$2</i>');
  return x;
}

/** Where the bracket or parenthesis opened at `at` closes, counting pairs inside; -1 when it does not on this line. */
function closing(h: string, at: number, open: string, close: string, stop: RegExp) {
  let depth = 0;
  // Capped, so a long line of unclosed brackets does not cost a scan to its end for each one.
  for (let j = at; j < h.length && j - at < 2000 && !stop.test(h[j]); j++) {
    if (h[j] === open) depth++;
    else if (h[j] === close && --depth === 0) return j;
  }
  return -1;
}

/**
 * [text](url) links in escaped text. The text may hold bracket pairs ("[[Bug] title](…)") and the URL
 * parenthesis pairs (…/Queue_(waiting)). Only http(s) URLs become links; anything else stays as written.
 * Each link is swapped for a \u0000n\u0000 placeholder so the later passes leave it alone.
 */
function mdLinks(h: string, links: string[]) {
  let out = '';
  let i = 0;
  for (let open = h.indexOf('[', i); open >= 0; open = h.indexOf('[', i)) {
    const close = closing(h, open, '[', ']', /\n/);
    const end = close >= 0 && h[close + 1] === '(' ? closing(h, close + 1, '(', ')', /\s/) : -1;
    const url = end >= 0 ? h.slice(close + 2, end) : '';
    // Escaped quotes and angle brackets are never in the URL, so the attribute cannot be closed early.
    if (!/^https?:\/\/[^/.\s]/.test(url) || /&(?:quot|#39|lt|gt);/.test(url)) {
      out += h.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    links.push(`<a data-action="open-url" data-href="${url}" title="${url}">${emphasis(h.slice(open + 1, close))}</a>`);
    out += `${h.slice(i, open)}\u0000${links.length - 1}\u0000`;
    i = end + 1;
  }
  return out + h.slice(i);
}

/** Links, bold and italics in escaped text; `code` spans are kept as they are. */
function spans(h: string) {
  // Code spans become \u0001n\u0001 first, so link text may hold them ("[`foo.ts`](…)") and nothing touches their inside.
  const codes: string[] = [];
  const h0 = h.replace(/[\u0000\u0001]/g, '').replace(/`([^`\n]+)`/g, (_, c) => `\u0001${codes.push(`<code>${c}</code>`) - 1}\u0001`);
  const links: string[] = [];
  const x = linkify(emphasis(mdLinks(h0, links)));
  return x.replace(/\u0000(\d+)\u0000/g, (_, n) => links[Number(n)]).replace(/\u0001(\d+)\u0001/g, (_, n) => codes[Number(n)]);
}

const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const ROW = /^\s*\|.*\|\s*$/;
const RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** One stretch of text between code blocks: escaped, then split into blocks. */
function blocks(text: string) {
  return blockLines(escHtml(text).split('\n'));
}

/** "> quoted" (escaped), and a rule: three or more of -, * or _ alone on a line. */
const QUOTE = /^\s*&gt; ?(.*)$/;
const HR = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;

function blockLines(lines: string[]): string {
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(spans).join('<br>')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    const head = line.match(/^#{1,6} +(.+)$/);
    if (head) { flush(); out.push(`<b class="mh">${spans(head[1])}</b>`); continue; }
    if (HR.test(line)) { flush(); out.push('<hr>'); continue; }
    // A quote: its lines without "> ", as blocks of their own (lists, nested quotes).
    if (QUOTE.test(line)) {
      flush();
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].match(QUOTE)![1]);
      i--;
      out.push(`<blockquote>${blockLines(inner)}</blockquote>`);
      continue;
    }
    // A table: a row of cells, the rule under it, then its rows.
    if (ROW.test(line) && i + 1 < lines.length && RULE.test(lines[i + 1])) {
      flush();
      const th = cells(line).map((c) => `<th>${spans(c)}</th>`).join('');
      const rows: string[] = [];
      i += 2;
      while (i < lines.length && ROW.test(lines[i])) { rows.push(`<tr>${cells(lines[i]).map((c) => `<td>${spans(c)}</td>`).join('')}</tr>`); i++; }
      i--;
      out.push(`<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
      continue;
    }
    const li = line.match(LIST);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items: string[] = [];
      let m: RegExpMatchArray | null = li;
      while (i < lines.length && (m = lines[i].match(LIST)) && /\d/.test(m[2]) === ordered) {
        // A deeper item is shown under the one before it, indented.
        const deep = m[1].length >= 2;
        items.push(`<li${deep ? ' class="sub"' : ''}>${spans(m[3])}</li>`);
        i++;
        // A line that only continues the item goes with it.
        while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !LIST.test(lines[i])) { items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, `<br>${spans(lines[i].trim())}</li>`); i++; }
      }
      i--;
      const start = ordered ? Number(li[2].replace(/\D/g, '')) : 1;
      out.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out.join('');
}

/** Agent markdown as HTML. Everything is escaped first; only the tags made here are in the result. */
export function mdHtml(src: string) {
  const parts = String(src ?? '').split(/```[\w-]*\n?/);
  return parts.map((p, i) => (i % 2 === 1 ? `<pre>${escHtml(p.replace(/\n$/, ''))}</pre>` : blocks(p))).join('');
}
