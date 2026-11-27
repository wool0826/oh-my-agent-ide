import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REMOTE_PREFS_DEFAULT, SendQueue, cleanPrefs, newsEvent, newsGroup, newsKey, newsRef, newsText, plainText, type Outgoing, type RemoteNews,
} from '../src/shared/remoteNotice';

const say = ((k: string, v?: Record<string, string | number>) => `${k}${v ? JSON.stringify(v) : ''}`) as never;

const question: RemoteNews = { type: 'decision', id: 'd1', source: 'question', who: 'W-03', title: 'Which name?', detail: 'Pick one:\n```ts\nconst secret = 1;\n```\nFoo or bar', options: ['foo', 'bar'] };
const result: RemoteNews = { type: 'result', task: 'T-1', who: 'W-03', title: 'Add login', summary: 'Added the form.\n```\ncode\n```', ok: true, code: true, prUrl: 'https://github.com/o/r/pull/7', links: ['https://claude.ai/artifact/x'] };

test('remoteNotice: prefs default to every kind on and summaries; bad values fall back', () => {
  assert.deepEqual(cleanPrefs(null), REMOTE_PREFS_DEFAULT);
  assert.deepEqual(cleanPrefs({ events: { prs: false, errors: 'no' }, level: 'title', requests: 'yes', buttons: 1 }), { events: { decisions: true, results: true, prs: false, errors: true, replies: true }, level: 'title', requests: true, buttons: true });
  assert.equal(cleanPrefs({ requests: false }).requests, false);
  assert.equal(cleanPrefs({ buttons: false }).buttons, false);
  assert.equal(cleanPrefs({ level: 'all' }).level, 'summary');
});

test('remoteNotice: code blocks and indented code never leave, and long text is cut', () => {
  assert.equal(plainText('a\n```\nsecret\n```\nb'), 'a\n…\nb');
  assert.equal(plainText('a\n    indented secret\nb'), 'a\nb');
  assert.equal(plainText('x'.repeat(50), 10), `${'x'.repeat(9)}…`);
  assert.equal(plainText('a\n```\nnever closed'), 'a\n…');
});

test('remoteNotice: a permission says only who waits; a plan adds its title; a question its text and options', () => {
  assert.equal(newsText(say, { ...question, source: 'permission', title: 'Bash: rm -rf /' } as RemoteNews, 'summary'), 'noti.workerWaits{"id":"W-03"}');
  assert.equal(newsText(say, { ...question, source: 'plan', title: 'Plan for T-1' } as RemoteNews, 'summary'), 'noti.workerWaits{"id":"W-03"}\n\nPlan for T-1');
  const q = newsText(say, question, 'summary');
  assert.match(q, /Which name\?/);
  assert.match(q, /Foo or bar/);
  assert.match(q, /· foo\n· bar/);
  assert.doesNotMatch(q, /secret/);
  assert.equal(newsText(say, question, 'title'), 'noti.workerWaits{"id":"W-03"}\n\nWhich name?');
  assert.match(newsText(say, { ...question, who: null } as RemoteNews, 'title'), /^noti\.decision/);
});

test('remoteNotice: a result has who and how, the title, and at summary level its summary and links without code', () => {
  const s = newsText(say, result, 'summary');
  assert.match(s, /^W-03 res\.doneLabel · noti\.pr\{"n":"7"\}\n\nAdd login\n\nAdded the form\./);
  assert.match(s, /https:\/\/github\.com\/o\/r\/pull\/7\nhttps:\/\/claude\.ai\/artifact\/x$/);
  assert.doesNotMatch(s, /code\n/);
  assert.equal(newsText(say, result, 'title'), 'W-03 res.doneLabel · noti.pr{"n":"7"}\n\nAdd login');
  assert.match(newsText(say, { ...result, ok: false } as RemoteNews, 'title'), /noti\.failed/);
  assert.doesNotMatch(newsText(say, { ...result, ok: false, summary: 'npm ERR! cat .env' } as RemoteNews, 'summary'), /npm ERR/);
});

test('remoteNotice: a PR and an error name what happened; the PR link only at summary level', () => {
  const pr: RemoteNews = { type: 'pr', task: 'T-1', title: 'Add login', merged: true, prUrl: 'https://github.com/o/r/pull/7' };
  assert.equal(newsText(say, pr, 'summary'), 'noti.merged\n\nAdd login\n\nhttps://github.com/o/r/pull/7');
  assert.equal(newsText(say, pr, 'title'), 'noti.merged\n\nAdd login');
  assert.equal(newsText(say, { type: 'error', text: 'Boom\nstack line' }, 'title'), 'tg.n.error\n\nBoom');
  assert.equal(newsText(say, { type: 'error', text: 'Boom\n$ cat secrets.txt\nhunter2' }, 'summary'), 'tg.n.error\n\nBoom');
});

