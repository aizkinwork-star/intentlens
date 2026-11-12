// server/services/segmentationContract.js — validation and ranking for hosted
// segmentation (SAM) requests.
//
// This module is pure. It does not call a provider, read a file or know about
// HTTP. The route and the provider adapter both use it so the browser, the
// server and the tests agree on one contract:
//
//   request:  an image (data URL or HTTPS URL) + optional normalized prompts
//   response: mask PNGs with pixel metadata + provenance
//
// Coordinates crossing this boundary are normalized to 0..1 unless the caller
// explicitly sends `coordinateSpace: "pixels"`. Keeping one convention avoids
// the classic "is 0.5 a fraction or a pixel?" bug.

import { appError } from '../lib/errors.js';

export const SEGMENTATION_MODES = ['auto', 'boxes', 'points', 'text'];
export const DEFAULT_MAX_MASKS = 12;
export const HARD_MAX_MASKS = 32;
export const MAX_PROMPTS = 24;
const MAX_IMAGE_URL = 2048;
const MAX_TEXT_PROMPT = 160;
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i;

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Approximate decoded size of a base64 payload without allocating it. */
export function base64Bytes(base64) {
  const text = String(base64 || '').replace(/\s+/g, '');
  if (!text) return 0;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

export function parseImageDataUrl(value, { maxImageBytes = 8 * 1024 * 1024 } = {}) {
  const text = String(value || '').trim();
  const match = DATA_URL_RE.exec(text);
  if (!match) {
    throw appError('BAD_JSON', 'imageDataUrl must be a base64 PNG, JPEG or WebP data URL.');
  }
  const bytes = base64Bytes(match[2]);
  if (!bytes) throw appError('BAD_JSON', 'The inline image is empty.');
  if (bytes > maxImageBytes) {
    throw appError('IMAGE_TOO_LARGE', `The inline image is about ${bytes} bytes; the limit is ${maxImageBytes}.`);
  }
  return { mimeType: match[1].toLowerCase(), bytes };
}

function parseHttpsImageUrl(value) {
  const text = String(value || '').trim();
  if (!text || text.length > MAX_IMAGE_URL) throw appError('BAD_JSON', 'imageUrl is missing or too long.');
  let url;
  try { url = new URL(text); } catch {
    throw appError('BAD_JSON', 'imageUrl must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:') throw appError('BAD_JSON', 'imageUrl must use HTTPS.');
  if (url.username || url.password) throw appError('BAD_JSON', 'imageUrl must not contain credentials.');
  return url.toString();
}

function imageDimensions(body) {
  const source = body?.image && typeof body.image === 'object' ? body.image : {};
  const width = Math.round(finite(body?.width ?? body?.imageWidth ?? source.width) || 0);
  const height = Math.round(finite(body?.height ?? body?.imageHeight ?? source.height) || 0);
  if (width < 0 || height < 0 || width > 20_000 || height > 20_000) {
    throw appError('BAD_JSON', 'Image dimensions are out of range.');
  }
  return { width: width || null, height: height || null };
}

function parsePoint(raw, { space, width, height }) {
  const source = Array.isArray(raw)
    ? { x: raw[0], y: raw[1], label: raw[2] }
    : (raw && typeof raw === 'object' ? raw : null);
  if (!source) return null;
  let x = finite(source.x);
  let y = finite(source.y);
  if (x === null || y === null) return null;
  if (space === 'pixels') {
    if (!width || !height) throw appError('BAD_JSON', 'Pixel prompts require width and height.');
    if (x < 0 || y < 0 || x > width || y > height) return null;
    x /= width;
    y /= height;
  } else if (x < 0 || x > 1 || y < 0 || y > 1) {
    return null;
  }
  const label = source.label === 0 || source.label === '0' ? 0 : 1;
  return { x: Number(x.toFixed(6)), y: Number(y.toFixed(6)), label };
}

function parseBox(raw, { space, width, height }) {
  const source = Array.isArray(raw)
    ? { x: raw[0], y: raw[1], w: raw[2], h: raw[3] }
    : (raw && typeof raw === 'object' ? raw : null);
  if (!source) return null;
  let x = finite(source.x ?? source.x1);
  let y = finite(source.y ?? source.y1);
  let w = finite(source.w ?? source.width);
  let h = finite(source.h ?? source.height);
  if (x === null || y === null || w === null || h === null) {
    // Support x1/y1/x2/y2 boxes.
    const x2 = finite(source.x2);
    const y2 = finite(source.y2);
    if (x === null || y === null || x2 === null || y2 === null) return null;
    w = x2 - x;
    h = y2 - y;
  }
  if (space === 'pixels') {
    if (!width || !height) throw appError('BAD_JSON', 'Pixel prompts require width and height.');
    if (w <= 0 || h <= 0) return null;
    if (x < 0 || y < 0 || x + w > width || y + h > height) return null;
    x /= width;
    y /= height;
    w /= width;
    h /= height;
  } else if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.000001 || y + h > 1.000001) {
    return null;
  }
  return {
    x: Number(x.toFixed(6)),
    y: Number(y.toFixed(6)),
    w: Number(Math.min(w, 1 - x).toFixed(6)),
    h: Number(Math.min(h, 1 - y).toFixed(6)),
  };
}

function inferMode({ points, boxes, text }) {
  if (boxes.length) return 'boxes';
  if (points.length) return 'points';
  if (text) return 'text';
  return 'auto';
}

/**
 * Validate a browser request. Unknown fields are ignored on purpose: the
 * server must never forward arbitrary client data to a provider.
 */
export function validateSegmentationRequest(body, {
  maxImageBytes = 8 * 1024 * 1024,
  maxMasks = DEFAULT_MAX_MASKS,
  capabilities = {},
} = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw appError('BAD_JSON', 'Expected a JSON object.');
  }

  const imageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl.trim() : '';
  const rawImageUrl = typeof body.imageUrl === 'string'
    ? body.imageUrl.trim()
    : (typeof body.image === 'string' && !body.image.startsWith('data:') ? body.image.trim() : '');
  if (imageDataUrl && rawImageUrl) {
    throw appError('BAD_JSON', 'Send either imageDataUrl or imageUrl, not both.');
  }
  if (!imageDataUrl && !rawImageUrl) {
    throw appError('CAMERA_FRAME_MISSING', 'Provide an inline image or an HTTPS image URL.');
  }

  const image = imageDataUrl
    ? { kind: 'data', dataUrl: imageDataUrl, ...parseImageDataUrl(imageDataUrl, { maxImageBytes }) }
    : { kind: 'url', url: parseHttpsImageUrl(rawImageUrl) };
  const { width, height } = imageDimensions(body);
  image.width = width;
  image.height = height;

  const coordinateSpace = String(body.coordinateSpace || body.promptSpace || 'normalized').toLowerCase();
  if (!['normalized', 'pixels'].includes(coordinateSpace)) {
    throw appError('BAD_JSON', 'coordinateSpace must be "normalized" or "pixels".');
  }

  const rawPrompts = body.prompts && typeof body.prompts === 'object' ? body.prompts : body;
  const rawPoints = Array.isArray(rawPrompts?.points) ? rawPrompts.points.slice(0, MAX_PROMPTS) : [];
  const rawBoxes = Array.isArray(rawPrompts?.boxes) ? rawPrompts.boxes.slice(0, MAX_PROMPTS) : [];
  const text = clean(rawPrompts?.textPrompt ?? rawPrompts?.text, MAX_TEXT_PROMPT);
  const opts = { space: coordinateSpace, width, height };

  const points = rawPoints.map((point) => parsePoint(point, opts)).filter(Boolean);
  const boxes = rawBoxes.map((box) => parseBox(box, opts)).filter(Boolean);
  if (rawPoints.length && !points.length) throw appError('BAD_JSON', 'No valid point prompts were supplied.');
  if (rawBoxes.length && !boxes.length) throw appError('BAD_JSON', 'No valid box prompts were supplied.');

  const requestedMode = clean(body.mode, 24).toLowerCase();
  const mode = requestedMode && SEGMENTATION_MODES.includes(requestedMode)
    ? requestedMode
    : inferMode({ points, boxes, text });
  if (requestedMode && !SEGMENTATION_MODES.includes(requestedMode)) {
    throw appError('BAD_JSON', `mode must be one of ${SEGMENTATION_MODES.join(', ')}.`);
  }
  if (mode === 'boxes' && !boxes.length) throw appError('BAD_JSON', 'Box mode needs at least one box.');
  if (mode === 'points' && !points.length) throw appError('BAD_JSON', 'Point mode needs at least one point.');
  if (mode === 'text' && !text) throw appError('BAD_JSON', 'Text mode needs a text prompt.');
  if (mode === 'auto' && (points.length || boxes.length || text)) {
    // Explicit auto with prompts is still usable: the adapter decides whether it
    // can honour them natively or must filter automatic proposals.
  }

  if (mode === 'text' && capabilities.textPrompt !== true) {
    throw appError('SEGMENTATION_PROMPT_UNSUPPORTED', 'This segmentation model does not accept text prompts.');
  }
  const wantsPrompts = mode === 'boxes' || mode === 'points';
  const nativePrompts = mode === 'boxes' ? capabilities.boxPrompt === true : capabilities.pointPrompt === true;
  if (wantsPrompts && !nativePrompts && capabilities.automatic !== true) {
    throw appError('SEGMENTATION_PROMPT_UNSUPPORTED', 'This segmentation model accepts neither native prompts nor automatic proposals.');
  }

  const cap = clamp(Math.round(finite(body.maxMasks) || maxMasks), 1, Math.min(HARD_MAX_MASKS, maxMasks));
  return {
    requestId: clean(body.requestId, 80) || `seg_${Date.now().toString(36)}`,
    image,
    mode,
    coordinateSpace,
    points,
    boxes,
    text,
    maxMasks: cap,
    promptStrategy: wantsPrompts ? (nativePrompts ? 'native' : 'filter') : 'automatic',
  };
}

