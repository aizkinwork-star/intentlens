import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, modelFor, PROVIDERS } from './provider.js';

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

test('every PWA provider has a concrete default and no silent substitution', () => {
  for (const provider of Object.values(PROVIDERS)) {
    assert.ok(provider.defaultModel, provider.id);
    assert.ok(provider.label, provider.id);
    assert.ok(provider.browserCors, provider.id);
  }
  assert.equal(modelFor('groq', ''), PROVIDERS.groq.defaultModel);
  assert.equal(modelFor('custom', 'custom-model'), 'custom-model');
  assert.equal(PROVIDERS.nim, undefined);
  assert.equal(PROVIDERS.blockrun, undefined);
});
