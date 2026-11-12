import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { buildReplicateSamAdapter, mapReplicateStatus, REPLICATE_API_BASE } from './replicateSam.js';
import { validateSegmentationRequest } from './segmentationContract.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE = `data:image/png;base64,${Buffer.from('fake').toString('base64')}`;
const MASK_URL = 'https://replicate.delivery/pbxt/mask0.png';
const COMBINED_URL = 'https://replicate.delivery/pbxt/combined.png';

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

function maskPng(width = 4, height = 4) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(width + 1);
    for (let x = 0; x < width; x += 1) row[x + 1] = x < 2 && y < 2 ? 255 : 0;
    rows.push(row);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function imageResponse(buffer) {
  return new Response(buffer, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(buffer.length) },
  });
}

function baseRequest(extra = {}) {
  return validateSegmentationRequest({
    imageDataUrl: IMAGE,
    width: 4,
    height: 4,
    boxes: [{ x: 0, y: 0, w: 1, h: 1 }],
    ...extra,
  }, { capabilities: { automatic: true }, maxMasks: 4 });
}

function adapterWith(fetchImpl, overrides = {}) {
  return buildReplicateSamAdapter({
    apiToken: 'r8_test_token',
    modelId: 'meta/sam-2',
    version: 'fe97b453a6455861e3bac769b441ca1f1086110da7466dbb65cf1eecfd60dc83',
    fetchImpl,
    urlGuard: () => true,
    sleep: async () => {},
    pollIntervalMs: 1,
    maxWaitMs: 10_000,
    maxMaskBytes: 1024 * 1024,
    maxMasks: 4,
    ...overrides,
  });
}

test('a prediction that starts asynchronously is polled to success', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === `${REPLICATE_API_BASE}/predictions`) {
      assert.equal(options.headers.authorization, 'Bearer r8_test_token');
      assert.match(options.body, /fe97b453/);
      return jsonResponse({ id: 'p1', status: 'starting', urls: { get: `${REPLICATE_API_BASE}/predictions/p1` } }, 201);
    }
    if (url === `${REPLICATE_API_BASE}/predictions/p1`) {
      return jsonResponse({
        id: 'p1',
        status: 'succeeded',
        output: { combined_mask: COMBINED_URL, individual_masks: [MASK_URL] },
        metrics: { predict_time: 1.2 },
      });
    }
    if (url === MASK_URL) return imageResponse(maskPng());
    throw new Error(`unexpected ${url}`);
  };

  const result = await adapterWith(fetchImpl).predict(baseRequest());
  assert.equal(result.predictionId, 'p1');
  assert.equal(result.masks.length, 1);
  assert.equal(result.masks[0].width, 4);
  assert.equal(result.masks[0].areaPixels, 4);
  assert.deepEqual(result.masks[0].bbox, { x: 0, y: 0, width: 2, height: 2 });
  assert.equal(result.combinedMaskUrl, COMBINED_URL);
  assert.equal(result.metrics.predict_time, 1.2);
  assert.equal(calls.filter((c) => c.url === MASK_URL).length, 1);
});

test('the model endpoint is used when no version is pinned', async () => {
  let posted = null;
  const fetchImpl = async (url, options = {}) => {
    if (url === `${REPLICATE_API_BASE}/models/meta/sam-2/predictions`) {
      posted = JSON.parse(options.body);
      return jsonResponse({
        id: 'p2',
        status: 'succeeded',
        output: { individual_masks: [MASK_URL] },
      }, 201);
    }
    if (url === MASK_URL) return imageResponse(maskPng());
    throw new Error(`unexpected ${url}`);
  };
  const result = await adapterWith(fetchImpl, { version: '' }).predict(baseRequest());
  assert.equal(result.masks.length, 1);
  assert.deepEqual(Object.keys(posted), ['input']);
});

test('an authentication failure is mapped and never retried', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ detail: 'bad token' }, 401);
  };
  await assert.rejects(() => adapterWith(fetchImpl).predict(baseRequest()), (err) => {
    assert.equal(err.code, 'MODEL_AUTH_FAILED');
    assert.doesNotMatch(err.message, /r8_test_token/);
    return true;
  });
  assert.equal(calls, 1);
});

