// A shell line read the way its shell splits it, for the always-ask rules (src/main/agents/permissions.ts) and for
// what "Allow for this task" covers (grants.ts). Pure: nothing is run and nothing is expanded.
//
// It finds every command in the line, also the ones inside `$(…)`, backticks, `( … )`, `{ … }`, a here-document fed
// to a shell, `bash -c '…'`, `cmd /c …`, `powershell -Command …` and `iex '…'`, and hands each one over without what
// was wrapped around it (`sudo`, `env`, `&`, `Start-Process`) and without git's global options, so
// `git -C repo push -f` and `& git.exe push -f` both read as git, push, -f.
//
// What it cannot see: a command built at run time (`$c = 'push -f'; git $c`), an alias, a script file's contents.

export type Shell = 'bash' | 'powershell';

const SHELL_TOOLS = new Map<string, Shell>([['Bash', 'bash'], ['PowerShell', 'powershell']]);

/** The shell a tool runs its `command` in, or null when the tool is not a shell. */
export function shellOf(tool: string): Shell | null {
  return SHELL_TOOLS.get(tool) ?? null;
}

export interface ShellCmd {
  /** The program, lower case, without its folder and `.exe`: `git`, `remove-item`. */
  prog: string;
  /** The program as written, without its folder and `.exe`. */
  name: string;
  /** Its arguments, quotes taken off. For git, the global options before the subcommand are left out. */
  args: string[];
}

export interface ShellLine {
  /** Every command the line runs, as far as it can be read. */
  cmds: ShellCmd[];
  /**
   * The line's one command, when that is all it is: nothing chained, piped, redirected or substituted, and no
   * wrapper that takes its command as text (`bash -c`, `sudo`, `iex`, `Start-Process`). Null otherwise.
   */
  single: ShellCmd | null;
  /** True when part of the line was left unread: it nests deeper than anything is written by hand. What it runs is then not known. */
  unread: boolean;
}

/** A command as it stands in the line: its words, the here-documents fed to it, and the command piped into it. */
interface Raw { words: string[]; docs: string[]; from: Raw | null }

/** How far the reading went: `nest` groups deep now, and whether anything was given up on. */
interface Limits { nest: number; unread: boolean }

interface Scan { src: string; i: number; shell: Shell; out: Raw[]; ops: number; depth: number; lim: Limits }

/** Texts read as command lines inside one another (`bash -c "bash -c …"`), and groups inside one another (`$(… $(…))`). */
const MAX_DEPTH = 8;
const MAX_NEST = 32;

