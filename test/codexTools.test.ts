import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { codexToolsFrom, type SdkToolDef } from '../src/main/agents/codexTools';

const ok = (text: string) => ({ content: [{ type: 'text', text }] });
const defs: SdkToolDef[] = [
  {
    name: 'create_task', description: 'Create a task.',
    inputSchema: { title: z.string().describe('Short title'), kind: z.enum(['code', 'other']), plan_first: z.boolean().optional() },
    handler: async (a) => ok(`created ${a.title} (${a.kind}${a.plan_first ? ', plan first' : ''})`),
  },
  { name: 'list_repos', description: 'List repositories.', inputSchema: {}, handler: async () => ok('demo') },
  { name: 'stop_worker', description: 'Stop.', inputSchema: { worker_id: z.string() }, handler: async () => ({ content: [{ type: 'text', text: 'No such Worker.' }], isError: true }) },
];

test('a tool keeps its name and description, and its arguments become a JSON Schema', () => {
  const [create, list] = codexToolsFrom(defs);
  assert.equal(create.name, 'create_task');
  assert.equal(create.description, 'Create a task.');
  assert.deepEqual(create.inputSchema, {
    type: 'object', additionalProperties: false, required: ['title', 'kind'],
    properties: { title: { type: 'string', description: 'Short title' }, kind: { type: 'string', enum: ['code', 'other'] }, plan_first: { type: 'boolean' } },
  });
  assert.deepEqual(list.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
});

test('a call runs the same handler and answers with its text', async () => {
  const [create, list] = codexToolsFrom(defs);
  assert.equal(await create.run({ title: 'Fix login', kind: 'code', plan_first: true }), 'created Fix login (code, plan first)');
  assert.equal(await list.run(undefined), 'demo');
});

test('arguments that do not fit the schema never reach the handler', async () => {
  const [create] = codexToolsFrom(defs);
  await assert.rejects(async () => create.run({ title: 'x', kind: 'research' }), /Invalid arguments for create_task: kind/);
  await assert.rejects(async () => create.run({ kind: 'code' }), /title/);
});

test('a handler that reports an error answers as a failure with its message', async () => {
  const stop = codexToolsFrom(defs)[2];
  await assert.rejects(async () => stop.run({ worker_id: 'W-99' }), /No such Worker\./);
});
