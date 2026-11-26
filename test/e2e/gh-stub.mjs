// Stands in for the `gh` CLI in end-to-end tests (the app runs it when OMA_GH_STUB points here).
// Pull requests live in the JSON file named by OMA_E2E_GH: a PR the app asks about is open, mergeable and
// approved unless the file says otherwise, and `pr merge` marks it merged. Every call is recorded for the test.
// A merge moves the base: the repository's other open PRs are `behind` until `update-branch` takes the base in, which
// gives the PR a new head and applies its `afterUpdate` fields (the checks of the new head, say). A PR with
// `conflictOnUpdate` refuses the update as GitHub does for a conflict.
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
  // A head commit of its own for each PR, so one can be found by it; `update-branch` gives it a new one.
  const head = (url, p) => p.headOid ?? `${'a'.repeat(40)}${url.match(/(\d+)$/)?.[1] ?? ''}`.slice(-40);
  const host = process.env.GH_HOST || 'github.com';

  if (args[0] === 'pr' && args[1] === 'view') {
    const p = pr(args[2]);
    const fields = args[args.indexOf('--json') + 1] ?? '';
    if (fields.includes('comments')) out({ comments: [], reviews: [] });
    else out({ state: p.state, headRefName: p.head ?? 'feature', headRefOid: head(args[2], p), baseRefName: 'main', baseRefOid: 'b'.repeat(40), mergeable: p.mergeable, reviewDecision: p.reviewDecision, statusCheckRollup: p.checks });
  } else if (args[0] === 'pr' && args[1] === 'merge') {
    const p = pr(args[2]);
    const at = args.indexOf('--match-head-commit');
    if (p.failMerge) { process.stderr.write('Pull request is not mergeable'); code = 1; }
    else if (at > 0 && args[at + 1] !== head(args[2], p)) { process.stderr.write('Head branch was modified. Review and try the merge again.'); code = 1; }
    else {
      p.state = 'MERGED';
      const repo = args[2].replace(/\/pull\/\d+$/, '/pull/');
      for (const [url, other] of Object.entries(db.prs)) if (url !== args[2] && url.startsWith(repo) && other.state === 'OPEN') other.behind = true;
    }
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
  } else if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/update-branch$/.test(args.find((a) => a.startsWith('repos/')) ?? '')) {
    // The merge queue takes the base into the PR's branch.
    const [, owner, name, num] = args.find((a) => a.startsWith('repos/')).match(/^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\//);
    const p = pr(`https://${host}/${owner}/${name}/pull/${num}`);
    if (p.conflictOnUpdate) {
      p.mergeable = 'CONFLICTING';
      process.stderr.write('gh: merge conflict between base and head (HTTP 422)');
      code = 1;
    } else {
      p.rev = (p.rev ?? 0) + 1;
      p.headOid = `${'c'.repeat(40)}${num}${p.rev}`.slice(-40);
      p.behind = false;
      Object.assign(p, p.afterUpdate ?? {});
      delete p.afterUpdate;
      out({ message: 'Updating pull request branch.' });
    }
  } else if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/compare\//.test(args[1] ?? '')) {
    // The merge queue asks how far a PR's head is behind its base (`--jq .behind_by`).
    const [, owner, name, sha] = args[1].match(/^repos\/([^/]+)\/([^/]+)\/compare\/.+\.\.\.(\w+)$/);
    const at = `https://${host}/${owner}/${name}/pull/`;
    const found = Object.entries(db.prs).find(([url, p]) => url.startsWith(at) && head(url, p) === sha);
    out(String(found?.[1].behind ? 1 : 0));
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
