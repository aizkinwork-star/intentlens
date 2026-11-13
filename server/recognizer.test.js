// server/recognizer.test.js — the local recogniser must be honest about what it
// can and cannot do. No provider, key or network is involved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { recognizerStatus, recognizePng, resetRecognizerForTests } from './services/componentRecognizer.js';
import { recognizerClassifyHandler } from './routes/recognizer.js';

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const oneShotDirs = [];

function emptyModelDir() {
  const dir = mkdtempSync(join(tmpdir(), 'intentlens-recognizer-'));
  oneShotDirs.push(dir);
  return dir;
}

function withModelDir(dir, fn) {
  const saved = process.env.COMPONENT_MODEL_DIR;
  process.env.COMPONENT_MODEL_DIR = dir;
  resetRecognizerForTests();
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.COMPONENT_MODEL_DIR;
    else process.env.COMPONENT_MODEL_DIR = saved;
    resetRecognizerForTests();
  }
}

test.after(() => {
  for (const dir of oneShotDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function fakeRes() {
  return {
    status: 0,
    detailed: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { this.body = String(chunk || ''); },
  };
}

function fakeReq(payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const stream = Readable.from([body]);
  stream.headers = { 'content-length': String(body.length), 'content-type': 'application/json' };
  return stream;
}

test('status is honest when the model files are missing', () => {
  withModelDir(emptyModelDir(), () => {
    const status = recognizerStatus();
    assert.equal(status.available, false);
    assert.equal(status.loaded, false);
    assert.equal(status.model, null);
    assert.match(status.modelDir, /intentlens-recognizer-/);
    assert.match(status.note, /confirmation/i);
  });
});

test('status reports a model file without metadata as unavailable', () => {
  const dir = emptyModelDir();
  writeFileSync(join(dir, 'component_classifier.onnx'), Buffer.from('not-really-onnx'));
  withModelDir(dir, () => {
    const status = recognizerStatus();
    assert.equal(status.modelFile, true);
    assert.equal(status.metaFile, false);
    assert.equal(status.available, false);
    assert.equal(status.model, null);
  });
});

test('a JPEG crop is refused rather than silently classified', async () => {
  const out = await recognizePng(JPEG_BYTES);
  assert.equal(out.available, false);
  assert.equal(out.reason, 'not_a_png');
  assert.deepEqual(out.candidates, []);
});

test('a corrupt PNG is refused with a decode reason and no candidates', async () => {
  const out = await recognizePng(Buffer.concat([PNG_SIGNATURE, Buffer.from('broken')]));
  assert.equal(out.available, false);
  assert.match(out.reason, /decode|truncated|chunk|png/i);
  assert.deepEqual(out.candidates, []);
});

test('the classify route rejects a non-PNG data URL without loading a model', async () => {
  const res = fakeRes();
  await recognizerClassifyHandler(
    fakeReq({ dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' }),
    res,
  );
  assert.equal(res.status, 400);
  const payload = JSON.parse(res.body);
  assert.equal(payload.error.code, 'BAD_JSON');
  assert.match(payload.error.message, /PNG/);
});

test('the classify route rejects an empty body', async () => {
  const res = fakeRes();
  const stream = Readable.from([Buffer.from('')]);
  stream.headers = { 'content-length': '0' };
  await recognizerClassifyHandler(stream, res);
  assert.equal(res.status, 400);
  const payload = JSON.parse(res.body);
  assert.equal(payload.error.code, 'BAD_JSON');
});

test('the classify route never calls a provider or the network', async () => {
  const res = fakeRes();
  const savedFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (...args) => { fetchCalls += 1; return savedFetch(...args); };
  try {
    await recognizerClassifyHandler(fakeReq({ dataUrl: 'not-a-data-url' }), res);
  } finally {
    globalThis.fetch = savedFetch;
  }
  assert.equal(fetchCalls, 0);
  assert.ok(res.status >= 400);
});
