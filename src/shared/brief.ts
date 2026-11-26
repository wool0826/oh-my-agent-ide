// The one-line fields a decision card shows above its long text (decision 226): what is asked, why, what it risks and
// what comes of it, each clipped to BRIEF_MAX. A shell call also gets plain words for what it does and risk badges,
// read from the command itself (shellWords.ts), so a PowerShell call without Claude Code's description still says
// what it does. Pure: main builds them when it asks, the renderer only shows them.
/* eslint-disable @typescript-eslint/no-explicit-any -- tool input is whatever the model sent, read field by field. */

import { firstSentence, toolAction, type Say } from './askWhy';
import type { Key } from './i18n';
import { readShell, shellOf, type ShellCmd } from './shellWords';
import type { Decision, DecisionBrief, RiskTag } from './types';

/** The most characters one line of a card's summary keeps; the card clips to its width before that. */
export const BRIEF_MAX = 60;

/**
 * One short line from any text: Markdown marks off, its first sentence only, no closing full stop, clipped to `max`.
 * Empty for nothing.
 */
export function briefLine(text: string | null | undefined, max = BRIEF_MAX): string {
  const plain = String(text ?? '')
    .split(/\r?\n\s*\r?\n/)[0]
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = plain.match(/^.+?[.!?。](?=\s|$)/u);
  const one = (m ? m[0] : plain).replace(/[.。]$/u, '').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** A brief with every line clipped, whoever wrote it; empty fields dropped. */
export function clipBrief(b: DecisionBrief): DecisionBrief {
  const out: DecisionBrief = { what: briefLine(b.what), why: briefLine(b.why), risk: briefLine(b.risk) };
  const res = briefLine(b.out);
  if (res) out.out = res;
  if (b.tags?.length) out.tags = b.tags.map((x) => (x.label ? { kind: x.kind, label: briefLine(x.label, 32) } : { kind: x.kind }));
  return out;
}

// ---- shell calls ----

type Act = { key: Key; tag: RiskTag; x?: 'args' | 'host' | 'first' };

const READ: Act = { key: 'sh.read', tag: 'read', x: 'args' };
const LIST: Act = { key: 'sh.list', tag: 'read', x: 'args' };
const SEARCH: Act = { key: 'sh.search', tag: 'read', x: 'first' };
const DELETE: Act = { key: 'sh.delete', tag: 'delete', x: 'args' };
const WEB: Act = { key: 'sh.web', tag: 'network', x: 'host' };
const QUIET: Act = { key: 'sh.read', tag: 'read' };

/** Programs by name (PowerShell's lower-case cmdlets and aliases too). Git, gh and the package managers go by subcommand below. */
const PROGS: Record<string, Act> = {
  cat: READ, type: READ, 'get-content': READ, gc: READ, head: READ, tail: READ, less: READ, more: READ,
  ls: LIST, dir: LIST, 'get-childitem': LIST, gci: LIST, tree: LIST, find: LIST,
  grep: SEARCH, rg: SEARCH, 'select-string': SEARCH, sls: SEARCH, findstr: SEARCH,
  rm: DELETE, del: DELETE, erase: DELETE, rmdir: DELETE, rd: DELETE, 'remove-item': DELETE, ri: DELETE,
  mkdir: { key: 'sh.mkdir', tag: 'write', x: 'args' }, md: { key: 'sh.mkdir', tag: 'write', x: 'args' }, 'new-item': { key: 'sh.mkdir', tag: 'write', x: 'args' }, ni: { key: 'sh.mkdir', tag: 'write', x: 'args' }, touch: { key: 'sh.writeFile', tag: 'write', x: 'args' },
  cp: { key: 'sh.copy', tag: 'write', x: 'first' }, copy: { key: 'sh.copy', tag: 'write', x: 'first' }, 'copy-item': { key: 'sh.copy', tag: 'write', x: 'first' }, cpi: { key: 'sh.copy', tag: 'write', x: 'first' },
  mv: { key: 'sh.move', tag: 'write', x: 'first' }, move: { key: 'sh.move', tag: 'write', x: 'first' }, 'move-item': { key: 'sh.move', tag: 'write', x: 'first' }, mi: { key: 'sh.move', tag: 'write', x: 'first' },
  'set-content': { key: 'sh.writeFile', tag: 'write', x: 'first' }, 'add-content': { key: 'sh.writeFile', tag: 'write', x: 'first' }, 'out-file': { key: 'sh.writeFile', tag: 'write', x: 'first' },
  curl: WEB, wget: WEB, 'invoke-webrequest': WEB, iwr: WEB, 'invoke-restmethod': WEB, irm: WEB,
  node: { key: 'sh.runFile', tag: 'write', x: 'first' }, python: { key: 'sh.runFile', tag: 'write', x: 'first' }, python3: { key: 'sh.runFile', tag: 'write', x: 'first' }, py: { key: 'sh.runFile', tag: 'write', x: 'first' },
  tsc: { key: 'sh.typecheck', tag: 'read' }, eslint: { key: 'sh.lint', tag: 'read' },
  // Words that only move around or print: no phrase of their own, read-only.
  cd: QUIET, 'set-location': QUIET, pwd: QUIET, echo: QUIET, 'write-output': QUIET, 'write-host': QUIET, printf: QUIET, which: QUIET, where: QUIET, 'get-command': QUIET, 'test-path': QUIET, wc: QUIET, stat: QUIET, sleep: QUIET, 'start-sleep': QUIET,
};

const GIT: Record<string, Act> = {
  status: { key: 'sh.gitStatus', tag: 'read' }, diff: { key: 'sh.gitDiff', tag: 'read' }, show: { key: 'sh.gitDiff', tag: 'read' },
  log: { key: 'sh.gitLog', tag: 'read' }, blame: { key: 'sh.gitLog', tag: 'read' }, 'rev-parse': { key: 'sh.gitLog', tag: 'read' }, 'ls-files': { key: 'sh.gitStatus', tag: 'read' },
  add: { key: 'sh.gitAdd', tag: 'write' }, commit: { key: 'sh.gitCommit', tag: 'write' },
  checkout: { key: 'sh.gitSwitch', tag: 'write' }, switch: { key: 'sh.gitSwitch', tag: 'write' }, branch: { key: 'sh.gitSwitch', tag: 'write' },
  merge: { key: 'sh.gitMerge', tag: 'write' }, rebase: { key: 'sh.gitMerge', tag: 'write' }, 'cherry-pick': { key: 'sh.gitMerge', tag: 'write' },
  reset: { key: 'sh.gitReset', tag: 'write' }, restore: { key: 'sh.gitReset', tag: 'write' }, stash: { key: 'sh.gitReset', tag: 'write' },
  clean: { key: 'sh.gitClean', tag: 'delete' },
  push: { key: 'sh.gitPush', tag: 'network' }, pull: { key: 'sh.gitFetch', tag: 'network' }, fetch: { key: 'sh.gitFetch', tag: 'network' }, clone: { key: 'sh.gitFetch', tag: 'network' },
};

const GH_READ = new Set(['view', 'list', 'status', 'checks', 'diff', 'watch']);
const PKG = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const INSTALL = new Set(['install', 'i', 'ci', 'add']);

/** File and folder names a command names, without flags, `./` or more than the last part of a path; two at most. */
function names(args: string[], first = false): string {
  const xs = args.map((a) => a.replace(/,$/, '')).filter((a) => a && !a.startsWith('-')).map((a) => {
    const parts = a.replace(/^\.[\\/]/, '').split(/[\\/]+/).filter(Boolean);
    return parts.length > 2 ? parts.slice(-2).join('/') : parts.join('/') || a;
  });
  if (first) return xs[0] ?? '';
  return xs.length > 2 ? `${xs.slice(0, 2).join(' · ')} +${xs.length - 2}` : xs.join(' · ');
}

function hostOf(args: string[]): string {
  for (const a of args) {
    try { return new URL(a).host; } catch { /* not a URL */ }
  }
  return '';
}

/** What one command does and its risk class, or null when the table does not know it. */
function readCmd(say: Say, c: ShellCmd): { what: string; tags: RiskTag[] } | null {
  const sub = (c.args[0] ?? '').toLowerCase();
  if (c.prog === 'git') {
    if (sub === 'push' && c.args.some((a) => a === '--delete' || a === '-d' || /^:/.test(a))) return { what: say('sh.gitBranchDelete'), tags: ['delete', 'network'] };
    if (sub === 'branch' && c.args.some((a) => /^(-d|-D|--delete)$/.test(a))) return { what: say('sh.gitBranchDelete'), tags: ['delete'] };
    if (sub === 'branch' && !c.args.slice(1).some((a) => !/^(-a|-r|-v|-vv|--list|--all|--show-current)$/.test(a))) return { what: say('sh.gitStatus'), tags: ['read'] };
    // What throws away work that is not committed: a hard reset, a restore, a checkout of paths, a dropped stash.
    const discards = (sub === 'reset' && c.args.includes('--hard')) || sub === 'restore' || (sub === 'checkout' && c.args.includes('--'))
      || (sub === 'stash' && /^(drop|clear)$/.test(c.args[1] ?? ''));
    if (discards) return { what: say('sh.gitReset'), tags: ['delete'] };
    const act = GIT[sub];
    return act ? { what: say(act.key), tags: [act.tag] } : null;
  }
  if (c.prog === 'gh') {
    const verb = (c.args[1] ?? '').toLowerCase();
    if (sub === 'api') {
      const method = c.args.find((_, i) => /^(-X|--method)$/.test(c.args[i - 1] ?? '')) ?? c.args.find((a) => /^--method=/.test(a))?.slice(9);
      if (/^delete$/i.test(method ?? '')) return { what: say('sh.ghDelete'), tags: ['delete', 'network'] };
      return { what: say('sh.ghApi'), tags: ['network'] };
    }
    if (verb === 'delete') return { what: say('sh.ghDelete'), tags: ['delete', 'network'] };
    if (sub === 'pr' && verb === 'create') return { what: say('sh.prCreate'), tags: ['network'] };
    if (sub === 'pr' && verb === 'merge') return { what: say('sh.prMerge'), tags: ['network'] };
    if (GH_READ.has(verb)) return { what: say('sh.ghView'), tags: ['network'] };
    return { what: say('sh.ghApi'), tags: ['network'] };
  }
  if (PKG.has(c.prog) || c.prog === 'npx' || c.prog === 'pip' || c.prog === 'pip3') {
    if (INSTALL.has(sub)) return { what: say('sh.install'), tags: ['write', 'network'] };
    if (c.prog === 'npx') return { what: say('sh.runFile', { x: c.args.find((a) => !a.startsWith('-')) ?? 'npx' }), tags: ['write'] };
    if (sub === 'run' || sub === 'test' || sub === 'start' || sub === 'exec') return { what: say('sh.runScript', { x: sub === 'run' || sub === 'exec' ? c.args[1] ?? sub : sub }), tags: ['write'] };
    return null;
  }
  // `find` deletes with -delete or an -exec of rm; `sed -i` and `tee` write the files they name.
  if (c.prog === 'find' && c.args.some((a, i) => a === '-delete' || (/^-(exec|execdir|ok)$/.test(a) && PROGS[(c.args[i + 1] ?? '').toLowerCase()] === DELETE))) {
    return { what: say('sh.delete', { x: say('sh.someFiles') }), tags: ['delete'] };
  }
  if ((c.prog === 'sed' && c.args.some((a) => /^(-i|--in-place)/.test(a))) || c.prog === 'tee' || c.prog === 'tee-object') {
    const files = c.args.filter((a) => !a.startsWith('-'));
    return { what: say('sh.writeFile', { x: names(c.prog === 'sed' ? files.slice(1) : files, true) || say('sh.someFiles') }), tags: ['write'] };
  }
  const act = PROGS[c.prog];
  if (!act) return null;
  if (act === QUIET) return { what: '', tags: ['read'] };
  const x = act.x === 'host' ? hostOf(c.args) : act.x === 'first' ? names(c.args, true) : act.x === 'args' ? names(c.args) : '';
  // A download that is saved (wget always, curl and Invoke-WebRequest with an output file) also writes a file.
  const saves = act === WEB && (c.prog === 'wget' || c.args.some((a) => /^(-o|-O|--output|--remote-name|-outfile)$/i.test(a)));
  return { what: say(act.key, { x: x || say(act.x === 'host' ? 'sh.someHost' : 'sh.someFiles') }), tags: saves ? ['network', 'write'] : [act.tag] };
}

/**
 * Files a command writes with `>` or `>>` on any of its lines: not a `>` inside quotes, not a stream joined to another
 * (`2>&1`), not `=>` or `->`, not the null device, and not in a here-document's body.
 */
function written(command: string): string[] {
  const out: string[] = [];
  let doc: string | null = null;
  for (const line of String(command).split(/\r?\n/)) {
    if (doc !== null) { if (line.trim() === doc) doc = null; continue; }
    let q = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === q) q = ''; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
        doc = /^<<-?\s*(["']?)([\w.-]+)\1/.exec(line.slice(i))?.[2] ?? doc;
        i++;
        continue;
      }
      if (ch !== '>' || /[-=<>&]/.test(line[i - 1] ?? '')) continue;
      let j = line[i + 1] === '>' ? i + 2 : i + 1;
      if (line[j] === '&') { i = j; continue; }
      while (line[j] === ' ' || line[j] === '\t') j++;
      let f = '';
      if (line[j] === '"' || line[j] === "'") {
        const close = line.indexOf(line[j], j + 1);
        f = line.slice(j + 1, close < 0 ? undefined : close);
        j = close < 0 ? line.length : close + 1;
      } else {
        while (j < line.length && !/[\s;&|<>()]/.test(line[j])) f += line[j++];
      }
      if (f && !/^(\/dev\/null|\$null|nul)$/i.test(f)) out.push(f);
      i = j - 1;
    }
  }
  return out;
}

