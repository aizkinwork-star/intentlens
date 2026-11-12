// server/services/replicateSam.js — optional hosted SAM 2 adapter (Replicate).
//
// Why this exists: SAM is a promptable segmenter, not a component classifier.
// It can return tight masks for a board, a connector or a component; it cannot
// decide "resistor vs capacitor". The local k-NN/vision layer still owns
// identity. This adapter therefore reports masks and provenance, never a class.
//
// Security and cost rules:
//   - The token lives in the server process and is never returned or logged.
//   - Only HTTPS Replicate hosts are contacted.
//   - Every request has a timeout, a poll ceiling and a mask-count/byte ceiling.
//   - The route, not the adapter, enforces the flat per-run cost budget.
//
// Replicate's public "meta/sam-2" model (large, image-only) runs automatic mask
// generation. It does not accept box/point prompts. If a promptable deployment
// is configured, `inputStyle: "promptable"` maps boxes/points to its input. When
// only automatic proposals are available, the contract filters proposals by the
// user's box/point and reports that it did so.

import { appError } from '../lib/errors.js';
import { isSafeUrl } from '../lib/safeFetch.js';
import { decodePngMask, isPng } from '../lib/png.js';
import {
  buildAutomaticSamInput,
  buildPromptableSamInput,
  normalizeReplicateOutput,
} from './segmentationContract.js';

export const REPLICATE_API_BASE = 'https://api.replicate.com/v1';

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const VERSION_RE = /^[A-Za-z0-9]{8,80}$/;
const DEFAULT_POLL_MS = 1500;
const DEFAULT_MAX_WAIT_MS = 180_000;

function isAbort(err) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

function isTimeout(err) {
  return err?.name === 'TimeoutError' || err?.code === 'ERR_ABORT_TIMEOUT';
}

function abortError() {
  const err = new Error('The segmentation request was cancelled.');
  err.name = 'AbortError';
  return err;
}

function timeoutSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : null;
  if (!timeout) return signal;
  if (!signal) return timeout;
  return AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal;
}

