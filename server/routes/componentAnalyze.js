// POST /api/component/analyze — screenshot-driven vision analysis.
//
// One capture -> one analysis. No per-frame inference, no continuous tracking.
// The capture must already be stored (POST /api/captures); this route reads the
// immutable original from disk, so the model sees exactly what the user captured.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { json, readJson, recordServerLog } from '../lib/http.js';
import { appError, errorPayload } from '../lib/errors.js';
import { config } from '../config.js';
import { buildRouter } from '../services/router.js';
import { providerHealthSnapshot } from '../services/provider.js';
import { providerAvailability, tryBuildRouter } from '../services/providerGate.js';
import { COMPONENT_SCHEMA, buildComponentPrompt } from '../services/componentSchema.js';
import { recognizerStatus } from '../services/componentRecognizer.js';
import { ELECTROCOM61_CLASSES } from '../../componentVocabulary.js';
import { toComponentResult } from '../../componentResult.js';
import {
  addObjectToProject,
  currentStepOf,
  deserializeProject,
  projectContextForAI,
} from '../../projectPlanner.js';

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function imageDataUrlFromFile(store, captureId) {
  const file = store.getCaptureFile(captureId);
  if (!file || !file.path) return null;
  const buffer = readFileSync(file.path);
  return `data:${file.mimeType};base64,${buffer.toString('base64')}`;
}

export function readComponentRequest(body, { store } = {}) {
  if (!body || typeof body !== 'object') throw appError('BAD_JSON', 'Expected a JSON object.');

  const projectId = clean(body.projectId, 80);
  if (!ID_RE.test(projectId)) throw appError('BAD_JSON', 'A valid projectId is required.');

  const captureId = clean(body.captureId, 80) || null;
  if (captureId && !ID_RE.test(captureId)) throw appError('BAD_JSON', 'Invalid capture id.');

  let imageDataUrl = null;
  let width = null;
  let height = null;

  if (captureId) {
    if (!store) throw appError('INTERNAL_ERROR', 'Capture storage is unavailable.');
    const meta = store.getCapture(captureId);
    if (!meta) throw appError('NOT_FOUND', `Capture ${captureId} not found.`);
    if (meta.projectId !== projectId) throw appError('BAD_JSON', 'That capture belongs to a different project.');
    imageDataUrl = imageDataUrlFromFile(store, captureId);
    if (!imageDataUrl) throw appError('IMAGE_DECODE_FAILED', 'The stored capture file is missing.');
    ({ width, height } = meta);
  } else {
    const frame = body.capture || body.frame;
    if (!frame || typeof frame !== 'object' || typeof frame.dataUrl !== 'string') {
      throw appError('CAMERA_FRAME_MISSING', 'Provide a stored captureId or an inline capture.');
    }
    imageDataUrl = frame.dataUrl;
    width = Math.round(Number(frame.width));
    height = Math.round(Number(frame.height));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw appError('CAMERA_FRAME_MISSING', 'The inline capture is missing usable width/height.');
    }
  }

  const localCandidates = Array.isArray(body.localCandidates)
    ? body.localCandidates.slice(0, 5).map((item) => ({
      name: clean(item?.name, 80),
      distance: Number.isFinite(Number(item?.distance)) ? Number(item.distance) : null,
      confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : null,
    })).filter((item) => item.name)
    : [];

  return {
    requestId: clean(body.requestId, 80) || `req_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
    projectId,
    captureId,
    imageDataUrl,
    width,
    height,
    question: clean(body.question, 800),
    userCorrection: clean(body.userCorrection, 160) || null,
    previousInstruction: clean(body.previousInstruction, 700) || null,
    localCandidates,
    projectContext: body.projectContext && typeof body.projectContext === 'object' ? body.projectContext : null,
  };
}

export function resolveProjectForRequest(store, request) {
  if (store) {
    const doc = store.getProjectDoc(request.projectId);
    if (doc) return deserializeProject(doc) || doc;
  }
  return null;
}

/**
 * Pure analysis call (router injected). Returns { routed, rawJson, converted }.
 * Tests inject a fake router and assert the request count.
 */
export async function runComponentAnalysis({ router, request, project, signal }) {
  const projectContext = project
    ? projectContextForAI(project)
    : request.projectContext;

  // The local recogniser's label vocabulary makes the AI's answer
  // dataset-grounded instead of open-ended. It is context, not a command: the
  // image and the user always win over the list.
  const status = recognizerStatus();
  // Fall back to the committed label list when the model files are absent, so
  // the prompt is still dataset-grounded instead of open-ended.
  const datasetClasses = status.model?.classNames || ELECTROCOM61_CLASSES;

  const prompt = buildComponentPrompt({
    projectContext,
    capture: {
      captureId: request.captureId || 'inline_capture',
      width: request.width,
      height: request.height,
    },
    localCandidates: request.localCandidates,
    datasetClasses,
    question: request.question || project?.userGoal || '',
    userCorrection: request.userCorrection,
    previousInstruction: request.previousInstruction,
  });

  const routed = await router.analyze({
    instructions: prompt.instructions,
    userText: prompt.userText,
    imageDataUrl: request.imageDataUrl,
    imageDataUrls: [request.imageDataUrl],
    imageMeta: { width: request.width, height: request.height },
    schema: COMPONENT_SCHEMA,
    allowWebSearch: false,
    requestId: request.requestId,
    deadlineMs: config.answerDeadlineMs,
    signal,
  });

  let rawJson;
  try {
    rawJson = typeof routed?.result?.text === 'string' ? JSON.parse(routed.result.text) : routed?.result?.text;
  } catch {
    throw appError('MODEL_BAD_RESPONSE', 'The model did not return valid JSON.');
  }

  const converted = toComponentResult(rawJson);
  return { routed, rawJson, converted };
}

/**
 * Persist the outcome of an analysis attempt that did not produce an object, so
 * a resumed project still shows the honest state instead of "waiting".
 */
export function persistAnalysisOutcome(store, { request, status, message, errors = [] }) {
  if (!store || !request.captureId) return;
  const project = store.getProjectDoc(request.projectId);
  if (!project) return;
  const at = new Date().toISOString();
  store.saveProjectDoc({
    ...project,
    lastAnalysis: {
      captureId: request.captureId,
      status,
      message: String(message || '').slice(0, 600),
      errors: errors.slice(0, 6).map((e) => String(e).slice(0, 200)),
      at,
    },
    updatedAt: at,
  });
}

function persistObject(store, { request, result, routed, requestId }) {  if (!store) return null;
  const project = store.getProjectDoc(request.projectId);
  if (!project) return null;

  const step = currentStepOf(project);
  const createdAt = new Date().toISOString();
  const object = {
    id: `obj_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
    projectId: request.projectId,
    captureId: request.captureId || null,
    name: result.component.name,
    identityStatus: result.component.identity_status,
    confirmed: false,
    uncertainty: result.component.uncertainty,
    evidence: result.component.evidence,
    center: result.location?.center || null,
    corners: result.location?.corners || null,
    source: 'ai_vision',
    provider: routed?.providerUsed || null,
    modelId: routed?.modelId || null,
    requestId,
    stepId: step?.stepId || null,
    nextAction: result.next_action,
    instruction: result.instruction,
    createdAt,
    updatedAt: createdAt,
  };

  let updated = addObjectToProject(project, object);
  updated = {
    ...updated,
    conversationHistory: [
      ...(updated.conversationHistory || []),
      {
        role: 'assistant',
        kind: 'component_analysis',
        text: result.instruction,
        at: createdAt,
        captureId: request.captureId || null,
        objectId: object.id,
      },
    ].slice(-40),
    lastAnswer: {
      text: result.instruction,
      objectId: object.id,
      captureId: request.captureId || null,
      nextAction: result.next_action,
      provider: routed?.providerUsed || null,
      at: createdAt,
    },
    updatedAt: createdAt,
  };
  store.saveProjectDoc(updated);
  return object;
}

