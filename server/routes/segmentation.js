// server/routes/segmentation.js — optional hosted SAM masks.
//
// POST /api/segmentation        run one segmentation request
// GET  /api/segmentation        key-free status
// POST /api/segmentation/config save token/model/toggle (never echoed)
// DELETE /api/segmentation/:id  drop cached masks
// GET  /api/segmentation/:id/mask/:index  same-origin PNG for the overlay
//
// This route is intentionally separate from /api/analyze. Vision models answer
// questions; segmentation only proposes regions. Keeping them separate prevents
// a mask from being presented as a component identification.

import { appError, errorPayload } from '../lib/errors.js';
import { json, readJson, recordServerLog } from '../lib/http.js';
import { config, isPlaceholderCredential, sam2Status } from '../config.js';
import {
  capabilitiesForInputStyle,
  buildReplicateSamAdapter,
} from '../services/replicateSam.js';
import {
  selectMasksForPrompts,
  validateSegmentationRequest,
} from '../services/segmentationContract.js';
import { segmentationStore } from '../services/segmentationStore.js';
import { costManager, costStatusForClient } from '../services/costManager.js';
import {
  applyCredentialsToConfig,
  loadCredentials,
  saveCredentials,
} from '../lib/credentialStore.js';

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const VERSION_RE = /^[A-Za-z0-9]{8,80}$/;

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function handleSegmentationStatus(req, res) {
  json(res, 200, {
    ok: true,
    ...sam2Status(),
    budget: costStatusForClient(),
  });
}

/** Save the optional Replicate token/settings in the same encrypted store as
 * other provider credentials. The token is never returned to the caller. */
export async function handleSaveSegmentationConfig(req, res) {
  const body = await readJson(req, 16_000);
  const stored = { ...(await loadCredentials()).credentials };
  const next = { ...stored };

  if (body?.apiToken !== undefined) {
    const token = String(body.apiToken || '').trim();
    if (token && /(your[-_ ]|replace[-_ ]|placeholder|example|dummy|xxxx)/i.test(token)) {
      json(res, 400, { error: { code: 'BAD_JSON', message: 'That looks like a placeholder token. Paste a real Replicate token.', retryable: false } });
      return;
    }
    if (token) next.REPLICATE_API_TOKEN = token;
    else delete next.REPLICATE_API_TOKEN;
  }

  if (body?.modelId !== undefined) {
    const modelId = String(body.modelId || '').trim();
    if (modelId && !MODEL_ID_RE.test(modelId)) {
      json(res, 400, { error: { code: 'BAD_JSON', message: 'modelId must look like "owner/model".', retryable: false } });
      return;
    }
    if (modelId) next.REPLICATE_SAM_MODEL = modelId;
    else delete next.REPLICATE_SAM_MODEL;
  }

  if (body?.version !== undefined) {
    const version = String(body.version || '').trim();
    if (version && !VERSION_RE.test(version)) {
      json(res, 400, { error: { code: 'BAD_JSON', message: 'version must be a Replicate version hash.', retryable: false } });
      return;
    }
    if (version) next.REPLICATE_SAM_VERSION = version;
    else delete next.REPLICATE_SAM_VERSION;
  }

  if (body?.inputStyle !== undefined) {
    const style = String(body.inputStyle || '').trim().toLowerCase();
    if (!['automatic', 'promptable'].includes(style)) {
      json(res, 400, { error: { code: 'BAD_JSON', message: 'inputStyle must be "automatic" or "promptable".', retryable: false } });
      return;
    }
    next.SAM2_INPUT_STYLE = style;
  }

  if (body?.enabled !== undefined) next.SAM2_ENABLED = body.enabled === true ? 'true' : 'false';

  try {
    await saveCredentials(next);
  } catch (err) {
    json(res, 503, { error: { code: 'SECURE_STORAGE_FAILED', message: err.message, retryable: false } });
    return;
  }

  for (const key of [
    'REPLICATE_API_TOKEN', 'REPLICATE_SAM_MODEL', 'REPLICATE_SAM_VERSION',
    'SAM2_INPUT_STYLE', 'SAM2_ENABLED',
  ]) {
    if (next[key] === undefined) delete process.env[key];
    else process.env[key] = String(next[key]);
  }
  await applyCredentialsToConfig(config);
  segmentationStore.sweep();
  recordServerLog({ level: 'info', category: 'segmentation', message: 'Hosted segmentation settings updated.' });
  json(res, 200, { ok: true, ...sam2Status() });
}

