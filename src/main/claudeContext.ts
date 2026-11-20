import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What the user keeps for Claude Code itself: their rules (~/.claude/CLAUDE.md, ~/.claude/rules/*.md)
 * and Claude Code's auto-memory (~/.claude/projects/<project>/memory/).
 * Only these files are read; ~/.claude/settings.json (permissions, hooks, MCP) stays out of agent sessions.
 */

/** Claude Code's config folder: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeHome(env: NodeJS.ProcessEnv = process.env) {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
}

/** Claude Code names a project folder after its path with every non-alphanumeric character turned into '-'. */
export function projectSlug(dir: string) {
  return path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Auto-memory folder Claude Code uses when it runs in `dir`. Very long slugs are shortened by Claude Code,
 * so an existing folder that starts with the first 200 characters is used when there is one.
 */
export function memoryDirFor(dir: string, home = claudeHome()) {
  const projects = path.join(home, 'projects');
  let slug = projectSlug(dir);
  if (slug.length > 200) {
    try {
      const hit = fs.readdirSync(projects).find((n) => n.startsWith(slug.slice(0, 200)));
      if (hit) slug = hit;
    } catch { /* no projects yet */ }
  }
  return path.join(projects, slug, 'memory');
}

const RULES_MAX = 20_000;

/** The user's Claude Code rules as one text block, or '' when there are none. */
export function userRules(home = claudeHome(), max = RULES_MAX) {
  const parts: string[] = [];
  const add = (file: string, label: string) => {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) parts.push(`## ${label}\n${text}`);
    } catch { /* missing */ }
  };
  add(path.join(home, 'CLAUDE.md'), 'CLAUDE.md');
  try {
    const dir = path.join(home, 'rules');
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) add(path.join(dir, f), `rules/${f}`);
  } catch { /* no rules folder */ }
  const s = parts.join('\n\n');
  return s.length > max ? `${s.slice(0, max)}\n…` : s;
}

/** Rule files that exist, relative to the Claude Code folder (for Settings). */
export function ruleFiles(home = claudeHome()) {
  const out: string[] = [];
  if (fs.existsSync(path.join(home, 'CLAUDE.md'))) out.push('CLAUDE.md');
  try {
    for (const f of fs.readdirSync(path.join(home, 'rules')).filter((n) => n.endsWith('.md')).sort()) out.push(`rules/${f}`);
  } catch { /* none */ }
  return out;
}

/** Prompt section carrying the user's rules, or '' when there are none. */
export function userRulesSection(home = claudeHome()) {
  const r = userRules(home);
  return r ? `\n\nThe user's own rules for Claude (from their Claude Code setup). Follow them unless the task says otherwise.\n\n${r}` : '';
}

export interface ClaudeMemoryHit { file: string; line: number; text: string; score: number }

function terms(q: string) {
  return [...new Set(q.toLowerCase().split(/[\s,.;:!?()[\]{}"'`/\\]+/).filter((x) => x.length >= 2))];
}

/** Word search over the markdown files in the given auto-memory folders. */
export function searchClaudeMemory(query: string, dirs: string[], limit = 8): ClaudeMemoryHit[] {
  const ts = terms(query);
  if (!ts.length) return [];
  const hits: ClaudeMemoryHit[] = [];
  for (const dir of new Set(dirs)) {
    let files: string[];
    try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let text: string;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      text.split('\n').forEach((line, i) => {
        const l = line.toLowerCase();
        let score = 0;
        for (const x of ts) if (l.includes(x)) score += x.length >= 4 ? 2 : 1;
        if (score > 0 && line.trim().length > 2) hits.push({ file, line: i + 1, text: line.trim(), score });
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