export async function componentAnalyzeHandler(req, res, store) {
  const started = Date.now();
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let captureId = null;
  let requestId = null;

  try {
    const body = await readJson(req, config.maxBodyBytes);
    const request = readComponentRequest(body, { store });
    captureId = request.captureId;
    requestId = request.requestId;

    const availability = providerAvailability();
    if (!availability.available) {
      persistAnalysisOutcome(store, {
        request,
        status: 'unavailable',
        message: availability.message,
      });
      json(res, 200, {
        status: 'unavailable',
        ...availability,
        projectId: request.projectId,
        captureId,
        capturePreserved: true,
      });
      return;
    }

    const built = tryBuildRouter();
    if (!built.router) {
      persistAnalysisOutcome(store, {
        request,
        status: 'unavailable',
        message: built.unavailable.message,
      });
      json(res, 200, {
        status: 'unavailable',
        ...built.unavailable,
        projectId: request.projectId,
        captureId,
        capturePreserved: true,
      });
      return;
    }

    const project = resolveProjectForRequest(store, request);
    const { routed, converted } = await runComponentAnalysis({
      router: built.router,
      request,
      project,
      signal: controller.signal,
    });

    if (!converted.ok) {
      recordServerLog({
        level: 'error',
        category: 'model',
        message: `Component result rejected: ${converted.errors.join(' ')}`,
      });
      persistAnalysisOutcome(store, {
        request,
        status: 'rejected',
        message: 'The AI response could not be validated, so no box was drawn. Capture another image or retry.',
        errors: converted.errors,
      });
      json(res, 200, {
        status: 'rejected',
        code: 'RESULT_SCHEMA_INVALID',
        message: 'The AI response could not be validated, so no box was drawn. Capture another image or retry.',
        errors: converted.errors,
        projectId: request.projectId,
        captureId,
        capturePreserved: true,
        provider: {
          id: routed.providerUsed,
          name: routed.providerName,
          modelId: routed.modelId,
        },
      });
      return;
    }

    const object = persistObject(store, {
      request,
      result: converted.result,
      routed,
      requestId,
    });

    recordServerLog({
      level: 'ok',
      category: 'api',
      message: `Component analysis ok via ${routed.providerUsed} (${routed.modelId || 'unknown model'}) (${Date.now() - started}ms)`,
      ms: Date.now() - started,
    });

    json(res, 200, {
      status: 'ok',
      requestId,
      projectId: request.projectId,
      captureId,
      capturePreserved: true,
      analysis: converted.result,
      object,
      provider: {
        id: routed.providerUsed,
        name: routed.providerName,
        modelId: routed.modelId,
        fallbackOccurred: routed.fallbackOccurred,
        attempts: routed.attempts,
        health: providerHealthSnapshot(),
      },
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    if (controller.signal.aborted && !res.writableEnded) {
      res.end();
      return;
    }
    recordServerLog({
      level: 'error',
      category: 'api',
      message: `Component analysis failed: ${err?.message || err}`,
      detail: err?.stack || String(err),
    });
    if (res.writableEnded) return;
    const status = err?.name === 'AppError' ? err.status : 500;
    const payload = errorPayload(err);
    payload.capturePreserved = Boolean(captureId);
    if (captureId) payload.captureId = captureId;
    json(res, status, payload);
  }
}
