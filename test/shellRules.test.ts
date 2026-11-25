import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alwaysAskRule } from '../src/main/agents/permissions';
import { ASK_RULES, type AskRule } from '../src/shared/grants';

// The always-ask rules as a table: the tool, the command, and the rule it must ask under (null: it must not ask).
// A way round a rule that is found later goes here as a row.

const raw = String.raw;
/** What `powershell -EncodedCommand` takes: base64 of UTF-16LE. */
const enc = (s: string) => Buffer.from(s, 'utf16le').toString('base64');

type Row = [tool: string, command: string, rule: AskRule | null];

const B = 'Bash', P = 'PowerShell';

const ASKS: Row[] = [
  // --- The four gaps this table was started for ---
  // 1. The rules looked at the Bash tool only.
  [P, 'git push --force origin feature', 'ask.forcePush'],
  [P, 'gh pr merge 12 --squash', 'ask.merge'],
  // 2. ("Allow for this task" covering every PowerShell command: test/grants.test.ts.)
  // 3. git's global options hid the subcommand.
  [B, 'git -C repo push --force', 'ask.forcePush'],
  [B, 'git -c a=b push -f', 'ask.forcePush'],
  // 4. The GitHub API does what `gh pr merge` and `gh repo delete` do.
  [B, 'gh api -X PUT repos/o/r/pulls/5/merge', 'ask.merge'],
  [B, 'gh api -X DELETE repos/o/r', 'ask.repoDelete'],
  [B, 'gh api -X DELETE repos/o/r/git/refs/heads/feature', 'ask.apiDelete'],
  [B, 'gh api -X PATCH repos/o/r/git/refs/heads/feature -f sha=abc -F force=true', 'ask.forcePush'],

  // --- Force push, Bash ---
  [B, 'git push --force origin feature', 'ask.forcePush'],
  [B, 'git push origin feature --force', 'ask.forcePush'],
  [B, 'git push --force-with-lease origin feature', 'ask.forcePush'],
  [B, 'git push --force-with-lease=feature:abc123 origin feature', 'ask.forcePush'],
  [B, 'git push -fu origin feature', 'ask.forcePush'],
  [B, 'git push origin +feature', 'ask.forcePush'],
  [B, 'git push --mirror backup', 'ask.forcePush'],
  [B, 'git --git-dir=.git --work-tree=. push origin +feature', 'ask.forcePush'],
  [B, 'git --git-dir .git --no-pager push -f', 'ask.forcePush'],
  [B, '/usr/bin/git push --force', 'ask.forcePush'],
  [B, '"git" push "--force"', 'ask.forcePush'],
  [B, raw`g\it push --for\ce`, 'ask.forcePush'],
  [B, raw`"C:\Program Files\Git\cmd\git.exe" push --force`, 'ask.forcePush'],
  [B, 'GIT_TRACE=1 git push --force', 'ask.forcePush'],
  [B, 'env GIT_TRACE=1 git push --force', 'ask.forcePush'],
  [B, 'sudo -u deploy git push -f', 'ask.forcePush'],
  [B, 'timeout 60 git push --force', 'ask.forcePush'],
  [B, 'nohup git push --force &', 'ask.forcePush'],
  [B, 'command git push -f', 'ask.forcePush'],
  [B, 'xargs git push --force', 'ask.forcePush'],
  [B, 'cd repo && git push --force', 'ask.forcePush'],
  [B, '(cd repo; git push -f)', 'ask.forcePush'],
  [B, '{ git push -f; }', 'ask.forcePush'],
  [B, 'out=$(git push --force 2>&1)', 'ask.forcePush'],
  [B, 'echo "pushed: $(git push --force)"', 'ask.forcePush'],
  [B, 'echo `git push --force`', 'ask.forcePush'],
  [B, 'if git fetch; then git push -f; fi', 'ask.forcePush'],
  [B, 'git fetch\ngit push --force', 'ask.forcePush'],
  [B, 'git fetch origin \\\n  && git push \\\n  --force', 'ask.forcePush'],
  [B, 'bash -c "git push --force origin x"', 'ask.forcePush'],
  [B, "sh -lc 'git push -f'", 'ask.forcePush'],
  [B, 'eval "git push -f"', 'ask.forcePush'],
  [B, 'echo "git push --force" | bash', 'ask.forcePush'],
  [B, "bash <<'EOF'\ngit push --force\nEOF", 'ask.forcePush'],
  [B, 'bash <<< "git push --force"', 'ask.forcePush'],
  [B, 'cmd //c "git push --force"', 'ask.forcePush'],
  [B, 'powershell -NoProfile -Command "git push --force"', 'ask.forcePush'],
  [B, `pwsh -EncodedCommand ${enc('git push --force')}`, 'ask.forcePush'],
  [B, 'gh api -X PATCH repos/o/r/git/refs/heads/feature --input body.json', 'ask.forcePush'],
  [B, `gh api graphql -f query='mutation { updateRef(input: {refId: "a", oid: "b", force: true}) { clientMutationId } }'`, 'ask.forcePush'],

  // --- Force push, PowerShell ---
  [P, 'git.exe push -f', 'ask.forcePush'],
  [P, 'git -C repo push --force', 'ask.forcePush'],
  [P, '& git push --force', 'ask.forcePush'],
  [P, raw`& "C:\Program Files\Git\cmd\git.exe" push --force origin x`, 'ask.forcePush'],
  [P, "& 'git' 'push' '--force'", 'ask.forcePush'],
  [P, 'git push --fo`rce', 'ask.forcePush'],
  [P, 'git --% push --force', 'ask.forcePush'],
  [P, '$out = git push --force 2>&1', 'ask.forcePush'],
  [P, '$out=git push -f', 'ask.forcePush'],
  [P, 'iex "git push --force"', 'ask.forcePush'],
  [P, "Invoke-Expression -Command 'git push --force'", 'ask.forcePush'],
  [P, "'git push --force' | iex", 'ask.forcePush'],
  [P, "Start-Process git -ArgumentList 'push','--force'", 'ask.forcePush'],
  [P, "Start-Process git -ArgumentList 'push', '-f' -NoNewWindow -Wait", 'ask.forcePush'],
  [P, "saps -FilePath git -ArgumentList @('push', '-f', 'origin', 'x')", 'ask.forcePush'],
  [P, "start git 'push --force'", 'ask.forcePush'],
  [P, 'cmd /c "git push --force"', 'ask.forcePush'],
  [P, 'cmd.exe /d /c git push --force', 'ask.forcePush'],
  [P, 'cmd /c start "" git push --force', 'ask.forcePush'],
  [P, 'powershell -NoProfile -Command "git push --force"', 'ask.forcePush'],
  [P, 'powershell.exe -nop -c git push --force', 'ask.forcePush'],
  [P, 'pwsh -c { git push --force }', 'ask.forcePush'],
  [P, `powershell -enc ${enc('git push --force')}`, 'ask.forcePush'],
  [P, "bash -c 'git push --force'", 'ask.forcePush'],
  [P, 'wsl git push --force', 'ask.forcePush'],
  [P, 'git fetch; git push --force', 'ask.forcePush'],
  [P, 'git fetch && git push --force', 'ask.forcePush'],
  [P, 'if ($ok) { git push --force }', 'ask.forcePush'],
  [P, '& { git push -f }', 'ask.forcePush'],
  [P, 'Invoke-Command -ScriptBlock { git push -f }', 'ask.forcePush'],
  [P, 'Write-Host "pushed: $(git push --force)"', 'ask.forcePush'],
  [P, 'git push `\n  --force', 'ask.forcePush'],

  // --- A protected branch ---
  [B, 'git push origin main', 'ask.pushMain'],
  [B, 'git push -u origin HEAD:main', 'ask.pushMain'],
  [B, 'git push origin feature:refs/heads/release/1.2', 'ask.pushMain'],
  [B, 'git -C repo push origin :main', 'ask.pushMain'],
  [B, 'git push origin --delete master', 'ask.pushMain'],
  [B, 'git push -o ci.skip origin develop', 'ask.pushMain'],
  [B, 'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc', 'ask.pushMain'],
  [P, 'git push origin main', 'ask.pushMain'],
  [P, 'cmd /c git push origin main', 'ask.pushMain'],

  // --- Merging a PR ---
  [B, 'gh pr merge 12 --squash', 'ask.merge'],
  [B, 'gh pr merge', 'ask.merge'],
  [B, 'gh -R o/r pr merge 5', 'ask.merge'],
  [B, 'gh pr --repo o/r merge 5 --auto', 'ask.merge'],
  [B, 'gh.exe pr merge 5', 'ask.merge'],
  [B, 'GH_TOKEN=x gh pr merge 5', 'ask.merge'],
  [B, 'gh pr checks 5 --watch && gh pr merge 5 --squash', 'ask.merge'],
  [B, "sh -c 'gh pr merge 3'", 'ask.merge'],
  [B, 'gh api --method=PUT /repos/o/r/pulls/5/merge', 'ask.merge'],
  [B, 'gh api -XPUT repos/o/r/pulls/5/merge -f merge_method=squash', 'ask.merge'],
  [B, 'gh api --method put https://api.github.com/repos/o/r/pulls/5/merge', 'ask.merge'],
  [B, 'gh api repos/o/r/merges -f base=main -f head=feature', 'ask.merge'],
  [B, `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`, 'ask.merge'],
  [B, `gh api graphql -F id=x -f query='mutation($id: ID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }'`, 'ask.merge'],
  [P, '$r = gh pr merge 5 --squash', 'ask.merge'],
  [P, 'gh pr merge 5 --squash | Out-Null', 'ask.merge'],
  [P, "Start-Process -FilePath gh -ArgumentList 'pr merge 5' -Wait", 'ask.merge'],
  [P, "Invoke-Expression 'gh pr merge 5'", 'ask.merge'],
  [P, '1..3 | ForEach-Object { gh pr merge $_ }', 'ask.merge'],
  [P, 'gh api -X PUT repos/o/r/pulls/5/merge', 'ask.merge'],
  [P, 'cmd /c gh pr merge 5', 'ask.merge'],

  // --- Deleting on GitHub ---
  [B, 'gh repo delete o/r --yes', 'ask.repoDelete'],
  [B, 'gh release delete v1.0', 'ask.repoDelete'],
  [B, 'gh api --method DELETE repos/o/r/releases/12', 'ask.repoDelete'],
  [B, 'gh api -X delete /repos/o/r/', 'ask.repoDelete'],
  [P, 'gh repo delete o/r --yes', 'ask.repoDelete'],
  [P, 'gh api -X DELETE repos/o/r', 'ask.repoDelete'],
  [B, 'gh api --method DELETE repos/o/r/issues/comments/9', 'ask.apiDelete'],
  [B, 'gh api -XDELETE repos/o/r/actions/runs/77', 'ask.apiDelete'],
  [B, `gh api graphql -f query='mutation { deleteRef(input: {refId: "x"}) { clientMutationId } }'`, 'ask.apiDelete'],
  [P, 'gh api -X DELETE repos/o/r/git/refs/heads/feature', 'ask.apiDelete'],

  // --- SQL, wherever it stands ---
  [B, 'psql -c "DROP TABLE users"', 'ask.drop'],
  [B, 'sqlite3 app.db "delete from sessions"', 'ask.delete'],
  [B, "psql <<'EOF'\nTRUNCATE TABLE users;\nEOF", 'ask.drop'],
  [B, 'psql -h db.production.internal -c "select 1"', 'ask.prodDb'],
  [P, 'Invoke-Sqlcmd -Query "DROP TABLE users"', 'ask.drop'],
  [P, 'Invoke-Sqlcmd -Query "DELETE FROM sessions"', 'ask.delete'],
  [P, 'sqlcmd -S prod -Q "select 1"', 'ask.prodDb'],

  // --- Clusters, infrastructure, deployments ---
  [B, 'kubectl apply -f deploy.yaml', 'ask.k8s'],
  [B, 'kubectl -n web delete pod api-1', 'ask.k8s'],
  [B, 'kubectl --context=staging rollout restart deploy/api', 'ask.k8s'],
  [P, 'kubectl delete ns web', 'ask.k8s'],
  [B, 'terraform destroy', 'ask.infra'],
  [B, 'terraform -chdir=infra apply -auto-approve', 'ask.infra'],
  [P, 'tofu apply', 'ask.infra'],
  [B, 'helm upgrade api ./chart', 'ask.deploy'],
  [B, 'helm -n web uninstall api', 'ask.deploy'],
  [P, 'helm install api ./chart', 'ask.deploy'],

  // --- The root or the home folder ---
  [B, 'rm -rf /', 'ask.rmHome'],
  [B, 'rm -rf ~', 'ask.rmHome'],
  [B, 'rm -r -f ~/', 'ask.rmHome'],
  [B, 'rm -rf -- "$HOME"', 'ask.rmHome'],
  [B, 'rm --recursive --force /*', 'ask.rmHome'],
  [B, 'sudo rm -rf /', 'ask.rmHome'],
  [B, raw`rm -rf C:\ `, 'ask.rmHome'],
  [B, 'rm -rf build ~', 'ask.rmHome'],
  [P, raw`Remove-Item -Recurse -Force C:\ `, 'ask.rmHome'],
  [P, raw`Remove-Item -Path C:\* -Recurse`, 'ask.rmHome'],
  [P, 'rm -r $HOME', 'ask.rmHome'],
  [P, 'ri -Recurse -Force $env:USERPROFILE', 'ask.rmHome'],
  [P, 'rmdir -Recurse ~', 'ask.rmHome'],
  [P, raw`cmd /c rd /s /q C:\ `, 'ask.rmHome'],
  [P, raw`cmd /c "del /s /q %USERPROFILE%\*"`, 'ask.rmHome'],
];

