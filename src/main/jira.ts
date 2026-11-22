// Reads the user's Jira issues with the address and token from Settings (decision 125).
// The token is stored encrypted like an account token, is sent only to that Jira site, and never reaches the page.

import { loadSettings, updateJiraToken, jiraToken } from './settings';
import { t } from './i18n';
import { jiraAuth, jiraBase, jiraSearchUrls, parseJiraIssues, type JiraIssue } from '../shared/jira';

export function jiraReady(): boolean {
  const s = loadSettings();
  return !!jiraBase(s.jiraUrl) && !!s.jiraTokenEnc;
}

export function setJiraToken(token: string) { updateJiraToken(token.trim()); }

export async function listJiraIssues(): Promise<JiraIssue[]> {
  const s = loadSettings();
  const base = jiraBase(s.jiraUrl);
  const token = jiraToken();
  if (!base || !token) throw new Error(t('jira.err.setup'));
  const headers = { accept: 'application/json', authorization: jiraAuth(s.jiraEmail, token) };
  let last = '';
  for (const url of jiraSearchUrls(base, !!s.jiraEmail.trim())) {
    // redirect: 'error' keeps the token from following a redirect to another host.
    const res = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20_000) }).catch((e: Error) => { last = e.message; return null; });
    if (!res) continue;
    if (res.status === 401 || res.status === 403) throw new Error(t('jira.err.auth'));
    // An endpoint this site does not have: try the next one.
    if (res.status === 404 || res.status === 410) { last = `HTTP ${res.status}`; continue; }
    if (!res.ok) throw new Error(t('jira.err.http', { code: res.status }));
    return parseJiraIssues(await res.json(), base);
  }
  throw new Error(t('jira.err.reach', { msg: last }));
}
