// What the app keeps of a run command's output: its last lines, and the first local address it prints.

/** Colour and cursor codes a dev server prints for a terminal. */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

/** The output with what was just printed added, without terminal codes, kept to its last `max` characters from a line start. */
export function appendOutput(out: string, chunk: string, max = 6000): string {
  const all = (out + chunk.replace(ANSI, '').replace(/\r\n?/g, '\n'));
  if (all.length <= max) return all;
  const cut = all.slice(-max);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut;
}

/** The first address on this machine in the output (a dev server saying where it listens), as a URL to open. */
export function localUrl(out: string): string | null {
  const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s"'<>)\]]*)?/i.exec(out);
  if (!m) return null;
  return m[0].replace(/\/\/(?:0\.0\.0\.0|\[::\])/i, '//localhost').replace(/[.,;]+$/, '');
}

/** The last `n` lines, for the Worker view. */
export function lastLines(out: string, n = 12): string {
  return out.replace(/\n+$/, '').split('\n').slice(-n).join('\n');
}