/**
 * Normalize the many shapes a hosted SAM endpoint can return into one list.
 * Replicate's meta/sam-2 returns { combined_mask, individual_masks }; other
 * deployments return { masks: [...] } or a bare array of URLs.
 */
export function normalizeReplicateOutput(output) {
  let combinedMaskUrl = null;
  let raw = [];

  if (typeof output === 'string') {
    raw = [output];
  } else if (Array.isArray(output)) {
    raw = output;
  } else if (output && typeof output === 'object') {
    combinedMaskUrl = typeof output.combined_mask === 'string'
      ? output.combined_mask
      : (typeof output.combinedMask === 'string' ? output.combinedMask : null);
    if (Array.isArray(output.individual_masks)) raw = output.individual_masks;
    else if (Array.isArray(output.individualMasks)) raw = output.individualMasks;
    else if (Array.isArray(output.masks)) raw = output.masks;
    else if (output.mask) raw = [output.mask];
    else if (typeof output.mask_url === 'string') raw = [output.mask_url];
    else if (typeof output.url === 'string') raw = [output.url];
  }

  const scores = Array.isArray(output?.scores) ? output.scores : [];
  const seen = new Set();
  const masks = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    const url = typeof item === 'string'
      ? item
      : (item && typeof item === 'object'
        ? (item.url || item.mask || item.image || item.mask_url || null)
        : null);
    if (typeof url !== 'string' || !url.trim() || seen.has(url)) continue;
    seen.add(url);
    const score = item && typeof item === 'object' && finite(item.score) !== null
      ? finite(item.score)
      : (finite(scores[i]) ?? null);
    masks.push({ url: url.trim(), score });
  }
  return { masks, combinedMaskUrl };
}

function rectIntersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return 0;
  return (right - x) * (bottom - y);
}

function boxToPixels(box, width, height) {
  return {
    x: box.x * width,
    y: box.y * height,
    width: box.w * width,
    height: box.h * height,
  };
}

function pointToPixels(point, width, height) {
  return { x: point.x * width, y: point.y * height };
}

function pointInside(box, point) {
  return point.x >= box.x && point.x <= box.x + box.width
    && point.y >= box.y && point.y <= box.y + box.height;
}

/**
 * Rank downloaded masks against the request. With automatic mask generation the
 * server cannot ask SAM for a specific box; it selects the proposal that best
 * matches the box. The selected method is reported so the UI never claims native
 * prompting when it was post-filtering.
 */
export function selectMasksForPrompts(masks, request, {
  minBoxScore = 0.15,
  minPointScore = 0.1,
} = {}) {
  const list = Array.isArray(masks) ? masks.filter((m) => m && m.bbox) : [];
  if (!list.length) return [];
  const width = request?.image?.width || list[0].width || 0;
  const height = request?.image?.height || list[0].height || 0;
  const max = clamp(Number(request?.maxMasks) || DEFAULT_MAX_MASKS, 1, HARD_MAX_MASKS);
  const chosen = new Map();

  const add = (mask, entry) => {
    const existing = chosen.get(mask.index);
    if (!existing || entry.score > existing.score) chosen.set(mask.index, { ...entry, maskIndex: mask.index });
  };

  const mode = request?.mode || 'auto';
  if (mode === 'boxes' && request.boxes?.length && width && height) {
    for (let p = 0; p < request.boxes.length; p += 1) {
      const box = boxToPixels(request.boxes[p], width, height);
      const boxArea = box.width * box.height;
      let best = null;
      for (const mask of list) {
        const maskRect = { x: mask.bbox.x, y: mask.bbox.y, width: mask.bbox.width, height: mask.bbox.height };
        const maskArea = maskRect.width * maskRect.height;
        const inter = rectIntersection(box, maskRect);
        if (!inter) continue;
        const iou = inter / (boxArea + maskArea - inter);
        const coverage = inter / boxArea;
        const score = 0.6 * iou + 0.4 * coverage;
        if (!best || score > best.score) best = { mask, score };
      }
      if (best && best.score >= minBoxScore) {
        add(best.mask, {
          score: Number(best.score.toFixed(4)),
          promptIndex: p,
          method: 'box-overlap',
          prompt: request.boxes[p],
        });
      }
    }
  } else if (mode === 'points' && request.points?.length && width && height) {
    for (let p = 0; p < request.points.length; p += 1) {
      const point = pointToPixels(request.points[p], width, height);
      const containing = list.filter((mask) => pointInside(mask.bbox, point));
      if (containing.length) {
        // The smallest containing proposal is the most specific one.
        const mask = containing.sort((a, b) => (a.areaPixels || 0) - (b.areaPixels || 0))[0];
        add(mask, { score: 1, promptIndex: p, method: 'point-contains', prompt: request.points[p] });
        continue;
      }
      let best = null;
      const diag = Math.hypot(width, height) || 1;
      for (const mask of list) {
        const cx = mask.bbox.x + mask.bbox.width / 2;
        const cy = mask.bbox.y + mask.bbox.height / 2;
        const score = Math.max(0, 1 - Math.hypot(point.x - cx, point.y - cy) / diag);
        if (!best || score > best.score) best = { mask, score };
      }
      if (best && best.score >= minPointScore) {
        add(best.mask, {
          score: Number(best.score.toFixed(4)),
          promptIndex: p,
          method: 'point-nearest',
          prompt: request.points[p],
        });
      }
    }
  } else {
    const ranked = [...list].sort((a, b) => {
      const sa = Number.isFinite(a.score) ? a.score : -1;
      const sb = Number.isFinite(b.score) ? b.score : -1;
      if (sb !== sa) return sb - sa;
      return (b.areaPixels || 0) - (a.areaPixels || 0);
    });
    for (const mask of ranked) {
      add(mask, { score: Number.isFinite(mask.score) ? mask.score : 0, promptIndex: null, method: 'automatic', prompt: null });
    }
  }

  return [...chosen.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

/** Replicate's meta/sam-2 automatic mask generator input. */
export function buildAutomaticSamInput(request, {
  pointsPerSide = 16,
  predIouThreshold = 0.86,
  stabilityThreshold = 0.92,
  maskLimit = 24,
} = {}) {
  const image = request.image.kind === 'data' ? request.image.dataUrl : request.image.url;
  return {
    image,
    points_per_side: clamp(Math.round(pointsPerSide), 4, 64),
    pred_iou_thresh: clamp(Number(predIouThreshold) || 0.86, 0.5, 1),
    stability_score_thresh: clamp(Number(stabilityThreshold) || 0.92, 0.5, 1),
    use_m2m: true,
    mask_limit: clamp(Math.round(maskLimit), 1, 64),
    points_per_batch: 64,
    crop_n_layers: 0,
    box_nms_thresh: 0.7,
    crop_n_points_downscale_factor: 1,
    min_mask_region_area: 0,
    multimask_output: false,
  };
}

/** Promptable SAM-style input used by deployments that expose boxes/points. */
export function buildPromptableSamInput(request) {
  const image = request.image.kind === 'data' ? request.image.dataUrl : request.image.url;
  const width = request.image.width;
  const height = request.image.height;
  const out = { image };
  if (request.mode === 'points' && request.points.length) {
    if (!width || !height) {
      throw appError('BAD_JSON', 'Pixel point prompts require image width and height.');
    }
    out.points = request.points.map((p) => [Math.round(p.x * width), Math.round(p.y * height)]);
    out.point_labels = request.points.map((p) => (p.label === 0 ? 0 : 1));
  }
  if (request.mode === 'boxes' && request.boxes.length) {
    if (!width || !height) {
      throw appError('BAD_JSON', 'Pixel box prompts require image width and height.');
    }
    const b = request.boxes[0];
    out.box = [
      Math.round(b.x * width),
      Math.round(b.y * height),
      Math.round((b.x + b.w) * width),
      Math.round((b.y + b.h) * height),
    ];
  }
  return out;
}

export default {
  SEGMENTATION_MODES,
  DEFAULT_MAX_MASKS,
  HARD_MAX_MASKS,
  base64Bytes,
  parseImageDataUrl,
  validateSegmentationRequest,
  normalizeReplicateOutput,
  selectMasksForPrompts,
  buildAutomaticSamInput,
  buildPromptableSamInput,
};
