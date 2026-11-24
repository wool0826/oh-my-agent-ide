// claude.ai connectors and the Artifact tool in the Dispatcher's and the Workers' Claude Code sessions (T-0064).
//
// Two things reach a session from the user's claude.ai account:
// - claude.ai connectors (MCP servers of scope "claudeai", such as "claude.ai Claude Docs", whose docs are claude.ai
//   artifacts). Claude Code fetches and connects them by itself, after the session starts, when it is signed in with
//   a claude.ai login that may use them. One that needs a sign-in reports "needs-auth"; a session cannot sign in.
// - The built-in Artifact tool (publish, list, read, upload_asset, read_asset), on once the account has the feature.
//   It is named in the Dispatcher's tool list so it appears there when it does; Workers have every built-in tool.
// Neither exists for Codex sessions. Turned off in Settings, both are kept out of new sessions.
import type { Options } from '@anthropic-ai/claude-agent-sdk';

/** The built-in tool, for the Dispatcher's own list of built-in tools. */
export const ARTIFACT_TOOL = 'Artifact';

/** How often a session's connectors are looked at, at most (after a turn). */
export const CONNECTOR_CHECK_MS = 60_000;
/** A connector that failed is reconnected at most this often. */
export const RECONNECT_GAP_MS = 5 * 60_000;

/** What mcpServerStatus() reports, as far as it is read here. */
export interface ServerStatus {
  name: string;
  status: string;
  scope?: string;
  error?: string;
  config?: { type?: string };
}

/** Flag settings for a session: the connectors and the Artifact tool, on or off. */
export function connectorSettings(on: boolean): NonNullable<Exclude<Options['settings'], string>> {
  return on ? { enableArtifact: true } : { enableArtifact: false, disableClaudeAiConnectors: true };
}

export const isConnector = (s: ServerStatus) => s.scope === 'claudeai' || s.config?.type === 'claudeai-proxy';

/**
 * Lines worth a log entry: connectors whose status changed since the last look (`seen` is updated), and ones that
 * went away. Needs-auth is said once, not on every look.
 */
export function connectorChanges(statuses: ServerStatus[], seen: Map<string, string>): string[] {
  const out: string[] = [];
  const now = new Set<string>();
  for (const s of statuses.filter(isConnector)) {
    now.add(s.name);
    if (seen.get(s.name) === s.status) continue;
    seen.set(s.name, s.status);
    out.push(`${s.name}: ${s.status}${s.error ? ` (${s.error.slice(0, 200)})` : ''}`);
  }
  for (const name of [...seen.keys()]) if (!now.has(name)) { seen.delete(name); out.push(`${name}: gone`); }
  return out;
}

/** Connectors that failed and were not tried again within RECONNECT_GAP_MS. Needs-auth ones cannot be fixed here. */
export function toReconnect(statuses: ServerStatus[], tried: Map<string, number>, now: number, gap = RECONNECT_GAP_MS): string[] {
  return statuses.filter((s) => isConnector(s) && s.status === 'failed' && now - (tried.get(s.name) ?? -Infinity) >= gap).map((s) => s.name);
}

/** "Claude Docs: create" for mcp__claude_ai_Claude_Docs__create; null for any other tool. */
export function connectorToolLabel(tool: string): string | null {
  const m = /^mcp__claude_ai_(.+?)__(\w+)$/.exec(tool);
  return m ? `${m[1].replace(/_/g, ' ')}: ${m[2]}` : null;
}

/** What the Dispatcher and the Workers are told about these tools (only with them on). */
export function connectorPrompt(): string[] {
  return [
    'claude.ai artifacts and connectors:',
    '- Your session may have the Artifact tool or claude.ai connector tools (mcp__claude_ai_*, such as Claude Docs, whose docs are claude.ai artifacts). Use them to publish, read, upload or download artifacts when the task or the user asks for that; publishing makes content visible on claude.ai, so do not do it unasked.',
    '- They come from the user\'s claude.ai account and may be missing, disconnected or waiting for a sign-in. If the one you need is not there or fails, do not retry in a loop or ask for codes or tokens: say in one line what is unavailable (a sign-in in claude.ai connector settings, or not offered for this account) and go on without it, saving files locally instead.',
  ];
}
