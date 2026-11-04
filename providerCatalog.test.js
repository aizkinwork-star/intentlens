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
import { buildOpenAICompatibleProvider, chatCompletionsUrl } from './server/services/openaiCompatibleProvider.js';

const NVIDIA_VISION = 'meta/llama-3.2-11b-vision-instruct';
const CLOUDFLARE_VISION = '@cf/meta/llama-3.2-11b-vision-instruct';
const GROQ_CLASSIFIER = 'meta-llama/llama-prompt-guard-2-86m';

test('every catalog entry is a Meta model with an explicit modality', () => {
  for (const [providerId, provider] of Object.entries(META_MODEL_CATALOG)) {
    assert.ok(provider.models, providerId);
    for (const [modelId, model] of Object.entries(provider.models)) {
      assert.ok(modelId.length > 0);
      assert.ok(['vision', 'text', 'classifier'].includes(model.modality), `${providerId}/${modelId}`);
      assert.ok(model.name.length > 0);
    }
  }
});

test('provider models are scoped to their own catalog', () => {
  assert.equal(providerSupportsVisionModel('nvidia-nim', NVIDIA_VISION), true);
  assert.equal(providerSupportsVisionModel('cloudflare-workers-ai', CLOUDFLARE_VISION), true);
  assert.equal(providerSupportsModel('groq', GROQ_CLASSIFIER), true);
  assert.equal(providerSupportsVisionModel('groq', GROQ_CLASSIFIER), false);

  assert.equal(providerSupportsModel('nvidia-nim', CLOUDFLARE_VISION), false);
  assert.equal(providerSupportsModel('cloudflare-workers-ai', NVIDIA_VISION), false);
  assert.equal(providerSupportsModel('groq', NVIDIA_VISION), false);
});

test('vision catalog reflects the live account findings', () => {
  assert.equal(providerSupportsVisionModel('nvidia-nim', 'meta/muse-glimmer-30b'), true);
  assert.equal(META_MODEL_CATALOG['nvidia-nim'].models['meta/muse-glimmer-30b'].verified, true);
  assert.equal(META_MODEL_CATALOG['nvidia-nim'].models[NVIDIA_VISION].verified, false);
  assert.equal(META_MODEL_CATALOG['nvidia-nim'].models['meta/llama-3.2-90b-vision-instruct'].verified, false);

  assert.equal(providerSupportsVisionModel('cloudflare-workers-ai', CLOUDFLARE_VISION), true);
  assert.equal(META_MODEL_CATALOG['cloudflare-workers-ai'].models[CLOUDFLARE_VISION].verified, true);
  assert.equal(
    META_MODEL_CATALOG['cloudflare-workers-ai'].models['@cf/meta/llama-4-scout-17b-16e-instruct'].verified,
    false,
  );

  // The supplied Groq account exposes no Meta chat or vision model.
  assert.equal(providerSupportsVisionModel('groq', GROQ_CLASSIFIER), false);
  assert.equal(providerSupportsModel('groq', 'llama-3.3-70b-versatile'), false);
  assert.equal(providerSupportsModel('groq', 'meta-llama/llama-4-scout-17b-16e-instruct'), false);
});

test('text-only and classifier Meta models are not vision eligible', () => {
  assert.equal(providerSupportsVisionModel('cloudflare-workers-ai', '@cf/meta/llama-3.1-8b-instruct'), false);
  assert.equal(providerSupportsVisionModel('cloudflare-workers-ai', '@cf/meta/llama-guard-3-8b'), false);
  assert.equal(providerSupportsVisionModel('groq', GROQ_CLASSIFIER), false);
});

test('adapters reject a model from another provider catalog', () => {
  assert.throws(() => buildNimProvider({ baseUrl: 'https://integrate.api.nvidia.com', apiKey: 'k', modelId: CLOUDFLARE_VISION }), /Meta vision model/);
  assert.throws(() => buildCloudflareProvider({ accountId: 'a', apiToken: 'k', modelId: NVIDIA_VISION }), /Meta vision model/);
  assert.throws(() => buildGroqProvider({ apiKey: 'k', modelId: GROQ_CLASSIFIER }), /Meta vision model/);
  assert.throws(() => buildGroqProvider({ apiKey: 'k', modelId: NVIDIA_VISION }), /Meta vision model/);
});

