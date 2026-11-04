// server/routes/transcribe.js — local-only speech-to-text.
//
// The browser records a short clip and posts it here as base64. The server
// forwards it, as multipart/form-data, to a speech-to-text process running on
// this machine (whisper.cpp server, faster-whisper, an OpenAI-compatible local
// endpoint). Audio never leaves the machine: config.sttUrl is loopback-only.
//
// Nothing is transcribed unless STT_URL is set. Without it the route fails with
// STT_NOT_CONFIGURED so the UI can explain exactly what to configure.

import { readJson, json, recordServerLog } from '../lib/http.js';
import { config } from '../config.js';

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MIME_RE = /^audio\/(webm|ogg|wav|x-wav|mp4|mpeg|mp3|m4a|x-m4a|aac)(?:;.*)?$/i;

function sanitizeUrl(value) {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

export function transcribeStatus() {
  return {
    configured: Boolean(config.sttUrl),
    url: config.sttUrl ? sanitizeUrl(config.sttUrl) : null,
    model: config.sttModel || null,
    language: config.sttLanguage || null,
    rejectedUrl: config.sttUrlRejected || false,
  };
}

export function handleTranscribeStatus(res) {
  json(res, 200, transcribeStatus());
}

function extensionFor(mime) {
  if (/webm/i.test(mime)) return 'webm';
  if (/ogg/i.test(mime)) return 'ogg';
  if (/wav/i.test(mime)) return 'wav';
  if (/mp4|m4a|aac/i.test(mime)) return 'm4a';
  if (/mpeg|mp3/i.test(mime)) return 'mp3';
  return 'webm';
}

/** Builds the multipart body by hand so no third-party form parser is needed. */
export function buildMultipart(audio, mime) {
  const boundary = `----IntentLensSTT${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  const fields = [
    ['model', config.sttModel],
    ['response_format', 'json'],
    ['language', config.sttLanguage],
  ].filter(([, value]) => value);

  const head = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="file"; filename="clip.${extensionFor(mime)}"\r\n`
    + `Content-Type: ${mime}\r\n\r\n`,
    'utf8',
  );
  const tailFields = fields
    .map(([name, value]) => `\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`)
    .join('');
  const tail = Buffer.from(`${tailFields}\r\n--${boundary}--\r\n`, 'utf8');
  return {
    boundary,
    body: Buffer.concat([head, audio, tail]),
  };
}

export async function handleTranscribe(req, res) {
  if (!config.sttUrl) {
    json(res, 501, {
      ok: false,
      error: {
        code: 'STT_NOT_CONFIGURED',
        message: config.sttUrlRejected
          ? 'STT_URL must point at a localhost endpoint (for example http://127.0.0.1:8080/inference).'
          : 'Local transcription is not configured. Set STT_URL in .env to a local speech-to-text endpoint and restart the app.',
        retryable: false,
      },
    });
    return;
  }

  let payload;
  try {
    payload = await readJson(req, MAX_REQUEST_BYTES);
  } catch (err) {
    json(res, err.status || 400, {
      ok: false,
      error: { code: err.code || 'BAD_REQUEST', message: err.message || 'Could not read the audio payload.', retryable: false },
    });
    return;
  }

  const base64 = typeof payload?.audio === 'string' ? payload.audio : '';
  const mime = String(payload?.mimeType || 'audio/webm').split(',')[0].trim();
  if (!base64) {
    json(res, 400, { ok: false, error: { code: 'AUDIO_MISSING', message: 'No audio was included in the request.', retryable: false } });
    return;
  }
  if (!MIME_RE.test(mime)) {
    json(res, 415, { ok: false, error: { code: 'UNSUPPORTED_AUDIO', message: `Unsupported audio type ${mime}.`, retryable: false } });
    return;
  }

  const audio = Buffer.from(base64, 'base64');
  if (!audio.length) {
    json(res, 400, { ok: false, error: { code: 'AUDIO_EMPTY', message: 'The audio clip was empty.', retryable: false } });
    return;
  }
  if (audio.length > MAX_AUDIO_BYTES) {
    json(res, 413, { ok: false, error: { code: 'AUDIO_TOO_LARGE', message: 'The audio clip is too large. Keep recordings under 30 seconds.', retryable: false } });
    return;
  }

  const { boundary, body } = buildMultipart(audio, mime);
  const headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    accept: 'application/json',
  };
  if (config.sttApiKey) headers.authorization = `Bearer ${config.sttApiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.sttTimeoutMs);
  try {
    const upstream = await fetch(config.sttUrl, { method: 'POST', headers, body, signal: controller.signal });
    const raw = await upstream.text();
    if (!upstream.ok) {
      recordServerLog({ level: 'warn', category: 'speech', message: `local STT returned ${upstream.status}`, status: upstream.status });
      json(res, 502, {
        ok: false,
        error: {
          code: 'STT_UPSTREAM_ERROR',
          message: `The local speech-to-text service returned ${upstream.status}. Check that STT_URL points at its transcription route.`,
          retryable: true,
          upstreamStatus: upstream.status,
        },
      });
      return;
    }

    let data = null;
    try { data = JSON.parse(raw); } catch { data = null; }
    const transcript = String(data?.text ?? data?.transcript ?? raw ?? '').trim();
    if (!transcript) {
      json(res, 502, { ok: false, error: { code: 'STT_EMPTY', message: 'The local speech service returned no text.', retryable: true } });
      return;
    }

    json(res, 200, { ok: true, text: transcript, model: config.sttModel || null });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    recordServerLog({
      level: 'warn',
      category: 'speech',
      message: aborted ? 'local STT timed out' : `local STT request failed: ${err?.message || err}`,
    });
    json(res, 502, {
      ok: false,
      error: {
        code: aborted ? 'STT_TIMEOUT' : 'STT_UNREACHABLE',
        message: aborted
          ? 'The local speech service did not answer in time.'
          : 'Could not reach the local speech service. Is it running and is STT_URL correct?',
        retryable: true,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}
