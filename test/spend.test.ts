import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpendMeter, addSpend, formatTokens, formatUsd, hasSpend, spendOf, spendSince, spendVars, type Spend } from '../src/shared/spend';
import { tr } from '../src/shared/i18n';

const sp = (costUsd: number, input: number, output: number, cacheRead = 0, cacheWrite = 0): Spend => ({ costUsd, input, output, cacheRead, cacheWrite });

test('spend: a result sums every model, subagents included', () => {
  const s = spendOf({
    total_cost_usd: 1.25,
    modelUsage: {
      'claude-opus-5-5': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 9000, cacheCreationInputTokens: 300 },
      'claude-haiku-5-5': { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 10 },
    },
  });
  assert.deepEqual(s, sp(1.25, 120, 55, 9000, 310));
});

test('spend: missing or odd fields count as zero', () => {
  assert.deepEqual(spendOf({}), sp(0, 0, 0));
  assert.deepEqual(spendOf({ total_cost_usd: NaN, modelUsage: { m: { inputTokens: -3 } } }), sp(0, 0, 0));
  assert.equal(hasSpend(spendOf({})), false);
  assert.equal(hasSpend(null), false);
});

test('spend: a turn is the growth of the running totals', () => {
  const turn = spendSince(sp(3, 300, 90, 5000, 200), sp(1, 100, 40, 2000, 100));
  assert.ok(turn);
  assert.ok(Math.abs(turn.costUsd - 2) < 1e-9);
  assert.deepEqual({ ...turn, costUsd: 0 }, sp(0, 200, 50, 3000, 100));
});

test('spend: the first turn of a session counts in full', () => {
  assert.deepEqual(spendSince(sp(0.5, 10, 5), null), sp(0.5, 10, 5));
});

test('spend: totals that went down mean the counter started over', () => {
  assert.deepEqual(spendSince(sp(0.2, 30, 10), sp(4, 900, 300)), sp(0.2, 30, 10));
});

test('spend: an all-zero result (crash, startup error) is skipped', () => {
  assert.equal(spendSince(sp(0, 0, 0), sp(4, 900, 300)), null);
});

test('meter: a new session counts each turn as the growth of its totals', () => {
  const m = new SpendMeter(false, null);
  assert.deepEqual(m.take(sp(1, 100, 10)), sp(1, 100, 10));
  assert.deepEqual(m.take(sp(3, 250, 30)), sp(2, 150, 20));
  assert.deepEqual(m.total, sp(3, 250, 30));
});

test('meter: a resume with saved totals counts only what is new', () => {
  const m = new SpendMeter(true, sp(3, 250, 30));
  assert.deepEqual(m.take(sp(4, 300, 40)), sp(1, 50, 10));
});

test('meter: a resume without saved totals only sets the baseline', () => {
  const m = new SpendMeter(true, null);
  assert.deepEqual(m.take(sp(40, 9000, 900)), sp(0, 0, 0));
  assert.deepEqual(m.total, sp(40, 9000, 900));
  assert.deepEqual(m.take(sp(41, 9100, 950)), sp(1, 100, 50));
});

test('meter: a zero result leaves the baseline alone', () => {
  const m = new SpendMeter(true, sp(3, 250, 30));
  assert.equal(m.take(sp(0, 0, 0)), null);
  assert.deepEqual(m.take(sp(4, 300, 40)), sp(1, 50, 10));
});

test('meter: a counter that started over counts in full and becomes the baseline', () => {
  const m = new SpendMeter(true, sp(3, 250, 30));
  assert.deepEqual(m.take(sp(0.5, 20, 5)), sp(0.5, 20, 5));
  assert.deepEqual(m.take(sp(1, 40, 10)), sp(0.5, 20, 5));
});

test('spend: adding starts from nothing', () => {
  assert.deepEqual(addSpend(undefined, sp(1, 2, 3, 4, 5)), sp(1, 2, 3, 4, 5));
  assert.deepEqual(addSpend(sp(1, 2, 3, 4, 5), sp(1, 1, 1, 1, 1)), sp(2, 3, 4, 5, 6));
});

test('spend: dollars', () => {
  assert.equal(formatUsd(0), '$0');
  assert.equal(formatUsd(0.004), '<$0.01');
  assert.equal(formatUsd(1.234), '$1.23');
  assert.equal(formatUsd(1234.4), '$1,234');
});

test('spend: tokens', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(3400), '3.4K');
  assert.equal(formatTokens(3000), '3K');
  assert.equal(formatTokens(12_345), '12K');
  assert.equal(formatTokens(999_700), '1M');
  assert.equal(formatTokens(1_234_567), '1.2M');
  assert.equal(formatTokens(25_000_000), '25M');
});

test('spend: shown as an API-equivalent estimate in both languages', () => {
  const v = spendVars(sp(1.5, 12_000, 3400, 1_200_000, 80_000));
  assert.deepEqual(v, { cost: '$1.50', in: '12K', out: '3.4K', cache: '1.3M', read: '1.2M', write: '80K' });
  assert.equal(tr('en', 'spend.cost', v), 'API-equivalent estimate $1.50');
  assert.equal(tr('ko', 'spend.cost', v), 'API 환산 추정 $1.50');
  assert.equal(tr('ko', 'spend.memo', v), 'API 환산 추정 $1.50 (입력 12K, 출력 3.4K, 캐시 읽기 1.2M, 캐시 쓰기 80K)');
});
