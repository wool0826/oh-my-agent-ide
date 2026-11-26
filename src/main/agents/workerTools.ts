// The app's own tools a Worker can call (recall from memory, tell the Dispatcher), for Claude Code and for Codex.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { type CodexTool } from './codexSession';
import { store } from '../store';
import { searchMemory } from '../memory';
import { memoryDirFor, searchClaudeMemory } from '../claudeContext';
import { paths } from '../paths';
import { type Worker } from '../../shared/types';
import { TellKind } from './workerText';

/** A change to the task's planned steps: declare or revise them, or mark one done. Returns the tool's reply. */
export type StepsOp = { kind: 'set'; steps: unknown } | { kind: 'done'; step: unknown };
export type StepsFn = (op: StepsOp) => string;

const SET_STEPS = 'Declare or revise the planned steps of your current task (3–7 short labels, in order, at most 12), so the user sees how far you are. Steps already marked done stay done when the revised plan still names them.';
const STEP_DONE = 'Mark a step of your current task done (its 1-based number from set_steps) as soon as you finish it. The Dispatcher is told without being interrupted.';

/** Claude Code memory of the repository's main checkout; Workers without a repository share the IDE home's. */
export function workerMemoryDir(w: Worker) {
  const repo = w.repo ? store.repo(w.repo) : null;
  return memoryDirFor(repo ? repo.path : paths().home);
}

/**
 * A Worker's own tools: read-only memory search (IDE memory plus the shared Claude Code memory), its line to the
 * Dispatcher and its planned steps. None changes files, so all work in plan mode too.
 */

export function workerTools(memDir: string | null, tell: (kind: TellKind, text: string) => string, steps: StepsFn) {
  return createSdkMcpServer({
    name: 'oma',
    version: '0.6.2',
    alwaysLoad: true,
    tools: [
      tool(
        'tell_dispatcher',
        'Say something to the Dispatcher without ending your turn. kind "answer": the answer to a "[Dispatcher question]". kind "request": something you need the Dispatcher to do or answer (what another Worker is doing, a new task for work outside yours); its reply comes later as a "[Dispatcher]" message. kind "note": news that needs no reply.',
        {
          kind: z.enum(['answer', 'request', 'note']),
          text: z.string().describe('Complete on its own: the Dispatcher does not see your conversation.'),
        },
        async (a) => ({ content: [{ type: 'text' as const, text: tell(a.kind, a.text) }] }),
        { annotations: { readOnlyHint: true } },
      ),
      tool('set_steps', SET_STEPS, { steps: z.array(z.string()).describe('Short step labels, for example "Write tests"') },
        async (a) => ({ content: [{ type: 'text' as const, text: steps({ kind: 'set', steps: a.steps }) }] }), { annotations: { readOnlyHint: true } }),
      tool('step_done', STEP_DONE, { step: z.number().int().describe('Step number, 1-based') },
        async (a) => ({ content: [{ type: 'text' as const, text: steps({ kind: 'done', step: a.step }) }] }), { annotations: { readOnlyHint: true } }),
      tool('recall', "Search the user's memory: preferences, repository notes, past decisions and finished tasks (IDE memory), and the Claude Code memory shared for this repository.", { query: z.string() }, async (a) => {
        const ide = searchMemory(a.query, 8).map((h) => `[ide] ${h.path}:${h.line} ${h.text}`);
        const cc = memDir ? searchClaudeMemory(a.query, [memDir], 8).map((h) => `[claude] ${h.file}:${h.line} ${h.text}`) : [];
        const lines = [...ide, ...cc];
        return { content: [{ type: 'text' as const, text: lines.length ? lines.join('\n') : 'Nothing relevant in memory.' }] };
      }),
    ],
  });
}

/** What the recall tool answers: IDE memory, plus the Claude Code memory shared for the repository. */
export function recallText(memDir: string | null, query: string) {
  const ide = searchMemory(query, 8).map((h) => `[ide] ${h.path}:${h.line} ${h.text}`);
  const cc = memDir ? searchClaudeMemory(query, [memDir], 8).map((h) => `[claude] ${h.file}:${h.line} ${h.text}`) : [];
  const lines = [...ide, ...cc];
  return lines.length ? lines.join('\n') : 'Nothing relevant in memory.';
}

/** The same tools for a Worker that runs on Codex. */
export function workerCodexTools(memDir: string | null, tell: (kind: TellKind, text: string) => string, steps: StepsFn): CodexTool[] {
  return [
    {
      name: 'tell_dispatcher',
      description: 'Say something to the Dispatcher without ending your turn. kind "answer": the answer to a "[Dispatcher question]". kind "request": something you need the Dispatcher to do or answer; its reply comes later as a "[Dispatcher]" message. kind "note": a milestone that needs no reply.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['kind', 'text'],
        properties: { kind: { type: 'string', enum: ['answer', 'request', 'note'] }, text: { type: 'string', description: 'Complete on its own: the Dispatcher does not see your conversation.' } },
      },
      run: (a) => {
        const kind = (['answer', 'request', 'note'] as const).find((k) => k === a?.kind);
        if (!kind || typeof a?.text !== 'string' || !a.text.trim()) throw new Error('tell_dispatcher needs kind (answer, request or note) and text.');
        return tell(kind, a.text);
      },
    },
    {
      name: 'set_steps',
      description: SET_STEPS,
      inputSchema: { type: 'object', additionalProperties: false, required: ['steps'], properties: { steps: { type: 'array', items: { type: 'string' } } } },
      run: (a) => steps({ kind: 'set', steps: a?.steps }),
    },
    {
      name: 'step_done',
      description: STEP_DONE,
      inputSchema: { type: 'object', additionalProperties: false, required: ['step'], properties: { step: { type: 'integer' } } },
      run: (a) => steps({ kind: 'done', step: a?.step }),
    },
    {
      name: 'recall',
      description: "Search the user's memory: preferences, repository notes, past decisions and finished tasks.",
      inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string' } } },
      run: (a) => recallText(memDir, String(a?.query ?? '')),
    },
  ];
}