const DOES_NOT_ASK: Row[] = [
  // Ordinary git and gh.
  [B, 'git status', null],
  [B, 'git push', null],
  [B, 'git push origin feature', null],
  [B, 'git push -u origin feature', null],
  [B, 'git -C repo push origin feature', null],
  [B, 'git push --force-if-includes origin feature', null],
  [B, 'git push -o ci.skip origin feature', null],
  [B, 'git push origin main-fix', null],
  [B, 'git push origin feature/main', null],
  [B, 'git push origin main:feature', null],
  [B, 'git fetch --force origin', null],
  [B, 'git checkout -f main', null],
  [B, 'git config alias.pf "push --force"', null],
  [B, 'gh pr view 5', null],
  [B, 'gh pr create --title "Merge later" --body "gh pr merge 5 once green"', null],
  [B, 'gh pr list --search merge', null],
  [B, 'gh release view v1.0', null],
  [B, 'gh repo view o/r', null],
  [B, 'gh api repos/o/r/pulls/5/merge', null],
  [B, 'gh api repos/o/r/pulls/5', null],
  [B, 'gh api repos/o/r/git/refs/heads/main', null],
  [B, "gh api -X POST repos/o/r/issues/5/comments -f body='Should we delete the repo or merge?'", null],
  [B, 'gh api -X POST repos/o/r/git/refs -f ref=refs/heads/feature -f sha=abc', null],
  [B, `gh api graphql -f query='query { repository(owner: "o", name: "r") { deleteBranchOnMerge mergeCommitAllowed } }'`, null],
  // The words of a rule as text, not as a command.
  [B, 'echo "git push --force"', null],
  [B, 'grep -rn "git push --force" docs', null],
  [B, 'git commit -m "Ask before git push --force and gh pr merge"', null],
  [B, 'git commit -m "$(cat <<\'EOF\'\nAsk before a force push\n\ngit push --force now asks\ngh pr merge 5 too\nEOF\n)"', null],
  [B, 'git log --grep="gh pr merge"', null],
  [B, 'git push origin feature # not --force', null],
  [B, "cat > notes.md <<'EOF'\nrm -rf /\ngit push --force\nEOF", null],
  // Flags of other programs, and folders that are not the root or home.
  [B, 'kubectl get pods -n prod', null],
  [B, 'kubectl -n delete get pods', null],
  [B, 'terraform plan', null],
  [B, 'terraform -chdir=apply plan', null],
  [B, 'helm list -n web', null],
  [B, 'rm -rf build', null],
  [B, 'rm -rf ./', null],
  [B, 'rm -rf *', null],
  [B, 'rm -rf ~/project/dist', null],
  [B, 'rm -rf /tmp/x', null],
  [B, 'rm -f /', null],
  [B, 'ls /', null],
  [B, 'npm test', null],
  [B, 'psql -c "DELETE FROM t WHERE id = 1"', null],
  [B, '', null],
  // PowerShell.
  [P, 'git status', null],
  [P, 'git push origin feature', null],
  [P, '$branch = git rev-parse --abbrev-ref HEAD', null],
  [P, 'Write-Host "git push --force"', null],
  [P, "Get-Content notes.md | Select-String 'gh pr merge'", null],
  [P, "git commit -m @'\nAsk before git push --force\n\ngit push --force now asks, and so doesn't gh pr view\n'@", null],
  [P, 'gh pr view 5', null],
  [P, 'gh api repos/o/r/pulls', null],
  [P, '$force = $true', null],
  [P, raw`Remove-Item -Recurse -Force .\dist`, null],
  [P, raw`Remove-Item -Recurse C:\work\tmp`, null],
  [P, raw`Remove-Item C:\ `, null],
  [P, 'Get-ChildItem ~ -Recurse', null],
  [P, 'Start-Process notepad', null],
  [P, 'cmd /c dir', null],
  [P, 'iex "git status"', null],
  // Not a shell tool: the rules say nothing.
  ['Edit', 'git push --force', null],
  ['mcp__ci__run', 'gh pr merge 5', null],
];

