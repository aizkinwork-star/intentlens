// POST /api/analyze — local-first, multi-provider cloud inference.
//
// Order: validate request -> build explicit context -> call the configured
// vision model through the provider failover router -> validate output ->
// return GroundingResult. Any catalogued vision model in any configured
// provider may be used; a text-only model is never sent an image.
//
// Non-negotiables:
//   - Only a vision-capable model receives an image.
//   - No API keys in browser code; keys live in the backend encrypted store.
//   - A hard token/cost preflight runs before every outbound request.
//   - Outbound network restricted to known hosts plus explicit HTTPS relays.
//   - Fail closed when all providers are unavailable.
//   - No per-frame AI calls; the tracker handles local tracking.
//   - No web search at runtime; local source vault instead.

import { randomUUID } from 'node:crypto';
import { readJson, json, recordServerLog } from '../lib/http.js';
import { appError, errorPayload } from '../lib/errors.js';
import { config, localModelConfig, modelMode, localModelAvailable, outboundNetworkAllowed, providerRuntime } from '../config.js';
import { isValidPoint, isValidBox } from '../../grid.js';
import { buildGroundingPrompt, summarizeContext, resolveLimits } from '../services/contextBuilder.js';
import { ContextBudget } from '../services/contextBudget.js';
import { buildRouter } from '../services/router.js';
import { chatCompletionsUrl } from '../services/openaiCompatibleProvider.js';
import { providerHealthSnapshot } from '../services/provider.js';
import { buildLocalVaultSearchProvider } from '../services/searchAdapter.js';
import { toGroundingResult } from '../services/groundingValidator.js';
import { validateInstructionPlan } from '../services/instructionValidator.js';
import { record as benchRecord, getAllStats } from '../services/benchmark.js';
import { costStatusForClient } from '../services/costManager.js';
import { mockGrounding } from '../services/mockModel.js';

const IMAGE_DATA_URL = /^data:image\/(jpeg|jpg|png|webp|gif|x-icon);base64,[a-z0-9+/=\s]+$/i;

const text = (value, max) => String(value ?? '').trim().slice(0, max);

function decodedBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
}

/** Exact upstream target for logs. Account ids and keys are never logged. */
function inferenceTarget(providerId, modelId) {
  const runtime = providerRuntime(providerId);
  if (!runtime) {
    const endpoint = chatCompletionsUrl(config.modalBaseUrl || '');
    let host = '';
    try { host = new URL(endpoint).hostname; } catch { /* ignore */ }
    return { endpoint, host };
  }
  if (runtime.kind === 'cloudflare') {
    return {
      endpoint: `https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/${modelId || runtime.modelId}`,
      host: 'api.cloudflare.com',
    };
  }
  let host = '';
  try { host = new URL(runtime.endpoint).hostname; } catch { /* ignore */ }
  return { endpoint: runtime.endpoint || '', host };
}

function sanitizeSceneMap(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw appError('BAD_JSON', 'sceneMap must be an array.');
  const out = [];
  for (const raw of list.slice(-24)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = text(raw.id, 40);
    if (!id) continue;
    const item = {
      id,
      label: text(raw.label, 80),
      kind: text(raw.kind || 'unknown', 20),
      sourceFrameId: text(raw.sourceFrameId, 40),
      confidence: Number(raw.confidence),
      status: raw.status === 'stale' ? 'stale' : raw.status === 'confirmed' ? 'confirmed' : 'current',
      evidenceKind: ['visual_inference', 'verified_reference', 'user_confirmed'].includes(raw.evidenceKind)
        ? raw.evidenceKind
        : 'visual_inference',
    };
    if (!Number.isFinite(item.confidence)) item.confidence = 0;
    if (raw.point !== undefined && raw.point !== null) {
      if (!isValidPoint(raw.point.x, raw.point.y)) continue;
      item.point = { x: raw.point.x, y: raw.point.y };
    }
    if (raw.box !== undefined && raw.box !== null) {
      if (!isValidBox(raw.box)) continue;
      item.box = { x: raw.box.x, y: raw.box.y, width: raw.box.width, height: raw.box.height };
    }
    if (!item.point && !item.box && !item.label) continue;
    out.push(item);
  }
  return out;
}

function sanitizeRegion(region) {
  if (region == null) return null;
  if (typeof region !== 'object') throw appError('BAD_JSON', 'userSelectedRegion must be an object or null.');
  if (!isValidPoint(region.x, region.y)) throw appError('BAD_JSON', 'userSelectedRegion has invalid coordinates.');
  return { x: region.x, y: region.y, cellId: text(region.cellId, 12) || null };
}

function sanitizeReferencePack(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw appError('BAD_JSON', 'referencePack must be an array.');
  return list.slice(0, 6).map((raw) => ({
    id: text(raw?.id, 40) || randomUUID(),
    title: text(raw?.title, 80) || 'Untitled reference',
    kind: ['datasheet', 'schematic', 'manual', 'user_note', 'other'].includes(raw?.kind) ? raw.kind : 'other',
    verifiedByUser: Boolean(raw?.verifiedByUser),
    summary: text(raw?.summary, 300) || null,
  }));
}