test('OpenAI-compatible adapter resolves user endpoints and enforces Meta vision', () => {
  assert.equal(
    chatCompletionsUrl('https://team--intentlens.modal.run'),
    'https://team--intentlens.modal.run/v1/chat/completions',
  );
  assert.equal(
    chatCompletionsUrl('https://team--intentlens.modal.run/v1'),
    'https://team--intentlens.modal.run/v1/chat/completions',
  );
  assert.equal(chatCompletionsUrl('http://team--intentlens.modal.run'), '');

  const provider = buildOpenAICompatibleProvider({
    id: 'modal',
    endpoint: 'https://team--intentlens.modal.run/v1/chat/completions',
    apiKey: 'real-looking-key',
    modelId: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct',
  });
  assert.equal(provider.id, 'modal');
  assert.equal(provider.capabilities.imageInput, true);

  assert.throws(() => buildOpenAICompatibleProvider({
    id: 'openrouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: 'k',
    modelId: 'openai/gpt-4o',
  }), /Meta vision model/);
});

test('providerConfigured requires credentials plus a catalogued vision model', () => {
  const saved = {
    nimApiKey: config.nimApiKey,
    nimEnabled: config.nimEnabled,
    nimModelId: config.nimModelId,
    cloudflareAccountId: config.cloudflareAccountId,
    cloudflareApiToken: config.cloudflareApiToken,
    cloudflareModelId: config.cloudflareModelId,
    openrouterApiKey: config.openrouterApiKey,
    openrouterModelId: config.openrouterModelId,
    blockrunApiKey: config.blockrunApiKey,
    blockrunModelId: config.blockrunModelId,
    modalApiKey: config.modalApiKey,
    modalBaseUrl: config.modalBaseUrl,
    modalModelId: config.modalModelId,
    groqApiKey: config.groqApiKey,
    groqVisionModel: config.groqVisionModel,
    accessTier: config.accessTier,
  };
  try {
    config.nimApiKey = 'nvapi-real-looking-key';
    config.nimEnabled = true;
    config.accessTier = 'free';

    config.nimModelId = 'meta/muse-glimmer-30b';
    assert.equal(providerConfigured('nvidia-nim'), true);

    // Catalogued vision model, not verified yet: still configurable so it can
    // be tested; the UI keeps showing the unverified warning.
    config.nimModelId = NVIDIA_VISION;
    assert.equal(providerConfigured('nvidia-nim'), true);

    config.nimModelId = CLOUDFLARE_VISION; // cross-provider model
    assert.equal(providerConfigured('nvidia-nim'), false);

    config.cloudflareAccountId = 'a'.repeat(32);
    config.cloudflareApiToken = 'real-looking-token';
    config.cloudflareModelId = '@cf/meta/llama-4-scout-17b-16e-instruct';
    assert.equal(providerConfigured('cloudflare-workers-ai'), true);

    config.cloudflareModelId = CLOUDFLARE_VISION;
    assert.equal(providerConfigured('cloudflare-workers-ai'), true);

    // OpenRouter's Meta models are paid: free access must not make it eligible.
    config.openrouterApiKey = 'sk-or-v1-real-looking-key';
    config.openrouterModelId = 'meta-llama/llama-4-maverick';
    assert.equal(providerConfigured('openrouter'), false);
    config.accessTier = 'paid';
    assert.equal(providerConfigured('openrouter'), true);
    config.openrouterModelId = 'openai/gpt-4o';
    assert.equal(providerConfigured('openrouter'), false);

    // BlockRun is catalogued and paid; the HTTP 402 key still configures it so
    // the desktop can retry after credit is added.
    config.blockrunApiKey = 'real-looking-blockrun-key';
    config.blockrunModelId = 'meta-llama/llama-4-maverick';
    assert.equal(providerConfigured('blockrun'), true);

    // Modal needs a user endpoint on an allowlisted *.modal.run host.
    config.modalApiKey = 'real-looking-modal-key';
    config.modalModelId = 'meta-llama/Llama-4-Maverick-17B-128E-Instruct';
    config.modalBaseUrl = 'https://demo--intentlens.modal.run';
    assert.equal(providerConfigured('modal'), true);
    config.modalBaseUrl = 'https://example.com';
    assert.equal(providerConfigured('modal'), false);

    // Groq still needs an explicit Meta vision model; the supplied account has none.
    config.groqApiKey = 'gsk_real-looking-key';
    config.groqVisionModel = '';
    assert.equal(providerConfigured('groq'), false);
  } finally {
    Object.assign(config, saved);
  }
});
