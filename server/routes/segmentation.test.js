import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSegmentationMask, handleSegmentationRun } from './segmentation.js';

const IMAGE = `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`;
const SEG_ID = `seg_${'a'.repeat(24)}`;

function fakeRes() {
  const res = {
    writableEnded: false,
    statusCode: null,
    headers: null,
    body: '',
    writeHead(code, headers) {
      res.statusCode = code;
      res.headers = headers;
    },
    end(body) {
      res.body = body ?? '';
      res.writableEnded = true;
    },
    on() {},
    off() {},
  };
  return res;
}

function fakeReq() {
  return { on() {}, off() {} };
}

function config(overrides = {}) {
  return {
    allowOutboundNetwork: true,
    maxImageBytes: 1024,
    maxBodyBytes: 1024,
    sam2: {
      enabled: true,
      apiToken: 'r8_test_token',
      modelId: 'meta/sam-2',
      version: '',
      inputStyle: 'automatic',
      maxMasks: 4,
      maxMaskBytes: 1024,
      maxWaitMs: 1000,
      timeoutMs: 1000,
      pollIntervalMs: 1,
      pointsPerSide: 16,
      costPerRunUsd: 0.01,
      ...overrides,
    },
  };
}

function fakeCost({ remainingUsd = 1, maxRequestUsd = 0.25 } = {}) {
  const entries = [];
  return {
    entries,
    getBudget: () => ({ maxRequestUsd }),
    snapshot: () => ({ remainingUsd }),
    record: (entry) => entries.push(entry),
  };
}

function fakeStore() {
  const saved = [];
  return {
    saved,
    createId: () => SEG_ID,
    save: (id, index, buffer) => saved.push({ id, index, buffer }),
    read: () => null,
    remove: () => true,
    sweep: () => 0,
  };
}

function fakeAdapter(masks, calls = { count: 0 }) {
  return {
    calls,
    async predict() {
      calls.count += 1;
      return {
        predictionId: 'pred_1',
        modelId: 'meta/sam-2',
        version: null,
        inputStyle: 'automatic',
        elapsedMs: 12,
        masks,
        combinedMaskUrl: null,
      };
    },
  };
}

function boxMask({ bbox = { x: 0, y: 0, width: 2, height: 2 }, width = 4, height = 4 } = {}) {
  return {
    index: 0,
    buffer: Buffer.from('png'),
    width,
    height,
    decoded: true,
    areaPixels: 4,
    coverage: 0.25,
    bbox,
    centroid: { x: 1, y: 1 },
    score: 0.9,
  };
}

async function run(body, { cfg = config(), cost = fakeCost(), store = fakeStore(), adapter = fakeAdapter([boxMask()]) } = {}) {
  const res = fakeRes();
  await handleSegmentationRun(fakeReq(), res, {
    config: cfg,
    cost,
    store,
    adapter,
    body,
  });
  return { res, payload: res.body ? JSON.parse(res.body) : null, cost, store, adapter };
}

test('a successful prompt is returned as a same-origin mask URL', async () => {
  const { res, payload, cost, store } = await run({
    imageDataUrl: IMAGE,
    width: 4,
    height: 4,
    boxes: [{ x: 0, y: 0, w: 1, h: 1 }],
    maxMasks: 2,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.segmentationId, SEG_ID);
  assert.equal(payload.masks.length, 1);
  assert.equal(payload.masks[0].url, `/api/segmentation/${SEG_ID}/mask/0`);
  assert.equal(payload.masks[0].method, 'box-overlap');
  assert.equal(payload.masks[0].bbox.width, 2);
  assert.equal(payload.provenance.promptStrategy, 'filter');
  assert.equal(payload.provenance.maskCount, 1);
  assert.equal(store.saved.length, 1);
  assert.equal(cost.entries.length, 1);
  assert.equal(cost.entries[0].costUsd, 0.01);
  assert.doesNotMatch(res.body, /r8_test_token/);
});

test('disabled segmentation fails with a clear 503 and no provider call', async () => {
  const adapter = fakeAdapter([boxMask()]);
  const { res, payload } = await run(
    { imageDataUrl: IMAGE, width: 4, height: 4 },
    { cfg: config({ enabled: false }), adapter },
  );
  assert.equal(res.statusCode, 503);
  assert.equal(payload.error.code, 'SEGMENTATION_DISABLED');
  assert.equal(adapter.calls.count, 0);
});

test('the flat per-run cost is checked before the provider is called', async () => {
  const adapter = fakeAdapter([boxMask()]);
  const { res, payload } = await run(
    { imageDataUrl: IMAGE, width: 4, height: 4 },
    { cost: fakeCost({ remainingUsd: 0.001 }), adapter },
  );
  assert.equal(res.statusCode, 402);
  assert.equal(payload.error.code, 'BUDGET_EXCEEDED');
  assert.equal(adapter.calls.count, 0);
});

test('a box that matches no proposal returns an empty result, not a wrong mask', async () => {
  const { res, payload, store } = await run({
    imageDataUrl: IMAGE,
    width: 100,
    height: 100,
    boxes: [{ x: 0, y: 0, w: 0.1, h: 0.1 }],
  }, {
    adapter: fakeAdapter([boxMask({ bbox: { x: 80, y: 80, width: 10, height: 10 }, width: 100, height: 100 })]),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(payload.masks, []);
  assert.equal(payload.reason, 'no_mask_matched_prompt');
  assert.equal(store.saved.length, 0);
});

test('a missing mask file returns 404, and a present one is served as PNG', async () => {
  const missing = fakeRes();
  await handleSegmentationMask(fakeReq(), missing, SEG_ID, 0, { store: fakeStore() });
  assert.equal(missing.statusCode, 404);
  assert.equal(JSON.parse(missing.body).error.code, 'NOT_FOUND');

  const found = fakeRes();
  const store = { read: () => Buffer.from('png-bytes') };
  await handleSegmentationMask(fakeReq(), found, SEG_ID, 0, { store });
  assert.equal(found.statusCode, 200);
  assert.equal(found.headers['content-type'], 'image/png');
  assert.equal(found.body.toString(), 'png-bytes');
});