function checkFlatCost(cost, amountUsd) {
  const amount = Math.max(0, Number(amountUsd) || 0);
  const budget = cost.getBudget();
  if (amount > budget.maxRequestUsd) {
    throw appError(
      'REQUEST_COST_LIMIT',
      `A segmentation run is estimated at $${amount.toFixed(4)}, above the per-request cap of $${budget.maxRequestUsd.toFixed(2)}. Raise the cap or disable hosted segmentation.`,
    );
  }
  const snapshot = cost.snapshot();
  if (amount > snapshot.remainingUsd) {
    throw appError(
      'BUDGET_EXCEEDED',
      `A segmentation run is estimated at $${amount.toFixed(4)}, but only $${snapshot.remainingUsd.toFixed(4)} remains in the daily/monthly budget.`,
    );
  }
  return { amount, snapshot };
}

/**
 * Run one segmentation request. `deps` exists for tests: a fake adapter, store,
 * cost manager and body can be supplied without a network or an HTTP server.
 */
export async function handleSegmentationRun(req, res, deps = {}) {
  try {
    await runSegmentation(req, res, deps);
  } catch (err) {
    if (res?.writableEnded) return;
    const code = err?.code || err?.name || 'ERROR';
    recordServerLog({
      level: 'warn',
      category: 'segmentation',
      message: `Segmentation rejected/failed: ${code} ${String(err?.message || '').slice(0, 160)}`,
    });
    json(res, err?.status || 500, errorPayload(err));
  }
}

