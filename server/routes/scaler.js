// server/routes/scaler.js — serves the fitted feature scaler.
import { json } from '../lib/http.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCALER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'datasets', 'processed', 'feature_scaler.json');

export async function handleGetScaler(req, res) {
  if (!existsSync(SCALER_PATH)) {
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'Scaler not found. Run feature extraction first.', retryable: false } });
    return;
  }
  try {
    const data = JSON.parse(readFileSync(SCALER_PATH, 'utf8'));
    // Validate
    if (!data.mean || !data.std || data.mean.length !== data.std.length) {
      json(res, 500, { error: { code: 'INVALID_SCALER', message: 'Scaler is malformed.', retryable: false } });
      return;
    }
    if (data.version !== '4.0') {
      json(res, 500, { error: { code: 'VERSION_MISMATCH', message: 'Scaler version mismatch. Expected 4.0, got ' + data.version, retryable: false } });
      return;
    }
    json(res, 200, data);
  } catch (e) {
    json(res, 500, { error: { code: 'INVALID_SCALER', message: 'Failed to load scaler.', retryable: false } });
  }
}