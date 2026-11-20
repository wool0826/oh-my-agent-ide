import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { t } from '../i18n';
import type { Key } from '../../shared/i18n';

/**
 * Actions that always ask the user, regardless of auto mode.
 * The PreToolUse hook returns 'ask', canUseTool is called, and it posts a decision.
 */
const BASH_RULES: { re: RegExp; why: Key }[] = [
  { re: /\bgit\s+push\b[^;&|\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/, why: 'ask.forcePush' },
  // Only when a protected branch is the push target, as in git push [opts] <remote> [<local>:]main
  { re: /\bgit\s+push(?:\s+-[-\w]+(?:=\S+)?)*\s+[\w.-]+\s+(?:\S+:)?(?:refs\/heads\/)?(main|master|develop|release\/[\w.-]+)(?=\s|$|[;&|])/, why: 'ask.pushMain' },
  { re: /\b(drop|truncate)\s+(table|database|schema)\b/i, why: 'ask.drop' },
  { re: /\bdelete\s+from\b(?![^\n]*\bwhere\b)/i, why: 'ask.delete' },
  { re: /\b(psql|mysql|mongosh?|redis-cli|sqlcmd)\b[^\n]*\b(prod|production|live|real)\b/i, why: 'ask.prodDb' },
  { re: /\b(prod|production)\b[^\n]*\b(psql|mysql|mongosh?|redis-cli|sqlcmd)\b/i, why: 'ask.prodDb' },
  { re: /\bkubectl\s+(apply|delete|scale|rollout|edit|patch|drain)\b/, why: 'ask.k8s' },
  { re: /\b(terraform|tofu)\s+(apply|destroy|import)\b/, why: 'ask.infra' },
  { re: /\bhelm\s+(install|upgrade|uninstall|rollback)\b/, why: 'ask.deploy' },
  { re: /\bgh\s+pr\s+merge\b/, why: 'ask.merge' },
  { re: /\bgh\s+(repo|release)\s+delete\b/, why: 'ask.repoDelete' },
  { re: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|[A-Za-z]:\\)(\s|$)/, why: 'ask.rmHome' },
];

/** Prefix of the hook's reason; the permission handler strips it. */
export const ALWAYS_ASK_PREFIX = 'Always ask: ';

/**
 * Why a tool call must be asked about, or null to leave it to auto mode.
 * Only destructive or shared-state shell commands are listed; file edits are auto mode's call, wherever they are.
 */
export function alwaysAskReason(tool: string, input: any): string | null {
  if (tool !== 'Bash') return null;
  const cmd = String(input?.command ?? '');
  for (const r of BASH_RULES) if (r.re.test(cmd)) return t(r.why);
  return null;
}

export function alwaysAskHook(): HookCallbackMatcher {
  return {
    hooks: [async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const why = alwaysAskReason(input.tool_name, input.tool_input);
      if (!why) return {};
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `${ALWAYS_ASK_PREFIX}${why}` },
      };
    }],
  };
}
