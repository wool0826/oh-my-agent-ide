// Review comments on a Worker's diff: the user notes lines in the Changes tab and sends them as one message.

export interface PatchLine {
  kind: 'h' | 'add' | 'del' | 'ctx';
  /** The line as it stands in the patch, with its +, - or space. */
  text: string;
  /** Its number in the file: the new file's for added and unchanged lines, the old file's for removed ones. */
  no: number | null;
}

/** A unified diff's lines with their line numbers, read from the hunk headers. */
export function patchLines(patch: string): PatchLine[] {
  let oldNo = 0, newNo = 0;
  return patch.replace(/\n+$/, '').split('\n').map((text): PatchLine => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldNo = Number(hunk[1]); newNo = Number(hunk[2]); return { kind: 'h', text, no: null }; }
    if (text.startsWith('\\') || text.startsWith('@@')) return { kind: 'h', text, no: null };
    if (text.startsWith('+')) return { kind: 'add', text, no: newNo++ };
    if (text.startsWith('-')) return { kind: 'del', text, no: oldNo++ };
    oldNo++;
    return { kind: 'ctx', text, no: newNo++ };
  });
}

export interface DiffNote {
  path: string;
  /** Index of the line in patchLines(patch), which places the note in the Changes tab. */
  at: number;
  no: number | null;
  /** The line commented on, as in the patch. */
  code: string;
  text: string;
}

/** A line of code in a message is a reminder of where the note points, not the whole line. */
const CODE_MAX = 160;

/**
 * The message a Worker gets for the notes: each with its file and line, the line itself, and the comment,
 * in the order of the files and lines.
 */
export function reviewMessage(notes: readonly DiffNote[]): string {
  const sorted = notes.filter((n) => n.text.trim()).slice().sort((a, b) => a.path.localeCompare(b.path) || a.at - b.at);
  if (!sorted.length) return '';
  const body = sorted.map((n) => {
    const code = n.code.length > CODE_MAX ? `${n.code.slice(0, CODE_MAX - 1)}…` : n.code;
    return `${n.path}${n.no ? `:${n.no}` : ''}\n> ${code}\n${n.text.trim()}`;
  }).join('\n\n');
  return `[Review comments on your changes]\n\n${body}`;
}
