import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readShell, shellOf, type Shell } from '../src/shared/shellWords';

const raw = String.raw;
/** Each command as `prog arg arg`, in the order found. */
const cmds = (line: string, shell: Shell) => readShell(line, shell).cmds.map((c) => [c.prog, ...c.args].join(' '));
const single = (line: string, shell: Shell) => { const c = readShell(line, shell).single; return c && [c.name, ...c.args].join(' '); };

test('shell words: only the shell tools are shells', () => {
  assert.deepEqual([shellOf('Bash'), shellOf('PowerShell'), shellOf('Edit'), shellOf('mcp__x__bash'), shellOf('constructor')], ['bash', 'powershell', null, null, null]);
});

test('shell words: bash quotes, escapes and separators', () => {
  assert.deepEqual(cmds(`git commit -m "a; b && c" --author='x | y'`, 'bash'), ['git commit -m a; b && c --author=x | y']);
  assert.deepEqual(cmds(raw`echo a\ b "c \"d\"" 'e'"f"`, 'bash'), ['echo a b c "d" ef']);
  assert.deepEqual(cmds('a; b && c || d | e & f\ng', 'bash'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(cmds('npm test 2>&1 >out.txt | tail -5', 'bash'), ['npm test', 'tail -5']);
  assert.deepEqual(cmds('echo $HOME ${X:-y} $1', 'bash'), ['echo $HOME ${X:-y} $1']);
  assert.deepEqual(cmds('echo {a,b} x{1,2}', 'bash'), ['echo {a,b} x{1,2}']);
  assert.deepEqual(cmds('ls # git push --force\npwd', 'bash'), ['ls', 'pwd']);
  assert.deepEqual(cmds("echo $'a\\tb'", 'bash'), ['echo a\tb']);
});

test('shell words: bash substitutions, groups and here-documents', () => {
  assert.deepEqual(cmds('echo "$(date +%s)" `whoami`', 'bash'), ['date +%s', 'whoami', 'echo $() $()']);
  assert.deepEqual(cmds('(cd a && make) || { echo no; exit 1; }', 'bash'), ['cd a', 'make', 'echo no', 'exit 1']);
  assert.deepEqual(cmds('diff <(sort a) <(sort b)', 'bash'), ['sort a', 'sort b', 'diff']);
  // The text of a here-document is not commands, unless a shell reads it.
  assert.deepEqual(cmds("cat > f <<'EOF'\nrm -rf /\nEOF\nls", 'bash'), ['cat', 'ls']);
  assert.deepEqual(cmds('cat <<-EOF | wc -l\n\tx\n\tEOF\nls', 'bash'), ['cat', 'wc -l', 'ls']);
  assert.deepEqual(cmds('sh <<EOF\nmake clean\nEOF', 'bash'), ['sh', 'make clean']);
});

test('shell words: PowerShell quotes, escapes, blocks and here-strings', () => {
  assert.deepEqual(cmds(`Write-Host 'it''s' "say ""hi""" "a\`"b"`, 'powershell'), ["write-host it's say \"hi\" a\"b"]);
  assert.deepEqual(cmds(raw`Get-Content C:\work\a.txt`, 'powershell'), [raw`get-content C:\work\a.txt`]);
  assert.deepEqual(cmds('a; b | c\nd', 'powershell'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(cmds('Get-ChildItem `\n  -Recurse', 'powershell'), ['get-childitem -Recurse']);
  // The blocks' commands are found; what is left of the statement around them is no program anyone runs.
  assert.deepEqual(cmds('if ($x) { npm test } else { npm run lint }', 'powershell'), ['$x', 'npm test', 'npm run lint', '$x else']);
  assert.deepEqual(cmds('npm test *> log.txt 2>&1', 'powershell'), ['npm test']);
  assert.deepEqual(cmds('ls <# git push --force #> # gh pr merge\npwd', 'powershell'), ['ls', 'pwd']);
  assert.deepEqual(cmds("Set-Content x @'\nrm -rf /\n'@\nls", 'powershell'), ['set-content x rm -rf /', 'ls']);
  assert.deepEqual(cmds('Write-Host @"\nit is $(Get-Date)\n"@', 'powershell'), ['get-date', 'write-host it is $(Get-Date)']);
});

test('shell words: wrappers are taken off and what they run is read', () => {
  assert.deepEqual(cmds('X=1 Y=2 env Z=3 nice -n 5 timeout -k 5 30 npm test', 'bash'), ['npm test']);
  assert.deepEqual(cmds('sudo -u me -- make install', 'bash'), ['make install']);
  assert.deepEqual(cmds('bash -lc "cd a && make"', 'bash'), ['bash -lc cd a && make', 'cd a', 'make']);
  assert.deepEqual(cmds('bash build.sh', 'bash'), ['bash build.sh']);
  assert.deepEqual(cmds(raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "npm test; npm run lint"`, 'bash').slice(1), ['npm test', 'npm run lint']);
  assert.deepEqual(cmds('& npm.cmd test', 'powershell'), ['npm test']);
  assert.deepEqual(cmds(raw`. .\env.ps1`, 'powershell'), ['env.ps1']);
  assert.deepEqual(cmds("Start-Process -FilePath npm -ArgumentList 'run', 'build' -Wait -WorkingDirectory app", 'powershell'), ['npm run build']);
  assert.deepEqual(cmds('cmd /c "dir && cd"', 'powershell').slice(1), ['dir', 'cd']);
  assert.deepEqual(cmds('wsl -d Ubuntu -- make test', 'powershell').slice(1), ['make test']);
});

test('shell words: git is read without its global options', () => {
  assert.deepEqual(cmds('git -C repo -c user.name=x --no-pager --git-dir=.git --work-tree . log -1', 'bash'), ['git log -1']);
  assert.deepEqual(cmds('git --version', 'bash'), ['git']);
  assert.deepEqual(cmds(raw`& "C:\Program Files\Git\cmd\git.exe" -C repo status`, 'powershell'), ['git status']);
});

test('shell words: a line is one command only when nothing else can run in it', () => {
  assert.equal(single('npm install left-pad', 'bash'), 'npm install left-pad');
  assert.equal(single('CI=1 ./scripts/build.sh --fast', 'bash'), 'build.sh --fast');
  assert.equal(single('git commit -m "one; two | three"', 'bash'), 'git commit -m one; two | three');
  assert.equal(single('timeout 30 npm test', 'bash'), 'npm test');
  assert.equal(single('& git.exe -C repo status', 'powershell'), 'git status');
  assert.equal(single('$s = git status', 'powershell'), 'git status');
  for (const line of ['a; b', 'a && b', 'a | b', 'a > f', 'a 2>&1', 'echo $(b)', 'echo `b`', 'a &', 'a\nb', '(a)', 'bash -c a', 'sudo a', 'xargs a', 'eval a', 'cmd /c a', ''])
    assert.equal(single(line, 'bash'), null, line);
  for (const line of ['a; b', 'a | b', 'a > f', 'a "$(b)"', 'a (b)', 'a { b }', '& { a }', 'iex a', 'Start-Process a', 'powershell -Command a', 'cmd /c a', 'a `\n; b'])
    assert.equal(single(line, 'powershell'), null, line);
  assert.equal(single('git -c alias.status=!sh status', 'bash'), null);
});

test('shell words: a line nested past what is read says so, and one within it does not', () => {
  const unread = (line: string, shell: Shell) => readShell(line, shell).unread;
  assert.equal(unread('echo "$(basename "$(dirname "$(pwd)")")"', 'bash'), false);
  assert.equal(unread(`echo ${'$('.repeat(30)}date${')'.repeat(30)}`, 'bash'), false);
  assert.equal(unread(`echo ${'$('.repeat(40)}date${')'.repeat(40)}`, 'bash'), true);
  assert.equal(unread('(' .repeat(50000), 'bash'), true);
  assert.equal(unread('{ '.repeat(50000), 'powershell'), true);
  assert.equal(unread(`${'nohup '.repeat(12)}make`, 'bash'), false);
  assert.equal(unread(`${'nohup '.repeat(30)}make`, 'bash'), true);
  assert.deepEqual(cmds(`${'nohup '.repeat(12)}make`, 'bash'), ['make']);
  // Nothing after the last wrapper is nothing left unread.
  assert.equal(unread('bash -c ""', 'bash'), false);
  assert.equal(unread('', 'bash'), false);
});
