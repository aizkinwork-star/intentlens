// metaOnly.test.js — HARD CONSTRAINT: only Meta-published models are reachable,
// on every provider, in both the desktop server and the phone PWA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROVIDER_MODELS, GROQ_TEXT_MODELS, callModel, isMetaModelId } from './pwa/provider.js';
import { META_MODEL_CATALOG, providerSupportsModel, config, normalizeTier } from './server/config.js';

const NON_META = /nemotron|nvidia\/|gpt-oss|qwen|mistral|gemma|deepseek|dots-/i;
const META_ID = /^(meta-llama\/|meta\/|meta-models\/|@cf\/meta\/)/i;

test('every phone catalogue entry is a Meta model', () => {
  for (const [provider, catalogue] of Object.entries(PROVIDER_MODELS)) {
    for (const id of Object.keys(catalogue)) {
      assert.match(id, META_ID, `${provider}: ${id}`);
      assert.doesNotMatch(id, NON_META, `${provider}: ${id}`);
    }
  }
});

test('every desktop server catalogue entry is a Meta model', () => {
  for (const [provider, def] of Object.entries(META_MODEL_CATALOG)) {
    for (const id of Object.keys(def.models)) {
      assert.match(id, META_ID, `${provider}: ${id}`);
      assert.doesNotMatch(id, NON_META, `${provider}: ${id}`);
    }
  }
});

test('the desktop server refuses non-Meta ids on every provider', () => {
  for (const provider of Object.keys(META_MODEL_CATALOG)) {
    for (const id of ['nvidia/nemotron-3.5-super-vl:free', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b']) {
      assert.equal(providerSupportsModel(provider, id), false, `${provider}: ${id}`);
    }
  }
});

test('the phone refuses non-Meta ids before any key check or network call, even typed by hand', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; throw new Error('must not be called'); };
  const bad = ['nvidia/nemotron-3.5-super-vl:free', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'meta-llama/llama-nemotron-x'];
  for (const providerId of ['openrouter', 'groq', 'modal', 'custom']) {
    for (const model of bad) {
      const result = await callModel({
        providerId, model, apiKey: 'k', baseUrl: 'https://example.modal.run', prompt: 'hi', fetchImpl,
      });
      assert.equal(result.ok, false, `${providerId}: ${model}`);
      assert.equal(result.code, 'NON_META_MODEL', `${providerId}: ${model}`);
    }
  }
  assert.equal(called, 0);
  assert.equal(isMetaModelId('meta-llama/llama-4-maverick'), true);
  assert.equal(isMetaModelId('@cf/meta/llama-3.2-11b-vision-instruct'), true);
});

test('Groq never receives an image, on the phone or the desktop server', () => {
  for (const info of Object.values(GROQ_TEXT_MODELS)) assert.equal(info.vision, false);
  for (const def of Object.values({ groq: META_MODEL_CATALOG.groq })) {
    for (const info of Object.values(def.models)) assert.notEqual(info.modality, 'vision');
  }
});

test('access defaults to paid and legacy free settings are upgraded', () => {
  assert.equal(normalizeTier(undefined), 'paid');
  assert.equal(normalizeTier('free'), 'paid');
  assert.equal(config.accessTier === 'paid' || config.accessTier === 'preview', true);
});

test('no shipped code, config or README names a non-Meta model', () => {
  for (const file of ['README.md', '.env.example', 'index.html', 'pwa/index.html', 'pwa/provider.js', 'pwa/README.md', 'server/config.js']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    const lines = text.split('\n').filter((line) => /nemotron|gpt-oss|qwen\/|dots-3/i.test(line)
      && !/NON_META_MARKERS|NON_META|isMetaModelId|refuse/i.test(line));
    assert.deepEqual(lines, [], `${file} mentions a non-Meta model`);
  }
});
