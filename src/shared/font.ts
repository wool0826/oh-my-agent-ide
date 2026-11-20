/* UI font settings, shared by main (cleaning stored values) and the renderer (CSS variables). Imports nothing, so tests can load it directly. */

/** Base text size in styles.css (px). Other sizes grow and shrink in proportion. */
export const FONT_SIZE_DEFAULT = 13;
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 20;

/** System fonts used when none is chosen, and appended as fallbacks after a chosen font. */
export const SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif';

/** Fonts suggested in Settings (typing any name also works). */
export const FONT_SUGGESTIONS = ['Pretendard', 'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Segoe UI', 'SF Pro Text', 'Inter', 'Roboto', 'Arial', 'Helvetica Neue', 'Georgia', 'D2Coding', 'JetBrains Mono', 'Consolas'];

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong', '-apple-system', 'blinkmacsystemfont']);

/** Round the text size to whole px within range. Non-numbers give the default. */
export function clampFontSize(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}

/** Clean typed font names: comma-separated, with quotes, extra spaces and empty entries removed. */
export function normalizeFontFamily(v: unknown): string {
  if (typeof v !== 'string') return '';
  return splitFamilies(v).join(', ');
}

/** Turn stored font names into a CSS font-family value: system fonts if empty, otherwise the names followed by system fonts as fallbacks. */
export function fontStack(family: string): string {
  const names = splitFamilies(family);
  if (!names.length) return SYSTEM_FONT_STACK;
  const quoted = names.map((n) => (GENERIC.has(n.toLowerCase()) ? n : `"${n}"`));
  return `${quoted.join(', ')}, ${SYSTEM_FONT_STACK}`;
}

function splitFamilies(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.replace(/[";{}<>\\]|'/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