async function runSegmentation(req, res, deps = {}) {
  const cfg = deps.config || config;
  const sam = cfg.sam2 || {};
  const store = deps.store || segmentationStore;
  const cost = deps.cost || costManager;

  if (sam.enabled !== true) throw appError('SEGMENTATION_DISABLED');
  if (cfg.allowOutboundNetwork !== true) throw appError('NETWORK_DISABLED');
  if (!sam.apiToken || isPlaceholderCredential(sam.apiToken)) {
    throw appError('SEGMENTATION_NOT_CONFIGURED');
  }

  const body = deps.body !== undefined ? deps.body : await readJson(req, cfg.maxBodyBytes);
  const capabilities = capabilitiesForInputStyle(sam.inputStyle);
  const request = validateSegmentationRequest(body, {
    maxImageBytes: cfg.maxImageBytes,
    maxMasks: sam.maxMasks,
    capabilities,
  });
  checkFlatCost(cost, sam.costPerRunUsd);

  const adapter = deps.adapter || buildReplicateSamAdapter({
    apiToken: sam.apiToken,
    modelId: sam.modelId,
    version: sam.version,
    inputStyle: sam.inputStyle,
    timeoutMs: sam.timeoutMs,
    pollIntervalMs: sam.pollIntervalMs,
    maxWaitMs: sam.maxWaitMs,
    maxMasks: sam.maxMasks,
    maxMaskBytes: sam.maxMaskBytes,
    pointsPerSide: sam.pointsPerSide,
  });

  const controller = new AbortController();
  const onRequestAbort = () => controller.abort();
  const onResponseClose = () => { if (!res.writableEnded) controller.abort(); };
  req?.on?.('aborted', onRequestAbort);
  res?.on?.('close', onResponseClose);

  try {
    const result = await adapter.predict(request, { signal: controller.signal });
    // Mask dimensions are authoritative. Normalized prompts work at any size,
    // but selection would be wrong if the caller's size disagreed with the PNG.
    if (result.masks[0]?.width) request.image.width = result.masks[0].width;
    if (result.masks[0]?.height) request.image.height = result.masks[0].height;

    let chosen = selectMasksForPrompts(result.masks, request);
    if (!chosen.length && request.mode === 'auto') {
      chosen = result.masks.slice(0, request.maxMasks).map((mask) => ({
        maskIndex: mask.index,
        score: Number.isFinite(mask.score) ? mask.score : 0,
        promptIndex: null,
        method: 'automatic',
        prompt: null,
      }));
    }

    const segmentationId = chosen.length ? store.createId() : null;
    const masks = [];
    for (const choice of chosen) {
      const mask = result.masks.find((item) => item.index === choice.maskIndex);
      if (!mask) continue;
      if (segmentationId) store.save(segmentationId, mask.index, mask.buffer);
      masks.push({
        index: mask.index,
        url: segmentationId ? `/api/segmentation/${segmentationId}/mask/${mask.index}` : null,
        width: mask.width,
        height: mask.height,
        bbox: mask.bbox,
        centroid: mask.centroid,
        areaPixels: mask.areaPixels,
        coverage: mask.coverage,
        score: choice.score,
        decode: mask.decoded ? 'png-8bit' : 'metadata-only',
        promptIndex: choice.promptIndex,
        method: choice.method,
      });
    }

    cost.record({
      providerId: 'replicate',
      modelId: result.modelId,
      requestId: result.predictionId || request.requestId,
      inputTokens: 0,
      outputTokens: 0,
      imageTokens: 0,
      costUsd: Number(sam.costPerRunUsd) || 0,
      source: 'flat-rate',
    });

    const response = {
      ok: true,
      segmentationId,
      image: { width: request.image.width, height: request.image.height },
      masks,
      provenance: {
        provider: 'replicate',
        modelId: result.modelId,
        version: result.version || null,
        inputStyle: result.inputStyle,
        promptStrategy: request.promptStrategy,
        mode: request.mode,
        predictionId: result.predictionId,
        elapsedMs: result.elapsedMs,
        costUsd: Number(sam.costPerRunUsd) || 0,
        costSource: 'flat-rate estimate',
        maskCount: masks.length,
        candidateCount: result.masks.length,
        cached: false,
      },
      note: request.promptStrategy === 'filter'
        ? 'Box/point prompts selected from automatic SAM proposals. They were not native model prompts; verify the mask before using it for placement.'
        : (request.promptStrategy === 'native'
          ? 'The configured model accepted the prompt natively.'
          : 'Automatic mask proposals. Identity still comes from the local classifier or vision model.'),
    };
    if (!masks.length) {
      response.reason = 'no_mask_matched_prompt';
      response.note = 'SAM returned proposals, but none matched the prompt closely enough. Nothing was drawn.';
    }

    recordServerLog({
      level: masks.length ? 'ok' : 'warn',
      category: 'segmentation',
      message: `POST /api/segmentation provider=replicate model=${result.modelId} mode=${request.mode} strategy=${request.promptStrategy} masks=${masks.length}/${result.masks.length} elapsed=${result.elapsedMs}ms`,
    });
    json(res, 200, response);
  } catch (err) {
    if (err?.name === 'AbortError') {
      recordServerLog({ level: 'info', category: 'segmentation', message: 'Segmentation request cancelled by the client.' });
      if (!res.writableEnded) json(res, 499, { error: { code: 'REQUEST_CANCELLED', message: 'The request was cancelled.', retryable: true } });
      return;
    }
    recordServerLog({
      level: 'warn',
      category: 'segmentation',
      message: `Segmentation failed: ${err?.code || err?.name || 'ERROR'} ${String(err?.message || '').slice(0, 160)}`,
    });
    if (!res.writableEnded) json(res, err?.status || 500, errorPayload(err));
  } finally {
    req?.off?.('aborted', onRequestAbort);
    res?.off?.('close', onResponseClose);
  }
}

export async function handleSegmentationMask(req, res, id, index, deps = {}) {
  const store = deps.store || segmentationStore;
  const buffer = store.read(id, index);
  if (!buffer) {
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'That segmentation mask is missing or expired.', retryable: false } });
    return;
  }
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': buffer.length,
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(buffer);
}

export async function handleDeleteSegmentation(req, res, id, deps = {}) {
  const store = deps.store || segmentationStore;
  const removed = store.remove(id);
  json(res, 200, { ok: true, removed });
}

export { checkFlatCost };