test('always-ask rules: every row that must ask does, under its rule', () => {
  for (const [tool, command, rule] of ASKS) assert.equal(alwaysAskRule(tool, { command }), rule, `${tool}: ${command}`);
});

test('always-ask rules: ordinary commands, and the words of a rule as text, do not ask', () => {
  for (const [tool, command] of DOES_NOT_ASK) assert.equal(alwaysAskRule(tool, { command }), null, `${tool}: ${command}`);
});

test('always-ask rules: every rule has a row in each shell it can be met in, and a rule switched off is passed over', () => {
  for (const rule of ASK_RULES) assert.ok(ASKS.some((r) => r[2] === rule), `no row for ${rule}`);
  for (const tool of [B, P]) assert.ok(ASK_RULES.every((rule) => ASKS.some((r) => r[0] === tool && r[2] === rule)), `a rule has no ${tool} row`);
  assert.equal(alwaysAskRule(P, { command: 'git push --force origin main' }, ['ask.forcePush']), 'ask.pushMain');
  assert.equal(alwaysAskRule(P, { command: 'git push --force origin main' }, ['ask.forcePush', 'ask.pushMain']), null);
  // The API's DELETE of a repository is the repository rule's alone: switching that off does not hand it to the other.
  assert.equal(alwaysAskRule(B, { command: 'gh api -X DELETE repos/o/r' }, ['ask.repoDelete']), null);
});

test('always-ask rules: a line that cannot be read does not throw', () => {
  for (const command of ['"unclosed', "'unclosed", '$(', '`', ')))', '}}}', '{{{', '((((', 'bash -c', 'powershell -enc !!!', 'git', 'a <<EOF', "@'\nx", 'constructor x', '__proto__', 'toString -a']) {
    for (const tool of [B, P]) assert.doesNotThrow(() => alwaysAskRule(tool, { command }), `${tool}: ${command}`);
  }
  assert.equal(alwaysAskRule(B, {}), null);
  assert.equal(alwaysAskRule(P, null), null);
  // Wrappers inside wrappers stop somewhere.
  let deep = 'git push --force';
  for (let i = 0; i < 4; i++) deep = `bash -c ${JSON.stringify(deep)}`;
  assert.equal(alwaysAskRule(B, { command: deep }), 'ask.forcePush');
  for (let i = 0; i < 10; i++) deep = `bash -c ${JSON.stringify(deep)}`;
  assert.doesNotThrow(() => alwaysAskRule(B, { command: deep }));
});