test('a failed prediction surfaces the provider error, scrubbed', async () => {
  const fetchImpl = async () => jsonResponse({
    id: 'p3',
    status: 'failed',
    error: 'CUDA out of memory r8_secretvalue',
  }, 201);
  await assert.rejects(() => adapterWith(fetchImpl).predict(baseRequest()), (err) => {
    assert.equal(err.code, 'SEGMENTATION_FAILED');
    assert.doesNotMatch(err.message, /r8_secretvalue/);
    return true;
  });
});

test('a mask larger than the byte ceiling is rejected', async () => {
  const fetchImpl = async (url) => {
    if (url === `${REPLICATE_API_BASE}/predictions`) {
      return jsonResponse({ id: 'p4', status: 'succeeded', output: { individual_masks: [MASK_URL] } }, 201);
    }
    return new Response(Buffer.alloc(200), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '200' },
    });
  };
  await assert.rejects(
    () => adapterWith(fetchImpl, { maxMaskBytes: 100 }).predict(baseRequest()),
    (err) => err.code === 'SEGMENTATION_MASK_INVALID',
  );
});

test('a non-PNG mask is rejected instead of being drawn', async () => {
  const fetchImpl = async (url) => {
    if (url === `${REPLICATE_API_BASE}/predictions`) {
      return jsonResponse({ id: 'p5', status: 'succeeded', output: { individual_masks: [MASK_URL] } }, 201);
    }
    return imageResponse(Buffer.from('not a png'));
  };
  await assert.rejects(
    () => adapterWith(fetchImpl).predict(baseRequest()),
    (err) => err.code === 'SEGMENTATION_MASK_INVALID',
  );
});

test('an aborted request stops before any mask is drawn', async () => {
  const fetchImpl = async (url) => {
    if (url === `${REPLICATE_API_BASE}/predictions`) {
      return jsonResponse({ id: 'p6', status: 'starting', urls: { get: `${REPLICATE_API_BASE}/predictions/p6` } }, 201);
    }
    return jsonResponse({ id: 'p6', status: 'succeeded', output: { individual_masks: [MASK_URL] } });
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => adapterWith(fetchImpl).predict(baseRequest(), { signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
});

test('promptable deployments receive native pixel boxes', async () => {
  let input = null;
  const fetchImpl = async (url, options = {}) => {
    if (url === `${REPLICATE_API_BASE}/predictions`) {
      input = JSON.parse(options.body).input;
      return jsonResponse({ id: 'p7', status: 'succeeded', output: { individual_masks: [MASK_URL] } }, 201);
    }
    return imageResponse(maskPng());
  };
  const request = validateSegmentationRequest({
    imageDataUrl: IMAGE,
    width: 100,
    height: 50,
    boxes: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.6 }],
  }, { capabilities: { boxPrompt: true, automatic: false } });
  await adapterWith(fetchImpl, { inputStyle: 'promptable' }).predict(request);
  assert.deepEqual(input.box, [10, 10, 50, 40]);
  assert.equal(input.points_per_side, undefined);
});

test('the health check accepts a real token response and hides failures', async () => {
  const good = await adapterWith(async () => jsonResponse({ username: 'tester' })).healthCheck();
  assert.equal(good.ok, true);
  assert.match(good.detail, /tester/);

  const bad = await adapterWith(async () => jsonResponse({ detail: 'nope' }, 401)).healthCheck();
  assert.equal(bad.ok, false);
  assert.doesNotMatch(bad.detail, /r8_test_token/);
});

test('status mapping keeps 4xx request errors non-retryable', () => {
  const err = mapReplicateStatus(422, 'bad input');
  assert.equal(err.code, 'MODEL_UPSTREAM_ERROR');
  assert.equal(err.badRequest, true);
  assert.equal(mapReplicateStatus(429, '').code, 'MODEL_RATE_LIMITED');
  assert.equal(mapReplicateStatus(402, '').code, 'MODEL_QUOTA_EXHAUSTED');
});
