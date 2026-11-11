// multiProvider.test.js — server configuration and adapter guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  config,
  isAllowedInferenceUrl,
  isAllowedOutboundHost,
  isKnownModel,
  isPlaceholderCredential,
  isVisionModel,
  modelModality,
  normalizeTier,
  providerConfigured,
  providerRuntime,
} from './server/config.js';
import { buildOpenAICompatibleProvider, chatCompletionsUrl } from './server/services/openaiCompatibleProvider.js';
import { buildGroqProvider } from './server/services/groqProvider.js';
import { buildNimProvider } from './server/services/nimProvider.js';
import { buildCloudflareProvider } from './server/services/cloudflareProvider.js';
import { buildAnthropicProvider } from './server/services/anthropicProvider.js';

function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withProviderState(providerId, patch, fn) {
  const original = config.providers[providerId];
  config.providers[providerId] = { ...original, ...patch };
  try { return fn(); } finally { config.providers[providerId] = original; }
}

test('placeholder credentials are rejected, real-looking values are not', () => {
  for (const value of ['', '   ', 'your_api_key', 'replace_me', 'change-me', 'placeholder', 'example_token', 'dummy', 'xxxx', 'sample key', '<api-key>']) {
    assert.equal(isPlaceholderCredential(value), true, JSON.stringify(value));
  }
  assert.equal(isPlaceholderCredential('nvapi-abcdefghijklmnop'), false);
  assert.equal(isPlaceholderCredential('sk-proj-1234567890'), false);
});

test('NVIDIA dashboard URLs still normalize to the inference origin', async () => {
  const { normalizeNimBaseUrl } = await import('./server/config.js');
  assert.equal(normalizeNimBaseUrl('https://build.nvidia.com'), 'https://integrate.api.nvidia.com');
  assert.equal(normalizeNimBaseUrl('http://integrate.api.nvidia.com'), 'https://integrate.api.nvidia.com');
  assert.equal(normalizeNimBaseUrl('https://evil.example.com'), 'https://integrate.api.nvidia.com');
});

test('known inference hosts and user relays follow the documented rules', () => {
  for (const url of [
    'https://integrate.api.nvidia.com/v1/chat/completions',
    'https://api.cloudflare.com/client/v4',
    'https://api.groq.com/openai/v1',
    'https://openrouter.ai/api/v1',
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    'https://api.mistral.ai/v1/chat/completions',
    'https://api.openai.com/v1/chat/completions',
    'https://api.anthropic.com/v1/messages',
    'https://team--intentlens.modal.run/v1/chat/completions',
  ]) {
    assert.equal(isAllowedOutboundHost(url), true, url);
  }
  assert.equal(isAllowedOutboundHost('http://integrate.api.nvidia.com'), false);
  assert.equal(isAllowedOutboundHost('https://integrate.api.nvidia.com.evil.example'), false);
  assert.equal(isAllowedOutboundHost('https://modal.run.evil.example'), false);
  assert.equal(isAllowedOutboundHost('not a url'), false);

  assert.equal(isAllowedInferenceUrl('https://relay.example.com/v1'), true);
  assert.equal(isAllowedInferenceUrl('http://localhost:11434'), true);
  assert.equal(isAllowedInferenceUrl('http://127.0.0.1:8080'), true);
  assert.equal(isAllowedInferenceUrl('http://relay.example.com'), false);
  assert.equal(isAllowedInferenceUrl('https://192.168.1.10/v1'), false);
  assert.equal(isAllowedInferenceUrl('https://10.0.0.5/v1'), false);
  assert.equal(isAllowedInferenceUrl('file:///etc/passwd'), false);
});

test('access tiers map to the registry and legacy free is preserved', () => {
  assert.equal(normalizeTier(undefined), 'paid');
  assert.equal(normalizeTier('free'), 'free');
  assert.equal(normalizeTier('preview'), 'preview');
  assert.equal(normalizeTier('enterprise'), 'paid');
});

test('legacy model helpers are provider-agnostic', () => {
  assert.equal(isKnownModel('meta/llama-3.2-11b-vision-instruct'), true);
  assert.equal(isKnownModel('qwen/qwen2.5-vl-72b-instruct'), true);
  assert.equal(isKnownModel('not-a-real-model'), false);
  assert.equal(isVisionModel('qwen/qwen2.5-vl-72b-instruct'), true);
  assert.equal(isVisionModel('llama-3.3-70b-versatile'), false);
  assert.equal(modelModality('llama-3.3-70b-versatile'), 'text');
});

