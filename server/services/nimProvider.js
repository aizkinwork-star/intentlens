// server/services/nimProvider.js — NVIDIA NIM adapter (Meta Llama Vision).
//
// Meta-only. The key lives in the backend process and is never logged.

import { mapHttpError, retryAfterMs } from './provider.js';
import { GROUNDING_SCHEMA } from './groundingSchema.js';
import { providerSupportsVisionModel } from '../config.js';

function unfence(text) {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return (m ? m[1] : text).trim();
}

/**
 * muse-glimmer is a reasoning model: the answer can arrive in `content`, or the
 * text can be split across `reasoning_content` and `content`. Extract the JSON
 * object from whichever field holds it instead of assuming `content` is set.
 */
function extractJson(text) {
  const body = unfence(String(text || ''));
  try { return JSON.parse(body); } catch { /* try a substring */ }
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(body.slice(start, end + 1)); } catch { /* give up */ }
  }
  return null;
}

function messageText(message) {
  const pick = (value) => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('');
    return '';
  };
  return [pick(message?.content), pick(message?.reasoning_content), pick(message?.reasoning)]
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function buildNimProvider({ baseUrl, apiKey, modelId, timeoutMs } = {}) {
  if (!apiKey || !modelId || !baseUrl) {
    throw new Error('NVIDIA NIM provider requires apiKey, modelId and baseUrl');
  }
  if (!providerSupportsVisionModel('nvidia-nim', modelId)) {
    throw new Error(`NVIDIA NIM model ${modelId} is not an allowlisted Meta vision model`);
  }

  return {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    modelId,
    capabilities: { imageInput: true, structuredOutput: true, webGrounding: false },

    async healthCheck() {
      if (!apiKey) return { ok: false, detail: 'NIM_API_KEY not configured' };
      try {
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'Reply with OK only.' }],
            max_tokens: 8,
            stream: false,
          }),
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return { ok: false, status: res.status, detail: `HTTP ${res.status}: ${body.slice(0, 200)}` };
        }
        return { ok: true, detail: 'NVIDIA NIM reachable' };
      } catch (err) {
        return { ok: false, detail: err.message || String(err) };
      }
    },

    async analyze({ instructions, userText, imageDataUrl, imageDataUrls, schema, signal }) {
      if (!apiKey) throw mapHttpError(401, 'NVIDIA NIM API key not configured');

      const outputSchema = schema || GROUNDING_SCHEMA;
      const images = Array.isArray(imageDataUrls) && imageDataUrls.length
        ? imageDataUrls
        : (imageDataUrl ? [imageDataUrl] : []);
      const schemaHint = `\n\nReply with ONE JSON object only (no markdown) matching this schema:\n${JSON.stringify(outputSchema)}`;
      const body = {
        model: modelId,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: [
            { type: 'text', text: userText + schemaHint },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ] },
        ],
        temperature: 0.2,
        max_tokens: 3072,
      };

      const timeout = AbortSignal.timeout(timeoutMs || 180000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let res;
      try {
        res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err.name === 'TimeoutError' || err.name === 'AbortError') throw mapHttpError(504, 'NVIDIA NIM timeout');
        throw mapHttpError(503, `NVIDIA NIM unreachable: ${err.message || err}`);
      }

      const raw = await res.text();
      if (!res.ok) throw mapHttpError(res.status, raw, { retryAfterMs: retryAfterMs(res.headers) });

      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      if (!parsed) throw new Error('NVIDIA NIM returned an empty body');

      const text = messageText(parsed?.choices?.[0]?.message);
      if (!text) throw new Error('NVIDIA NIM returned no content');

      const rawJson = extractJson(text);
      if (!rawJson) throw new Error('NVIDIA NIM did not return valid JSON');
      return { text: JSON.stringify(rawJson), citations: [], searchedWeb: false };
    },
  };
}