function sanitizeCorrections(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw appError('BAD_JSON', 'recentCorrections must be an array.');
  return list.slice(-5).map((raw) => ({
    targetId: text(raw?.targetId, 40),
    correction: text(raw?.correction, 160),
    at: text(raw?.at, 40) || null,
  })).filter((c) => c.targetId && c.correction);
}

export function readAnalyzeRequest(body) {
  if (!body || typeof body !== 'object') throw appError('BAD_JSON', 'Expected a JSON object.');

  const command = text(body.command, 500);
  if (!command) throw appError('COMMAND_MISSING');

  const frame = body.frame;
  if (!frame || typeof frame !== 'object') throw appError('CAMERA_FRAME_MISSING');
  const dataUrl = typeof frame.dataUrl === 'string' ? frame.dataUrl.trim() : '';
  if (!dataUrl) throw appError('CAMERA_FRAME_MISSING');
  if (!IMAGE_DATA_URL.test(dataUrl)) {
    throw appError('CAMERA_FRAME_MISSING', 'The frame must be a base64 JPEG, PNG, WebP or GIF data URL.');
  }
  if (decodedBytes(dataUrl) > config.maxImageBytes) {
    throw appError('IMAGE_TOO_LARGE', `The frame is larger than ${Math.round(config.maxImageBytes / 1e6)} MB.`);
  }

  const width = Number(frame.width);
  const height = Number(frame.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 20000 || height > 20000) {
    throw appError('CAMERA_FRAME_MISSING', 'The frame is missing usable width/height.');
  }

  return {
    requestId: text(body.requestId, 80) || `req_${Date.now()}_${randomUUID().slice(0, 6)}`,
    sessionId: text(body.sessionId, 80) || 'sess_local_demo',
    projectId: text(body.projectId, 80) || 'default',
    command,
    frame: {
      frameId: text(frame.frameId, 60) || `frame_${Date.now()}`,
      dataUrl,
      mimeType: text(frame.mimeType, 40) || 'image/jpeg',
      width: Math.round(width),
      height: Math.round(height),
      capturedAt: text(frame.capturedAt, 40) || new Date().toISOString(),
    },
    userSelectedRegion: sanitizeRegion(body.userSelectedRegion),
    sceneMap: sanitizeSceneMap(body.sceneMap),
    taskSummary: text(body.taskSummary, 300),
    pcbContext: body.pcbContext && typeof body.pcbContext === 'object' ? body.pcbContext : null,
    referencePack: sanitizeReferencePack(body.referencePack),
    recentCorrections: sanitizeCorrections(body.recentCorrections),
    lastTargetId: text(body.lastTargetId, 40) || null,
    allowWebSearch: false,
  };
}