test('remoteNotice: kinds, keys and burst groups', () => {
  assert.equal(newsEvent(question), 'decisions');
  assert.equal(newsEvent(result), 'results');
  assert.equal(newsEvent({ type: 'error', text: 'x' }), 'errors');
  assert.equal(newsKey(question), 'decision:d1');
  assert.equal(newsKey(result), newsKey({ ...result }));
  assert.notEqual(newsKey(result), newsKey({ ...result, summary: 'other' } as RemoteNews));
  assert.equal(newsGroup(result), 'info:W-03');
  assert.equal(newsGroup({ ...result, ok: false } as RemoteNews), 'info:W-03:failed');
  assert.equal(newsGroup({ ...question, who: null } as RemoteNews), 'decision:dispatcher');
});

const out = (key: string, group = key, o: Partial<Outgoing> = {}): Outgoing => ({ key, group, text: key, silent: false, urgent: false, ...o });

test('remoteNotice: the queue drops a repeat within its window and takes it again after', () => {
  const q = new SendQueue(50, 1000);
  assert.equal(q.add(out('a'), 0), true);
  q.next();
  assert.equal(q.add(out('a'), 500), false);
  assert.equal(q.add(out('a'), 1500), true);
});

test('remoteNotice: news of a group that still waits joins its message, silent only when both are', () => {
  const q = new SendQueue();
  q.add(out('a', 'g', { silent: true }), 0);
  q.add(out('b', 'g'), 1);
  q.add(out('c', 'h'), 2);
  assert.equal(q.size, 2);
  const first = q.next()!;
  assert.equal(first.text, 'a\n\nb');
  assert.equal(first.silent, false);
});

test('remoteNotice: news stops joining a waiting message once it would pass one Telegram message', () => {
  const q = new SendQueue(50, 1000, 10);
  q.add(out('aaaa', 'g'), 0);
  q.add(out('bbbb', 'g'), 0);
  q.add(out('cccc', 'g'), 0);
  assert.deepEqual(q.items.map((x) => x.text), ['aaaa\n\nbbbb', 'cccc']);
});

test('remoteNotice: news in a message that was dropped or cleared can be told again', () => {
  const q = new SendQueue(50, 1000);
  q.add(out('a', 'g'), 0);
  q.add(out('b', 'g'), 0);
  q.forget(q.next()!);
  assert.equal(q.add(out('a', 'g'), 1), true);
  assert.equal(q.add(out('b', 'g'), 1), true);
  q.clear();
  assert.equal(q.add(out('a', 'g'), 2), true);
});

test('remoteNotice: a full queue drops its oldest news that is not a decision', () => {
  const q = new SendQueue(3);
  q.add(out('d', 'd', { urgent: true }), 0);
  q.add(out('a'), 0);
  q.add(out('b'), 0);
  q.add(out('c'), 0);
  assert.deepEqual(q.items.map((x) => x.key), ['d', 'b', 'c']);
  q.retry(out('z'));
  assert.equal(q.next()!.key, 'z');
});

test('remoteNotice: a Dispatcher answer is sent whole at either level, without code, and a reply to it finds it', () => {
  const n: RemoteNews = { type: 'reply', id: 'c-9', text: 'Gave it to W-02.\n```\nsecret\n```' };
  assert.equal(newsText((k) => k, n, 'title'), 'Gave it to W-02.\n…');
  assert.equal(newsEvent(n), 'replies');
  assert.equal(newsRef(n), 'c-9');
  assert.equal(newsRef(result), 'T-1');
  assert.equal(newsRef({ type: 'error', text: 'x' }), undefined);
});

test('remoteNotice: news joined into one message keeps the first one\'s reference', () => {
  const q = new SendQueue();
  const o = (key: string, ref: string): Outgoing => ({ key, group: 'reply', text: key, silent: false, urgent: false, ref });
  q.add(o('a', 'c-1'), 0);
  q.add(o('b', 'c-2'), 0);
  assert.equal(q.size, 1);
  assert.equal(q.next()!.ref, 'c-1');
});
