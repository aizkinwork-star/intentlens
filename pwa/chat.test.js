import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildChatPrompt, buildComponentPrompt, COMPONENT_SCHEMA } from './prompt.js';
import {
  PROVIDERS,
  PROVIDER_HOSTS,
  OPENROUTER_MODELS,
  GROQ_TEXT_MODELS,
  callModel,
  callChatModel,
  modelFor,
  providerSupportsImages,
  modelAcceptsImages,
  PROVIDER_MODELS,
  isMetaModelId,
} from './provider.js';
import { cameraErrorMessage, computeCaptureSize } from './camera.js';
import { escapeHtml, safeHref } from './safe.js';
import { edgeMidpoints, polygonPointsAttribute } from './geometry.js';

const here = dirname(fileURLToPath(import.meta.url));

function fakeFetch(content = 'hello', model = 'returned-model') {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ model, choices: [{ message: { content } }] }),
    };
  };
  return { impl, calls };
}

test('text chat prompt never asks for or contains an image', () => {
  const { instructions, userText } = buildChatPrompt({
    projectContext: { project: 'Board A', summary: 'blink an LED' },
    history: [{ role: 'user', text: 'What is a resistor?' }],
    question: 'Which pin is ground?',
  });
  const text = `${instructions}\n${userText}`;
  assert.doesNotMatch(text, /image_url|base64|data:image/i);
  assert.match(userText, /None was sent/i);
  assert.match(userText, /Which pin is ground/);
  assert.match(userText, /What is a resistor/);
});

test('component prompt includes the exact answer schema', () => {
  const { instructions, userText } = buildComponentPrompt({
    capture: { width: 640, height: 480, gridSize: 64 },
    question: 'Where is the resistor?',
  });
  assert.match(`${instructions}\n${userText}`, /JSON Schema for the answer/);
  assert.match(userText, /"component"/);
  assert.match(userText, /"location"/);
  assert.ok(userText.includes(JSON.stringify(COMPONENT_SCHEMA)));
});

test('text chat request has a text-only content array and no image payload', async () => {
  const { impl, calls } = fakeFetch('A resistor limits current.');
  const result = await callChatModel({
    providerId: 'groq',
    apiKey: 'sentinel-key-chat-test',
    model: 'meta-llama/llama-3.3-70b-versatile',
    prompt: 'Hello',
    fetchImpl: impl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'A resistor limits current.');
  assert.equal(result.providerId, 'groq');
  assert.equal(result.host, 'api.groq.com');
  assert.match(result.endpoint, /api\.groq\.com\/openai\/v1\/chat\/completions/);
  assert.match(result.requestId, /^pwa_/);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.mode, 'chat');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.messages.length, 1);
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'Hello' }]);
  assert.equal(body.messages[0].content.some((part) => part.type === 'image_url'), false);
  assert.equal(body.max_tokens, 3072);
  assert.equal(body.response_format, undefined);
  assert.equal(body.reasoning, undefined);
  assert.equal(calls[0].url.includes('sentinel-key-chat-test'), false);
  assert.equal(JSON.stringify(result).includes('sentinel-key-chat-test'), false);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sentinel-key-chat-test');
});

test('vision request does include one image_url when an image is passed', async () => {
  const { impl, calls } = fakeFetch('{"ok":true}');
  const result = await callModel({
    providerId: 'openrouter',
    apiKey: 'sentinel-key-vision-test',
    prompt: 'describe',
    imageDataUrl: 'data:image/jpeg;base64,AAAA',
    fetchImpl: impl,
  });
  assert.equal(result.mode, 'vision');
  assert.equal(result.imageAttached, true);
  assert.equal(result.host, 'openrouter.ai');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, PROVIDERS.openrouter.defaultModel);
  assert.equal(body.max_tokens, 8192);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  // The paid Meta default is not a reasoning model, so no reasoning hint is sent.
  assert.equal(body.reasoning, undefined);
  const imageParts = body.messages[0].content.filter((part) => part.type === 'image_url');
  assert.equal(imageParts.length, 1);
  assert.equal(imageParts[0].image_url.url, 'data:image/jpeg;base64,AAAA');
  assert.equal(calls[0].url.includes('sentinel-key-vision-test'), false);
});

