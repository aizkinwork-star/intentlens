import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS,
  defaultModelFor,
  extractJson,
  modelAllowedAtTier,
  modelFor,
  modelsFor,
  safeRecognizerUrl,
} from './provider.js';

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

test('paid defaults are catalogued vision models and there is no cross-provider substitution', () => {
  for (const provider of Object.values(PROVIDERS)) {
    assert.ok(provider.label, provider.id);
    assert.ok(provider.browserCors, provider.id);
  }
  assert.equal(PROVIDERS.openrouter.defaultModel, 'google/gemini-2.5-flash');
  assert.equal(modelFor('groq', ''), defaultModelFor('groq', 'paid'));
  assert.equal(modelFor('custom', ''), '');
  assert.equal(modelFor('custom', 'custom-model'), 'custom-model');
  assert.equal(defaultModelFor('openrouter', 'free').endsWith(':free'), true);
});

test('tier filters hide paid models from free access', () => {
  assert.equal(modelAllowedAtTier('openrouter', 'meta-llama/llama-4-maverick', 'free'), false);
  assert.equal(modelAllowedAtTier('openrouter', 'meta-llama/llama-4-maverick', 'paid'), true);
  assert.equal('meta-llama/llama-4-maverick' in modelsFor('openrouter', 'free'), false);
  assert.equal('meta-llama/llama-4-maverick' in modelsFor('openrouter', 'paid'), true);
  assert.equal(modelAllowedAtTier('openrouter', 'unknown-but-typed', 'free'), false);
});

test('the optional recogniser endpoint only accepts https, same-origin or loopback', () => {
  const base = 'https://app.example.com/intentlens/';
  assert.equal(safeRecognizerUrl('', base), '');
  assert.equal(safeRecognizerUrl('not a url', base), '');
  assert.equal(safeRecognizerUrl('http://evil.example.com/classify', base), '');
  assert.equal(
    safeRecognizerUrl('https://pc.example.com/api/recognizer/classify', base),
    'https://pc.example.com/api/recognizer/classify',
  );
  assert.equal(
    safeRecognizerUrl('/api/recognizer/classify', base),
    'https://app.example.com/api/recognizer/classify',
  );
  assert.equal(
    safeRecognizerUrl('http://localhost:8011/api/recognizer/classify', base),
    'http://localhost:8011/api/recognizer/classify',
  );
  assert.equal(
    safeRecognizerUrl('http://192.168.1.20:8011/api/recognizer/classify', base),
    '',
    'plain http to a LAN address must be refused',
  );
});