const ORDER: RiskTag[] = ['rule', 'delete', 'network', 'write', 'read', 'unknown'];

/** The badges in a fixed order, each once; read-only drops out next to anything stronger. */
function sortTags(tags: RiskTag[]): RiskTag[] {
  const set = new Set(tags);
  if (set.size > 1) set.delete('read');
  return ORDER.filter((x) => set.has(x));
}

/**
 * What a shell line does in plain words and its risk classes. Phrases come from the table for the first two
 * commands it knows; with none known, Claude Code's own description; with neither, a warning to read the command.
 */
export function shellBrief(say: Say, tool: string, input: any): { what: string; tags: RiskTag[]; known: boolean } {
  const shell = shellOf(tool);
  const command = String(input?.command ?? '');
  const desc = typeof input?.description === 'string' ? briefLine(input.description) : '';
  if (!shell) return { what: desc, tags: ['unknown'], known: false };
  const line = readShell(command, shell);
  const phrases: string[] = [];
  const tags: RiskTag[] = [];
  let unknown = line.unread || !line.cmds.length;
  for (const c of line.cmds) {
    const r = readCmd(say, c);
    if (!r) { unknown = true; continue; }
    tags.push(...r.tags);
    if (r.what && !phrases.includes(r.what)) phrases.push(r.what);
  }
  const files = written(command);
  if (files.length) {
    tags.push('write');
    // `cat > file <<EOF` and `echo … > file` are a file being written, whatever the command before the arrow.
    if (!phrases.length || line.cmds.every((c) => PROGS[c.prog] === READ || PROGS[c.prog] === QUIET)) phrases.splice(0, phrases.length, say('sh.writeFile', { x: names(files) }));
  }
  if (unknown) tags.push('unknown');
  const known = phrases.length > 0 && !unknown;
  const what = known ? phrases.slice(0, 2).join(' · ') : desc || (phrases.length ? phrases.slice(0, 2).join(' · ') : say('brief.noDesc'));
  return { what: briefLine(what), tags: sortTags(tags.length ? tags : ['unknown']), known };
}

