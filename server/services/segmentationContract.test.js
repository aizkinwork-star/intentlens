import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base64Bytes,
  buildAutomaticSamInput,
  normalizeReplicateOutput,
  parseImageDataUrl,
  selectMasksForPrompts,
  validateSegmentationRequest,
} from './segmentationContract.js';

const IMAGE = `data:image/png;base64,${Buffer.from('x'.repeat(64)).toString('base64')}`;
const AUTO = { automatic: true, boxPrompt: false, pointPrompt: false, textPrompt: false };
const PROMPTABLE = { automatic: false, boxPrompt: true, pointPrompt: true, textPrompt: false };

function codeOf(fn) {
  try { fn(); return 'NO_ERROR'; } catch (err) { return err.code; }
}

test('base64 size is estimated without decoding the payload', () => {
  assert.equal(base64Bytes(Buffer.from('1234').toString('base64')), 4);
  assert.equal(base64Bytes(''), 0);
});

test('a data URL is accepted and its size checked', () => {
  const parsed = parseImageDataUrl(IMAGE, { maxImageBytes: 1024 });
  assert.equal(parsed.mimeType, 'image/png');
  assert.equal(parsed.bytes, 64);
  assert.equal(codeOf(() => parseImageDataUrl(IMAGE, { maxImageBytes: 10 })), 'IMAGE_TOO_LARGE');
  assert.equal(codeOf(() => parseImageDataUrl('data:text/plain;base64,QQ==')), 'BAD_JSON');
});

test('a request may not contain both an inline image and a URL', () => {
  assert.equal(codeOf(() => validateSegmentationRequest({
    imageDataUrl: IMAGE,
    imageUrl: 'https://example.com/a.png',
  })), 'BAD_JSON');
});

test('plain HTTP image URLs are refused', () => {
  assert.equal(codeOf(() => validateSegmentationRequest({
    imageUrl: 'http://example.com/a.png',
  })), 'BAD_JSON');
});

test('normalized boxes infer box mode and clamp maxMasks', () => {
  const request = validateSegmentationRequest({
    imageDataUrl: IMAGE,
    boxes: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }],
    maxMasks: 999,
  }, { maxMasks: 8, capabilities: AUTO });
  assert.equal(request.mode, 'boxes');
  assert.equal(request.maxMasks, 8);
  assert.equal(request.promptStrategy, 'filter');
  assert.deepEqual(request.boxes[0], { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
});

test('pixel prompts require dimensions and are converted to fractions', () => {
  const request = validateSegmentationRequest({
    imageDataUrl: IMAGE,
    width: 200,
    height: 100,
    coordinateSpace: 'pixels',
    points: [[50, 25]],
  }, { capabilities: AUTO });
  assert.equal(request.mode, 'points');
  assert.deepEqual(request.points, [{ x: 0.25, y: 0.25, label: 1 }]);
  assert.equal(codeOf(() => validateSegmentationRequest({
    imageDataUrl: IMAGE,
    coordinateSpace: 'pixels',
    points: [[5, 5]],
  }, { capabilities: AUTO })), 'BAD_JSON');
});

test('native and filtered prompt strategies are reported honestly', () => {
  const body = { imageDataUrl: IMAGE, boxes: [{ x: 0, y: 0, w: 1, h: 1 }] };
  assert.equal(validateSegmentationRequest(body, { capabilities: AUTO }).promptStrategy, 'filter');
  assert.equal(validateSegmentationRequest(body, { capabilities: PROMPTABLE }).promptStrategy, 'native');
});

test('a model without text support rejects text prompts', () => {
  assert.equal(codeOf(() => validateSegmentationRequest({
    imageDataUrl: IMAGE,
    textPrompt: 'find the capacitor',
  }, { capabilities: AUTO })), 'SEGMENTATION_PROMPT_UNSUPPORTED');
});

test('out-of-range prompts are rejected rather than clipped silently', () => {
  assert.equal(codeOf(() => validateSegmentationRequest({
    imageDataUrl: IMAGE,
    boxes: [{ x: 0.9, y: 0.1, w: 0.5, h: 0.2 }],
  }, { capabilities: AUTO })), 'BAD_JSON');
  assert.equal(codeOf(() => validateSegmentationRequest({
    imageDataUrl: IMAGE,
    points: [[1.4, 0.5]],
  }, { capabilities: AUTO })), 'BAD_JSON');
});

