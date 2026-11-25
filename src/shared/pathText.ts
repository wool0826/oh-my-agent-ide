// How a long folder path is shown where it does not fit.

/** A path shortened in the middle: its first folders and its last ones, so where it starts and ends both show. */
export function midPath(p: string, head = 2, tail = 2) {
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  const lead = p.startsWith(sep) ? sep : '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > head + tail + 1 ? `${lead}${[...parts.slice(0, head), '…', ...parts.slice(-tail)].join(sep)}` : p;
}
