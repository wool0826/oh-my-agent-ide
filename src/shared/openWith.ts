// Opening a Worker's folder in an editor, a terminal or the file manager (item 3A): which editors and terminals there
// are on each OS, the command that opens a folder in each, and what the open menu lists. Pure: main finds the programs
// and runs the command, the window draws the menu.

export type EditorId = 'vscode' | 'cursor' | 'idea' | 'custom';
export type TerminalId = 'wt' | 'powershell' | 'cmd' | 'terminal' | 'iterm' | 'x-terminal';

export interface EditorPreset {
  id: Exclude<EditorId, 'custom'>;
  name: string;
  /** Two letters on a coloured square in the menu and Settings (not the product's logo). */
  badge: string;
  /** Its command-line program, looked up on the PATH. */
  bin: string;
  /** macOS: the app `open -a` starts when the program is not on the PATH. */
  macApps: string[];
}

export const EDITORS: EditorPreset[] = [
  { id: 'vscode', name: 'VS Code', badge: 'VS', bin: 'code', macApps: ['Visual Studio Code'] },
  { id: 'cursor', name: 'Cursor', badge: 'Cu', bin: 'cursor', macApps: ['Cursor'] },
  { id: 'idea', name: 'IntelliJ IDEA', badge: 'IJ', bin: 'idea', macApps: ['IntelliJ IDEA', 'IntelliJ IDEA CE', 'IntelliJ IDEA Ultimate'] },
];

export const EDITOR_DEFAULT: EditorId = 'vscode';
export const PATH_TOKEN = '{path}';

export interface TerminalPreset { id: TerminalId; name: string }

/** The terminals offered on `platform`, the usual one first. */
export function terminalsFor(platform: string): TerminalPreset[] {
  if (platform === 'win32') return [{ id: 'wt', name: 'Windows Terminal' }, { id: 'powershell', name: 'PowerShell' }, { id: 'cmd', name: 'Command Prompt' }];
  if (platform === 'darwin') return [{ id: 'terminal', name: 'Terminal' }, { id: 'iterm', name: 'iTerm' }];
  return [{ id: 'x-terminal', name: 'Terminal' }];
}

export const cleanEditor = (v: unknown): EditorId => (v === 'custom' || EDITORS.some((e) => e.id === v) ? v as EditorId : EDITOR_DEFAULT);
export const cleanTerminal = (v: unknown, platform: string): TerminalId => {
  const list = terminalsFor(platform);
  return list.find((x) => x.id === v)?.id ?? list[0].id;
};
export const cleanEditorCmd = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 500) : '');

/** A command line split into words: spaces separate them, double or single quotes keep spaces inside one. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let any = false;
  for (const ch of line) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (any || cur) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (any || cur) out.push(cur);
  return out;
}

/** The program a custom command starts (its first word, without folder and extension), for labels and errors. */
export function commandName(line: string): string {
  const first = splitCommand(line)[0] ?? '';
  return first.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat)$/i, '');
}

export interface Launch { file: string; args: string[]; cwd?: string }

/** What main found on this computer: programs on the PATH (by name) and macOS apps (by name). */
export interface Found { bin: (name: string) => boolean; macApp: (name: string) => boolean }

/** The words of a command with `{path}` filled in; the folder is added at the end when the command has no `{path}`. */
export function fillPath(words: string[], folder: string): string[] {
  const has = words.some((w) => w.includes(PATH_TOKEN));
  const filled = words.map((w) => w.split(PATH_TOKEN).join(folder));
  return has ? filled : [...filled, folder];
}

/** The template shown for a preset in Settings, e.g. "cursor {path}". */
export const presetTemplate = (id: EditorId) => `${EDITORS.find((e) => e.id === id)?.bin ?? ''} ${PATH_TOKEN}`.trim();

/**
 * How `editor` opens `folder` on `platform`, or null when it is not there (its program is not on the PATH and, on
 * macOS, no app of its name is installed; or the custom command is empty).
 */
export function editorLaunch(editor: EditorId, custom: string, folder: string, platform: string, found: Found): Launch | null {
  if (editor === 'custom') {
    const words = splitCommand(custom);
    if (!words.length || !found.bin(words[0])) return null;
    const [file, ...args] = fillPath(words, folder);
    return { file, args };
  }
  const p = EDITORS.find((e) => e.id === editor)!;
  if (found.bin(p.bin)) return { file: p.bin, args: [folder] };
  if (platform === 'darwin') {
    const app = p.macApps.find((a) => found.macApp(a));
    if (app) return { file: 'open', args: ['-a', app, folder] };
  }
  return null;
}

/** How `terminal` opens a shell in `folder`. Windows' shells get a console of their own (main spawns them detached). */
export function terminalLaunch(terminal: TerminalId, folder: string, platform: string, found: Found): Launch {
  switch (terminal) {
    case 'wt': if (found.bin('wt')) return { file: 'wt', args: ['-d', folder] }; return { file: 'powershell.exe', args: ['-NoExit'], cwd: folder };
    case 'powershell': return { file: found.bin('pwsh') ? 'pwsh.exe' : 'powershell.exe', args: ['-NoExit'], cwd: folder };
    case 'cmd': return { file: 'cmd.exe', args: [], cwd: folder };
    case 'terminal': return { file: 'open', args: ['-a', 'Terminal', folder] };
    case 'iterm': return { file: 'open', args: ['-a', 'iTerm', folder] };
    default:
      if (platform !== 'linux') return { file: 'open', args: [folder] };
      if (found.bin('x-terminal-emulator')) return { file: 'x-terminal-emulator', args: [], cwd: folder };
      return { file: 'gnome-terminal', args: [`--working-directory=${folder}`] };
  }
}

/** The program `editor` needs, for "code 명령 없음". */
export function editorProgram(editor: EditorId, custom: string): string {
  return editor === 'custom' ? commandName(custom) : EDITORS.find((e) => e.id === editor)!.bin;
}

export interface EditorChoice { id: EditorId; name: string; badge: string; ok: boolean }

/** An editor's name and badge; a custom command is named by its program. */
export function editorLabel(editor: EditorId, custom: string): { name: string; badge: string } {
  if (editor !== 'custom') { const p = EDITORS.find((e) => e.id === editor)!; return { name: p.name, badge: p.badge }; }
  const n = commandName(custom);
  return { name: n || 'Editor', badge: (n.replace(/[^a-z0-9]/gi, '').slice(0, 2) || '··').replace(/^./, (c) => c.toUpperCase()) };
}

/**
 * The editors the open menu lists, presets in their usual order: the default (also when it is missing; opening it then
 * says why) and every other one found on this computer. A custom default comes first.
 */
export function menuEditors(def: EditorId, custom: string, available: Partial<Record<EditorId, boolean>>): EditorChoice[] {
  const out: EditorChoice[] = [];
  for (const p of EDITORS) if (p.id === def || available[p.id]) out.push({ id: p.id, name: p.name, badge: p.badge, ok: !!available[p.id] });
  if (def === 'custom') out.unshift({ id: 'custom', ...editorLabel('custom', custom), ok: !!available.custom });
  return out;
}

/** The arguments of a Windows batch file (`code.cmd`) quoted for cmd.exe; the folder names Windows allows hold no quote. */
export function cmdLine(file: string, args: string[]): string {
  const q = (s: string) => (/[\s&()^%!"]/.test(s) || !s ? `"${s.replace(/"/g, '')}"` : s);
  return `"${[file, ...args].map(q).join(' ')}"`;
}
