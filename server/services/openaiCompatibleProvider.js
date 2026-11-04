// server/services/openaiCompatibleProvider.js — generic OpenAI-compatible
// adapter for OpenRouter, BlockRun and user-deployed Modal endpoints.
//
// Meta-only: the caller must pass a model id from that provider's catalog, and
// the adapter refuses anything that is not catalogued as vision. Keys stay in
// the backend process and are never logged.

import { mapHttpError, retryAfterMs } from './provider.js';
import { GROUNDING_SCHEMA } from './groundingSchema.js';
import { providerSupportsVisionModel } from '../config.js';

function unfence(text) {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return (m ? m[1] : text).trim();
}

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

/**
 * Resolve a chat-completions URL. Fixed hosts keep their exact API path; Modal
 * and custom relays accept a bare deployment URL, /v1, or the full path.
 */
export function chatCompletionsUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  let clean;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return '';
    clean = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
  if (/\/chat\/completions$/i.test(clean)) return clean;
  if (/\/v1$/i.test(clean)) return `${clean}/chat/completions`;
  return `${clean}/v1/chat/completions`;
}

export function buildOpenAICompatibleProvider({ id, name, endpoint, host, apiKey, modelId, timeoutMs = 120000 } = {}) {
  if (!id || !endpoint) throw new Error('OpenAI-compatible provider requires id and endpoint');
  if (!apiKey) throw new Error(`${name || id} provider requires apiKey`);
  if (!modelId) throw new Error(`${name || id} provider requires an explicit Meta vision model id`);
  if (!providerSupportsVisionModel(id, modelId)) {
    throw new Error(`${name || id} model ${modelId} is not an allowlisted Meta vision model`);
  }

  return {
    id,
    name: name || id,
    modelId,
    capabilities: { imageInput: true, structuredOutput: true, webGrounding: false },

    async healthCheck() {
      try {
        const res = await fetch(endpoint, {
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
        return { ok: true, detail: `${name || id} reachable` };
      } catch (err) {
        return { ok: false, detail: err.message || String(err) };
      }
    },

    async analyze({ instructions, userText, imageDataUrl, imageDataUrls, schema, signal }) {
      const outputSchema = schema || GROUNDING_SCHEMA;
      const images = Array.isArray(imageDataUrls) && imageDataUrls.length
        ? imageDataUrls
        : (imageDataUrl ? [imageDataUrl] : []);
      const schemaHint = `\n\nReply with ONE JSON object only (no markdown) matching this schema:\n${JSON.stringify(outputSchema)}`;

      const headers = {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      };
      if (id === 'openrouter') {
        headers['x-title'] = 'IntentLens';
      }

      const body = {
        model: modelId,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: [
            { type: 'text', text: `${userText}${schemaHint}` },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ] },
        ],
        temperature: 0.1,
        max_tokens: 3072,
        stream: false,
      };

      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err.name === 'TimeoutError' || err.name === 'AbortError') throw mapHttpError(504, `${name || id} timeout`);
        throw mapHttpError(503, `${name || id} unreachable: ${err.message || err}`);
      }

      const raw = await res.text();
      if (!res.ok) throw mapHttpError(res.status, raw, { retryAfterMs: retryAfterMs(res.headers) });

      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      if (!parsed) throw new Error(`${name || id} returned an empty body`);

      const text = messageText(parsed?.choices?.[0]?.message);
      if (!text) throw new Error(`${name || id} returned no content`);

      const rawJson = extractJson(text);
      if (!rawJson) throw new Error(`${name || id} did not return valid JSON`);

      return {
        text: JSON.stringify(rawJson),
        citations: [],
        searchedWeb: false,
        httpStatus: res.status,
        returnedModel: parsed?.model || modelId,
        endpoint,
        host: host || '',
      };
    },
  };
}