function scrub(text) {
  return String(text || '')
    .replace(/r8_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .slice(0, 280)
    .trim();
}

export function mapReplicateStatus(status, body = '') {
  if (status === 401 || status === 403) {
    return appError('MODEL_AUTH_FAILED', 'Replicate rejected the saved token. Replace REPLICATE_API_TOKEN.');
  }
  if (status === 402) {
    return appError('MODEL_QUOTA_EXHAUSTED', 'Replicate reports no credit for this account.');
  }
  if (status === 429) {
    return appError('MODEL_RATE_LIMITED', 'Replicate is rate limiting this account. Retry shortly.');
  }
  if (status === 404) {
    return appError('MODEL_UPSTREAM_ERROR', 'The configured Replicate model or version was not found.');
  }
  if (status === 400 || status === 422) {
    const err = appError('MODEL_UPSTREAM_ERROR', `Replicate rejected the request: ${scrub(body) || `HTTP ${status}`}`);
    err.badRequest = true;
    return err;
  }
  return appError('MODEL_UPSTREAM_ERROR', `Replicate returned HTTP ${status}.`);
}

export function capabilitiesForInputStyle(inputStyle = 'automatic') {
  if (inputStyle === 'promptable') {
    return { automatic: false, boxPrompt: true, pointPrompt: true, textPrompt: false };
  }
  return { automatic: true, boxPrompt: false, pointPrompt: false, textPrompt: false };
}

function normalizeEndpoint(version, modelId) {
  if (!MODEL_ID_RE.test(String(modelId || ''))) {
    throw appError('SEGMENTATION_NOT_CONFIGURED', 'REPLICATE_SAM_MODEL must look like "owner/model".');
  }
  if (version && !VERSION_RE.test(String(version))) {
    throw appError('SEGMENTATION_NOT_CONFIGURED', 'REPLICATE_SAM_VERSION looks invalid.');
  }
  return version
    ? { url: `${REPLICATE_API_BASE}/predictions`, version }
    : { url: `${REPLICATE_API_BASE}/models/${modelId}/predictions`, version: null };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Build a Replicate SAM adapter. `fetchImpl` and `sleep` are injectable so the
 * test suite can cover success, polling, failures and cancellation without a
 * network or a key.
 */
export function buildReplicateSamAdapter({
  apiToken,
  modelId = 'meta/sam-2',
  version = '',
  inputStyle = 'automatic',
  fetchImpl = globalThis.fetch,
  urlGuard = isSafeUrl,
  timeoutMs = DEFAULT_MAX_WAIT_MS,
  pollIntervalMs = DEFAULT_POLL_MS,
  maxWaitMs = timeoutMs,
  maxMaskBytes = 4 * 1024 * 1024,
  maxMasks = 12,
  pointsPerSide = 16,
  predIouThreshold = 0.86,
  stabilityThreshold = 0.92,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  const token = String(apiToken || '').trim();
  if (!token) throw appError('SEGMENTATION_NOT_CONFIGURED', 'REPLICATE_API_TOKEN is not configured.');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  if (!['automatic', 'promptable'].includes(inputStyle)) {
    throw new Error('inputStyle must be "automatic" or "promptable".');
  }
  const endpoint = normalizeEndpoint(version, modelId);
  const capabilities = capabilitiesForInputStyle(inputStyle);
  const tokenForLog = token;

  function assertUrl(url) {
    if (!urlGuard(url)) throw appError('MODEL_UPSTREAM_ERROR', 'Blocked a non-HTTPS or private segmentation URL.');
  }

  async function requestJson(url, { method = 'GET', body = null, signal = null, headers = {} } = {}) {
    assertUrl(url);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${tokenForLog}`, 'content-type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: timeoutSignal(timeoutMs, signal),
        redirect: 'error',
      });
    } catch (err) {
      if (signal?.aborted || isAbort(err)) throw abortError();
      if (isTimeout(err)) throw appError('MODEL_TIMEOUT', 'Replicate did not answer in time.');
      throw appError('MODEL_UPSTREAM_ERROR', `Replicate is unreachable: ${scrub(err?.message || err)}`);
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) throw mapReplicateStatus(response.status, text);
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!parsed) throw appError('MODEL_BAD_RESPONSE', 'Replicate returned an unreadable prediction.');
    return parsed;
  }

  async function createPrediction(input, signal) {
    const payload = endpoint.version ? { version: endpoint.version, input } : { input };
    const prediction = await requestJson(endpoint.url, {
      method: 'POST',
      body: payload,
      signal,
      headers: { prefer: 'wait=60' },
    });
    return await finishPrediction(prediction, signal);
  }

  async function finishPrediction(initial, signal) {
    let prediction = initial;
    const started = now();
    while (prediction && (prediction.status === 'starting' || prediction.status === 'processing')) {
      if (signal?.aborted) throw abortError();
      if (now() - started >= maxWaitMs) {
        throw appError('MODEL_TIMEOUT', `Replicate did not finish within ${Math.round(maxWaitMs / 1000)}s.`);
      }
      await sleep(pollIntervalMs);
      if (signal?.aborted) throw abortError();
      const url = prediction.urls?.get || (prediction.id ? `${REPLICATE_API_BASE}/predictions/${prediction.id}` : '');
      if (!url) throw appError('MODEL_BAD_RESPONSE', 'Replicate did not return a prediction id or poll URL.');
      prediction = await requestJson(url, { signal });
    }
    if (!prediction || prediction.status === 'failed' || prediction.status === 'canceled') {
      throw appError('SEGMENTATION_FAILED', `Replicate prediction ${prediction?.status || 'failed'}: ${scrub(prediction?.error || 'no detail')}`);
    }
    if (prediction.status !== 'succeeded') {
      throw appError('SEGMENTATION_FAILED', `Replicate prediction ended in an unexpected state: ${prediction.status || 'unknown'}.`);
    }
    return prediction;
  }

  async function downloadMask(url, signal, index) {
    assertUrl(url);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        signal: timeoutSignal(timeoutMs, signal),
        redirect: 'error',
      });
    } catch (err) {
      if (signal?.aborted || isAbort(err)) throw abortError();
      if (isTimeout(err)) throw appError('MODEL_TIMEOUT', 'Downloading a segmentation mask timed out.');
      throw appError('SEGMENTATION_MASK_INVALID', `Could not download mask ${index}: ${scrub(err?.message || err)}`);
    }
    if (!response.ok) throw appError('SEGMENTATION_MASK_INVALID', `Mask ${index} download returned HTTP ${response.status}.`);
    const declared = Number(response.headers?.get?.('content-length') || 0);
    if (declared > maxMaskBytes) {
      throw appError('SEGMENTATION_MASK_INVALID', `Mask ${index} is ${declared} bytes; the limit is ${maxMaskBytes}.`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw appError('SEGMENTATION_MASK_INVALID', `Mask ${index} is empty.`);
    if (buffer.length > maxMaskBytes) {
      throw appError('SEGMENTATION_MASK_INVALID', `Mask ${index} is ${buffer.length} bytes; the limit is ${maxMaskBytes}.`);
    }
    if (!isPng(buffer)) throw appError('SEGMENTATION_MASK_INVALID', `Mask ${index} is not a PNG.`);
    const metadata = decodePngMask(buffer);
    if (!metadata) throw appError('SEGMENTATION_MASK_INVALID', `Mask ${index} has an unreadable PNG header.`);
    return { buffer, metadata };
  }

  async function predict(request, { signal = null } = {}) {
    const started = now();
    const input = inputStyle === 'promptable'
      ? buildPromptableSamInput(request)
      : buildAutomaticSamInput(request, {
        pointsPerSide,
        predIouThreshold,
        stabilityThreshold,
        maskLimit: Math.min(64, Math.max(8, request.maxMasks * 2)),
      });

    const prediction = await createPrediction(input, signal);
    const { masks: candidates, combinedMaskUrl } = normalizeReplicateOutput(prediction.output);
    if (!candidates.length) {
      throw appError('SEGMENTATION_FAILED', 'Replicate returned a successful prediction with no masks.');
    }
    if (candidates.length > 128) {
      throw appError('SEGMENTATION_OUTPUT_TOO_LARGE', 'Replicate returned more than 128 masks.');
    }
    const selected = candidates.slice(0, Math.min(32, Math.max(maxMasks * 2, maxMasks)));

    const downloaded = await mapLimit(selected, 4, async (candidate, index) => {
      const { buffer, metadata } = await downloadMask(candidate.url, signal, index);
      return {
        index,
        buffer,
        width: metadata.width,
        height: metadata.height,
        decoded: metadata.decoded === true,
        areaPixels: metadata.areaPixels ?? null,
        coverage: metadata.coverage ?? null,
        bbox: metadata.bbox ?? null,
        centroid: metadata.centroid ?? null,
        score: candidate.score,
        sourceUrl: candidate.url,
      };
    });

    return {
      predictionId: prediction.id || null,
      modelId,
      version: endpoint.version,
      inputStyle,
      capabilities,
      masks: downloaded,
      combinedMaskUrl,
      elapsedMs: now() - started,
      metrics: prediction.metrics || null,
      rawStatus: prediction.status,
    };
  }

  async function healthCheck() {
    try {
      const account = await requestJson(`${REPLICATE_API_BASE}/account`, { signal: null });
      return {
        ok: true,
        detail: `Replicate token accepted${account?.username ? ` for ${account.username}` : ''}.`,
      };
    } catch (err) {
      return {
        ok: false,
        status: err?.status || null,
        detail: err?.code === 'MODEL_AUTH_FAILED'
          ? 'Replicate rejected the saved token.'
          : scrub(err?.message || err),
      };
    }
  }

  return {
    id: 'replicate-sam',
    name: 'Replicate SAM 2',
    modelId,
    version: endpoint.version,
    inputStyle,
    capabilities,
    predict,
    healthCheck,
  };
}

export default { REPLICATE_API_BASE, buildReplicateSamAdapter, mapReplicateStatus, capabilitiesForInputStyle };