export async function analyzeHandler(req, res, store) {
  const started = Date.now();
  let requestId = null;

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const body = await readJson(req, config.maxBodyBytes);
    const clean = readAnalyzeRequest(body);
    requestId = clean.requestId;

    const isLocalAvailable = localModelAvailable();

    if (!isLocalAvailable) {
      throw appError('AI_NOT_CONFIGURED', 'No vision provider is configured. Add a provider key in Settings (OpenRouter, Groq, Google AI Studio, NVIDIA NIM, Cloudflare, Mistral and others are supported).');
    }
    if (!outboundNetworkAllowed()) {
      throw appError('NETWORK_DISABLED', 'Outbound network is disabled in .env (ALLOW_OUTBOUND_NETWORK=false). Local camera, tracking and k-NN still work.');
    }

    const prompt = buildGroundingPrompt(clean);

    // Build router with cloud Meta providers.
    let router = null;
    try {
      router = buildRouter(config);
    } catch (err) {
      recordServerLog({ level: 'error', category: 'provider', message: `Router error: ${err.message}` });
    }

    if (!router || !router.providers?.length) {
      throw appError('AI_NOT_CONFIGURED', 'No vision provider is configured. Add a key in Provider Setup.');
    }

    // Build local vault search provider if store is available.
    let searchRouter = null;
    if (store) {
      try {
        searchRouter = buildLocalVaultSearchProvider(store, clean.projectId);
      } catch {
        // Search router construction non-fatal; search will be unavailable.
      }
    }

    recordServerLog({
      level: 'info',
      category: 'provider',
      message: `Analyzing frame (${clean.frame.width}x${clean.frame.height}) with command: "${clean.command}"`,
    });

    // Call the vision router sequentially.
    let routed;
    try {
      routed = await router.analyze({
        instructions: prompt.instructions,
        userText: prompt.userText,
        imageDataUrl: clean.frame.dataUrl,
        imageMeta: { width: clean.frame.width, height: clean.frame.height },
        allowWebSearch: false,
        requestId: clean.requestId,
        frameId: clean.frame.frameId,
        deadlineMs: config.answerDeadlineMs,
        signal: controller.signal,
      });
    } catch (err) {
      err.providerHealth = providerHealthSnapshot();
      throw err;
    }
    const { result: rawResult, providerUsed, providerName, modelId, fallbackOccurred, attempts } = routed;

    let rawJson = null;
    try {
      rawJson = typeof rawResult.text === 'string' ? JSON.parse(rawResult.text) : rawResult.text;
    } catch {
      recordServerLog({ level: 'error', category: 'model', message: 'Provider returned malformed non-JSON text', detail: rawResult.text });
      throw appError('MODEL_BAD_RESPONSE', 'Model did not return valid JSON.');
    }

    const result = toGroundingResult({
      raw: rawJson,
      request: clean,
      citations: rawResult.citations || [],
      searchedWeb: Boolean(rawResult.searchedWeb),
    });
    // Validate multi-step instruction plan if present.
    if (result.plan) {
      const v = validateInstructionPlan(result.plan);
      if (!v.ok) result.plan._validationErrors = v.errors;
    }

    const resolvedModelId = modelId || localModelConfig.modelId;
    const target = inferenceTarget(providerUsed, resolvedModelId);
    const httpStatus = Number.isFinite(rawResult?.httpStatus) ? rawResult.httpStatus : 200;
    const returnedModel = rawResult?.returnedModel || resolvedModelId;
    const attemptTrail = (attempts || []).map((a) => {
      const at = inferenceTarget(a.id, a.modelId);
      return `${a.id}(${at.host || a.id}) model=${a.modelId || '-'} ${a.ok ? 'ok' : (a.code || 'fail')} ${a.ms ?? '-'}ms`;
    }).join(' | ');

    recordServerLog({
      level: 'ok',
      category: 'api',
      message: `POST ${target.endpoint} provider=${providerUsed} host=${target.host} model=${resolvedModelId} returned=${returnedModel} mode=vision http=${httpStatus} status=ok latency=${Date.now() - started}ms request=${clean.requestId}${fallbackOccurred ? ` fallback=true attempts=${attemptTrail}` : ''}`,
      ms: Date.now() - started,
    });

    const payload = {
      requestId: clean.requestId,
      frameId: clean.frame.frameId,
      ...result,
      meta: {
        ...(result.meta || {}),
        searchedWeb: false,
        searchEnabled: false,
        modelMode: modelMode(),
        modelId: resolvedModelId,
        returnedModel,
        providerUsed,
        providerName: providerName || providerUsed,
        fallbackOccurred,
        providerHealth: providerHealthSnapshot(),
        request: {
          method: 'POST',
          endpoint: target.endpoint,
          host: target.host,
          model: resolvedModelId,
          mode: 'vision',
          provider: providerUsed,
          requestId: clean.requestId,
          httpStatus,
        },
        ...(attempts?.length ? {
          attempts: attempts.map((a) => ({
            ...a,
            endpoint: inferenceTarget(a.id, a.modelId).endpoint,
            host: inferenceTarget(a.id, a.modelId).host,
          })),
        } : {}),
        latencyMs: Date.now() - started,
        context: summarizeContext(clean, resolveLimits('none')),
        projectId: clean.projectId,
        budget: routed.budget || null,
        cost: costStatusForClient(),
        benchmark: getAllStats(),
      },
    };

    if (res.writableEnded) return;
    json(res, 200, payload);
    console.log(`[${requestId}] analyze ok mode=${modelMode()} searched=false ${Date.now() - started}ms`);
  } catch (err) {
    if (controller.signal.aborted && !res.writableEnded) {
      console.log(`[${requestId || '-'}] analyze cancelled by client`);
      res.end();
      return;
    }
    const status = err?.name === 'AppError' ? err.status : 500;
    const msg = err?.message || 'Inference failed';
    const attempts = Array.isArray(err?.attempts) ? err.attempts : [];
    const attemptTrail = attempts.map((a) => {
      const target = inferenceTarget(a.id, a.modelId);
      return `${a.id}(${target.host || a.id}) POST ${target.endpoint || '-'} model=${a.modelId || '-'} ${a.ok ? 'ok' : (a.code || 'fail')} ${a.ms ?? '-'}ms`;
    }).join(' | ');
    recordServerLog({
      level: 'error',
      category: 'api',
      message: `Inference failed (${status})${requestId ? ` request=${requestId}` : ''} mode=vision: ${msg}${attemptTrail ? ` attempts=${attemptTrail}` : ''}`,
      detail: err?.stack || String(err),
    });
    console.warn(`[${requestId || '-'}] analyze failed ${status}: ${err?.code || err?.message}`);
    if (!res.writableEnded) json(res, status, errorPayload(err));
  }
}