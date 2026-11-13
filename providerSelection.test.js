// providerSelection.test.js — tier-aware, key-first provider selection.
//
// The rule that matters: a provider is only usable when its key (and any extra
// credential) is really present, and the model chosen must match the user's
// access tier. No provider is invented, and free tier never silently spends.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  config,
  effectiveModelId,
  providerConfigured,
  isPlaceholderCredential,
} from './server/config.js';
import { getModel, defaultModelFor } from './modelRegistry.js';

/** Patch runtime config for one test and always restore it. */
function withRuntime(patch, fn) {
  const savedProviders = structuredClone(config.providers);
  const savedTier = config.accessTier;
  const savedPriority = [...config.providerPriority];
  try {
    Object.assign(config, patch);
    return fn();
  } finally {
    config.providers = savedProviders;
    config.accessTier = savedTier;
    config.providerPriority = savedPriority;
  }
}

function setProvider(id, patch) {
  config.providers[id] = { ...config.providers[id], enabled: true, ...patch };
}

test('placeholder credentials never count as a configured provider', () => {
  assert.equal(isPlaceholderCredential(''), true);
  assert.equal(isPlaceholderCredential('sk-or-v1-replace-me'), true);
  assert.equal(isPlaceholderCredential('your-api-key-here'), true);
  assert.equal(isPlaceholderCredential('sk-or-v1-9f8e7d6c5b4a'), false);
});

test('a provider without a key is rejected; a real key makes it selectable', () => {
  withRuntime({ accessTier: 'paid' }, () => {
    setProvider('openrouter', { apiKey: '', modelId: '' });
    assert.equal(providerConfigured('openrouter'), false);

    setProvider('openrouter', { apiKey: 'sk-or-v1-9f8e7d6c5b4a', modelId: '' });
    assert.equal(providerConfigured('openrouter'), true);
  });
});

test('free tier never auto-selects a paid model', () => {
  withRuntime({ accessTier: 'free' }, () => {
    for (const providerId of ['openrouter', 'google-ai-studio', 'groq', 'mistral']) {
      const model = effectiveModelId(providerId);
      if (!model) continue; // this provider has no free vision model at all
      const info = getModel(providerId, model);
      assert.ok(info, `${providerId}/${model} must be catalogued`);
      assert.equal(info.tier, 'free', `${providerId} auto-selected ${model}`);
    }
  });
});

test('free tier selects the recommended free model for OpenRouter', () => {
  withRuntime({ accessTier: 'free' }, () => {
    setProvider('openrouter', { apiKey: 'sk-or-v1-9f8e7d6c5b4a', modelId: '' });
    const model = effectiveModelId('openrouter');
    assert.equal(model, defaultModelFor('openrouter', { tier: 'free', visionOnly: true }));
    assert.ok(model.endsWith(':free'), model);
  });
});

test('paid tier selects a paid model and prefers a fast one on the 10 s path', () => {
  withRuntime({ accessTier: 'paid' }, () => {
    setProvider('openrouter', { apiKey: 'sk-or-v1-9f8e7d6c5b4a', modelId: '' });
    const model = effectiveModelId('openrouter');
    assert.equal(getModel('openrouter', model).tier, 'paid');
    const fast = defaultModelFor('openrouter', { tier: 'paid', visionOnly: true, preferFast: true });
    assert.equal(getModel('openrouter', fast)?.tier, 'paid');
    // A fast default must exist; otherwise the 10 s deadline cannot be met.
    assert.ok(getModel('openrouter', fast)?.fast, `${fast} should be flagged fast`);
  });
});

test('an explicit tier-allowed model overrides the automatic default', () => {
  withRuntime({ accessTier: 'free' }, () => {
    assert.equal(
      effectiveModelId('openrouter', 'meta-llama/llama-3.2-11b-vision-instruct:free'),
      'meta-llama/llama-3.2-11b-vision-instruct:free',
    );
  });
});

test('a paid-only choice is refused on the free tier, not silently downgraded', () => {
  withRuntime({ accessTier: 'free' }, () => {
    const resolved = effectiveModelId('openrouter', 'meta-llama/llama-4-maverick');
    assert.notEqual(resolved, 'meta-llama/llama-4-maverick');
    assert.equal(getModel('openrouter', resolved).tier, 'free');
  });
});

test('key-less providers are dropped before ordering, so a keyed fallback wins', () => {
  withRuntime({ accessTier: 'paid', providerPriority: ['groq', 'openrouter'] }, () => {
    setProvider('groq', { apiKey: '', modelId: '' });
    setProvider('openrouter', { apiKey: 'sk-or-v1-9f8e7d6c5b4a', modelId: '' });
    const usable = config.providerPriority.filter((id) => providerConfigured(id));
    assert.deepEqual(usable, ['openrouter']);
  });
});

test('priority order is honoured when several providers have keys', () => {
  withRuntime({ accessTier: 'paid', providerPriority: ['groq', 'openrouter'] }, () => {
    setProvider('groq', { apiKey: 'gsk_9f8e7d6c5b4a', modelId: '' });
    setProvider('openrouter', { apiKey: 'sk-or-v1-9f8e7d6c5b4a', modelId: '' });
    const usable = config.providerPriority.filter((id) => providerConfigured(id));
    assert.deepEqual(usable, ['groq', 'openrouter']);
  });
});
