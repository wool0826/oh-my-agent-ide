// Stands in for the `gh` CLI in end-to-end tests (the app runs it when OMA_GH_STUB points here).
// Pull requests live in the JSON file named by OMA_E2E_GH: a PR the app asks about is open, mergeable and
// approved unless the file says otherwise, and `pr merge` marks it merged. Every call is recorded for the test.
import fs from 'node:fs';

const file = process.env.OMA_E2E_GH;
const lock = `${file}.lock`;
const args = process.argv.slice(2);

// The app runs several of these at once (the PR watch reads while a merge writes). Each one reads the file,
// changes it and writes it back, so without a lock a slow reader would write an older copy over a merge.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const deadline = Date.now() + 10_000;
for (;;) {
  try { fs.mkdirSync(lock); break; } catch {
    if (Date.now() > deadline) { process.stderr.write('gh stub: the lock was never free'); process.exit(1); }
    pause(15);
  }
}

let code = 0;
let printed = '';
try {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const db = { prs: {}, issues: [], calls: [], ...read() };
  db.calls.push(args.join(' '));
  const out = (v) => { printed = typeof v === 'string' ? v : JSON.stringify(v); };
  const pr = (url) => (db.prs[url] ??= { state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', checks: [] });

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
  } else if (args[0] === '--version') {
    out('gh version 0.0.0 (stand-in)');
  } else if (args[0] === 'auth' && args[1] === 'status') {
    const host = args[args.indexOf('--hostname') + 1];
    if ((db.signedOut ?? []).includes(host)) { process.stderr.write(`You are not logged into any GitHub hosts on ${host}.`); code = 1; }
  } else if (args[0] === 'api' && args[1] === 'graphql') {
    // The PR monitor's state query: `rN: repository(owner: "o", name: "r") { pN: pullRequest(number: N) {...} ... }`.
    const query = (args.find((a) => a.startsWith('query=')) ?? '').slice(6);
    const host = process.env.GH_HOST || 'github.com';
    const data = {};
    for (const part of query.split(/(?=r\d+: repository\()/).slice(1)) {
      const [, alias, owner, name] = part.match(/^(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/);
      data[alias] = {};
      for (const [, num] of part.matchAll(/p(\d+): pullRequest\(number: \d+\)/g)) {
        const p = pr(`https://${host}/${owner}/${name}/pull/${num}`);
        data[alias][`p${num}`] = { state: p.state, headRefName: p.head ?? 'feature' };
      }
    }
    out({ data });
  } else if (args[0] === 'api') {
    out([]);
  } else {
    process.stderr.write(`gh stub: not supported: ${args.join(' ')}`);
    code = 1;
  }
  // Written whole to a new file and renamed, so a reader never sees half of it.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(db, null, 1));
  fs.renameSync(`${file}.tmp`, file);
} finally {
  fs.rmdirSync(lock);
}
process.stdout.write(printed);
process.exit(code);
