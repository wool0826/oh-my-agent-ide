// A file name cut to one line in its middle, so its start and its extension stay (attachment chips, decision 227).

/** Wide characters (CJK, Hangul, full-width forms) take about two columns of a Latin one. */
function cols(ch: string): number {
  return (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
}

export function nameWidth(name: string): number {
  let n = 0;
  for (const ch of name) n += cols(ch);
  return n;
}

/**
 * `name` when it fits `budget` columns; otherwise its start, an ellipsis, its end and its extension (up to 5
 * characters after the dot), about 60/40 between start and end.
 */
export function middleName(name: string, budget = 30): string {
  if (nameWidth(name) <= budget) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
  const stem = [...name.slice(0, name.length - ext.length)];
  const room = Math.max(2, budget - nameWidth(ext) - 1);
  const headRoom = Math.ceil(room * 0.6);
  const tailRoom = room - headRoom;
  const head: string[] = [];
  let used = 0;
  for (const ch of stem) {
    if (used + cols(ch) > headRoom) break;
    head.push(ch);
    used += cols(ch);
  }
  const tail: string[] = [];
  used = 0;
  for (let i = stem.length - 1; i >= head.length; i--) {
    if (used + cols(stem[i]) > tailRoom) break;
    tail.unshift(stem[i]);
    used += cols(stem[i]);
  }
  return `${head.join('').trimEnd()}…${tail.join('').trimStart()}${ext}`;
}
