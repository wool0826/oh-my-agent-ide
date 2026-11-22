// The small markdown agents write in reports and chat: code blocks, headings, lists, tables, bold, italics, links.
// Shared so it can be tested; the renderer's md() (ui/core.ts) is this.

import { linkify } from './linkify';

export function escHtml(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Bold, italics and links in escaped text; `code` spans are kept as they are. */
function spans(h: string) {
  return h.split(/(`[^`\n]+`)/).map((part, i) => {
    if (i % 2 === 1) return `<code>${part.slice(1, -1)}</code>`;
    let x = part.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    // *italic* opens after a space, a bracket or the start, so a * inside a URL or a path stays as it is.
    x = x.replace(/(^|[\s(\[;>])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, '$1<i>$2</i>');
    // _italic_ only between spaces or punctuation, so snake_case names and URLs stay as they are.
    x = x.replace(/(^|[\s(])_(?=\S)([^_\n]*?\S)_(?=$|[\s.,;:!?)])/g, '$1<i>$2</i>');
    return linkify(x);
  }).join('');
}

const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const ROW = /^\s*\|.*\|\s*$/;
const RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** One stretch of text between code blocks: escaped, then split into blocks. */
function blocks(text: string) {
  const lines = escHtml(text).split('\n');
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
