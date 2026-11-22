import { query } from '@anthropic-ai/claude-agent-sdk';
import { safeJson } from './advisor';
import { accounts } from '../accounts';
import { loadSettings, claudeHelperModel } from '../settings';
import { memoryDigest, remember, searchMemory } from '../memory';
import { memoryDirFor, searchClaudeMemory } from '../claudeContext';
import { store } from '../store';
import { claudeExecutable } from '../runtime';
import { paths } from '../paths';
import { log } from '../log';
import { langName, t } from '../i18n';
import { nowIso, oneLine, uid } from '../util';
import { alreadyKnown, answerWorthChecking, canSuggest, pickSuggestion, sourceTag, trimSuggestions, type Picked } from '../../shared/memorySuggest';
import { hasSpend, spendOf } from '../../shared/spend';
import type { AutoAnswer, Decision } from '../../shared/types';

/**
 * "Remember this?" cards. After a decision answer or a correction, a low-effort structured-output call
 * (like advisor.ts) asks whether it holds a fact worth reusing. A card appears only when the model is sure,
 * memory does not already hold the fact, and the task has had no card yet. Nothing is saved until the user agrees.
 */

interface Source {
  key: string;
  taskId: string | null;
  workerId: string | null;
  kind: 'decision' | 'correction';
  id: string;
  /** The exchange, for the prompt. */
  lines: string[];
}

/** Keys being checked right now, so two quick answers in one task make one card at most. */
const busy = new Set<string>();

export function suggestFromDecision(d: Decision) {
  if (!answerWorthChecking(d.answer)) return;
  const task = d.taskId ? store.task(d.taskId) : null;
  void consider({
    key: d.taskId ?? d.id, taskId: d.taskId, workerId: d.workerId, kind: 'decision', id: d.id,
    lines: [
      `${d.workerId ? `Worker ${d.workerId}` : 'The Dispatcher'} asked the user${task ? ` while working on "${task.title}"` : ''}.`,
      d.source === 'permission' ? `Permission request: ${d.title}` : d.source === 'plan' ? `Plan to approve: ${d.title}` : `Question: ${d.title}`,
      d.detail && d.detail !== task?.title ? `Context: ${oneLine(d.detail, 600)}` : '',
      d.code ? `Details:\n${d.code.slice(0, 1500)}` : '',
      d.options.length ? `Options: ${d.options.map((o) => `"${o.label}"`).join(', ')}` : '',
      d.source === 'permission' ? `The user denied it, giving this reason: ${d.answer}`
        : d.source === 'plan' ? `The user asked for this change to the plan: ${d.answer}`
        : `The user's answer: ${d.answer}`,
    ],
  });
}

export function suggestFromCorrection(a: AutoAnswer) {
  // Fixing the preference already saved it.
  if (!a.corrected || a.corrected.scope === 'preference') return;
  const w = store.worker(a.workerId);
  const tasks = (w?.taskIds ?? []).map((id) => store.task(id)).filter((x) => !!x && x.createdAt <= a.createdAt);
  const taskId = tasks.length ? tasks[tasks.length - 1]!.id : null;
  void consider({
    key: taskId ?? a.id, taskId, workerId: a.workerId, kind: 'correction', id: a.id,
    lines: [
      `Worker ${a.workerId} asked: ${a.question}`,
      `The Dispatcher answered "${a.answer}" on the user's behalf, citing: ${a.basis}`,
      `The user corrected it to: ${a.corrected.answer}`,
      'The user marked the correction "just this once". Suggest a fact only if the correction states a general rule, never this one exception.',
    ],
  });
}

async function consider(src: Source) {
  if (!loadSettings().memorySuggest || !canSuggest(store.data.memorySuggestions, src.key, busy)) return;
  busy.add(src.key);
  try {
    const repo = store.task(src.taskId ?? '')?.repo ?? store.worker(src.workerId ?? '')?.repo ?? null;
    const picked = await judge(src, repo);
    // Recall again with the fact itself: skip what memory already says.
    if (!picked || alreadyKnown(picked.text, recall(picked.text, repo).map((h) => h.text))) return;
    if (!loadSettings().memorySuggest || !canSuggest(store.data.memorySuggestions, src.key)) return;
    store.data.memorySuggestions = trimSuggestions([...store.data.memorySuggestions, {
      id: uid(), key: src.key, taskId: src.taskId, workerId: src.workerId, repo: picked.scope === 'repo' ? repo : null,
      ...picked, source: sourceTag(src), status: 'pending', createdAt: nowIso(),
    }]);
    store.changed();
  } catch (e) {
    log.warn('memory suggestion failed', (e as Error).message);
  } finally {
    busy.delete(src.key);
  }
}