test('a provider needs a real key plus a catalogued vision model', () => {
  withEnv({ NIM_MODEL_ID: 'meta/muse-glimmer-30b' }, () => {
    withProviderState('nvidia-nim', { enabled: true, apiKey: 'nvapi-real-looking-key' }, () => {
      assert.equal(providerConfigured('nvidia-nim'), true);
      withProviderState('nvidia-nim', { apiKey: 'your_nim_api_key' }, () => {
        assert.equal(providerConfigured('nvidia-nim'), false);
      });
      withProviderState('nvidia-nim', { enabled: false }, () => {
        assert.equal(providerConfigured('nvidia-nim'), false);
      });
    });
  });

  withEnv({ NIM_MODEL_ID: '@cf/meta/llama-3.2-11b-vision-instruct' }, () => {
    withProviderState('nvidia-nim', { enabled: true, apiKey: 'nvapi-real-looking-key' }, () => {
      assert.equal(providerConfigured('nvidia-nim'), false, 'cross-provider model must be refused');
    });
  });
});

test('a text-only selected model is never vision-configured', () => {
  withEnv({ GROQ_MODEL_ID: 'llama-3.3-70b-versatile', GROQ_VISION_MODEL: '', GROQ_TEXT_MODEL: '' }, () => {
    withProviderState('groq', { enabled: true, apiKey: 'gsk_real-looking-key' }, () => {
      assert.equal(providerConfigured('groq'), false);
    });
  });
  withEnv({ GROQ_MODEL_ID: 'meta-llama/llama-4-scout-17b-16e-instruct', GROQ_VISION_MODEL: '', GROQ_TEXT_MODEL: '' }, () => {
    withProviderState('groq', { enabled: true, apiKey: 'gsk_real-looking-key' }, () => {
      assert.equal(providerConfigured('groq'), true);
    });
  });
});

test('providerRuntime resolves a generic endpoint without exposing the key', () => {
  withEnv({ OPENROUTER_MODEL_ID: 'meta-llama/llama-4-maverick' }, () => {
    withProviderState('openrouter', { enabled: true, apiKey: 'sk-or-v1-secret', baseUrl: 'https://openrouter.ai/api/v1/chat/completions' }, () => {
      const runtime = providerRuntime('openrouter');
      assert.equal(runtime.id, 'openrouter');
      assert.equal(runtime.kind, 'openai');
      assert.equal(runtime.modelId, 'meta-llama/llama-4-maverick');
      assert.equal(runtime.endpoint, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(runtime.openWeight, true);
      assert.equal(JSON.stringify(runtime).includes('sk-or-v1-secret'), true, 'runtime is internal; routes must not return it');
    });
  });
});

test('OpenAI-compatible adapters refuse unknown, classifier and non-vision models', async () => {
  assert.throws(() => buildOpenAICompatibleProvider({
    id: 'openrouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: 'k',
    modelId: 'not-catalogued',
  }), /not in the .* catalogue/i);

  assert.throws(() => buildOpenAICompatibleProvider({
    id: 'groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: 'k',
    modelId: 'meta-llama/llama-guard-4-12b',
  }), /classifier/i);

  const textOnly = buildOpenAICompatibleProvider({
    id: 'groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: 'k',
    modelId: 'llama-3.3-70b-versatile',
  });
  await assert.rejects(
    () => textOnly.analyze({ instructions: 'x', userText: 'y', imageDataUrl: 'data:image/jpeg;base64,AAAA' }),
    /text-only/i,
  );
});

test('custom relays may serve an id outside the catalogue but still need a URL', () => {
  const provider = buildOpenAICompatibleProvider({
    id: 'custom',
    endpoint: 'https://relay.example.com/v1/chat/completions',
    modelId: 'my-own-vision-model',
    allowUnknownModel: true,
  });
  assert.equal(provider.modelId, 'my-own-vision-model');
  assert.equal(provider.capabilities.imageInput, true);
});

test('each adapter enforces its own provider catalogue', () => {
  assert.throws(
    () => buildNimProvider({ baseUrl: 'https://integrate.api.nvidia.com', apiKey: 'k', modelId: '@cf/meta/llama-3.2-11b-vision-instruct' }),
    /not in the .* catalogue/i,
  );
  assert.throws(
    () => buildCloudflareProvider({ accountId: 'a', apiToken: 'k', modelId: 'meta/llama-3.2-11b-vision-instruct' }),
    /not in the catalogue/i,
  );
  assert.throws(
    () => buildGroqProvider({ apiKey: 'k', modelId: 'meta/llama-3.2-11b-vision-instruct' }),
    /not in the .* catalogue/i,
  );
  assert.throws(
    () => buildAnthropicProvider({ apiKey: 'k', modelId: 'gpt-4o' }),
    /not in the catalogue/i,
  );
});

test('chat-completions URL resolution only accepts HTTPS or loopback HTTP', () => {
  assert.equal(chatCompletionsUrl('https://team--intentlens.modal.run'), 'https://team--intentlens.modal.run/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://team--intentlens.modal.run/v1'), 'https://team--intentlens.modal.run/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://relay.example/chat/completions'), 'https://relay.example/chat/completions');
  assert.equal(chatCompletionsUrl('http://team--intentlens.modal.run'), '');
  assert.equal(chatCompletionsUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1/chat/completions');
  assert.equal(chatCompletionsUrl('nonsense'), '');
});
