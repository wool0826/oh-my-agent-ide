import { query } from '@anthropic-ai/claude-agent-sdk';
import { accounts } from '../accounts';
import { loadSettings } from '../settings';
import { memoryDigest, searchMemory } from '../memory';
import { claudeExecutable } from '../runtime';
import { paths } from '../paths';
import { log } from '../log';

export interface AdvisorVerdict { canAnswer: boolean; answer: string; basis: string }

/**
 * Worker가 사용자에게 물은 질문을 Dispatcher가 대신 답할 수 있는지 판단한다.
 * 메모리에 분명한 근거가 있을 때만 답하고, 아니면 결정 대기함으로 넘긴다.
 */
export async function adviseOnQuestion(input: { workerId: string; taskTitle: string; question: string; options: string[] }): Promise<AdvisorVerdict | null> {
  const acc = accounts.pick();
  if (!acc) return null;
  const hits = searchMemory(`${input.question} ${input.options.join(' ')} ${input.taskTitle}`, 10)
    .map((h) => `- (${h.path}:${h.line}) ${h.text}`).join('\n');
  const prompt = [
    `Worker ${input.workerId}가 "${input.taskTitle}" 작업 중 사용자에게 아래 질문을 했습니다.`,
    `질문: ${input.question}`,
    input.options.length ? `선택지: ${input.options.map((o) => `"${o}"`).join(', ')}` : '',
    '',
    '사용자의 메모리(선호, 저장소 메모, 지난 결정)는 다음과 같습니다.',
    memoryDigest(4000) || '(비어 있음)',
    '',
    '질문과 관련 있어 보이는 메모리 줄:',
    hits || '(없음)',
    '',
    '메모리에 이 질문에 대한 분명한 근거(같은 주제의 선호나 지난 결정)가 있을 때만 canAnswer=true로 답하세요.',
    '추측이 필요하거나, 비용, 보안, 데이터 삭제, 외부 공개처럼 되돌리기 어려운 일이면 canAnswer=false입니다.',
    'answer는 선택지가 있으면 선택지 문구 그대로, basis는 근거가 된 메모리 내용을 한 문장으로 적습니다.',
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
