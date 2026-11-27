// The card the tooltip shows over a running task in the left sidebar (shared/runCard.ts says what is in it).
import type { RunCard } from '../../shared/runCard';
import { ago, esc, ic, sym } from './core';

const mark = (state: RunCard['steps'][number]['state']) =>
  state === 'done' ? sym('s-tick') : state === 'cur' ? sym('s-chev') : '';

export function runCardHtml(c: RunCard) {
  const shown = Math.min(c.at + 1, c.total);
  const pips = c.total ? `<div class="rc-p"><span class="rc-pips${c.err ? ' err' : ''}">${c.steps.map((s) => `<i class="${s.state === 'done' ? 'd' : s.state === 'cur' ? 'c' : ''}"></i>`).join('')}</span><span>${shown}/${c.total}</span></div>` : '';
  const steps = c.total ? `<ol class="rc-steps${c.err ? ' err' : ''}">${c.steps.map((s, i) => `<li class="${s.state}"><i>${mark(s.state)}</i><span>${i + 1}. ${esc(s.title)}</span></li>`).join('')}</ol>` : '';
  const now = c.now ? `<div class="rc-now${c.err ? ' err' : ''}">${sym('s-now')}<span>${esc(c.now)}</span></div>` : '';
  const chips = [
    c.branch ? `<span class="rc-chip">${sym('s-branch')}<span>${esc(c.branch)}</span></span>` : '',
    c.pr ? `<span class="rc-chip pr">${sym('s-pr')}<span>${esc(c.pr)}</span></span>` : '',
  ].join('');
  return `<div class="rc-h">${ic(c.err ? 'err' : 'run')}<b>${esc(c.task)}</b><span>${esc(c.worker)}</span><time>${esc(ago(c.since))}</time></div>`
    + `<div class="rc-t">${esc(c.title)}</div>${pips}${steps}${now}${chips ? `<div class="rc-f">${chips}</div>` : ''}`;
}