/** The risk class of a call that is not a shell line. */
function toolTags(tool: string): RiskTag[] {
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return ['write'];
  if (/^(Read|Glob|Grep|LS)$/.test(tool)) return ['read'];
  if (/^(WebFetch|WebSearch)$/.test(tool) || tool.startsWith('mcp__')) return ['network'];
  return ['unknown'];
}

/**
 * A permission card's lines: what the call does, why the Worker needs it (the current plan step as "n/total · step",
 * else its last sentence before asking) and its risk badges, an always-ask rule's own label first.
 */
export function permissionBrief(say: Say, a: {
  tool: string; input: unknown; rule?: Key | null;
  steps?: { title: string; doneAt: string | null }[] | null; said?: string | null;
}): DecisionBrief {
  const sh = shellOf(a.tool) ? shellBrief(say, a.tool, a.input) : { what: briefLine(toolAction(say, a.tool, a.input)), tags: toolTags(a.tool) };
  const steps = a.steps ?? [];
  const at = steps.findIndex((s) => !s.doneAt);
  const why = at >= 0 && steps[at].title.trim()
    ? say('brief.step', { n: at + 1, total: steps.length, step: steps[at].title.trim() })
    : firstSentence(a.said) ?? '';
  const tags: DecisionBrief['tags'] = sortTags(a.rule ? ['rule', ...sh.tags] : sh.tags).map((kind) => (kind === 'rule' && a.rule ? { kind, label: say(a.rule) } : { kind }));
  return clipBrief({ what: sh.what, why, risk: '', tags });
}

