// The app's own tools a Worker can call (recall from memory, tell the Dispatcher), for Claude Code and for Codex.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { type CodexTool } from './codexSession';
import { store } from '../store';
import { searchMemory } from '../memory';
import { memoryDirFor, searchClaudeMemory } from '../claudeContext';
import { paths } from '../paths';
import { type Worker } from '../../shared/types';
import { question, TellKind } from './workerText';

/** Claude Code memory of the repository's main checkout; Workers without a repository share the IDE home's. */
export function workerMemoryDir(w: Worker) {
  const repo = w.repo ? store.repo(w.repo) : null;
  return memoryDirFor(repo ? repo.path : paths().home);
}

/**
 * A Worker's own tools: read-only memory search (IDE memory plus the shared Claude Code memory) and its line to
 * the Dispatcher. Neither changes files, so both work in plan mode too.
 */

export function workerTools(memDir: string | null, tell: (kind: TellKind, text: string) => string) {
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

/** The same two tools for a Worker that runs on Codex. */
export function workerCodexTools(memDir: string | null, tell: (kind: TellKind, text: string) => string): CodexTool[] {
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
      name: 'recall',
      description: "Search the user's memory: preferences, repository notes, past decisions and finished tasks.",
      inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string' } } },
      run: (a) => recallText(memDir, String(a?.query ?? '')),
    },
  ];
}
