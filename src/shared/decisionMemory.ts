// Which answered decisions IDE memory keeps (memory/decisions/<month>.md), and the clean-up of lines saved before it
// chose. A permission prompt, a plan approved as it was or the CI "keep fixing?" question says nothing that lasts, and
// repeated dozens of times it crowds out the decisions recall should find. The user's allowed rules do not live here:
// the task keeps its permissions (shared/retro.ts) and its allowances (shared/grants.ts).
import { tr, type Key } from './i18n';
import { ALLOW, ALLOW_TASK, DENY, type Decision, type Lang } from './types';

const LANGS: Lang[] = ['en', 'ko'];
const inAll = (key: Key) => LANGS.map((l) => tr(l, key));
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** Answers that only say yes or no, in the words the inbox shows and the ones people type. */
const GENERIC_ANSWERS = new Set([
  ALLOW, DENY, ALLOW_TASK, ...inAll('allow'), ...inAll('deny'), ...inAll('allowTask'), ...inAll('plan.approve'),
  'yes', 'no', 'y', 'n', 'ok', 'okay', 'sure', 'approve', 'approved', '예', '네', '응', '아니오', '아니요', '아뇨', '좋아요', '확인', '승인',
].map(norm));

/** Questions that name nothing: "Continue?", "Proceed?", "계속할까요?". */
const GENERIC_QUESTION = /^(continue|proceed|go ahead|ok(ay)?|confirm|are you sure|allow|approve|계속(할까요|하시겠어요|해도 될까요)?|진행(할까요|하시겠어요|해도 될까요)?|확인|허용(할까요)?)\s*[?.!]*$/i;

const isGenericAnswer = (a: string) => GENERIC_ANSWERS.has(norm(a));

/**
 * Whether an answered decision goes into memory. Decided by where it came from, not by its words: a permission or the
 * CI question never does, nor a plan approved as it was. A plan sent back with a change, a Worker's question and the
 * Dispatcher's request_decision do, unless the question or the answer is empty, or a bare yes or no to a question that
 * names nothing.
 */
export function worthRemembering(d: Pick<Decision, 'source' | 'kind' | 'title' | 'answer'>): boolean {
  const title = d.title.trim();
  const ans = (d.answer ?? '').trim();
  if (d.source === 'permission' || d.kind === 'ci') return false;
  if (!title || !ans) return false;
  if (d.source === 'plan' && (ans === ALLOW || ans === DENY)) return false;
  return !(isGenericAnswer(ans) && GENERIC_QUESTION.test(title));
}

/** A localized string with its {placeholders} as a pattern: 'Allow {tool}?' matches 'Allow recall?'. */
const templateRe = (s: string) => new RegExp(`^${s.split(/\{[^}]*\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+')}$`);
const PERMISSION_TITLES = [...inAll('perm.bash'), ...inAll('perm.files'), ...inAll('perm.tool'), ...inAll('ci.capTitle')].map(templateRe);
const PLAN_TITLES = new Set(inAll('plan.title').map(norm));

/** A decision line as userAnswer writes it: `- <who>: <question> → <answer> _(<date>[, source: …])_`. */
const LINE = /^- (.+?): (.+) → (.+?) _\(\d{4}-\d{2}-\d{2}[^)]*\)_\s*$/;
/** The date and source after a line, which two saves of the same thing differ in. */
const STAMP = /\s*_\(\d{4}-\d{2}-\d{2}[^)]*\)_\s*$/;

/**
 * Whether a line saved before worthRemembering existed is one it would have left out. Those lines carry no source,
 * so this goes by the words the app wrote in either language; anything else, such as what the Dispatcher saved with
 * remember, is kept.
 */
export function noiseLine(line: string): boolean {
  const m = LINE.exec(line.trimEnd());
  if (!m) return false;
  const title = m[2].trim();
  const ans = m[3].trim();
  if (PERMISSION_TITLES.some((re) => re.test(title))) return true;
  if (PLAN_TITLES.has(norm(title)) && isGenericAnswer(ans)) return true;
  return isGenericAnswer(ans) && GENERIC_QUESTION.test(title);
}

/** What two saves of the same entry share: the text without its date and source. */
export const entryKey = (entry: string) => norm(entry.split('\n').map((l) => l.replace(STAMP, '')).join('\n'));

/**
 * What a later entry may replace: for a decision line, who asked and the question (a new answer to it is news, the
 * same answer again is not); for any other entry, the entry itself.
 */
const topicKey = (entry: string) => {
  const m = LINE.exec(entry.trimEnd());
  return m ? `q:${norm(`${m[1]}: ${m[2]}`)}` : `e:${entryKey(entry)}`;
};

/** Each topic's latest entry in a file, as entryKey has it. */
function latest(text: string): Map<string, string> {
  const last = new Map<string, string>();
  for (const e of entries(text)) if (e.bullet) last.set(topicKey(e.text), entryKey(e.text));
  return last;
}

/**
 * Whether saving this entry (`- <text>`) again would repeat the file: the latest entry on its topic, saved on any day,
 * says the same. An answer that changed back (A, then B, then A) is saved, so the file ends on what holds now.
 */
export function alreadySaved(fileText: string, text: string): boolean {
  const entry = `- ${text.trim().replace(/\n/g, '\n  ')} _(2000-01-01)_`;
  return latest(fileText).get(topicKey(entry)) === entryKey(entry);
}

/** A file's lines grouped as entries: a `- ` line with the indented lines under it, or any other single line. */
function entries(text: string): { text: string; bullet: boolean }[] {
  const out: { text: string; bullet: boolean }[] = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const last = out.at(-1);
    if (last?.bullet && /^ {2}\S/.test(line)) last.text += `\n${line}`;
    else out.push({ text: line, bullet: line.startsWith('- ') });
  }
  return out;
}

/**
 * A decisions file without the lines noiseLine finds and without repeats: an entry that says what the entry before it
 * on the same topic said (alreadySaved). `removed` counts both. Lines keep the file's own line ends.
 */
export function cleanDecisionFile(text: string): { text: string; removed: number; noise: number; repeats: number } {
  const last = new Map<string, string>();
  const kept: string[] = [];
  let noise = 0;
  let repeats = 0;
  for (const e of entries(text)) {
    if (!e.bullet) { kept.push(e.text); continue; }
    if (noiseLine(e.text)) { noise++; continue; }
    const topic = topicKey(e.text);
    const key = entryKey(e.text);
    if (last.get(topic) === key) { repeats++; continue; }
    last.set(topic, key);
    kept.push(e.text);
  }
  const removed = noise + repeats;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { text: removed ? kept.join('\n').replace(/\n/g, eol) : text, removed, noise, repeats };
}
