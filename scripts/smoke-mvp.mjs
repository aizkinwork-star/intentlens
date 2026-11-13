// scripts/smoke-mvp.mjs — live HTTP smoke test for the screenshot workflow.
// Uses the running server on PORT and its .session-token. Outbound network is
// disabled, so /api/component/analyze must return status:"unavailable" without
// contacting a provider.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.SMOKE_BASE || 'http://127.0.0.1:8011';
const dataDir = process.env.SMOKE_DATA || join(process.env.TEMP, 'il-mvp-smoke');
const token = readFileSync(join(dataDir, '.session-token'), 'utf8').trim();

const headers = { 'x-intentlens-token': token };
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(path, { method = 'GET', body = null, raw = false } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { res, buffer: Buffer.from(await res.arrayBuffer()) };
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  return { res, data };
}

// 1x1 JPEG so the capture route has a real image payload.
const JPEG_1PX = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDP/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);
const jpegDataUrl = `data:image/jpeg;base64,${JPEG_1PX.toString('base64')}`;

try {
  // Auth is enforced.
  const unauth = await fetch(`${base}/api/projects`);
  record('unauthenticated request is rejected', [401, 403].includes(unauth.status), `HTTP ${unauth.status}`);

  // Create project.
  const created = await call('/api/projects', {
    method: 'POST',
    body: { intent: 'I want to build a blinking LED with an Arduino Uno. I have an Arduino Uno, a breadboard and two LEDs.' },
  });
  const project = created.data.project;
  record('POST /api/projects creates a structured project',
    created.res.status === 201 && Boolean(project?.projectId),
    `${created.res.status} ${project?.projectId || ''} steps=${project?.orderedSteps?.length ?? '?'}`);
  if (!project) throw new Error('no project created');

  // Get project.
  const got = await call(`/api/projects/${project.projectId}`);
  record('GET /api/projects/:id returns the persisted project',
    got.res.status === 200 && got.data.project?.projectId === project.projectId,
    `HTTP ${got.res.status}`);

  // List projects.
  const listed = await call('/api/projects');
  record('GET /api/projects lists it',
    listed.res.status === 200 && listed.data.projects?.some((p) => p.projectId === project.projectId),
    `${listed.data.projects?.length ?? 0} project(s)`);

  // Update step.
  const movedStep = project.orderedSteps?.[1]?.stepId || project.currentStep;
  const updatedDoc = { ...project, currentStep: movedStep };
  const updated = await call(`/api/projects/${project.projectId}`, {
    method: 'PUT',
    body: { project: updatedDoc },
  });
  record('PUT /api/projects/:id persists the current step',
    updated.res.status === 200 && updated.data.project?.currentStep === movedStep,
    `HTTP ${updated.res.status} step=${updated.data.project?.currentStep || '?'}`);

  // Capture create.
  const capId = `cap_smoke_${Date.now().toString(36)}`;
  const capture = await call('/api/captures', {
    method: 'POST',
    body: {
      projectId: project.projectId,
      captureId: capId,
      width: 1280,
      height: 720,
      capturedAt: new Date().toISOString(),
      dataUrl: jpegDataUrl,
    },
  });
  record('POST /api/captures stores the capture',
    capture.res.status === 201 && capture.data.capture?.captureId === capId,
    `HTTP ${capture.res.status} grid=${capture.data.capture?.gridSize ?? 'none'}`);

  // Original bytes are unchanged.
  const original = await call(`/api/captures/${capId}/original`, { raw: true });
  record('original bytes are byte-identical to the upload',
    original.res.status === 200 && Buffer.compare(original.buffer, JPEG_1PX) === 0,
    `${original.buffer.length} bytes`);

  // There is no grid overlay any more: the endpoint must be gone.
  const overlay = await call(`/api/captures/${capId}/overlay`, { raw: true });
  record('no grid overlay is produced or served',
    overlay.res.status === 404,
    `HTTP ${overlay.res.status}`);

  // Duplicate capture is refused, original untouched.
  const duplicate = await call('/api/captures', {
    method: 'POST',
    body: {
      projectId: project.projectId,
      captureId: capId,
      width: 1280,
      height: 720,
      dataUrl: jpegDataUrl,
    },
  });
  record('a duplicate capture id is refused (immutable)',
    duplicate.res.status === 409 && duplicate.data.error?.code === 'CAPTURE_EXISTS',
    `HTTP ${duplicate.res.status} ${duplicate.data.error?.code || ''}`);

  // Analyze with outbound disabled -> unavailable, capture preserved.
  const analyzed = await call('/api/component/analyze', {
    method: 'POST',
    body: { projectId: project.projectId, captureId: capId, question: project.userGoal },
  });
  record('POST /api/component/analyze reports unavailable without a provider',
    analyzed.res.status === 200
      && analyzed.data.status === 'unavailable'
      && analyzed.data.capturePreserved === true,
    `${analyzed.data.status} ${analyzed.data.code || ''}`);

  // Explain with outbound disabled -> unavailable, no answer invented.
  const explained = await call('/api/explain', {
    method: 'POST',
    body: { projectId: project.projectId, captureId: capId, previousAnswer: 'Check the LED polarity.' },
  });
  record('POST /api/explain reports unavailable without a provider',
    explained.res.status === 200 && explained.data.status === 'unavailable' && !explained.data.answer,
    `${explained.data.status} ${explained.data.code || ''}`);

  // Capture metadata still present after analysis attempts.
  const stillThere = await call(`/api/captures/${capId}`);
  record('capture survives analysis/explain unavailability',
    stillThere.res.status === 200 && stillThere.data.capture?.captureId === capId,
    `HTTP ${stillThere.res.status}`);

  // Bad coordinate-shaped request is refused before any provider call.
  const bad = await call('/api/component/analyze', {
    method: 'POST',
    body: { projectId: 'not a valid id', captureId: 'x' },
  });
  record('invalid project id is rejected with 400',
    bad.res.status === 400 && Boolean(bad.data.error?.code),
    `HTTP ${bad.res.status} ${bad.data.error?.code || ''}`);
} catch (err) {
  record('smoke run completed without throwing', false, err.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
