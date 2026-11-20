import { query } from '@anthropic-ai/claude-agent-sdk';
import { accounts } from '../accounts';
import { loadSettings } from '../settings';
import { memoryDigest, searchMemory } from '../memory';
import { claudeExecutable } from '../runtime';
import { paths } from '../paths';
import { log } from '../log';
import { langName } from '../i18n';

export interface AdvisorVerdict { canAnswer: boolean; answer: string; basis: string }

/**
 * Decide whether the Dispatcher can answer a Worker's question on the user's behalf.
 * Answer only with clear support in memory; otherwise it goes to the decision inbox.
 */
export async function adviseOnQuestion(input: { workerId: string; taskTitle: string; question: string; options: string[] }): Promise<AdvisorVerdict | null> {
  const acc = accounts.pick();
  if (!acc) return null;
  const hits = searchMemory(`${input.question} ${input.options.join(' ')} ${input.taskTitle}`, 10)
    .map((h) => `- (${h.path}:${h.line}) ${h.text}`).join('\n');
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
    '',
    'Set canAnswer=true only if memory clearly supports an answer (a preference or past decision on the same topic).',
    'If it needs guessing, or concerns cost, security, deleting data, or making something public, set canAnswer=false.',
    `If there are options, answer with an option's exact wording. basis is one sentence, in ${langName()}, quoting the memory it relies on.`,
  ].filter(Boolean).join('\n');

  try {
    const q = query({
      prompt,
      options: {
        model: loadSettings().dispatcherModel,
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

function safeJson(s: string | undefined) {
  if (!s) return null;
  const m = s.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}