test('Replicate automatic output is normalized to mask URLs', () => {
  const out = normalizeReplicateOutput({
    combined_mask: 'https://replicate.delivery/combined.png',
    individual_masks: [
      'https://replicate.delivery/mask0.png',
      { url: 'https://replicate.delivery/mask1.png', score: 0.91 },
      'https://replicate.delivery/mask0.png',
    ],
  });
  assert.equal(out.combinedMaskUrl, 'https://replicate.delivery/combined.png');
  assert.equal(out.masks.length, 2);
  assert.equal(out.masks[1].score, 0.91);
  assert.deepEqual(normalizeReplicateOutput(['https://a.example/m.png']).masks, [
    { url: 'https://a.example/m.png', score: null },
  ]);
  assert.equal(normalizeReplicateOutput({ masks: ['https://a.example/m.png'], scores: [0.7] }).masks[0].score, 0.7);
  assert.equal(normalizeReplicateOutput(null).masks.length, 0);
});

function mask(index, bbox, areaPixels, score = 0.5) {
  return { index, width: 100, height: 100, bbox, areaPixels, score };
}

test('a box prompt selects the proposal with the best overlap', () => {
  const request = {
    image: { width: 100, height: 100 },
    mode: 'boxes',
    boxes: [{ x: 0, y: 0, w: 0.5, h: 0.5 }],
    maxMasks: 4,
  };
  const masks = [
    mask(0, { x: 0, y: 0, width: 50, height: 50 }, 2500, 0.99),
    mask(1, { x: 60, y: 60, width: 30, height: 30 }, 900, 0.99),
    mask(2, { x: 0, y: 0, width: 90, height: 90 }, 8100, 0.99),
  ];
  const chosen = selectMasksForPrompts(masks, request);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].maskIndex, 0);
  assert.equal(chosen[0].method, 'box-overlap');
  assert.equal(chosen[0].score, 1);
});

test('a point prompt prefers the smallest proposal containing the point', () => {
  const request = {
    image: { width: 100, height: 100 },
    mode: 'points',
    points: [{ x: 0.25, y: 0.25, label: 1 }],
    maxMasks: 4,
  };
  const masks = [
    mask(0, { x: 0, y: 0, width: 80, height: 80 }, 1000, 0.99),
    mask(1, { x: 10, y: 10, width: 30, height: 30 }, 200, 0.50),
    mask(2, { x: 70, y: 70, width: 20, height: 20 }, 100, 0.99),
  ];
  const chosen = selectMasksForPrompts(masks, request);
  assert.equal(chosen[0].maskIndex, 1);
  assert.equal(chosen[0].method, 'point-contains');
});

test('automatic mode ranks by score, then area, and deduplicates', () => {
  const request = { image: { width: 100, height: 100 }, mode: 'auto', maxMasks: 2 };
  const masks = [
    mask(0, { x: 0, y: 0, width: 10, height: 10 }, 100, 0.2),
    mask(1, { x: 0, y: 0, width: 50, height: 50 }, 2500, 0.9),
    mask(2, { x: 60, y: 60, width: 20, height: 20 }, 400, 0.9),
  ];
  const chosen = selectMasksForPrompts(masks, request);
  assert.deepEqual(chosen.map((c) => c.maskIndex), [1, 2]);
});

test('a prompt that matches nothing returns no mask instead of the biggest one', () => {
  const request = {
    image: { width: 100, height: 100 },
    mode: 'boxes',
    boxes: [{ x: 0, y: 0, w: 0.1, h: 0.1 }],
    maxMasks: 4,
  };
  const chosen = selectMasksForPrompts([
    mask(0, { x: 80, y: 80, width: 10, height: 10 }, 100, 0.99),
  ], request);
  assert.deepEqual(chosen, []);
});

test('the automatic SAM input keeps the image and bounded generation settings', () => {
  const request = validateSegmentationRequest({ imageDataUrl: IMAGE }, { capabilities: AUTO });
  const input = buildAutomaticSamInput(request, { pointsPerSide: 999, maskLimit: 999 });
  assert.equal(input.image, IMAGE);
  assert.equal(input.points_per_side, 64);
  assert.equal(input.mask_limit, 64);
  assert.equal(input.multimask_output, false);
});