/** A risk that takes away "Allow for this task": a delete or an always-ask rule is asked about every time. */
export function riskyBrief(b: DecisionBrief | null | undefined): boolean {
  return !!b?.tags?.some((x) => x.kind === 'delete' || x.kind === 'rule');
}

/** The Dispatcher's request_decision fields; what falls back to the first sentence of its context. */
export function dispatcherBrief(a: { what?: string | null; why?: string | null; risk?: string | null; outcome?: string | null; context?: string | null }): DecisionBrief {
  return clipBrief({ what: a.what?.trim() || firstSentence(a.context) || '', why: a.why ?? '', risk: a.risk ?? '', out: a.outcome ?? '' });
}

/**
 * The lines a card shows, for any decision: the brief it was asked with, or one made from what older decisions
 * kept (a plan's summary lines, the reason's sentences).
 */
export function cardBrief(say: Say, d: Pick<Decision, 'source' | 'detail' | 'summary' | 'reason' | 'brief' | 'code'>): DecisionBrief {
  if (d.brief) return clipBrief(d.brief);
  if (d.source === 'plan') {
    return clipBrief({ what: d.summary?.what || firstSentence(d.code) || '', why: say('brief.planWhy'), risk: d.summary?.risk ?? '', out: d.summary?.output ?? '' });
  }
  if (d.source === 'permission') return clipBrief({ what: d.reason?.what ?? '', why: '', risk: '', tags: [{ kind: 'unknown' }] });
  return clipBrief({ what: firstSentence(d.detail) || d.reason?.what || '', why: d.reason?.why ?? '', risk: '' });
}
