// provider.test.js — sequential failover router tests. Run with: node --test
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRouter, resetProviderHealth } from './server/services/provider.js';
import { appError } from './server/lib/errors.js';

// Provider health is process-wide so cooldowns survive individual requests.
// Reset it between tests so ids reused across cases start clean.
beforeEach(() => resetProviderHealth());

const RAW = { resultStatus: 'target_found', answerShort: 'ok', target: null };

function mockProvider(id, { fail = false, code = 'MODEL_UPSTREAM_ERROR', retryable = false, raw = RAW } = {}) {
  let calls = 0;
  return {
    id,
    name: `Mock ${id}`,
    capabilities: { imageInput: true, structuredOutput: true, webGrounding: false },
    async healthCheck() { return { ok: !fail }; },
    async analyze(input, signal) {
      calls += 1;
      if (fail) throw appError(code, `mock ${id} failure`, undefined, retryable);
      return { text: JSON.stringify(raw), citations: [], searchedWeb: false };
    },
    get callCount() { return calls; },
  };
}

test('router returns the first successful provider result', async () => {
  const router = new ProviderRouter()
    .use(mockProvider('first', { fail: true }))
    .use(mockProvider('second'));
  const out = await router.analyze({});
  assert.equal(out.providerUsed, 'second');
  assert.equal(out.fallbackOccurred, true);
  assert.equal(out.result.text, JSON.stringify(RAW));
  assert.equal(out.attempts.length, 2);
  assert.equal(out.attempts[0].ok, false);
  assert.equal(out.attempts[1].ok, true);
});

test('router throws when every provider fails, preserving the attempt trail', async () => {
  const router = new ProviderRouter()
    .use(mockProvider('a', { fail: true, code: 'MODEL_TIMEOUT', retryable: true }))
    .use(mockProvider('b', { fail: true, code: 'MODEL_AUTH_FAILED' }));
  await assert.rejects(() => router.analyze({}), (err) => {
    assert.equal(err.code, 'MODEL_AUTH_FAILED');
    assert.equal(err.attempts.length, 2);
    assert.equal(err.attempts[0].id, 'a');
    assert.equal(err.attempts[1].id, 'b');
    return true;
  });
});

test('router does not fall over for locally-detectable input errors', async () => {
  const first = mockProvider('first', { fail: true, code: 'COMMAND_MISSING' });
  const second = mockProvider('second');
  const router = new ProviderRouter().use(first).use(second);
  await assert.rejects(() => router.analyze({}), (err) => {
    assert.equal(err.code, 'COMMAND_MISSING');
    assert.equal(second.callCount, 0);
    return true;
  });
});

test('healthCheckAll reports ok/fail per provider', async () => {
  const router = new ProviderRouter()
    .use(mockProvider('good'))
    .use(mockProvider('bad', { fail: true }));
  const health = await router.healthCheckAll();
  assert.equal(health.good.ok, true);
  assert.equal(health.bad.ok, false);
});
