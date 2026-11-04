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

test('every PWA provider defaults to a Meta-family model', () => {
  for (const provider of Object.values(PROVIDERS)) {
    assert.match(provider.defaultModel, /meta|llama|muse/i, provider.id);
  }
  assert.equal(modelFor('groq', ''), PROVIDERS.groq.defaultModel);
  assert.equal(modelFor('nim', 'custom-model'), 'custom-model');
});
