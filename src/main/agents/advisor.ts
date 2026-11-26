/* eslint-disable @typescript-eslint/no-explicit-any -- SDK result fields the SDK types leave out (structured_output, rate_limit_info). */
import { fakeMode } from '../fake';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { accounts } from '../accounts';
import { loadSettings, claudeHelperModel } from '../settings';
import { memoryDigest, searchMemory } from '../memory';
import { memoryDirFor, searchClaudeMemory, userRules } from '../claudeContext';
import { store } from '../store';
import { claudeExecutable } from '../runtime';
import { paths } from '../paths';
import { log } from '../log';
import { langName } from '../i18n';
import { hasSpend, spendOf } from '../../shared/spend';

export interface AdvisorVerdict { canAnswer: boolean; answer: string; basis: string }

/**
 * Decide whether the Dispatcher can answer a Worker's question on the user's behalf.
 * Answer only with clear support in memory; otherwise it goes to the decision inbox.
 */
export async function adviseOnQuestion(input: { workerId: string; taskTitle: string; question: string; options: string[] }): Promise<AdvisorVerdict | null> {
  if (fakeMode()) return null; // no model to ask: the question goes to the user
  const acc = accounts.pick();
  if (!acc) return null;
  const hits = searchMemory(`${input.question} ${input.options.join(' ')} ${input.taskTitle}`, 10)
    .map((h) => `- (${h.path}:${h.line}) ${h.text}`).join('\n');
  const w = store.worker(input.workerId);
  const repo = w?.repo ? store.repo(w.repo) : null;
  const ccHits = !loadSettings().claudeMemory ? '' : searchClaudeMemory(`${input.question} ${input.options.join(' ')}`, [memoryDirFor(repo ? repo.path : paths().home)], 6)
    .map((h) => `- (${h.file}:${h.line}) ${h.text}`).join('\n');
  const rules = loadSettings().claudeRules ? userRules(undefined, 6000) : '';
  const prompt = [
    `While working on "${input.taskTitle}", Worker ${input.workerId} asked the user this question.`,
    `Question: ${input.question}`,
    input.options.length ? `Options: ${input.options.map((o) => `"${o}"`).join(', ')}` : '',
    '',
    "The user's memory (preferences, repo notes, past decisions):",
    memoryDigest(4000) || '(empty)',
    '',
    'Memory lines that look related to the question:',
    hits || '(none)',
    ccHits ? `\nRelated lines from the Claude Code memory for this repository:\n${ccHits}` : '',
    rules ? `\nThe user's own rules for Claude:\n${rules}` : '',
    '',
    'Set canAnswer=true only if memory or the user\'s rules clearly support an answer (a preference, rule or past decision on the same topic).',
    'If it needs guessing, or concerns cost, security, deleting data, or making something public, set canAnswer=false.',
    `If there are options, answer with an option's exact wording. basis is one sentence, in ${langName()}, quoting the memory it relies on.`,
    `When canAnswer is false, basis is one short sentence, in ${langName()}, on why the user must decide (memory has nothing on it, or what it risks). The user sees it on the question card.`,
  ].filter(Boolean).join('\n');

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
            required: ['canAnswer', 'answer', 'basis'],
            properties: { canAnswer: { type: 'boolean' }, answer: { type: 'string' }, basis: { type: 'string' } },
          },
        },
      },
    });
    for await (const m of q) {
      if (m.type === 'rate_limit_event') accounts.applyEvent(acc.id, m.rate_limit_info as any);
      if (m.type === 'result') {
        // A one-off session, so its totals are this check's. It counts as the Dispatcher's own spend.
        const spend = spendOf(m);
        if (hasSpend(spend)) store.dispatcherSpent(spend);
        if (m.subtype !== 'success') return null;
        const out: any = (m as any).structured_output ?? safeJson(m.result);
        if (!out || typeof out.canAnswer !== 'boolean') return null;
        return { canAnswer: out.canAnswer && !!out.answer, answer: String(out.answer ?? ''), basis: String(out.basis ?? '') };
      }
    }
  } catch (e) {
    log.warn('advisor failed', (e as Error).message);
  }
  return null;
}

export function safeJson(s: string | undefined) {
  if (!s) return null;
  const m = s.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}
