/* 화면 글꼴 설정. main(저장 값 정리)과 renderer(CSS 변수 적용)가 같이 쓴다. 다른 모듈을 가져오지 않는다(테스트에서 바로 불러 쓰려고). */

/** styles.css의 기본 글자 크기(px). 다른 글자 크기는 이 값에 비례해서 커지고 작아진다. */
export const FONT_SIZE_DEFAULT = 13;
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 20;

/** 사용자가 고른 글꼴이 없을 때 쓰는 시스템 글꼴. 사용자가 고른 글꼴 뒤에도 대체 글꼴로 붙인다. */
export const SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif';

/** 설정 화면에서 고를 수 있게 보여 주는 글꼴 목록(직접 입력도 된다). */
export const FONT_SUGGESTIONS = ['Pretendard', 'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Segoe UI', 'SF Pro Text', 'Inter', 'Roboto', 'Arial', 'Helvetica Neue', 'Georgia', 'D2Coding', 'JetBrains Mono', 'Consolas'];

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong', '-apple-system', 'blinkmacsystemfont']);

/** 글자 크기를 정수 px로, 허용 범위 안으로 맞춘다. 숫자가 아니면 기본값. */
export function clampFontSize(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}

/** 입력한 글꼴 이름을 정리한다. 쉼표로 여러 개를 적을 수 있고, 따옴표와 앞뒤 공백, 빈 항목은 걷어 낸다. */
export function normalizeFontFamily(v: unknown): string {
  if (typeof v !== 'string') return '';
  return splitFamilies(v).join(', ');
}

/** 저장된 글꼴 이름을 CSS font-family 값으로 바꾼다. 비어 있으면 시스템 글꼴, 아니면 그 뒤에 시스템 글꼴을 대체 글꼴로 붙인다. */
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
