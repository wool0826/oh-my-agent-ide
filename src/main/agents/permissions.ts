import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { t } from '../i18n';
import type { Key } from '../../shared/i18n';
import { loadSettings } from '../settings';
import type { AskRule } from '../../shared/grants';
import { readShell, shellOf, type ShellCmd } from '../../shared/shellWords';

/** Branches a push should not reach without a PR. */
const PROTECTED = /^(?:refs\/heads\/)?(main|master|develop|release\/[\w.-]+)$/;

/** The first word that is not an option, passing over the options that take a value as the next word. */
function firstWord(args: string[], valued: readonly string[] = []): string {
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('-')) return args[i];
    if (valued.includes(args[i])) i++;
  }
  return '';
}

/** `git push`'s options and the refspecs after the remote, or null when the command is not one. */
function gitPush(c: ShellCmd): { flags: string[]; refs: string[] } | null {
  if (c.prog !== 'git' || c.args[0] !== 'push') return null;
  const flags: string[] = [], words: string[] = [];
  for (let i = 1; i < c.args.length; i++) {
    const a = c.args[i];
    if (!a.startsWith('-')) words.push(a);
    else {
      flags.push(a);
      if (['-o', '--push-option', '--receive-pack', '--exec', '--repo', '--recurse-submodules'].includes(a)) i++;
    }
  }
  return { flags, refs: words.slice(1) };
}

function forcePush(c: ShellCmd): boolean {
  const p = gitPush(c);
  if (!p) return false;
  // -f alone or in a cluster of push's one-letter options (-fu); --mirror overwrites every ref on the remote.
  return p.flags.some((f) => f === '--force' || f === '--mirror' || f.startsWith('--force-with-lease') || /^-[undqv46]*f[undqvf46]*$/.test(f))
    || p.refs.some((r) => r.startsWith('+'));
}

/** A protected branch is what the push writes to (or deletes): `main`, `HEAD:main`, `:main`, `+x:refs/heads/main`. */
function pushMain(c: ShellCmd): boolean {
  return !!gitPush(c)?.refs.some((r) => PROTECTED.test(r.replace(/^\+/, '').split(':').pop() ?? ''));
}

/** gh's command words (`pr`, `merge`), wherever `-R owner/repo` is written. */
function ghWords(c: ShellCmd): string[] {
  if (c.prog !== 'gh') return [];
  const out: string[] = [];
  for (let i = 0; i < c.args.length && out.length < 2; i++) {
    const a = c.args[i];
    if (a === '-R' || a === '--repo' || a === '--hostname') i++;
    else if (!a.startsWith('-')) out.push(a);
  }
  return out;
}

interface ApiCall { method: string; path: string; fields: string[]; input: boolean }

