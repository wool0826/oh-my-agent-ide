// The small markdown agents write in reports and chat: code blocks, headings, lists (nested), tables, bold, italics,
// strikethrough, links, quotes and rules.
// Shared so it can be tested; the renderer's md() (ui/core.ts) is this.

import { linkify } from './linkify';

export function escHtml(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Bold, italics and ~~strikethrough~~ in escaped text. */
function emphasis(h: string) {
  let x = h.replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<s>$1</s>');
  x = x.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<b><i>$1</i></b>');
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

interface Item { indent: number; marker: string; html: string }

/**
 * One list from items[k]: its items at that indent, each with the deeper items after it as a list of its own
 * (ordered or not, by their marker). It ends at a shallower item, or one of the other kind at its level.
 * Returns the HTML and the index after it.
 */
function listHtml(items: Item[], k: number): [string, number] {
  const base = items[k].indent;
  const ordered = /\d/.test(items[k].marker);
  const start = ordered ? Number(items[k].marker.replace(/\D/g, '')) : 1;
  const lis: string[] = [];
  while (k < items.length && items[k].indent >= base) {
    const it = items[k];
    // Two or more spaces past this level: a list inside the item before it.
    if (it.indent >= base + 2 && lis.length) {
      const [sub, next] = listHtml(items, k);
      lis[lis.length - 1] += sub;
      k = next;
      continue;
    }
    if (/\d/.test(it.marker) !== ordered) break;
    lis.push(it.html);
    k++;
  }
  const body = lis.map((h) => `<li>${h}</li>`).join('');
  return [ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${body}</ol>` : `<ul>${body}</ul>`, k];
}

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
    if (LIST.test(line)) {
      flush();
      const items: Item[] = [];
      for (let m; i < lines.length && (m = lines[i].match(LIST)); ) {
        items.push({ indent: m[1].replace(/\t/g, '    ').length, marker: m[2], html: spans(m[3]) });
        i++;
        // A line that only continues the item goes with it.
        while (i < lines.length && lines[i].trim() && /^(?:\t|\s{2,})\s*\S/.test(lines[i]) && !LIST.test(lines[i])) { items[items.length - 1].html += `<br>${spans(lines[i].trim())}`; i++; }
      }
      i--;
      for (let k = 0; k < items.length; ) { const [h, next] = listHtml(items, k); out.push(h); k = next; }
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
