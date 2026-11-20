import path from 'node:path';
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

/**
 * auto mode와 별개로 항상 사용자에게 물을 작업.
 * PreToolUse 훅이 'ask'를 돌려주면 canUseTool이 불리고, 그곳에서 결정 대기함에 올린다.
 */
const BASH_RULES: { re: RegExp; why: string }[] = [
  { re: /\bgit\s+push\b[^;&|\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/, why: '강제 push' },
  // git push [옵션] <원격> [<로컬>:]main 처럼 보호 브랜치가 push 대상일 때만
  { re: /\bgit\s+push(?:\s+-[-\w]+(?:=\S+)?)*\s+[\w.-]+\s+(?:\S+:)?(?:refs\/heads\/)?(main|master|develop|release\/[\w.-]+)(?=\s|$|[;&|])/, why: '기본 브랜치에 직접 push' },
  { re: /\b(drop|truncate)\s+(table|database|schema)\b/i, why: '테이블이나 DB 삭제' },
  { re: /\bdelete\s+from\b(?![^\n]*\bwhere\b)/i, why: '조건 없는 DELETE' },
  { re: /\b(psql|mysql|mongosh?|redis-cli|sqlcmd)\b[^\n]*\b(prod|production|live|real)\b/i, why: '운영 DB 접근' },
  { re: /\b(prod|production)\b[^\n]*\b(psql|mysql|mongosh?|redis-cli|sqlcmd)\b/i, why: '운영 DB 접근' },
  { re: /\bkubectl\s+(apply|delete|scale|rollout|edit|patch|drain)\b/, why: '쿠버네티스 변경' },
  { re: /\b(terraform|tofu)\s+(apply|destroy|import)\b/, why: '인프라 변경' },
  { re: /\bhelm\s+(install|upgrade|uninstall|rollback)\b/, why: '배포 변경' },
  { re: /\bgh\s+pr\s+merge\b/, why: 'PR 머지' },
  { re: /\bgh\s+(repo|release)\s+delete\b/, why: '저장소나 릴리스 삭제' },
  { re: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|[A-Za-z]:\\)(\s|$)/, why: '루트나 홈 폴더 삭제' },
];

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

export function alwaysAskReason(tool: string, input: any, roots: string[]): string | null {
  if (tool === 'Bash') {
    const cmd = String(input?.command ?? '');
    for (const r of BASH_RULES) if (r.re.test(cmd)) return r.why;
    return null;
  }
  if (WRITE_TOOLS.has(tool)) {
    const p = String(input?.file_path ?? input?.notebook_path ?? '');
    if (!p) return null;
    const abs = path.resolve(p);
    const inside = roots.some((r) => {
      const rel = path.relative(path.resolve(r), abs);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    return inside ? null : '작업 폴더 밖 파일 수정';
  }
  return null;
}

export function alwaysAskHook(roots: () => string[], onFlag: (toolUseId: string, why: string) => void): HookCallbackMatcher {
  return {
    hooks: [async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const why = alwaysAskReason(input.tool_name, input.tool_input, roots());
      if (!why) return {};
      onFlag(input.tool_use_id, why);
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `항상 확인: ${why}` },
      };
    }],
  };
}