/** A `gh api` call: its method (as gh works it out), its endpoint without host and query, and the fields it sends. */
function ghApi(c: ShellCmd): ApiCall | null {
  if (ghWords(c)[0] !== 'api') return null;
  const a = c.args;
  let method = '', path = '', input = false;
  const fields: string[] = [];
  for (let i = a.indexOf('api') + 1; i < a.length; i++) {
    const w = a[i];
    const eq = w.startsWith('--') ? w.indexOf('=') : -1;
    const name = eq > 0 ? w.slice(0, eq) : w;
    const value = () => (eq > 0 ? w.slice(eq + 1) : a[++i] ?? '');
    const glued = /^-([XfF])=?(.+)$/.exec(w);
    if (name === '-X' || name === '--method') method = value();
    else if (name === '-f' || name === '-F' || name === '--field' || name === '--raw-field') fields.push(value());
    else if (glued) { if (glued[1] === 'X') method = glued[2]; else fields.push(glued[2]); }
    else if (name === '--input') { input = true; value(); }
    else if (['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview'].includes(name)) value();
    else if (!w.startsWith('-') && !path) path = w;
  }
  return {
    method: (method || (fields.length || input ? 'POST' : 'GET')).toUpperCase(),
    path: path.replace(/^https?:\/\/[^/]+\//i, '').replace(/^\/+/, '').replace(/[?#].*$/, '').replace(/\/+$/, ''),
    fields, input,
  };
}

/** What a GraphQL call sends, as one text. */
const graphql = (a: ApiCall) => (a.path === 'graphql' ? a.fields.join('\n') : '');

function merges(c: ShellCmd): boolean {
  const w = ghWords(c);
  if (w[0] === 'pr' && w[1] === 'merge') return true;
  const a = ghApi(c);
  if (!a) return false;
  // PUT …/pulls/1/merge merges a PR; POST …/merges merges one branch into another. A GET of the first only asks whether it is merged.
  if (a.method !== 'GET' && /(^|\/)(pulls\/[^/]+\/merge|merges)$/.test(a.path)) return true;
  return /\b(mergePullRequest|mergeBranch|enablePullRequestAutoMerge|enqueuePullRequest)\b/.test(graphql(a));
}

const REPO_OR_RELEASE = /^repos\/[^/]+\/[^/]+(\/releases\/[^/]+)?$/;

function repoDelete(c: ShellCmd): boolean {
  const w = ghWords(c);
  if ((w[0] === 'repo' || w[0] === 'release') && /^delete\b/.test(w[1] ?? '')) return true;
  const a = ghApi(c);
  return !!a && a.method === 'DELETE' && REPO_OR_RELEASE.test(a.path);
}

/** Any other DELETE through the API: a branch, a comment, a workflow run. */
function apiDelete(c: ShellCmd): boolean {
  const a = ghApi(c);
  if (!a) return false;
  return (a.method === 'DELETE' && !REPO_OR_RELEASE.test(a.path)) || /\bdelete[A-Z]\w*\s*\(/.test(graphql(a));
}

const FORCE = /^force=(true|1)$/i;

/** A ref moved through the API with force, which is a force push by another road. `--input` hides the body, so it counts. */
function apiForce(c: ShellCmd): boolean {
  const a = ghApi(c);
  if (!a) return false;
  if (a.method !== 'GET' && a.method !== 'DELETE' && /(^|\/)git\/refs\/./.test(a.path) && (a.input || a.fields.some((f) => FORCE.test(f)))) return true;
  const q = graphql(a);
  return /\bupdateRefs?\b/.test(q) && (/\bforce\s*:\s*true\b/.test(q) || a.fields.some((f) => FORCE.test(f)));
}

/** A protected branch moved through the API, without a push. */
function apiMain(c: ShellCmd): boolean {
  const a = ghApi(c);
  return !!a && (a.method === 'PATCH' || a.method === 'PUT') && PROTECTED.test(/(?:^|\/)git\/(refs\/heads\/.+)$/.exec(a.path)?.[1] ?? '');
}

const KUBECTL_VALUE = ['-n', '--namespace', '--context', '--kubeconfig', '--cluster', '--user', '-s', '--server', '--as', '--as-group', '--token',
  '--certificate-authority', '--client-certificate', '--client-key', '--request-timeout', '--cache-dir', '-v', '--profile', '--tls-server-name'];
const HELM_VALUE = ['-n', '--namespace', '--kube-context', '--kubeconfig', '--kube-apiserver', '--kube-as-user', '--kube-as-group', '--kube-token',
  '--kube-ca-file', '--kube-tls-server-name', '--registry-config', '--repository-cache', '--repository-config', '--burst-limit', '--qps'];

/** The root, a drive or the home folder itself, with or without a trailing slash or `*`. */
const ROOT_OR_HOME = /^(?:(?:[A-Za-z]:|~|\$HOME|\$\{HOME\}|\$env:(?:USERPROFILE|HOME|HOMEPATH|SystemDrive)|%(?:USERPROFILE|HOMEPATH|HOMEDRIVE|SystemDrive)%)[\\/]?|[\\/])\*?$/i;
const REMOVERS = ['rm', 'remove-item', 'ri', 'rmdir', 'rd', 'del', 'erase'];

/** A recursive delete of the root or home folder: `rm -rf ~`, `rm -r -f -- /`, `Remove-Item -Recurse C:\`, `rd /s /q C:\`. */
function rmHome(c: ShellCmd): boolean {
  if (!REMOVERS.includes(c.prog)) return false;
  // cmd's own removers take /s and /q; to rm and Remove-Item a word like /s is a path.
  const cmd = c.prog !== 'rm' && c.prog !== 'remove-item' && c.prog !== 'ri';
  const flag = (a: string) => /^--?[A-Za-z-]+$/.test(a) || (cmd && /^\/[A-Za-z]$/.test(a));
  // PowerShell also takes a parameter's value after a colon: -Path:C:\, -Recurse:$true. A switch set to $false is not given.
  const args = c.args.flatMap((a) => {
    const m = /^(-[A-Za-z]+):(.*)$/.exec(a);
    return !m ? [a] : /^\$false$/i.test(m[2]) ? [] : [m[1], m[2]];
  });
  const recursive = args.some((a) => /^-[A-Za-z]*r[A-Za-z]*$/i.test(a) || a === '--recursive' || (cmd && /^\/s$/i.test(a)));
  return recursive && args.some((a) => !flag(a) && ROOT_OR_HOME.test(a));
}

/**
 * Actions that always ask the user, regardless of auto mode.
 * The PreToolUse hook returns 'ask', canUseTool is called, and it posts a decision.
 * `cmd` looks at one command of the line as src/shared/shellWords.ts reads it, so a rule holds in Bash and in
 * PowerShell alike and however the command is wrapped. `text` looks at the whole line: SQL is asked about wherever it stands.
 * `unread` is a line nested too deep to read to its end: nothing can be said for what it runs.
 */
const RULES: { why: AskRule; cmd?: (c: ShellCmd) => boolean; text?: RegExp; unread?: true }[] = [
  { why: 'ask.forcePush', cmd: (c) => forcePush(c) || apiForce(c) },
  { why: 'ask.pushMain', cmd: (c) => pushMain(c) || apiMain(c) },
  { why: 'ask.drop', text: /\b(drop|truncate)\s+(table|database|schema)\b/i },
  { why: 'ask.delete', text: /\bdelete\s+from\b(?![^\n]*\bwhere\b)/i },
  { why: 'ask.prodDb', text: /\b(psql|mysql|mongosh?|redis-cli|sqlcmd)\b[^\n]*\b(prod|production|live|real)\b/i },
  { why: 'ask.prodDb', text: /\b(prod|production)\b[^\n]*\b(psql|mysql|mongosh?|redis-cli|sqlcmd)\b/i },
  { why: 'ask.k8s', cmd: (c) => c.prog === 'kubectl' && ['apply', 'delete', 'scale', 'rollout', 'edit', 'patch', 'drain'].includes(firstWord(c.args, KUBECTL_VALUE)) },
  { why: 'ask.infra', cmd: (c) => (c.prog === 'terraform' || c.prog === 'tofu') && ['apply', 'destroy', 'import'].includes(firstWord(c.args)) },
  { why: 'ask.deploy', cmd: (c) => c.prog === 'helm' && ['install', 'upgrade', 'uninstall', 'rollback', 'delete', 'del', 'un'].includes(firstWord(c.args, HELM_VALUE)) },
  { why: 'ask.merge', cmd: merges },
  { why: 'ask.repoDelete', cmd: repoDelete },
  { why: 'ask.apiDelete', cmd: apiDelete },
  { why: 'ask.rmHome', cmd: rmHome },
  // Last, so that a rule found in the part that was read names the reason.
  { why: 'ask.unread', unread: true },
];

/** Prefix of the hook's reason; the permission handler strips it. */
export const ALWAYS_ASK_PREFIX = 'Always ask: ';

/**
 * Why a tool call must be asked about, or null to leave it to auto mode.
 * Only destructive or shared-state shell commands are listed, in any shell tool (Bash, PowerShell); file edits are
 * auto mode's call, wherever they are.
 */
export function alwaysAskReason(tool: string, input: any): string | null {
  const rule = alwaysAskRule(tool, input, loadSettings().askOff);
  return rule ? t(rule) : null;
}

/** The always-ask rule a tool call matches (its label key), or null. Rules the user switched off (`off`) are passed over. */
export function alwaysAskRule(tool: string, input: any, off: readonly string[] = []): Key | null {
  const shell = shellOf(tool);
  if (!shell) return null;
  const text = String(input?.command ?? '');
  const line = readShell(text, shell);
  for (const r of RULES) if (!off.includes(r.why) && (r.text?.test(text) || (r.cmd && line.cmds.some(r.cmd)) || (r.unread && line.unread))) return r.why;
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
