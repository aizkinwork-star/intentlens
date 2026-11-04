// server/services/localModelClient.js — v7 Strictly Local Meta-Only.
//
// Calls the local Meta Llama Vision runtime (e.g. Ollama at 127.0.0.1)
// over loopback. No remote hosts, no API keys, no hosted inference.
//
// v7 non-negotiables:
//   - baseUrl must be 127.0.0.1 (loopback only).
//   - No web search, no hosted inference, no external model endpoints.
//   - Meta Llama Vision models only.
//   - No API keys accepted or stored.

import { appError } from '../lib/errors.js';
import { GROUNDING_SCHEMA } from './groundingSchema.js';

// Peel ```json fences off model output.
function unfence(text) {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return (m ? m[1] : text).trim();
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

// Validate that baseUrl is loopback only.
function isLoopback(url) {
  try {
    const u = new URL(url);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch {
    return false;
  }
}

// Validate that modelId is a Meta Llama Vision model.
function isMetaModel(modelId) {
  return /llama/i.test(modelId) || modelId === 'muse-spark-1.3';
}

export async function callLocalModel({ baseUrl, modelId, instructions, userText, imageDataUrl, timeoutMs, signal }) {
  if (!isLoopback(baseUrl || '')) {
    throw appError('OUTBOUND_NETWORK_ATTEMPTED', `Local model URL must be loopback (127.0.0.1). Got: ${baseUrl}`);
  }
  if (!modelId || !isMetaModel(modelId)) {
    throw appError('BAD_JSON', `Only Meta Llama Vision models are permitted. Got: ${modelId}`);
  }

  const schemaHint = `\n\nReply with ONE JSON object only (no markdown) matching this schema:\n${JSON.stringify(GROUNDING_SCHEMA)}`;

  const body = {
    model: modelId,
    messages: [
      { role: 'system', content: instructions },
      { role: 'user', content: [
        { type: 'text', text: userText + schemaHint },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ] },
    ],
    stream: false,
    temperature: 0.2,
  };

  const timeout = AbortSignal.timeout(timeoutMs || 120000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: combined,
      });
      const raw = await res.text();
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      if (!res.ok) {
        const detail = typeof raw === 'string' ? raw.slice(0, 400) : JSON.stringify(parsed ?? {}).slice(0, 400);
        if (res.status === 401 || res.status === 403) {
          throw appError('LOCAL_MODEL_LOAD_FAILED', `Local model rejected request (HTTP ${res.status}). ${detail}`);
        }
        if (res.status === 429) throw appError('LOCAL_MODEL_TIMEOUT');
        if (res.status === 408 || res.status === 504) throw appError('LOCAL_MODEL_TIMEOUT');
        throw appError('LOCAL_MODEL_BAD_RESPONSE', `Local model returned HTTP ${res.status}. ${detail}`);
      }
      if (!parsed) throw appError('LOCAL_MODEL_BAD_RESPONSE', 'Local model returned an empty body.');

      const content = parsed?.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content : (Array.isArray(content)
        ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
        : '');
      if (!text) throw appError('LOCAL_MODEL_BAD_RESPONSE', 'Local model returned no content.');

      let rawJson;
      try { rawJson = JSON.parse(unfence(text)); } catch {
        throw appError('RESULT_SCHEMA_INVALID', 'Local model did not return valid JSON.');
      }
      return { text: JSON.stringify(rawJson), citations: [], searchedWeb: false };
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw appError('LOCAL_MODEL_TIMEOUT');
      if (err.badRequest) throw err;
      if (err.status && RETRYABLE_STATUS.has(err.status) && attempt < 2) continue;
      throw err;
    }
  }
  throw lastError || appError('LOCAL_MODEL_LOAD_FAILED');
}
