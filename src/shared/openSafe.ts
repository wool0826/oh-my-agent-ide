// Which paths the window may open with their default program. Agents report file paths, and opening a program,
// script or shortcut runs it; those are shown in their folder instead.

const DOCUMENTS = new Set([
  'md', 'markdown', 'txt', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'ini', 'diff', 'patch',
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'mp4', 'webm', 'mov', 'mp3', 'wav',
  'html', 'htm', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf',
]);

/** Open with the default program (a folder, or a document type); anything else is revealed in its folder. */
export function opensSafely(p: string, isDir: boolean): boolean {
  if (isDir) return true;
  const name = p.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && DOCUMENTS.has(name.slice(dot + 1).toLowerCase());
}
