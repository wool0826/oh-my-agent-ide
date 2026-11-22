// Starting a task from an issue of a registered repository: the issues come from `gh issue list`, and picking one
// is a message to the Dispatcher, so the task is made the way every other task is.

export interface Issue { number: number; title: string; url: string; labels: string[]; updatedAt: string }

/** `host/owner/name` of a repository's GitHub URL (https or ssh), for `gh -R`. Null for anything else, such as a local folder. */
export function ghRepoRef(url: string): { host: string; slug: string } | null {
  const m = /^(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { host: m[1], slug: `${m[2]}/${m[3]}` } : null;
}

/** The issues as `gh issue list --json number,title,url,labels,updatedAt` prints them. */
export function parseIssues(json: string): Issue[] {
  let rows: unknown;
  try { rows = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r: any) => (typeof r?.number === 'number' && typeof r.title === 'string' && typeof r.url === 'string'
    ? [{ number: r.number, title: r.title, url: r.url, labels: Array.isArray(r.labels) ? r.labels.map((l: any) => String(l?.name ?? '')).filter(Boolean) : [], updatedAt: String(r.updatedAt ?? '') }]
    : []));
}

/** What the Dispatcher is told when the user hands it an issue. The Worker reads the issue itself. */
export function issueMessage(repo: string, issue: Pick<Issue, 'number' | 'title' | 'url'>): string {
  return `@${repo} Work on issue #${issue.number}: ${issue.title}\n${issue.url}\nRead the issue and its comments first (\`gh issue view ${issue.url} --comments\`), and have the PR close it ("Closes #${issue.number}").`;
}
