// Meta-only provider catalog and adapter guard tests. Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  META_MODEL_CATALOG,
  config,
  providerConfigured,
  providerSupportsModel,
  providerSupportsVisionModel,
} from './server/config.js';
import { buildNimProvider } from './server/services/nimProvider.js';
import { buildCloudflareProvider } from './server/services/cloudflareProvider.js';
import { buildGroqProvider } from './server/services/groqProvider.js';

const NVIDIA_VISION = 'meta/llama-3.2-11b-vision-instruct';
const CLOUDFLARE_VISION = '@cf/meta/llama-4-scout-17b-16e-instruct';
const GROQ_VISION = 'meta-llama/llama-4-scout-17b-16e-instruct';

test('every catalog entry is a Meta model with an explicit modality', () => {
  for (const [providerId, provider] of Object.entries(META_MODEL_CATALOG)) {
    assert.ok(provider.models, providerId);
    for (const [modelId, model] of Object.entries(provider.models)) {
      assert.ok(modelId.length > 0);
      assert.ok(['vision', 'text'].includes(model.modality), `${providerId}/${modelId}`);
      assert.ok(model.name.length > 0);
    }
  }
});

test('provider models are scoped to their own catalog', () => {
  assert.equal(providerSupportsVisionModel('nvidia-nim', NVIDIA_VISION), true);
  assert.equal(providerSupportsVisionModel('cloudflare-workers-ai', CLOUDFLARE_VISION), true);
  assert.equal(providerSupportsVisionModel('groq', GROQ_VISION), true);

  assert.equal(providerSupportsModel('nvidia-nim', CLOUDFLARE_VISION), false);
  assert.equal(providerSupportsModel('cloudflare-workers-ai', NVIDIA_VISION), false);
  assert.equal(providerSupportsModel('groq', NVIDIA_VISION), false);
});

test('free Meta vision models are available where providers host them', () => {
  assert.equal(providerSupportsVisionModel('nvidia-nim', 'meta/llama-3.2-90b-vision-instruct'), true);
  assert.equal(providerSupportsVisionModel('nvidia-nim', 'meta/llama-4-maverick-17b-128e-instruct'), false);
  assert.equal(providerSupportsVisionModel('nvidia-nim', 'meta/muse-glimmer-30b'), true);
  assert.equal(providerSupportsVisionModel('cloudflare-workers-ai', '@cf/meta/llama-3.2-90b-vision-instruct'), true);
  assert.equal(providerSupportsVisionModel('cloudflare-workers-ai', '@cf/meta/llama-3.2-11b-vision-instruct'), true);
  assert.equal(providerSupportsVisionModel('groq', 'meta-llama/llama-4-maverick-17b-128e-instruct'), true);

  assert.equal(providerSupportsVisionModel('groq', 'meta/muse-glimmer-30b'), false);
  assert.equal(providerSupportsVisionModel('cloudflare-workers-ai', 'meta/muse-glimmer-30b'), false);
});

test('text-only Meta models are not vision eligible', () => {
  assert.equal(providerSupportsVisionModel('nvidia-nim', 'meta/llama-3.3-70b-instruct'), false);
  assert.equal(providerSupportsVisionModel('cloudflare-workers-ai', '@cf/meta/llama-3.1-8b-instruct'), false);
  assert.equal(providerSupportsVisionModel('groq', 'llama-3.3-70b-versatile'), false);
});

test('adapters reject a Meta model from another provider catalog', () => {
  assert.throws(() => buildNimProvider({ baseUrl: 'https://integrate.api.nvidia.com', apiKey: 'k', modelId: CLOUDFLARE_VISION }), /Meta vision model/);
  assert.throws(() => buildCloudflareProvider({ accountId: 'a', apiToken: 'k', modelId: NVIDIA_VISION }), /Meta vision model/);
  assert.throws(() => buildGroqProvider({ apiKey: 'k', modelId: NVIDIA_VISION }), /Meta vision model/);
});

test('providerConfigured rejects a cross-provider model even with a key', () => {
  const saved = {
    nimApiKey: config.nimApiKey,
    nimEnabled: config.nimEnabled,
    nimModelId: config.nimModelId,
  };
  try {
    config.nimApiKey = 'nvapi-real-looking-key';
    config.nimEnabled = true;
    config.nimModelId = CLOUDFLARE_VISION;
    assert.equal(providerConfigured('nvidia-nim'), false);
  } finally {
    config.nimApiKey = saved.nimApiKey;
    config.nimEnabled = saved.nimEnabled;
    config.nimModelId = saved.nimModelId;
  }
});
