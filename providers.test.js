// Provider configuration helpers: placeholders, URL allowlisting and priority.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  config,
  isAllowedOutboundHost,
  isPlaceholderCredential,
  normalizeNimBaseUrl,
  providerConfigured,
} from './server/config.js';

test('placeholder credentials are rejected, real-looking values are not', () => {
  for (const value of [
    '', '   ', 'your_nim_api_key', 'replace_me', 'change-me', 'placeholder',
    'example_token', 'dummy', 'xxxx', 'sample key', '<api-key>',
  ]) {
    assert.equal(isPlaceholderCredential(value), true, JSON.stringify(value));
  }
  assert.equal(isPlaceholderCredential('nvapi-abcdefghijklmnop'), false);
  assert.equal(isPlaceholderCredential('sk-proj-1234567890'), false);
});

test('NVIDIA dashboard URLs normalize to the inference host', () => {
  assert.equal(normalizeNimBaseUrl('https://build.nvidia.com'), 'https://integrate.api.nvidia.com');
  assert.equal(normalizeNimBaseUrl('https://build.nvidia.com/some/page'), 'https://integrate.api.nvidia.com');
  assert.equal(normalizeNimBaseUrl('http://integrate.api.nvidia.com'), 'https://integrate.api.nvidia.com');
  assert.equal(normalizeNimBaseUrl('https://evil.example.com'), 'https://integrate.api.nvidia.com');
  assert.equal(normalizeNimBaseUrl('https://integrate.api.nvidia.com/v1'), 'https://integrate.api.nvidia.com');
});

test('outbound hosts are HTTPS and allowlisted only', () => {
  assert.equal(isAllowedOutboundHost('https://integrate.api.nvidia.com'), true);
  assert.equal(isAllowedOutboundHost('https://api.cloudflare.com/client/v4'), true);
  assert.equal(isAllowedOutboundHost('https://api.groq.com/openai/v1'), true);
  assert.equal(isAllowedOutboundHost('https://openrouter.ai/api/v1'), true);
  assert.equal(isAllowedOutboundHost('https://api.blockrun.ai/v1'), true);
  assert.equal(isAllowedOutboundHost('https://demo--intentlens.modal.run/v1/chat/completions'), true);
  assert.equal(isAllowedOutboundHost('http://integrate.api.nvidia.com'), false);
  assert.equal(isAllowedOutboundHost('https://integrate.api.nvidia.com.evil.example'), false);
  assert.equal(isAllowedOutboundHost('https://modal.run.evil.example'), false);
  assert.equal(isAllowedOutboundHost('not a url'), false);
});

test('default provider priority puts vision hosts first and text-only Groq last', () => {
  assert.deepEqual(
    (process.env.PROVIDER_PRIORITY || 'openrouter,cloudflare-workers-ai,nvidia-nim,blockrun,modal,groq')
      .split(',').map((s) => s.trim()).filter(Boolean),
    ['openrouter', 'cloudflare-workers-ai', 'nvidia-nim', 'blockrun', 'modal', 'groq'],
  );
  assert.ok(config.providerPriority.indexOf('openrouter') < config.providerPriority.indexOf('groq'));
});

test('placeholder keys never make a provider configured', () => {
  const saved = {
    nimApiKey: config.nimApiKey,
    nimEnabled: config.nimEnabled,
    nimModelId: config.nimModelId,
  };
  try {
    config.nimApiKey = 'your_nim_api_key';
    config.nimEnabled = true;
    config.nimModelId = 'meta/llama-3.2-11b-vision-instruct';
    assert.equal(providerConfigured('nvidia-nim'), false);
  } finally {
    config.nimApiKey = saved.nimApiKey;
    config.nimEnabled = saved.nimEnabled;
    config.nimModelId = saved.nimModelId;
  }
});
