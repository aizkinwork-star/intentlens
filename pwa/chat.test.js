import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildChatPrompt } from './prompt.js';
import {
  PROVIDERS,
  PROVIDER_HOSTS,
  OPENROUTER_MODELS,
  callModel,
  callChatModel,
  modelFor,
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

test('text chat request has a text-only content array and no image payload', async () => {
  const { impl, calls } = fakeFetch('A resistor limits current.');
  const result = await callChatModel({
    providerId: 'groq',
    apiKey: 'sentinel-key-chat-test',
    model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    prompt: 'Hello',
    fetchImpl: impl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'A resistor limits current.');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.messages.length, 1);
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'Hello' }]);
  assert.equal(body.messages[0].content.some((part) => part.type === 'image_url'), false);
  assert.equal(calls[0].url.includes('sentinel-key-chat-test'), false);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sentinel-key-chat-test');
});

test('vision request does include one image_url when an image is passed', async () => {
  const { impl, calls } = fakeFetch('{"ok":true}');
  await callModel({
    providerId: 'openrouter',
    apiKey: 'sentinel-key-vision-test',
    prompt: 'describe',
    imageDataUrl: 'data:image/jpeg;base64,AAAA',
    fetchImpl: impl,
  });
  const body = JSON.parse(calls[0].init.body);
  const imageParts = body.messages[0].content.filter((part) => part.type === 'image_url');
  assert.equal(imageParts.length, 1);
  assert.equal(imageParts[0].image_url.url, 'data:image/jpeg;base64,AAAA');
  assert.equal(calls[0].url.includes('sentinel-key-vision-test'), false);
});

test('provider presets have honest capability and consent metadata', () => {
  assert.match(PROVIDERS.groq.defaultModel, /maverick/i);
  assert.doesNotMatch(PROVIDERS.groq.defaultModel, /scout/i);
  assert.equal(PROVIDERS.blockrun.consent, true);
  assert.equal(PROVIDERS.blockrun.vision, 'disputed');
  assert.match(PROVIDERS.blockrun.retention, /retained until deletion/i);
  assert.equal(PROVIDERS.openrouter.browserCors, 'allowed');
  assert.equal(PROVIDERS.blockrun.browserCors, 'blocked-observed');
  assert.ok(PROVIDER_HOSTS.includes('api.groq.com'));
  assert.ok(PROVIDER_HOSTS.includes('openrouter.ai'));
  assert.ok(PROVIDERS.openrouter.defaultModel in OPENROUTER_MODELS);
  assert.equal(modelFor('blockrun', ''), 'nvidia/llama-3.2-11b-vision');
});

test('a network failure never echoes the sentinel key or the Authorization header', async () => {
  const sentinel = 'sentinel-key-never-log';
  const result = await callModel({
    providerId: 'groq',
    apiKey: sentinel,
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

test('service worker refuses authorization-bearing and cross-origin requests', () => {
  const sw = readFileSync(join(here, 'sw.js'), 'utf8');
  assert.match(sw, /request\.headers\.has\(['"]authorization['"]\)/);
  assert.match(sw, /url\.origin !== self\.location\.origin/);
  assert.match(sw, /request\.method !== 'GET'/);
  assert.doesNotMatch(sw, /api\.groq\.com|openrouter\.ai|blockrun\.ai/);
});
