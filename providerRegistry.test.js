// providerRegistry.test.js — the shared catalogue is the one source of truth.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_TIERS,
  ALL_SECRET_ENV_KEYS,
  DEFAULT_PRIORITY,
  PROVIDERS,
  PROVIDER_MODELS,
  TIER_RANK,
  defaultModelFor,
  getModel,
  getProvider,
  isOpenWeightModel,
  listProviderIds,
  modelAllowedAtTier,
  modelsFor,
  normalizeProviderId,
  providerEndpoint,
} from './modelRegistry.js';

const KINDS = new Set(['openai', 'cloudflare', 'anthropic']);
const CORS = new Set(['allowed', 'unverified', 'blocked', 'local']);
const TIERS = new Set(['free', 'preview', 'paid']);
const MODALITIES = new Set(['text', 'vision', 'classifier']);

test('every registered provider has complete, non-contradictory metadata', () => {
  const ids = listProviderIds();
  assert.ok(ids.length >= 12, `expected a broad catalogue, got ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(new Set(DEFAULT_PRIORITY), new Set(ids), 'default priority must list every provider once');

  for (const [key, provider] of Object.entries(PROVIDERS)) {
    assert.equal(provider.id, key, key);
    assert.ok(provider.label.length > 0, key);
    assert.ok(provider.description.length > 0, key);
    assert.ok(KINDS.has(provider.kind), `${key} kind`);
    assert.ok(CORS.has(provider.browserCors), `${key} cors`);
    assert.equal(typeof provider.requiresKey, 'boolean', key);
    if (provider.requiresKey && key !== 'custom') assert.ok(provider.envKey, `${key} envKey`);
    if (provider.kind === 'cloudflare') assert.equal(provider.requiresAccountId, true, key);
    if (key === 'custom') assert.equal(provider.requiresBaseUrl, true);
  }
});

test('every model has an explicit modality and consistent vision flag', () => {
  let count = 0;
  for (const providerId of listProviderIds()) {
    const models = PROVIDER_MODELS[providerId];
    assert.ok(models, `${providerId} must have a model table`);
    assert.equal(models, PROVIDER_MODELS[normalizeProviderId(providerId)]);
    for (const [modelId, info] of Object.entries(models)) {
      count += 1;
      assert.equal(info.id, modelId, `${providerId}/${modelId}`);
      assert.ok(info.name.length > 0, `${providerId}/${modelId}`);
      assert.ok(MODALITIES.has(info.modality), `${providerId}/${modelId} modality`);
      assert.ok(TIERS.has(info.tier), `${providerId}/${modelId} tier`);
      assert.equal(typeof info.vision, 'boolean', `${providerId}/${modelId} vision`);
      assert.equal(info.vision, info.modality === 'vision', `${providerId}/${modelId} vision/modality`);
      assert.ok(Number(info.contextWindow) > 0, `${providerId}/${modelId} contextWindow`);
      assert.ok(Number(info.inputPerM) >= 0, `${providerId}/${modelId} input price`);
      assert.ok(Number(info.outputPerM) >= 0, `${providerId}/${modelId} output price`);
      if (info.modality === 'classifier') assert.equal(info.vision, false);
    }
  }
  assert.ok(count >= 50, `expected a broad model catalogue, got ${count}`);
});

test('providers declared text-only never expose a vision model', () => {
  for (const provider of Object.values(PROVIDERS)) {
    if (provider.textOnly !== true) continue;
    const models = Object.values(PROVIDER_MODELS[provider.id] || {});
    assert.equal(models.some((info) => info.vision), false, provider.id);
  }
});

test('free and paid filters follow tier order, never widening by accident', () => {
  assert.deepEqual(ACCESS_TIERS, ['free', 'preview', 'paid']);
  assert.ok(TIER_RANK.free < TIER_RANK.preview);
  assert.ok(TIER_RANK.preview < TIER_RANK.paid);

  const freeOpenRouter = modelsFor('openrouter', { tier: 'free' });
  assert.ok(Object.keys(freeOpenRouter).length > 0);
  for (const info of Object.values(freeOpenRouter)) assert.equal(info.tier, 'free');

  const paidOpenRouter = modelsFor('openrouter', { tier: 'paid' });
  assert.ok(Object.keys(paidOpenRouter).length > Object.keys(freeOpenRouter).length);
  assert.equal(modelAllowedAtTier('openrouter', 'meta-llama/llama-4-maverick', 'free'), false);
  assert.equal(modelAllowedAtTier('openrouter', 'meta-llama/llama-4-maverick', 'paid'), true);
});

test('known classifiers are never selected as vision or chat models', () => {
  const classifier = Object.entries(PROVIDER_MODELS)
    .flatMap(([providerId, models]) => Object.values(models).filter((m) => m.modality === 'classifier').map((m) => [providerId, m]))
    .at(0);
  assert.ok(classifier, 'catalogue should contain at least one classifier');
  const [providerId, info] = classifier;
  assert.equal(modelsFor(providerId, { tier: 'paid', visionOnly: true })[info.id], undefined);
  assert.equal(modelsFor(providerId, { tier: 'paid', includeClassifiers: false })[info.id], undefined);
});

test('default models are catalogued, vision-capable and tier-appropriate', () => {
  for (const providerId of ['openrouter', 'groq', 'google-ai-studio', 'nvidia-nim', 'cloudflare-workers-ai', 'mistral', 'together', 'deepinfra', 'openai', 'anthropic', 'ollama']) {
    const paid = defaultModelFor(providerId, { tier: 'paid', visionOnly: true });
    assert.ok(paid, providerId);
    assert.equal(getModel(providerId, paid).vision, true, `${providerId}/${paid}`);
  }
  const free = defaultModelFor('openrouter', { tier: 'free', visionOnly: true });
  assert.ok(free.endsWith(':free'), free);
  assert.equal(getModel('openrouter', free).tier, 'free');
});

test('unknown providers and cross-provider model ids are rejected', () => {
  assert.equal(getProvider('not-a-provider'), null);
  assert.equal(getModel('nvidia-nim', '@cf/meta/llama-3.2-11b-vision-instruct'), null);
  assert.equal(getModel('groq', 'meta/llama-3.2-11b-vision-instruct'), null);
  assert.equal(getModel('openrouter', 'meta-llama/llama-4-scout')?.vision, true);
});

test('provider aliases resolve to canonical ids', () => {
  assert.equal(normalizeProviderId('nvidia'), 'nvidia-nim');
  assert.equal(normalizeProviderId('gemini'), 'google-ai-studio');
  assert.equal(normalizeProviderId('hf'), 'huggingface');
  assert.equal(normalizeProviderId('cloudflare'), 'cloudflare-workers-ai');
  assert.equal(normalizeProviderId('local'), 'ollama');
});

test('open-weight detection is explicit where catalogued and heuristic elsewhere', () => {
  assert.equal(isOpenWeightModel('openrouter', 'meta-llama/llama-4-maverick'), true);
  assert.equal(isOpenWeightModel('openai', 'gpt-4.1-mini'), false);
  assert.equal(isOpenWeightModel('anthropic', 'claude-sonnet-4-20250514'), false);
  assert.equal(isOpenWeightModel('custom', 'qwen2.5-vl:7b'), true);
});

test('endpoints are built safely per provider shape', () => {
  assert.equal(
    providerEndpoint('openrouter'),
    'https://openrouter.ai/api/v1/chat/completions',
  );
  assert.equal(
    providerEndpoint('cloudflare-workers-ai', { accountId: 'abc', modelId: '@cf/meta/llama-3.2-11b-vision-instruct' }),
    'https://api.cloudflare.com/client/v4/accounts/abc/ai/run/@cf/meta/llama-3.2-11b-vision-instruct',
  );
  assert.equal(providerEndpoint('cloudflare-workers-ai', { accountId: '', modelId: '' }), '');
  assert.equal(
    providerEndpoint('custom', { baseUrl: 'https://relay.example' }),
    'https://relay.example/v1/chat/completions',
  );
  assert.equal(
    providerEndpoint('custom', { baseUrl: 'https://relay.example/v1' }),
    'https://relay.example/v1/chat/completions',
  );
  assert.equal(
    providerEndpoint('custom', { baseUrl: 'https://relay.example/chat/completions' }),
    'https://relay.example/chat/completions',
  );
  assert.equal(providerEndpoint('custom', { baseUrl: '' }), '');
  assert.equal(
    providerEndpoint('anthropic', { baseUrl: 'https://proxy.example' }),
    'https://proxy.example/v1/messages',
  );
  assert.equal(
    providerEndpoint('ollama', { baseUrl: 'http://localhost:11434' }),
    'http://localhost:11434/v1/chat/completions',
  );
});

test('every provider key and model variable is persistable', () => {
  for (const provider of Object.values(PROVIDERS)) {
    if (provider.envKey) assert.ok(ALL_SECRET_ENV_KEYS.includes(provider.envKey), provider.envKey);
    if (provider.modelEnvKey) assert.ok(ALL_SECRET_ENV_KEYS.includes(provider.modelEnvKey), provider.modelEnvKey);
    for (const key of provider.extraEnvKeys || []) {
      assert.ok(ALL_SECRET_ENV_KEYS.includes(key), key);
    }
  }
  assert.ok(ALL_SECRET_ENV_KEYS.includes('DAILY_BUDGET_USD'));
  assert.ok(ALL_SECRET_ENV_KEYS.includes('MAX_REQUEST_USD'));
  assert.equal(new Set(ALL_SECRET_ENV_KEYS).size, ALL_SECRET_ENV_KEYS.length);
});
