// Jira issues assigned to the user, handed to the Dispatcher as tasks (decision 125).
// Works with Jira Cloud (email + API token) and Jira Data Center (personal access token).
/* eslint-disable @typescript-eslint/no-explicit-any -- Jira answers untyped JSON, read field by field. */

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  type: string;
  url: string;
  updatedAt: string;
  /** The description as plain text, cut to a length a message can carry. */
  description: string;
}

/** The issues the list shows: the user's own, still open, most recently touched first. */
export const JIRA_JQL = 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC';
export const JIRA_FIELDS = ['summary', 'status', 'issuetype', 'updated', 'description'];
const DESC_MAX = 4000;

/**
 * The site's address as typed, down to its origin and any context path ("https://jira.company.com/jira").
 * Null unless it is https: the token goes in a header and must not travel in the clear.
 */
export function jiraBase(url: string): string | null {
  const v = url.trim().replace(/\/+$/, '');
  if (!v) return null;
  let u: URL;
  try { u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`); } catch { return null; }
  if (u.protocol !== 'https:' || !u.hostname.includes('.')) return null;
  // A pasted board or issue link keeps only what comes before Jira's own paths.
  const path = u.pathname.replace(/\/(browse|secure|projects|rest|jira\/software|issues)(\/.*)?$/i, '').replace(/\/+$/, '');
  return `${u.origin}${path}`;
}

/** Cloud signs in with the account's email and an API token; Data Center with a personal access token alone. */
export function jiraAuth(email: string, token: string): string {
  return email.trim() ? `Basic ${Buffer.from(`${email.trim()}:${token}`, 'utf8').toString('base64')}` : `Bearer ${token}`;
}

/** The search endpoints to try, in order: Cloud's current one first when an email is set, then the one Data Center has. */
export function jiraSearchUrls(base: string, cloud: boolean): string[] {
  const q = `jql=${encodeURIComponent(JIRA_JQL)}&maxResults=50&fields=${JIRA_FIELDS.join(',')}`;
  const v2 = `${base}/rest/api/2/search?${q}`;
  return cloud ? [`${base}/rest/api/3/search/jql?${q}`, v2] : [v2];
}

/** Atlassian Document Format (Cloud's description) as plain text: paragraphs and list items on their own lines. */
export function adfText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> };
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'mention' || n.type === 'emoji') return String(n.attrs?.text ?? n.attrs?.shortName ?? '');
  if (n.type === 'inlineCard') return String(n.attrs?.url ?? '');
  const inner = (n.content ?? []).map(adfText).join('');
  if (n.type === 'listItem') return `- ${inner.trim()}\n`;
  const block = n.type === 'paragraph' || n.type === 'heading' || n.type === 'codeBlock' || n.type === 'blockquote' || n.type === 'rule';
  return block ? `${inner}\n` : inner;
}

/** The issues of a search answer (v2 or v3), with links built from the site's address. */
export function parseJiraIssues(body: unknown, base: string): JiraIssue[] {
  const rows = (body as { issues?: unknown })?.issues;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r: any) => {
    const f = r?.fields;
    if (typeof r?.key !== 'string' || typeof f?.summary !== 'string') return [];
    const text = adfText(f.description).replace(/\n{3,}/g, '\n\n').trim();
    return [{
      key: r.key, summary: f.summary, status: String(f.status?.name ?? ''), type: String(f.issuetype?.name ?? ''),
      url: `${base}/browse/${r.key}`, updatedAt: String(f.updated ?? ''),
      description: text.length > DESC_MAX ? `${text.slice(0, DESC_MAX)}…` : text,
    }];
  });
}

/**
 * What the Dispatcher is told when the user hands it a Jira issue. The description rides along, because
 * Workers have no way into Jira; the Dispatcher picks the repository as for any request.
 */
export function jiraMessage(i: Pick<JiraIssue, 'key' | 'summary' | 'url' | 'description'>): string {
  const body = i.description ? `\n\nDescription:\n${i.description}` : '';
  return `Work on Jira issue ${i.key}: ${i.summary}\n${i.url}${body}\n\nPut "${i.key}" in the PR title so Jira links the PR to the issue. Workers cannot read Jira: everything known about the issue is above.`;
}