/** What the Dispatcher's recall finds: IDE memory, plus the Claude Code memory of the repository and the IDE home. */
function recall(q: string, repo: string | null) {
  const hits = searchMemory(q, 10).map((h) => ({ where: `${h.path}:${h.line}`, text: h.text }));
  if (!loadSettings().claudeMemory) return hits;
  const r = repo ? store.repo(repo) : null;
  const dirs = [memoryDirFor(paths().home), ...(r ? [memoryDirFor(r.path)] : [])];
  return [...hits, ...searchClaudeMemory(q, dirs, 8).map((h) => ({ where: `${h.file}:${h.line}`, text: h.text }))];
}

async function judge(src: Source, repo: string | null): Promise<Picked | null> {
  const acc = accounts.pick();
  if (!acc) return null;
  const exchange = src.lines.filter(Boolean).join('\n');
  const related = recall(exchange, repo).map((h) => `- (${h.where}) ${h.text}`).join('\n');
  const scopes = repo ? ['preference', 'repo'] : ['preference'];
  const prompt = [
    exchange,
    '',
    "The user's memory (preferences, repo notes):",
    memoryDigest(3000) || '(empty)',
    '',
    'Memory lines that look related:',
    related || '(none)',
    '',
    `Does this exchange reveal a fact worth reusing in later tasks: a lasting preference or principle of the user's${repo ? `, or a trait of the ${repo} repository (build, tests, conventions, constraints)` : ''}?`,
    'Set remember=false for choices that only fit this task, guesses about why the user chose something, and secrets or personal data.',
    'Set duplicate=true if the memory above already says it, even in other words.',
    'Set confidence="high" only if the answer states or clearly implies a general rule. When in doubt, use "medium" or "low".',
    repo ? 'scope is "preference" for how the user likes to work, "repo" for a trait of the repository.' : 'scope is "preference".',
    `text is one short sentence in ${langName()} that stands on its own as a rule. reason is one sentence in ${langName()} on how it helps later.`,
  ].join('\n');

  try {
    const q = query({
      prompt,
      options: {
        model: claudeHelperModel(),
        cwd: paths().home,
        env: accounts.env(acc.id),
        tools: [],
        settingSources: [],
        maxTurns: 2,
        persistSession: false,
        effort: 'low',
        pathToClaudeCodeExecutable: claudeExecutable(),
        outputFormat: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['remember', 'duplicate', 'confidence', 'scope', 'text', 'reason'],
            properties: {
              remember: { type: 'boolean' },
              duplicate: { type: 'boolean' },
              confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
              scope: { type: 'string', enum: scopes },
              text: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
      },
    });
    for await (const m of q) {
      if (m.type === 'rate_limit_event') accounts.applyEvent(acc.id, m.rate_limit_info as any);
      if (m.type === 'result') {
        // A one-off session like the auto-answer check: its totals count as the Dispatcher's own spend.
        const spend = spendOf(m);
        if (hasSpend(spend)) store.dispatcherSpent(spend);
        if (m.subtype !== 'success') return null;
        return pickSuggestion((m as any).structured_output ?? safeJson(m.result), repo);
      }
    }
  } catch (e) {
    log.warn('memory suggestion check failed', (e as Error).message);
  }
  return null;
}

/** Save a card's fact (as edited, if text is given) with its source. Returns the memory file it went to. */
export function saveSuggestion(id: string, text?: string) {
  const sg = store.data.memorySuggestions.find((x) => x.id === id && x.status === 'pending');
  if (!sg) throw new Error(t('err.noItem'));
  sg.text = oneLine(text?.trim() || sg.text, 400);
  sg.status = 'saved';
  const file = remember(sg.scope, sg.text, sg.repo, sg.source);
  store.chat('event', t('ev.remembered', { text: oneLine(sg.text, 120) }));
  store.changed();
  return file;
}

export function dismissSuggestion(id: string) {
  const sg = store.data.memorySuggestions.find((x) => x.id === id && x.status === 'pending');
  if (!sg) return;
  sg.status = 'dismissed';
  store.changed();
}
