// server/routes/captures.js — immutable still captures.
//
// The client sends one still image. The server never edits the original. Files
// are written with an exclusive-create flag, and a capture id can never be
// overwritten. There is no grid overlay: the model receives the honest original
// image only.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { json, readJson, recordServerLog } from '../lib/http.js';
import { appError, errorPayload } from '../lib/errors.js';
import { config } from '../config.js';
import { addCaptureToProject } from '../../projectPlanner.js';

const IMAGE_DATA_URL = /^data:image\/(jpeg|jpg|png|webp);base64,([a-z0-9+/=\s]+)$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function decodeImageDataUrl(dataUrl, label = 'image') {
  const match = IMAGE_DATA_URL.exec(String(dataUrl || '').trim());
  if (!match) throw appError('CAMERA_FRAME_MISSING', `The ${label} must be a base64 JPEG, PNG or WebP data URL.`);
  const mimeType = match[1].toLowerCase() === 'jpg' ? 'image/jpeg' : `image/${match[1].toLowerCase()}`;
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw appError('IMAGE_DECODE_FAILED', `The ${label} could not be decoded.`);
  if (buffer.length > config.maxImageBytes) {
    throw appError('IMAGE_TOO_LARGE', `The ${label} is larger than ${Math.round(config.maxImageBytes / 1e6)} MB.`);
  }
  return { mimeType, buffer };
}

function safeDimension(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 && n <= 20000 ? n : null;
}

export function readCaptureRequest(body) {
  if (!body || typeof body !== 'object') throw appError('BAD_JSON', 'Expected a JSON object.');

  const projectId = clean(body.projectId, 80);
  if (!ID_RE.test(projectId)) throw appError('BAD_JSON', 'A valid projectId is required.');

  const width = safeDimension(body.width);
  const height = safeDimension(body.height);
  if (!width || !height) throw appError('CAMERA_FRAME_MISSING', 'The capture is missing usable width/height.');

  const original = decodeImageDataUrl(body.dataUrl, 'capture');

  const providedId = clean(body.captureId, 80);
  if (providedId && !ID_RE.test(providedId)) throw appError('BAD_JSON', 'Invalid capture id.');

  return {
    projectId,
    captureId: providedId || `cap_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    width,
    height,
    capturedAt: clean(body.capturedAt, 40) || new Date().toISOString(),
    original,
  };
}

export async function captureCreateHandler(req, res, store) {
  try {
    const body = await readJson(req, config.maxBodyBytes);
    const request = readCaptureRequest(body);
    const project = store.getProjectDoc(request.projectId);
    if (!project) {
      json(res, 404, {
        error: { code: 'NOT_FOUND', message: `Project ${request.projectId} not found. Create the project first.`, retryable: false },
      });
      return;
    }

    let capture;
    try {
      capture = store.createCapture({
        id: request.captureId,
        projectId: request.projectId,
        originalBuffer: request.original.buffer,
        mimeType: request.original.mimeType,
        width: request.width,
        height: request.height,
        capturedAt: request.capturedAt,
      });
    } catch (err) {
      if (err.code === 'CAPTURE_EXISTS') {
        json(res, 409, { error: { code: 'CAPTURE_EXISTS', message: err.message, retryable: false } });
        return;
      }
      throw err;
    }

    const updated = addCaptureToProject(project, capture);
    store.saveProjectDoc(updated);

    recordServerLog({
      level: 'ok',
      category: 'capture',
      message: `Stored capture ${capture.captureId} (${capture.width}x${capture.height})`,
    });
    json(res, 201, { capture, project: updated });
  } catch (err) {
    const status = err?.name === 'AppError' ? err.status : 500;
    json(res, status, errorPayload(err));
  }
}

export function captureGetHandler(req, res, store, captureId) {
  if (!ID_RE.test(captureId)) {
    json(res, 400, { error: { code: 'BAD_JSON', message: 'Invalid capture id.', retryable: false } });
    return;
  }
  const capture = store.getCapture(captureId);
  if (!capture) {
    json(res, 404, { error: { code: 'NOT_FOUND', message: `Capture ${captureId} not found.`, retryable: false } });
    return;
  }
  json(res, 200, { capture });
}

export function captureFileHandler(req, res, store, captureId) {
  if (!ID_RE.test(captureId)) {
    json(res, 400, { error: { code: 'BAD_JSON', message: 'Invalid capture id.', retryable: false } });
    return;
  }
  const file = store.getCaptureFile(captureId);
  if (!file) {
    json(res, 404, { error: { code: 'NOT_FOUND', message: `Capture ${captureId} has no stored file.`, retryable: false } });
    return;
  }

  res.writeHead(200, {
    'content-type': file.mimeType,
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  if (file.inlineText) {
    res.end(file.inlineText);
    return;
  }
  try {
    res.end(readFileSync(file.path));
  } catch {
    // Headers are already sent; end the response instead of writing JSON.
    if (!res.writableEnded) res.end();
  }
}