test('a text-only provider or model refuses an image before any network call', async () => {
  let called = 0;
  const impl = async () => { called += 1; throw new Error('must not be called'); };

  // Groq has no default: without an explicitly chosen model nothing is sent.
  const groq = await callModel({
    providerId: 'groq',
    apiKey: 'sentinel-key',
    prompt: 'describe',
    imageDataUrl: 'data:image/jpeg;base64,AAAA',
    fetchImpl: impl,
  });
  assert.equal(groq.ok, false);
  assert.equal(groq.code, 'NO_MODEL');

  // A catalogued text-only Groq model is refused for images.
  const groqText = await callModel({
    providerId: 'groq',
    apiKey: 'sentinel-key',
    model: 'meta-llama/llama-3.3-70b-versatile',
    prompt: 'describe',
    imageDataUrl: 'data:image/jpeg;base64,AAAA',
    fetchImpl: impl,
  });
  assert.equal(groqText.ok, false);
  assert.equal(groqText.code, 'VISION_UNSUPPORTED'); // Groq never gets an image

  const textModel = await callModel({
    providerId: 'openrouter',
    apiKey: 'sentinel-key',
    model: 'meta-llama/llama-3.3-70b-instruct',
    accessTier: 'paid',
    prompt: 'describe',
    imageDataUrl: 'data:image/jpeg;base64,AAAA',
    fetchImpl: impl,
  });
  assert.equal(textModel.ok, false);
  assert.equal(textModel.code, 'MODEL_TEXT_ONLY');
  assert.equal(called, 0);
});

