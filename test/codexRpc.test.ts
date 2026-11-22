import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpc, RpcFailure } from '../src/main/codex/rpc';

function pair(onRequest: (method: string, params: any) => unknown = () => ({})) {
  const out: any[] = [];
  const notes: [string, any][] = [];
  const noise: string[] = [];
  const rpc = new JsonRpc((line) => out.push(JSON.parse(line)), {
    onNotify: (m, p) => notes.push([m, p]),
    onRequest,
    onNoise: (l) => noise.push(l),
  });
  return { rpc, out, notes, noise };
}
const tick = () => new Promise((r) => setImmediate(r));

test('a request is answered by the line with its id, in whatever pieces it arrives', async () => {
  const { rpc, out } = pair();
  const p = rpc.request('model/list', { limit: 2 });
  assert.deepEqual(out[0], { id: 1, method: 'model/list', params: { limit: 2 } });
  rpc.feed('{"id":1,"resu');
  rpc.feed('lt":{"data":[]}}\n');
  assert.deepEqual(await p, { data: [] });
});

test('an error answer rejects with the method and the message', async () => {
  const { rpc } = pair();
  const p = rpc.request('thread/resume', { threadId: 'x' });
  rpc.feed('{"id":1,"error":{"code":-32600,"message":"no such thread"}}\n');
  await assert.rejects(p, (e: Error) => e instanceof RpcFailure && /thread\/resume: no such thread/.test(e.message));
});

test('notifications and several lines in one chunk are delivered in order', () => {
  const { rpc, notes } = pair();
  rpc.feed('{"method":"turn/started","params":{"threadId":"t"}}\n\n{"method":"turn/completed","params":{"threadId":"t"}}\n');
  assert.deepEqual(notes.map((n) => n[0]), ['turn/started', 'turn/completed']);
});

test('a request from the other side is answered with what the handler returns, or with its error', async () => {
  const { rpc, out } = pair((method) => {
    if (method === 'item/tool/call') return { success: true };
    throw new Error('not supported');
  });
  rpc.feed('{"id":"a","method":"item/tool/call","params":{}}\n{"id":7,"method":"other","params":{}}\n');
  await tick();
  // The two answers go out as each handler settles, in no fixed order.
  assert.deepEqual(out.find((m) => m.id === 'a'), { id: 'a', result: { success: true } });
  assert.deepEqual(out.find((m) => m.id === 7), { id: 7, error: { code: -32000, message: 'not supported' } });
  assert.equal(out.length, 2);
});

test('lines that are not JSON-RPC are reported and do not stop the stream', () => {
  const { rpc, notes, noise } = pair();
  rpc.feed('warming up\n{"method":"ok"}\n');
  assert.deepEqual(noise, ['warming up']);
  assert.equal(notes.length, 1);
});

test('when the connection is lost every waiting request fails', async () => {
  const { rpc } = pair();
  const a = rpc.request('turn/start', {});
  const b = rpc.request('model/list', {});
  rpc.failAll('Codex exited (1)');
  await assert.rejects(a, /turn\/start: Codex exited/);
  await assert.rejects(b, /model\/list: Codex exited/);
});

test('a request with no answer times out', async () => {
  const { rpc } = pair();
  await assert.rejects(rpc.request('initialize', {}, 20), /initialize: no answer/);
});
