// Stands in for the `gh` CLI in end-to-end tests (the app runs it when OMA_GH_STUB points here).
// Pull requests live in the JSON file named by OMA_E2E_GH: a PR the app asks about is open, mergeable and
// approved unless the file says otherwise, and `pr merge` marks it merged. Every call is recorded for the test.
import fs from 'node:fs';

const file = process.env.OMA_E2E_GH;
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const db = { prs: {}, issues: [], calls: [], ...read() };
const args = process.argv.slice(2);
db.calls.push(args.join(' '));

const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const pr = (url) => (db.prs[url] ??= { state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', checks: [] });
let code = 0;

if (args[0] === 'pr' && args[1] === 'view') {
  const p = pr(args[2]);
  const fields = args[args.indexOf('--json') + 1] ?? '';
  if (fields.includes('comments')) out({ comments: [], reviews: [] });
  else out({ state: p.state, headRefName: p.head ?? 'feature', headRefOid: 'a'.repeat(40), baseRefName: 'main', baseRefOid: 'b'.repeat(40), mergeable: p.mergeable, reviewDecision: p.reviewDecision, statusCheckRollup: p.checks });
} else if (args[0] === 'pr' && args[1] === 'merge') {
  const p = pr(args[2]);
  if (p.failMerge) { process.stderr.write('Pull request is not mergeable'); code = 1; } else p.state = 'MERGED';
} else if (args[0] === 'repo' && args[1] === 'view') {
  out({ squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true });
} else if (args[0] === 'issue' && args[1] === 'list') {
  out(db.issues);
} else if (args[0] === 'api') {
  out([]);
} else {
  process.stderr.write(`gh stub: not supported: ${args.join(' ')}`);
  code = 1;
}

fs.writeFileSync(file, JSON.stringify(db, null, 1));
process.exit(code);