test('a paid model is refused if access is explicitly narrowed to free, before the network', async () => {
  let called = 0;
  const impl = async () => { called += 1; throw new Error('must not be called'); };
  const result = await callModel({
    providerId: 'openrouter',
    apiKey: 'sentinel-key',
    model: 'meta-llama/llama-4-maverick',
    accessTier: 'free',
    prompt: 'describe',
    imageDataUrl: 'data:image/jpeg;base64,AAAA',
    fetchImpl: impl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_ACCESS_LOCKED');
  assert.equal(called, 0);
});

test('a typed model id is sent verbatim in the request body', async () => {
  const { impl, calls } = fakeFetch();
  const typed = 'meta-llama/llama-4-future-vision';
  const result = await callModel({
    providerId: 'openrouter',
    apiKey: 'sentinel-key',
    model: typed,
    prompt: 'describe',
    imageDataUrl: 'data:image/jpeg;base64,AAAA',
    fetchImpl: impl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, typed);
  assert.equal(JSON.parse(calls[0].init.body).model, typed);
});

test('provider presets expose every host and label the browser-blocked ones', () => {
  assert.equal(PROVIDERS.openrouter.browserCors, 'verified-allowed');
  assert.equal(PROVIDERS.groq.browserCors, 'verified-allowed');
  assert.equal(PROVIDERS.openrouter.defaultModel, 'meta-llama/llama-4-maverick');
  assert.ok(PROVIDERS.openrouter.defaultModel in OPENROUTER_MODELS);
  assert.equal(OPENROUTER_MODELS[PROVIDERS.openrouter.defaultModel].vision, true);
  assert.equal(OPENROUTER_MODELS[PROVIDERS.openrouter.defaultModel].tier, 'paid');

  // Groq: text-only, no default, no image input.
  assert.equal(PROVIDERS.groq.vision, 'none');
  assert.equal(PROVIDERS.groq.defaultModel, '');
  assert.equal(PROVIDERS.groq.previewDefaultModel, undefined);
  assert.equal(GROQ_TEXT_MODELS['meta-models/muse-spark-open'].tier, 'preview');
  assert.equal(GROQ_TEXT_MODELS['meta-llama/llama-3.3-70b-versatile'].vision, false);
  assert.equal(GROQ_TEXT_MODELS['meta-llama/llama-3.3-70b-versatile'].tier, 'enterprise');
  assert.equal(providerSupportsImages('groq'), false);
  assert.equal(providerSupportsImages('openrouter'), true);
  assert.equal(modelAcceptsImages('openrouter', 'meta-llama/llama-4-maverick'), true);
  assert.equal(modelAcceptsImages('openrouter', 'meta-llama/llama-3.3-70b-instruct'), false);
  assert.equal(modelAcceptsImages('groq', ''), false);

  // Restored desktop-capable providers stay visible with their endpoint and reason.
  assert.equal(PROVIDERS['nvidia-nim'].endpoint, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(PROVIDERS['cloudflare-workers-ai'].unavailableInBrowser, true);
  assert.equal(PROVIDERS.blockrun.endpoint, 'https://api.blockrun.ai/v1/chat/completions');
  assert.match(PROVIDERS.blockrun.note, /402/);
  assert.match(PROVIDERS.modal.note, /NOT tested/i);
  assert.deepEqual(PROVIDER_HOSTS, [
    'openrouter.ai',
    'api.groq.com',
    'integrate.api.nvidia.com',
    'api.cloudflare.com',
    'api.blockrun.ai',
  ]);
  assert.equal(modelFor('custom', ''), PROVIDERS.custom.defaultModel);
  assert.equal(modelFor('custom', 'my-model'), 'my-model');
});

test('every catalogued phone model is Meta, and no Groq model accepts images', () => {
  for (const catalogue of Object.values(PROVIDER_MODELS)) {
    for (const id of Object.keys(catalogue)) assert.equal(isMetaModelId(id), true, id);
  }
  for (const info of Object.values(GROQ_TEXT_MODELS)) assert.equal(info.vision, false);
});

test('a browser-blocked provider refuses before any network call and names its endpoint', async () => {
  let called = 0;
  const impl = async () => { called += 1; throw new Error('must not be called'); };
  const result = await callModel({
    providerId: 'nvidia-nim',
    apiKey: 'sentinel-key',
    prompt: 'describe',
    imageDataUrl: 'data:image/jpeg;base64,AAAA',
    fetchImpl: impl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_CORS_BLOCKED');
  assert.match(result.message, /integrate\.api\.nvidia\.com/);
  assert.match(result.message, /desktop|relay/i);
  assert.equal(called, 0);
});

test('a network failure never echoes the sentinel key or the Authorization header', async () => {
  const sentinel = 'sentinel-key-never-log';
  const result = await callModel({
    providerId: 'groq',
    apiKey: sentinel,
    model: 'meta-llama/llama-3.3-70b-versatile',
    prompt: 'x',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assert.match(result.message, /Network failure/i);
});

test('camera errors map to recoverable messages and capture uses true frame size', () => {
  assert.match(cameraErrorMessage({ name: 'NotAllowedError' }), /permission was denied/i);
  assert.match(cameraErrorMessage({ name: 'NotFoundError' }), /No camera/i);
  assert.match(cameraErrorMessage({ name: 'NotReadableError' }), /busy or unreadable/i);
  assert.match(cameraErrorMessage({ name: 'OverconstrainedError' }), /cannot satisfy/i);
  assert.match(cameraErrorMessage({ name: 'AbortError' }), /interrupted/i);

  const landscape = computeCaptureSize(1920, 1080, 1600);
  assert.deepEqual({ width: landscape.width, height: landscape.height, portrait: landscape.portrait }, {
    width: 1600,
    height: 900,
    portrait: false,
  });
  assert.equal(computeCaptureSize(0, 0), null);
});

test('four edge midpoints are mathematically correct and no fill is requested', () => {
  const corners = [
    { x: 0.1, y: 0.2 }, { x: 0.9, y: 0.2 },
    { x: 0.9, y: 0.8 }, { x: 0.1, y: 0.8 },
  ];
  const mids = edgeMidpoints(corners);
  assert.deepEqual(mids.map((p) => Number(p.x.toFixed(2))), [0.5, 0.9, 0.5, 0.1]);
  assert.deepEqual(mids.map((p) => Number(p.y.toFixed(2))), [0.2, 0.5, 0.8, 0.5]);
  assert.equal(polygonPointsAttribute(corners), '100,200 900,200 900,800 100,800');
});

test('untrusted text is escaped and javascript URLs are rejected', () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
  );
  assert.equal(safeHref('javascript:alert(1)'), '#');
  assert.equal(safeHref('data:text/html,<script>'), '#');
  assert.equal(safeHref('https://example.com'), 'https://example.com');
});

test('PWA sources never persist an API key and always clear legacy slots', () => {
  const app = readFileSync(join(here, 'app.js'), 'utf8');
  assert.doesNotMatch(app, /setSetting\(\s*['"]apiKey['"]/);
  assert.doesNotMatch(app, /setSetting\(\s*['"]rememberKey['"]/);
  assert.doesNotMatch(app, /state\.rememberKey/);
  assert.match(app, /deleteSetting\(['"]apiKey['"]\)/);
  assert.match(app, /deleteSetting\(['"]rememberKey['"]\)/);
});

test('every provider call is wired to an in-memory request log', () => {
  const app = readFileSync(join(here, 'app.js'), 'utf8');
  const html = readFileSync(join(here, 'index.html'), 'utf8');

  assert.match(app, /function recordRequest\(/);
  assert.match(app, /function renderRequestLog\(/);
  assert.match(app, /function clearRequestLog\(/);
  assert.match(app, /recordRequest\(response\)/);
  assert.match(app, /recordRequest\(result\)/);
  assert.match(app, /endpoint/);
  assert.match(app, /host/);
  assert.match(app, /requestId/);
  assert.match(app, /imageAttached/);

  assert.match(html, /id="requestLog"/);
  assert.match(html, /id="requestLogCount"/);
  assert.match(html, /id="clearLogBtn"/);
  assert.match(html, /Provider request log/);

  // The log is memory-only and must not write the key anywhere.
  assert.doesNotMatch(app, /localStorage\.setItem\([^)]*apiKey/i);
  assert.doesNotMatch(app, /sessionStorage\.setItem\([^)]*apiKey/i);
  assert.match(app, /state\.requestLog = \[\]/);
});

test('phone CSP permits user endpoints and the full provider list stays visible', () => {
  const html = readFileSync(join(here, 'index.html'), 'utf8');
  assert.match(html, /connect-src 'self' https:/);
  assert.match(html, /blockrun/i);
  const sw = readFileSync(join(here, 'sw.js'), 'utf8');
  assert.match(sw, /intentlens-pwa-v\d+/);
});

test('service worker refuses authorization-bearing and cross-origin requests', () => {
  const sw = readFileSync(join(here, 'sw.js'), 'utf8');
  assert.match(sw, /request\.headers\.has\(['"]authorization['"]\)/);
  assert.match(sw, /url\.origin !== self\.location\.origin/);
  assert.match(sw, /request\.method !== 'GET'/);
  assert.doesNotMatch(sw, /api\.groq\.com|openrouter\.ai/);
});

test('a deployed worker change reloads the old shell exactly once', () => {
  const app = readFileSync(join(here, 'app.js'), 'utf8');
  assert.match(app, /addEventListener\(['"]controllerchange['"]/);
  assert.match(app, /registration\.update\(\)/);
  assert.match(app, /hadController/);
  assert.match(app, /register\(['"]\.\/sw\.js['"],\s*\{\s*updateViaCache:\s*['"]none['"]\s*\}\)/);
});

test('a new shell cache bypasses the HTTP cache instead of copying stale assets', () => {
  const sw = readFileSync(join(here, 'sw.js'), 'utf8');
  assert.match(sw, /cache:\s*['"]reload['"]/);
  assert.match(sw, /cache\.put\(url, response\)/);
});
