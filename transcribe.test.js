// Local speech-to-text route tests: URL safety and multipart shape.
// Run with: node scripts/run-source-tests.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackUrl, isLoopbackHost } from './server/config.js';
import { buildMultipart, transcribeStatus } from './server/routes/transcribe.js';
import { envFileCandidates } from './server/lib/env.js';

test('local STT accepts only loopback hosts', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:8080/inference'), true);
  assert.equal(isLoopbackUrl('http://localhost:9000/v1/audio/transcriptions'), true);
  assert.equal(isLoopbackUrl('http://[::1]:8080/inference'), true);
  assert.equal(isLoopbackUrl('https://127.0.0.1:8443/v1/audio/transcriptions'), true);

  assert.equal(isLoopbackUrl('https://api.openai.com/v1/audio/transcriptions'), false);
  assert.equal(isLoopbackUrl('http://192.168.1.50:8080/inference'), false);
  assert.equal(isLoopbackUrl('http://localhost.evil.example/inference'), false);
  assert.equal(isLoopbackUrl('file:///tmp/whisper'), false);
  assert.equal(isLoopbackUrl(''), false);
  assert.equal(isLoopbackUrl('not a url'), false);
});

test('loopback host matching does not accept suffix tricks', () => {
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('LOCALHOST'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.0.0.1.evil.example'), false);
  assert.equal(isLoopbackHost('localhost.evil.example'), false);
});

test('transcribe status never exposes a key and reports configuration', () => {
  const status = transcribeStatus();
  assert.equal(typeof status.configured, 'boolean');
  assert.equal(typeof status.model, 'string');
  assert.equal(Object.prototype.hasOwnProperty.call(status, 'sttApiKey'), false);
  assert.equal(JSON.stringify(status).includes('Bearer'), false);
  if (status.url) {
    assert.match(status.url, /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/);
  }
});

test('multipart body carries the audio as a file field', () => {
  const audio = Buffer.from([1, 2, 3, 4, 5]);
  const { boundary, body } = buildMultipart(audio, 'audio/webm;codecs=opus');
  assert.ok(body.length > audio.length);
  const head = body.subarray(0, 400).toString('utf8');
  assert.ok(head.includes(`--${boundary}`));
  assert.ok(head.includes('name="file"'));
  assert.ok(head.includes('filename="clip.webm"'));
  assert.ok(head.includes('Content-Type: audio/webm;codecs=opus'));
  assert.ok(body.subarray(Math.max(0, body.length - 100)).toString('utf8').includes(`--${boundary}--`));
  assert.ok(body.includes(audio));
});

test('the desktop app can read .env from its per-user config directory', () => {
  const previous = process.env.INTENTLENS_CONFIG_DIR;
  process.env.INTENTLENS_CONFIG_DIR = 'C:/tmp/intentlens-config';
  try {
    const files = envFileCandidates().map((f) => f.replace(/\\/g, '/'));
    assert.ok(files.includes('C:/tmp/intentlens-config/.env'), files.join(', '));
    assert.ok(files.some((f) => f.endsWith('/.env')));
  } finally {
    if (previous === undefined) delete process.env.INTENTLENS_CONFIG_DIR;
    else process.env.INTENTLENS_CONFIG_DIR = previous;
  }
});
