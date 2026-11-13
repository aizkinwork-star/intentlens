// server/routes/recognizer.js — local component recognition API.
//
// These routes never touch a provider, a key, or the network. They expose the
// measured on-device classifier so the desktop and phone clients can add
// dataset-grounded candidates to the AI prompt.
import { json, readJson, recordServerLog } from '../lib/http.js';
import { appError, errorPayload } from '../lib/errors.js';
import { config } from '../config.js';
import { recognizerStatus, recognizePng } from '../services/componentRecognizer.js';

const IMAGE_DATA_URL = /^data:image\/png;base64,([a-z0-9+/=\s]+)$/i;
const MAX_PIXELS = 4096 * 4096;

export function handleRecognizerStatus(req, res) {
  json(res, 200, recognizerStatus());
}

export async function recognizerClassifyHandler(req, res) {
  const started = Date.now();
  try {
    const body = await readJson(req, config.maxBodyBytes);
    if (!body || typeof body !== 'object') throw appError('BAD_JSON', 'Expected a JSON object.');
    const dataUrl = String(body.dataUrl || body.png || '').trim();
    const match = IMAGE_DATA_URL.exec(dataUrl);
    if (!match) {
      throw appError('BAD_JSON', 'Send a base64 PNG data URL in `dataUrl`. JPEG is not accepted by the local recogniser.');
    }
    const buffer = Buffer.from(match[1], 'base64');
    if (!buffer.length) throw appError('IMAGE_DECODE_FAILED', 'The PNG could not be decoded.');
    if (buffer.length > config.maxImageBytes) {
      throw appError('IMAGE_TOO_LARGE', `The PNG is larger than ${Math.round(config.maxImageBytes / 1e6)} MB.`);
    }
    const topK = Math.min(10, Math.max(1, Number(body.topK) || 5));
    const result = await recognizePng(buffer, { topK });
    if (result.available) {
      recordServerLog({
        level: 'ok',
        category: 'perception',
        message: `Local recogniser: ${result.label} (${Math.round((result.confidence || 0) * 100)}%) in ${Date.now() - started}ms`,
        ms: Date.now() - started,
      });
    }
    json(res, 200, {
      ...result,
      latencyMs: Date.now() - started,
      note: 'Unverified local model candidate. The AI analysis and user confirmation decide identity.',
    });
  } catch (err) {
    const status = err?.name === 'AppError' ? err.status : 500;
    json(res, status, errorPayload(err));
  }
}

export default { handleRecognizerStatus, recognizerClassifyHandler, MAX_PIXELS };
