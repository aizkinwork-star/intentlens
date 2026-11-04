import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, modelFor, defaultModelFor, modelsFor, modelAllowedAtTier, PROVIDERS } from './provider.js';

test('extractJson finds a JSON object after prose and code fences', () => {
  const raw = 'Here is the result:\n```json\n{"component":{"name":"resistor"},"location":null}\n```';
  assert.deepEqual(extractJson(raw), {
    component: { name: 'resistor' },
    location: null,
  });
});

test('extractJson keeps braces inside strings intact', () => {
  const raw = 'note {"instruction":"use {this} carefully","ok":true} trailing';
  assert.deepEqual(extractJson(raw), { instruction: 'use {this} carefully', ok: true });
});

test('extractJson returns null when there is no object', () => {
  assert.equal(extractJson('I cannot identify this part.'), null);
  assert.equal(extractJson('{"broken":'), null);
});

test('paid Meta defaults win and there is no cross-provider substitution', () => {
  for (const provider of Object.values(PROVIDERS)) {
    assert.ok(provider.label, provider.id);
    assert.ok(provider.browserCors, provider.id);
  }
  // The default is a Meta vision model, billed per token.
  assert.equal(PROVIDERS.openrouter.defaultModel, 'meta-llama/llama-4-maverick');
  // Groq has no safe default: access and vision support vary by account.
  assert.equal(PROVIDERS.groq.defaultModel, '');
  assert.equal(modelFor('groq', ''), '');
  assert.equal(modelFor('custom', ''), '');
  assert.equal(modelFor('custom', 'custom-model'), 'custom-model');
  // Paid is the default access level.
  assert.equal(defaultModelFor('openrouter', 'paid'), 'meta-llama/llama-4-maverick');
  assert.equal(defaultModelFor('groq', 'preview'), '');
  // The full provider set is visible, including desktop-only hosts.
  for (const id of ['openrouter', 'groq', 'nvidia-nim', 'cloudflare-workers-ai', 'blockrun', 'modal', 'custom']) {
    assert.ok(PROVIDERS[id], id);
  }
  for (const id of ['nvidia-nim', 'cloudflare-workers-ai', 'blockrun']) {
    assert.equal(PROVIDERS[id].unavailableInBrowser, true, id);
    assert.ok(PROVIDERS[id].endpoint, id);
    assert.ok(PROVIDERS[id].blockedMessage, id);
  }
  assert.equal(PROVIDERS.modal.requiresBaseUrl, true);
  assert.match(PROVIDERS.modal.label, /untested/i);
});

test('narrowing access to free hides paid and preview models; paid shows them all', () => {
  assert.equal(modelAllowedAtTier('openrouter', 'meta-llama/llama-4-maverick', 'free'), false);
  assert.equal(modelAllowedAtTier('openrouter', 'meta-llama/llama-4-maverick', 'paid'), true);
  assert.equal('meta-llama/llama-4-maverick' in modelsFor('openrouter', 'free'), false);
  assert.equal('meta-llama/llama-4-maverick' in modelsFor('openrouter'), true);
  assert.equal(modelAllowedAtTier('groq', 'meta-llama/llama-3.3-70b-versatile', 'free'), false);
  assert.equal(modelAllowedAtTier('groq', 'meta-models/muse-spark-open', 'free'), false);
  assert.equal(modelAllowedAtTier('groq', 'meta-models/muse-spark-open', 'preview'), true);
  // A typed id that is not catalogued is left to the provider to judge.
  assert.equal(modelAllowedAtTier('openrouter', 'meta-llama/new-model', 'free'), true);
});