/** Reads commands from `st.i` to the end, or to `close` (a `)` or `}` that ends the group being read). */
function scan(st: Scan, close: string): void {
  const { src } = st;
  const ps = st.shell === 'powershell';
  let cur: Raw = { words: [], docs: [], from: null };
  let word: string | null = null;
  // What the next word is, when it is not an argument: a redirect's file, or a here-string's text.
  let next: 'arg' | 'file' | 'doc' = 'arg';
  const docs: { delim: string; tabs: boolean; into: Raw }[] = [];
  const add = (s: string) => { word = (word ?? '') + s; };
  const endWord = () => {
    if (word === null) return;
    if (next === 'arg') cur.words.push(word);
    else if (next === 'doc') cur.docs.push(word);
    next = 'arg';
    word = null;
  };
  const endCmd = (piped = false) => {
    endWord();
    next = 'arg';
    const last = cur;
    if (last.words.length || last.docs.length || docs.some((d) => d.into === last)) st.out.push(last);
    cur = { words: [], docs: [], from: piped ? last : null };
  };
  /** Commands inside a substitution or a group, read in place. */
  const group = (end: string) => {
    st.ops++;
    // Deeper than this is not read, and the rest of the text with it.
    if (st.lim.nest >= MAX_NEST) { st.lim.unread = true; st.i = src.length; return; }
    st.lim.nest++;
    scan(st, end);
    st.lim.nest--;
  };
  /** Commands in a text of their own: what stood between backticks. */
  const inner = (text: string) => {
    st.ops++;
    if (st.depth < MAX_DEPTH) scan({ src: text, i: 0, shell: st.shell, out: st.out, ops: 0, depth: st.depth + 1, lim: st.lim }, '');
    else if (text.trim()) st.lim.unread = true;
  };
  /** A backtick substitution, from the opening backtick at `st.i`. */
  const backticks = () => {
    let j = st.i + 1;
    while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
    inner(src.slice(st.i + 1, j).replace(/\\([`\\$])/g, '$1'));
    st.i = j + 1;
    add('$()');
  };
  const double = () => {
    st.i++;
    add('');
    while (st.i < src.length) {
      const c = src[st.i], n = src[st.i + 1];
      if (c === '"') {
        if (ps && n === '"') { add('"'); st.i += 2; continue; }
        st.i++;
        return;
      }
      if (!ps && c === '\\') {
        if (n === '\n') st.i += 2;
        else if (n !== undefined && '"\\$`'.includes(n)) { add(n); st.i += 2; }
        else { add(c); st.i++; }
      } else if (ps && c === '`') { add(n ?? ''); st.i += 2; }
      else if (c === '$' && n === '(') { st.i += 2; group(')'); add('$()'); }
      else if (!ps && c === '`') backticks();
      else { add(c); st.i++; }
    }
  };
  const single = () => {
    st.i++;
    add('');
    while (st.i < src.length) {
      const c = src[st.i];
      if (c === "'") {
        if (ps && src[st.i + 1] === "'") { add("'"); st.i += 2; continue; }
        st.i++;
        return;
      }
      add(c);
      st.i++;
    }
  };
  /** `<`, `>`, `>>`, `2>&1`, `<<EOF`, `<<<text`: nothing here is an argument. */
  const redirect = () => {
    st.ops++;
    // A descriptor or stream written against the operator belongs to it: 2>, 1>>, *>.
    if (word !== null && /^(\d+|\*)$/.test(word)) word = null; else endWord();
    const c = src[st.i];
    let j = st.i;
    while (src[j] === c && j - st.i < 3) j++;
    const op = src.slice(st.i, j);
    st.i = j;
    if (!ps && op === '<<') {
      const tabs = src[st.i] === '-';
      if (tabs) st.i++;
      while (src[st.i] === ' ' || src[st.i] === '\t') st.i++;
      const m = /^[^\s;&|()<>]+/.exec(src.slice(st.i));
      if (m) { st.i += m[0].length; docs.push({ delim: m[0].replace(/['"\\]/g, ''), tabs, into: cur }); }
    } else if (!ps && op === '<<<') next = 'doc';
    else if (src[st.i] === '&') {
      st.i++;
      const m = /^[\d-]+/.exec(src.slice(st.i));
      if (m) st.i += m[0].length; else next = 'file';
    } else if (src[st.i] !== '(') next = 'file';
  };
  /** The here-documents announced on the line that just ended: their text is not commands of this line. */
  const readDocs = () => {
    for (const d of docs.splice(0)) {
      const lines: string[] = [];
      while (st.i < src.length) {
        const end = src.indexOf('\n', st.i);
        const line = src.slice(st.i, end < 0 ? src.length : end).replace(/\r$/, '');
        st.i = end < 0 ? src.length : end + 1;
        if ((d.tabs ? line.replace(/^\t+/, '') : line) === d.delim) break;
        lines.push(line);
      }
      d.into.docs.push(lines.join('\n'));
    }
  };

  while (st.i < src.length) {
    const c = src[st.i], n = src[st.i + 1];
    if (close && c === close && (ps || c !== '}' || word === null)) { endCmd(); st.i++; return; }
    switch (c) {
      case ' ': case '\t': case '\r': endWord(); st.i++; break;
      case '\n': endCmd(); st.ops++; st.i++; readDocs(); break;
      case ';': endCmd(); st.ops++; st.i += n === ';' ? 2 : 1; break;
      case '#':
        if (word === null) { const end = src.indexOf('\n', st.i); st.i = end < 0 ? src.length : end; } else { add(c); st.i++; }
        break;
      case '&':
        if (n === '&') { endCmd(); st.ops++; st.i += 2; }
        else if (!ps && n === '>') { st.i++; redirect(); }
        // PowerShell's call operator, at the start of a command.
        else if (ps && word === null && !cur.words.length) st.i++;
        else { endCmd(); st.ops++; st.i++; }
        break;
      case '|':
        st.ops++;
        if (n === '|') { endCmd(); st.i += 2; } else { st.i += !ps && n === '&' ? 2 : 1; endCmd(true); }
        break;
      case '(': {
        if (ps && word === '@') word = null;
        endWord();
        st.i++;
        const at = st.out.length;
        group(')');
        // PowerShell: `-ArgumentList @('push', '-f')` and `(Join-Path a b)` are arguments of the command they stand in.
        if (ps && cur.words.length) for (const r of st.out.slice(at)) cur.words.push(...r.words);
        break;
      }
      case ')': endCmd(); st.ops++; st.i++; break;
      case '{':
        if (ps) { if (word === '@') word = null; endWord(); st.i++; group('}'); }
        else if (word === null && (n === undefined || /\s/.test(n))) { endCmd(); st.ops++; st.i++; }
        else { add(c); st.i++; }
        break;
      case '}':
        if (ps || (word === null && !cur.words.length)) { endCmd(); st.ops++; st.i++; } else { add(c); st.i++; }
        break;
      case '<':
        if (ps && n === '#') { const end = src.indexOf('#>', st.i + 2); st.i = end < 0 ? src.length : end + 2; break; }
        redirect();
        break;
      case '>': redirect(); break;
      case '`':
        if (!ps) backticks();
        else if (n === '\n') st.i += 2;
        else if (n === '\r' && src[st.i + 2] === '\n') st.i += 3;
        else { add(n ?? ''); st.i += 2; }
        break;
      case '\\':
        if (ps) { add(c); st.i++; }
        else if (n === '\n') st.i += 2;
        else if (n === '\r' && src[st.i + 2] === '\n') st.i += 3;
        else { add(n ?? ''); st.i += 2; }
        break;
      case "'": single(); break;
      case '"': double(); break;
      case '@': {
        // PowerShell's here-string: @' or @" at the end of a line, closed by '@ or "@ at the start of one.
        const m = ps && (n === "'" || n === '"') ? /^[ \t]*\r?\n/.exec(src.slice(st.i + 2)) : null;
        if (!m) { add(c); st.i++; break; }
        const from = st.i + 2 + m[0].length;
        const end = src.indexOf(`\n${n}@`, from - 1);
        const body = src.slice(from, end < 0 ? src.length : end).replace(/\r$/, '');
        st.i = end < 0 ? src.length : end + 3;
        add(body);
        if (n === '"') for (let k = body.indexOf('$('); k >= 0; k = body.indexOf('$(', k + 2)) inner(body.slice(k + 2));
        break;
      }
      case '$':
        if (n === '(') { st.i += 2; group(')'); add('$()'); }
        else if (n === '{') { const end = src.indexOf('}', st.i); add(src.slice(st.i, end < 0 ? src.length : end + 1)); st.i = end < 0 ? src.length : end + 1; }
        else if (!ps && n === "'") {
          // $'…': backslash escapes inside single quotes.
          st.i += 2;
          add('');
          while (st.i < src.length && src[st.i] !== "'") {
            if (src[st.i] === '\\') { const e = src[st.i + 1] ?? ''; add(e === 'n' ? '\n' : e === 't' ? '\t' : e); st.i += 2; } else { add(src[st.i]); st.i++; }
          }
          st.i++;
        } else if (!ps && n === '"') st.i++;
        else { add(c); st.i++; }
        break;
      default: add(c); st.i++;
    }
  }
  endCmd();
}

function scanAll(text: string, shell: Shell, depth: number, lim: Limits): { raws: Raw[]; ops: number } {
  const st: Scan = { src: text, i: 0, shell, out: [], ops: 0, depth, lim };
  // A stray closing bracket ends a group that was never opened; keep reading after it.
  while (st.i < st.src.length) scan(st, '');
  return { raws: st.out, ops: st.ops };
}

const base = (w: string) => (w.split(/[\\/]/).filter(Boolean).pop() ?? w).replace(/\.(exe|cmd|bat|com)$/i, '');

/** Words a shell puts before a command without changing which command runs. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time']);
/** Wrappers that run the rest of their line as it stands, with the options of theirs that take a value. */
const PREFIX: Record<string, string[]> = {
  env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'], command: [], builtin: [], nohup: [], winpty: [], setsid: [], chronic: [],
  exec: ['-a'], nice: ['-n'], ionice: ['-c', '-n', '-p'], stdbuf: ['-i', '-o', '-e'], timeout: ['-k', '-s'],
};
/** The same, but they change who runs it or where its arguments come from, so the first word no longer says what a yes covers. */
const OPAQUE_PREFIX: Record<string, string[]> = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t'], doas: ['-u', '-C'],
  xargs: ['-I', '-n', '-P', '-L', '-d', '-s', '-E', '-a'],
};
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
const POWERSHELLS = new Set(['powershell', 'pwsh']);
/** git's options before the subcommand that take a value as the next word. */
const GIT_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);
/** Global options that can make git run another program (an alias, a hook, a helper), so the command is more than its subcommand. */
const GIT_RUNS = /^(?:-c|--config-env(?:=.*)?|--exec-path=.*)$/;
const START_VALUE = ['workingdirectory', 'verb', 'windowstyle', 'credential', 'redirectstandardoutput', 'redirectstandarderror', 'redirectstandardinput'];
const START_SWITCH = ['wait', 'nonewwindow', 'passthru', 'usenewenvironment', 'loaduserprofile'];

/** `-EncodedCommand`'s text: base64 of UTF-16LE. */
function decoded(b64: string): string {
  try {
    const bin = atob(b64);
    let s = '';
    for (let i = 0; i + 1 < bin.length; i += 2) s += String.fromCharCode(bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8));
    return s;
  } catch { return ''; }
}

/** The words after a wrapper's own options. */
function afterOptions(words: string[], valued: string[]): string[] {
  let k = 1;
  while (k < words.length && words[k].startsWith('-') && words[k] !== '--') k += valued.includes(words[k]) ? 2 : 1;
  if (words[k] === '--') k++;
  return words.slice(k);
}

/** `Start-Process [-FilePath] file [-ArgumentList] a, b` and cmd's `start "" file a b`, as the command they start. */
function started(words: string[]): string[] {
  const rest: string[] = [];
  let file: string | null = null;
  let inArgs = false;
  for (let k = 1; k < words.length; k++) {
    const w = words[k];
    const p = /^-[A-Za-z]+$/.test(w) ? w.slice(1).toLowerCase() : '';
    // Once the arguments have begun, a short dash word is one of them (`-f`), not a parameter of Start-Process.
    const own = p && (!inArgs || p.length >= 3);
    if (own && 'filepath'.startsWith(p)) { file = words[++k] ?? null; continue; }
    if (own && ('argumentlist'.startsWith(p) || p === 'args')) { inArgs = true; continue; }
    if (own && START_VALUE.some((v) => v.startsWith(p))) { k++; continue; }
    if (own && START_SWITCH.some((v) => v.startsWith(p))) continue;
    // cmd's own switches (/b, /wait) and its empty window title come before the program.
    if (file === null && !rest.length && (/^\/[A-Za-z]+$/.test(w) || w === '')) continue;
    rest.push(w);
    if (file !== null || rest.length > 1) inArgs = true;
  }
  if (file === null) file = rest.shift() ?? null;
  return file === null ? [] : [file, ...rest.flatMap((w) => w.split(/[,\s]+/)).filter(Boolean)];
}

/** What PowerShell is started to run: `-Command …`, `-EncodedCommand …`, or the rest of the line when neither is said. */
function powershellScript(args: string[]): string | null {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (!/^[-/][A-Za-z]+$/.test(a)) return args.slice(k).join(' ');
    const p = a.slice(1).toLowerCase();
    if ('command'.startsWith(p)) return args.slice(k + 1).join(' ');
    if (p === 'e' || p === 'ec' || (p.startsWith('en') && 'encodedcommand'.startsWith(p))) return decoded(args[k + 1] ?? '');
    if ('file'.startsWith(p)) return null;
    if (['executionpolicy', 'windowstyle', 'inputformat', 'outputformat', 'configurationname', 'workingdirectory', 'settingsfile', 'custompipename', 'psconsolefile', 'version', 'encodedarguments']
      .some((v) => v.startsWith(p)) || p === 'ep' || p === 'wd' || p === 'ea' || p === 'if' || p === 'of') k++;
  }
  return null;
}

interface Found { cmds: ShellCmd[]; opaque: boolean; lim: Limits }

/** A command as it stood in the line, turned into the command or commands that run. */
function resolve(raw: Raw, shell: Shell, depth: number, out: Found): void {
  const ps = shell === 'powershell';
  /** A text that is itself a command line: read it and add what it runs. */
  const reread = (text: string, as: Shell) => {
    out.opaque = true;
    if (!text.trim()) return;
    if (depth >= MAX_DEPTH) { out.lim.unread = true; return; }
    for (const r of scanAll(text, as, depth + 1, out.lim).raws) resolve(r, as, depth + 1, out);
  };
  /** What a shell with no script of its own reads: its here-documents, and what is piped into it. */
  const fed = (as: Shell) => {
    for (const d of raw.docs) reread(d, as);
    if (!raw.from) return;
    for (const d of raw.from.docs) reread(d, as);
    for (const w of raw.from.words) if (/\s/.test(w)) reread(w, as);
    reread(raw.from.words.slice(1).join(' '), as);
  };
  let words = ps ? raw.words.filter((w) => w !== '--%') : raw.words.slice();
  for (let turn = 0; turn < 16; turn++) {
    // Leading words that are not the command: NAME=value, `$x = `, `if`, `then`, `!`, and PowerShell's `.` and `&`.
    for (;;) {
      const w = words[0];
      if (w === undefined) return;
      const assign = ps ? /^(?:\[[\w.[\]]+\])?\$[\w:{}.]+[-+*/%]?=(.*)$/s.exec(w) : null;
      if (/^[A-Za-z_]\w*\+?=/.test(w) || KEYWORDS.has(w) || (ps && (w === '.' || w === '&'))) words.shift();
      else if (ps && /^(?:\[[\w.[\]]+\])?\$[\w:{}.]+$/.test(w) && /^[-+*/%]?=$/.test(words[1] ?? '')) words.splice(0, 2);
      else if (assign) { if (assign[1]) words[0] = assign[1]; else words.shift(); }
      else break;
    }
    const name = base(words[0]);
    const prog = name.toLowerCase();
    const args = words.slice(1);
    if (Object.hasOwn(PREFIX, prog) || Object.hasOwn(OPAQUE_PREFIX, prog)) {
      if (Object.hasOwn(OPAQUE_PREFIX, prog)) out.opaque = true;
      words = afterOptions(words, Object.hasOwn(PREFIX, prog) ? PREFIX[prog] : OPAQUE_PREFIX[prog]);
      // `timeout 30 npm test`: the first word left is how long.
      if (prog === 'timeout') words.shift();
      continue;
    }
    if (prog === 'start-process' || prog === 'saps' || prog === 'start') { out.opaque = true; words = started(words); continue; }
    if (prog === 'git') {
      let k = 0;
      for (; k < args.length && args[k].startsWith('-'); k += GIT_VALUE.has(args[k]) ? 2 : 1) if (GIT_RUNS.test(args[k])) out.opaque = true;
      out.cmds.push({ prog, name, args: args.slice(k) });
      return;
    }
    out.cmds.push({ prog, name, args });
    if (prog === 'eval') reread(args.join(' '), 'bash');
    else if (prog === 'iex' || prog === 'invoke-expression') {
      const text = args.filter((a) => !/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(a)).join(' ');
      if (text) reread(text, 'powershell'); else fed('powershell');
    } else if (SHELLS.has(prog)) {
      // The script is the word after the first option cluster that has a c in it: -c, -lc, -ic.
      let script: string | null = null;
      let file = false;
      for (let k = 0; k < args.length && script === null && !file; k++) {
        const a = args[k];
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) script = args[k + 1] ?? '';
        else if (a === '-o' || a === '-O' || a === '--rcfile' || a === '--init-file') k++;
        else if (!a.startsWith('-')) file = true;
      }
      if (script !== null) reread(script, 'bash'); else if (!file) fed('bash');
    } else if (POWERSHELLS.has(prog)) {
      const script = powershellScript(args);
      if (script !== null && script.trim() !== '-') reread(script, 'powershell'); else if (!args.some((a) => /^[-/]f(i(le?)?)?$/i.test(a))) fed('powershell');
    } else if (prog === 'cmd') {
      // /c or /k, and //c as Git Bash needs it written. cmd's own grammar is close enough to bash's for this: &, &&, ||, |.
      const k = args.findIndex((a) => /^\/\/?[ck]$/i.test(a));
      if (k >= 0) reread(args.slice(k + 1).join(' '), 'bash');
    } else if (prog === 'wsl') {
      let k = 0;
      while (k < args.length && args[k].startsWith('-')) k += ['-d', '--distribution', '-u', '--user', '--cd', '--shell-type'].includes(args[k]) ? 2 : 1;
      reread(args.slice(k).join(' '), 'bash');
    }
    return;
  }
  // More wrappers than were taken off: what they run was not reached.
  out.lim.unread = true;
}

/** The commands a line runs, read as `shell` reads it. */
export function readShell(command: string, shell: Shell): ShellLine {
  const found: Found = { cmds: [], opaque: false, lim: { nest: 0, unread: false } };
  try {
    const { raws, ops } = scanAll(String(command ?? '').trim(), shell, 0, found.lim);
    for (const r of raws) resolve(r, shell, 0, found);
    const plain = ops === 0 && raws.length === 1 && !found.opaque && !found.lim.unread && found.cmds.length === 1;
    return { cmds: found.cmds, single: plain ? found.cmds[0] : null, unread: found.lim.unread };
  } catch {
    // A line this reader fails on is one it cannot vouch for.
    return { cmds: found.cmds, single: null, unread: true };
  }
}
