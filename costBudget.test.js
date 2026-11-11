// costBudget.test.js — the hard budget gate and ledger accounting.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BUDGET,
  budgetSnapshot,
  makeUsageEntry,
  normalizeBudget,
  preflightBudget,
  pruneEntries,
  sumUsage,
  windowStart,
} from './costCore.js';

const now = Date.UTC(2026, 10, 11, 12, 0, 0); // 2026-11-11 12:00 UTC

function budget(overrides = {}) {
  return normalizeBudget({ ...DEFAULT_BUDGET, ...overrides });
}

test('budget normalization clamps nonsense and keeps hard caps', () => {
  const b = normalizeBudget({ dailyUsd: -5, monthlyUsd: 'x', maxRequestUsd: -1, maxInputTokens: 5, maxOutputTokens: 1, warnAtPercent: 500 });
  assert.equal(b.dailyUsd, DEFAULT_BUDGET.dailyUsd);
  assert.equal(b.monthlyUsd, DEFAULT_BUDGET.monthlyUsd);
  assert.equal(b.maxRequestUsd, DEFAULT_BUDGET.maxRequestUsd);
  assert.equal(b.maxInputTokens, 256);
  assert.equal(b.maxOutputTokens, 64);
  assert.equal(b.warnAtPercent, 100);
});

test('free models pass preflight and paid models are priced pessimistically', () => {
  const free = preflightBudget({
    budget: budget(),
    entries: [],
    providerId: 'openrouter',
    modelId: 'meta-llama/llama-3.2-11b-vision-instruct:free',
    inputText: 'Where is the battery connector?',
    image: { width: 1024, height: 768 },
    now,
  });
  assert.equal(free.ok, true);
  assert.equal(free.estimateUsd, 0);

  const paid = preflightBudget({
    budget: budget({ dailyUsd: 5, monthlyUsd: 5, maxRequestUsd: 1 }),
    entries: [],
    providerId: 'openrouter',
    modelId: 'meta-llama/llama-4-maverick',
    inputText: 'x'.repeat(4000),
    image: { width: 1600, height: 1200 },
    maxOutputTokens: 2048,
    now,
  });
  assert.equal(paid.ok, true);
  assert.ok(paid.estimateUsd > 0);
  assert.ok(paid.estimatedInputTokens >= 1000);
});

test('a request over the per-request cap is refused before sending', () => {
  const result = preflightBudget({
    budget: budget({ dailyUsd: 100, monthlyUsd: 100, maxRequestUsd: 0.000001 }),
    entries: [],
    providerId: 'openai',
    modelId: 'gpt-4.1',
    inputText: 'x'.repeat(8000),
    maxOutputTokens: 2048,
    now,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REQUEST_COST_LIMIT');
  assert.match(result.message, /per-request cap/i);
});

test('an exhausted daily or monthly budget refuses every paid request', () => {
  const entry = { at: now, providerId: 'openai', modelId: 'gpt-4.1', costUsd: 1 };
  const result = preflightBudget({
    budget: budget({ dailyUsd: 0.5, monthlyUsd: 10, maxRequestUsd: 1 }),
    entries: [entry],
    providerId: 'openai',
    modelId: 'gpt-4.1-mini',
    inputText: 'hello',
    now,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BUDGET_EXCEEDED');
  assert.equal(result.snapshot.todayUsd, 1);
  assert.equal(result.snapshot.dayRemainingUsd, 0);
});

test('the input token cap is enforced independently of money', () => {
  const result = preflightBudget({
    budget: budget({ maxInputTokens: 500 }),
    entries: [],
    providerId: 'openrouter',
    modelId: 'qwen/qwen2.5-vl-72b-instruct:free',
    inputText: 'x'.repeat(8000),
    now,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INPUT_TOKEN_LIMIT');
});

test('window sums only count entries inside the UTC day/month', () => {
  const entries = [
    { at: Date.UTC(2026, 9, 31, 23, 59), costUsd: 9 },   // previous month
    { at: Date.UTC(2026, 10, 1, 0, 1), costUsd: 2 },     // this month, earlier day
    { at: Date.UTC(2026, 10, 11, 1, 0), costUsd: 0.5 },  // today
    { at: Date.UTC(2026, 10, 11, 11, 0), costUsd: 0.25 },// today
  ];
  assert.equal(windowStart('day', now), Date.UTC(2026, 10, 11));
  assert.equal(sumUsage(entries, 'day', now), 0.75);
  assert.equal(sumUsage(entries, 'month', now), 2.75);
  const snap = budgetSnapshot({ budget: budget({ dailyUsd: 1 }), entries, now });
  assert.equal(snap.todayUsd, 0.75);
  assert.equal(snap.monthUsd, 2.75);
  assert.equal(snap.requests, 3);
});

test('usage entries prefer provider-reported token counts', () => {
  const entry = makeUsageEntry({
    providerId: 'openrouter',
    modelId: 'meta-llama/llama-4-maverick',
    usage: { prompt_tokens: 1200, completion_tokens: 300 },
    requestId: 'req_1',
    at: now,
  });
  assert.equal(entry.inputTokens, 1200);
  assert.equal(entry.outputTokens, 300);
  assert.equal(entry.source, 'provider-usage');
  assert.ok(entry.costUsd > 0);
  assert.equal(entry.at, now);

  const estimated = makeUsageEntry({
    providerId: 'openrouter',
    modelId: 'meta-llama/llama-4-maverick',
    inputTokens: 1000,
    outputTokens: 100,
    at: now,
  });
  assert.equal(estimated.source, 'estimate');
  assert.ok(estimated.costUsd > 0);
});

test('ledger pruning keeps this month and caps growth', () => {
  const old = { at: Date.UTC(2026, 9, 1), costUsd: 1 };
  const fresh = Array.from({ length: 10 }, (_, i) => ({ at: now - i, costUsd: 0.01 }));
  const kept = pruneEntries([old, ...fresh], { now, maxEntries: 5 });
  assert.equal(kept.length, 5);
  assert.equal(kept.some((e) => e.at === old.at), false);
  assert.deepEqual(kept.map((e) => e.at), [...kept.map((e) => e.at)].sort((a, b) => a - b));
});
