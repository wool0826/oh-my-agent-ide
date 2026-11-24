import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectorChanges, connectorPrompt, connectorSettings, connectorToolLabel, isConnector, RECONNECT_GAP_MS, toReconnect, type ServerStatus } from '../src/main/agents/connectors';
import { sessionSettings } from '../src/main/agents/session';

const docs = (status: string, error?: string): ServerStatus => ({ name: 'claude.ai Claude Docs', status, scope: 'claudeai', error, config: { type: 'claudeai-proxy' } });
const gmail: ServerStatus = { name: 'claude.ai Gmail', status: 'needs-auth', scope: 'claudeai' };
const own: ServerStatus = { name: 'oma', status: 'failed', scope: 'sdk' };

test('connectors on: the Artifact tool is enabled; off: it and the claude.ai connectors are kept out', () => {
  assert.deepEqual(connectorSettings(true), { enableArtifact: true });
  assert.deepEqual(connectorSettings(false), { enableArtifact: false, disableClaudeAiConnectors: true });
  // The session's own flag settings win; unset leaves Claude Code's defaults.
  assert.deepEqual(sessionSettings({ bashOutputMaxChars: 10 }, false), { enableArtifact: false, disableClaudeAiConnectors: true, bashOutputMaxChars: 10, autoCompactWindow: (sessionSettings({}) as { autoCompactWindow: number }).autoCompactWindow });
  assert.equal('enableArtifact' in (sessionSettings({}) as object), false);
  assert.equal(sessionSettings('/x.json', true), '/x.json');
});

test('only claude.ai connectors are watched; status changes are logged once each, and gone ones too', () => {
  assert.equal(isConnector(docs('connected')), true);
  assert.equal(isConnector({ name: 'x', status: 'failed', config: { type: 'claudeai-proxy' } }), true);
  assert.equal(isConnector(own), false);
  const seen = new Map<string, string>();
  assert.deepEqual(connectorChanges([docs('connected'), gmail, own], seen), ['claude.ai Claude Docs: connected', 'claude.ai Gmail: needs-auth']);
  assert.deepEqual(connectorChanges([docs('connected'), gmail], seen), []);
  assert.deepEqual(connectorChanges([docs('failed', 'socket hang up'), gmail], seen), ['claude.ai Claude Docs: failed (socket hang up)']);
  assert.deepEqual(connectorChanges([gmail], seen), ['claude.ai Claude Docs: gone']);
});

test('a failed connector is reconnected at most every 5 minutes; one that needs a sign-in never is', () => {
  const tried = new Map<string, number>();
  const now = 1_000_000;
  assert.deepEqual(toReconnect([docs('failed'), gmail, own, docs('pending')], tried, now), ['claude.ai Claude Docs']);
  tried.set('claude.ai Claude Docs', now);
  assert.deepEqual(toReconnect([docs('failed')], tried, now + RECONNECT_GAP_MS - 1), []);
  assert.deepEqual(toReconnect([docs('failed')], tried, now + RECONNECT_GAP_MS), ['claude.ai Claude Docs']);
});

test('connector tools get a readable name in permission cards; the prompt says how to cope without them', () => {
  assert.equal(connectorToolLabel('mcp__claude_ai_Claude_Docs__create'), 'Claude Docs: create');
  assert.equal(connectorToolLabel('mcp__claude_ai_Google_Drive__read_file'), 'Google Drive: read_file');
  assert.equal(connectorToolLabel('mcp__oma__recall'), null);
  const p = connectorPrompt().join('\n');
  assert.match(p, /Artifact tool/);
  assert.match(p, /do not retry in a loop or ask for codes or tokens/);
});
