// POST /api/explain — exactly one new AI request for a simpler explanation.
//
// REPEAT is deliberately not an endpoint: it reuses the stored answer on the
// client and returns text only. That keeps the inference count at zero.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { json, readJson, recordServerLog } from '../lib/http.js';
import { appError, errorPayload } from '../lib/errors.js';
import { config } from '../config.js';
import { providerAvailability, tryBuildRouter } from '../services/providerGate.js';
import { EXPLAIN_SCHEMA, buildExplainPrompt } from '../services/componentSchema.js';
import { deserializeProject, projectContextForAI } from '../../projectPlanner.js';

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const MAX_ANSWER = 4000;

export function readExplainRequest(body) {
  if (!body || typeof body !== 'object') throw appError('BAD_JSON', 'Expected a JSON object.');

  const projectId = clean(body.projectId, 80);
  if (!ID_RE.test(projectId)) throw appError('BAD_JSON', 'A valid projectId is required.');

  const previousAnswer = clean(body.previousAnswer, MAX_ANSWER);
  if (!previousAnswer) throw appError('BAD_JSON', 'There is no previous answer to explain. Ask for a component analysis first.');

  const captureId = clean(body.captureId, 80) || null;
  if (captureId && !ID_RE.test(captureId)) throw appError('BAD_JSON', 'Invalid capture id.');

  return {
    requestId: clean(body.requestId, 80) || `req_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
    projectId,
    captureId,
    previousAnswer,
    question: clean(body.question, 500),
  };
}

export async function runExplain({ router, request, project, captureImage = null, signal }) {
  const prompt = buildExplainPrompt({
    projectContext: project ? projectContextForAI(project) : null,
    previousAnswer: request.previousAnswer,
    question: request.question || project?.userGoal || '',
    capture: captureImage ? { captureId: request.captureId, gridSize: captureImage.gridSize } : null,
  });

  const routed = await router.analyze({
    instructions: prompt.instructions,
    userText: prompt.userText,
    imageDataUrl: captureImage?.dataUrl || null,
    imageDataUrls: captureImage?.dataUrl ? [captureImage.dataUrl] : [],
    schema: EXPLAIN_SCHEMA,
    allowWebSearch: false,
    requestId: request.requestId,
    signal,
  });

  let rawJson;
  try {
    rawJson = typeof routed?.result?.text === 'string' ? JSON.parse(routed.result.text) : routed?.result?.text;
  } catch {
    throw appError('MODEL_BAD_RESPONSE', 'The model did not return valid JSON.');
  }

  const answer = clean(rawJson?.answer, MAX_ANSWER);
  if (!answer) throw appError('MODEL_BAD_RESPONSE', 'The model returned an empty explanation.');

  return { routed, answer };
}

function loadCaptureImage(store, request) {
  if (!store || !request.captureId) return null;
  const meta = store.getCapture(request.captureId);
  if (!meta || meta.projectId !== request.projectId) return null;
  const file = store.getCaptureFile(request.captureId, 'original');
  if (!file || !file.path) return null;
  try {
    const buffer = readFileSync(file.path);
    return {
      dataUrl: `data:${file.mimeType};base64,${buffer.toString('base64')}`,
      gridSize: meta.gridSize,
    };
  } catch {
    return null;
  }
}

function persistExplain(store, { request, answer, routed }) {
  if (!store) return;
  const project = store.getProjectDoc(request.projectId);
  if (!project) return;
  const at = new Date().toISOString();
  const updated = {
    ...project,
    conversationHistory: [
      ...(project.conversationHistory || []),
      { role: 'assistant', kind: 'explanation', text: answer.slice(0, 2000), at, captureId: request.captureId || null },
    ].slice(-40),
    lastAnswer: {
      text: answer,
      objectId: project.lastAnswer?.objectId || null,
      captureId: request.captureId || project.lastAnswer?.captureId || null,
      nextAction: 'instruction',
      provider: routed?.providerUsed || null,
      kind: 'explanation',
      at,
    },
    updatedAt: at,
  };
  store.saveProjectDoc(deserializeProject(updated) || updated);
}

export async function explainHandler(req, res, store) {
  const started = Date.now();
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const body = await readJson(req, config.maxBodyBytes);
    const request = readExplainRequest(body);

    const availability = providerAvailability();
    if (!availability.available) {
      json(res, 200, {
        status: 'unavailable',
        ...availability,
        projectId: request.projectId,
        captureId: request.captureId,
      });
      return;
    }

    const built = tryBuildRouter();
    if (!built.router) {
      json(res, 200, {
        status: 'unavailable',
        ...built.unavailable,
        projectId: request.projectId,
        captureId: request.captureId,
      });
      return;
    }

    const project = store.getProjectDoc(request.projectId) || null;
    const captureImage = loadCaptureImage(store, request);
    const { routed, answer } = await runExplain({
      router: built.router,
      request,
      project,
      captureImage,
      signal: controller.signal,
    });

    persistExplain(store, { request, answer, routed });

    recordServerLog({
      level: 'ok',
      category: 'api',
      message: `Explanation ok via ${routed.providerUsed} (${Date.now() - started}ms)`,
      ms: Date.now() - started,
    });

    json(res, 200, {
      status: 'ok',
      requestId: request.requestId,
      projectId: request.projectId,
      captureId: request.captureId,
      answer,
      provider: {
        id: routed.providerUsed,
        name: routed.providerName,
        modelId: routed.modelId,
        fallbackOccurred: routed.fallbackOccurred,
        attempts: routed.attempts,
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
      message: `Explanation failed: ${err?.message || err}`,
      detail: err?.stack || String(err),
    });
    if (res.writableEnded) return;
    const status = err?.name === 'AppError' ? err.status : 500;
    json(res, status, errorPayload(err));
  }
}
