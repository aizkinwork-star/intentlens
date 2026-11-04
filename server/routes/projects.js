// server/routes/projects.js — structured project state for the screenshot workflow.
//
// The project document is created by projectPlanner.js (shared with tests and
// the browser) and persisted in SQLite. It is resumable after a refresh or a
// backend restart.
import { json, readJson, recordServerLog } from '../lib/http.js';
import { errorPayload } from '../lib/errors.js';
import { config } from '../config.js';
import { createProjectFromIntent, deserializeProject } from '../../projectPlanner.js';

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function readProjectCreate(body) {
  if (!body || typeof body !== 'object') throw new Error('Expected a JSON object.');
  const intent = text(body.intent ?? body.description ?? body.question, 1200);
  if (!intent) throw new Error('Describe what you want to build first.');
  return { intent };
}

function handleError(res, err) {
  const status = err?.name === 'AppError' ? err.status : /Describe what you want/.test(err?.message || '') ? 400 : 500;
  json(res, status, errorPayload(err));
}

export async function projectCreateHandler(req, res, store) {
  try {
    const body = await readJson(req, config.maxBodyBytes);
    const { intent } = readProjectCreate(body);
    const project = createProjectFromIntent(intent);
    const saved = store.saveProjectDoc(project);
    recordServerLog({
      level: 'ok',
      category: 'project',
      message: `Created project ${saved.projectId} (${saved.title}) from a natural-language request`,
    });
    json(res, 201, { project: saved });
  } catch (err) {
    handleError(res, err);
  }
}

export async function projectListHandler(req, res, store) {
  try {
    const docs = store.listProjectDocs(30).map((project) => ({
      projectId: project.projectId,
      title: project.title,
      userGoal: project.userGoal,
      skillLevel: project.skillLevel,
      currentStep: project.currentStep,
      updatedAt: project.updatedAt,
      captureCount: (project.capturedImages || []).length,
    }));
    json(res, 200, { projects: docs });
  } catch (err) {
    handleError(res, err);
  }
}

export async function projectGetHandler(req, res, store, projectId) {
  try {
    if (!ID_RE.test(projectId)) {
      json(res, 400, { error: { code: 'BAD_JSON', message: 'Invalid project id.', retryable: false } });
      return;
    }
    const project = store.getProjectDoc(projectId);
    if (!project) {
      json(res, 404, { error: { code: 'NOT_FOUND', message: `Project ${projectId} not found.`, retryable: false } });
      return;
    }
    json(res, 200, { project });
  } catch (err) {
    handleError(res, err);
  }
}

export async function projectUpdateHandler(req, res, store, projectId) {
  try {
    if (!ID_RE.test(projectId)) {
      json(res, 400, { error: { code: 'BAD_JSON', message: 'Invalid project id.', retryable: false } });
      return;
    }
    const existing = store.getProjectDoc(projectId);
    if (!existing) {
      json(res, 404, { error: { code: 'NOT_FOUND', message: `Project ${projectId} not found.`, retryable: false } });
      return;
    }
    const body = await readJson(req, config.maxBodyBytes);
    const incoming = deserializeProject(body.project ?? body);
    if (!incoming || incoming.projectId !== projectId) {
      json(res, 400, { error: { code: 'BAD_JSON', message: 'The project document is missing or has the wrong projectId.', retryable: false } });
      return;
    }
    // Server-owned creation time is never replaced by a client value.
    const merged = { ...incoming, createdAt: existing.createdAt || incoming.createdAt };
    const saved = store.saveProjectDoc(merged);
    json(res, 200, { project: saved });
  } catch (err) {
    handleError(res, err);
  }
}
