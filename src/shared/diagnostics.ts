// One text file that says what the app is and what state it is in, for finding out why something went wrong (decision 132).
// It is written for sharing, so secrets are taken out here, in one place, and the test pins what counts as one.

const SECRETS: [RegExp, string][] = [
  // Anthropic, OpenAI and GitHub tokens, by their prefixes.
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, 'sk-***'],
  [/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g, '$1_***'],
  // Atlassian API tokens.
  [/\bATATT[A-Za-z0-9_=-]{16,}/g, 'ATATT***'],
  // Anything sent as a credential.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  [/("?(?:token|tokenEnc|jiraTokenEnc|password|secret|authorization|api[_-]?key)"?\s*[:=]\s*)("[^"]*"|[^\s,}]+)/gi, '$1"***"'],
  // Credentials inside a URL.
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1***@'],
];

/** The text with anything that looks like a credential replaced. */
export function redact(text: string): string {
  return redactCount(text).text;
}

/**
 * The same, with how many values were taken out. `mask` stands in for each hidden value instead of `***` (an export
 * shows "[hidden]"); what comes before it, such as a token's prefix or a setting's name, stays.
 */
export function redactCount(text: string, mask?: string): { text: string; n: number } {
  let out = text;
  let n = 0;
  const shown = mask ?? '***';
  for (const [re, to] of SECRETS) {
    const hits = out.match(re);
    if (!hits) continue;
    // A value an earlier rule already hid ("API_KEY=sk-ant-***") is tidied, not counted again.
    n += hits.filter((h) => !h.includes(shown)).length;
    out = out.replace(re, mask === undefined ? to : to.replace(/"?\*\*\*"?/, mask.replace(/\$/g, '$$$$')));
  }
  return { text: out, n };
}

export interface DiagnosticsInput {
  app: { version: string; platform: string; arch: string; electron: string; node: string; fake: boolean };
  /** Settings as the window sees them (no tokens), with accounts by label and kind only. */
  settings: Record<string, unknown>;
  accounts: { label: string; kind: string; provider: string; plan: string; limited: boolean; lastError: string | null }[];
  checks: { id: string; host?: string; ok: boolean; detail: string }[];
  counts: { workers: Record<string, number>; tasks: Record<string, number>; decisionsPending: number; repos: number; automations: number };
  /** The end of the app's log. */
  log: string;
  /** The end of the crash log (errors nothing caught, pages that died); empty when there were none. */
  crashes?: string;
  /**
   * Words that name the user or their company (the company's GitHub host, the Jira site, the email, the OS user name):
   * each is replaced by its stand-in wherever it appears, the log included.
   */
  hide?: { text: string; as: string }[];
  now: string;
}

/** Settings worth reading in a report. The email and addresses that identify the user's company are left out. */
const LEFT_OUT = new Set(['jiraEmail', 'jiraUrl', 'githubHost', 'memoryRemote', 'customSound', 'accounts', 'jiraTokenEnc']);

export function diagnosticsText(d: DiagnosticsInput): string {
  const kv = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
  const settings = Object.fromEntries(Object.entries(d.settings).filter(([k]) => !LEFT_OUT.has(k)));
  const set = Object.fromEntries(['jiraUrl', 'githubHost', 'memoryRemote'].map((k) => [`${k} set`, !!String(d.settings[k] ?? '').trim()]));
  const parts = [
    `Oh My Agent IDE diagnostics, ${d.now}`,
    `\n[app]\n${kv(d.app)}`,
    `\n[checks]\n${d.checks.map((c) => `  ${c.ok ? 'ok  ' : 'FAIL'} ${c.id}${c.host ? ` (${c.host === 'github.com' ? c.host : 'company host'})` : ''}${c.ok ? '' : `: ${c.detail}`}`).join('\n') || '  (not run)'}`,
    `\n[accounts]\n${d.accounts.map((a, i) => `  ${i + 1}. ${a.provider} ${a.kind} ${a.plan}${a.limited ? ' limited' : ''}${a.lastError ? ` error: ${a.lastError}` : ''}`).join('\n') || '  (none)'}`,
    `\n[counts]\n${kv({ ...d.counts })}`,
    `\n[settings]\n${kv({ ...settings, ...set })}`,
    `\n[crashes]\n${d.crashes?.trim() || '(none)'}`,
    `\n[log]\n${d.log.trim() || '(empty)'}`,
  ];
  let out = redact(parts.join('\n'));
  for (const h of d.hide ?? []) {
    const word = h.text.trim();
    if (word.length < 3) continue;
    out = out.replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), h.as);
  }
  return `${out}\n`;
}

/** The last `n` lines of a log. */
export function tailLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}
