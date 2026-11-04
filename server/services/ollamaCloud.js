// server/services/ollamaCloud.js — Ollama Cloud vision provider (§14).
//
// Ollama Cloud exposes an OpenAI-compatible chat/completions endpoint:
//   POST {baseUrl}/chat/completions   Authorization: Bearer <key>
// With image input as a message content block { type: 'image_url', image_url: { url: <data URL> } }.
//
// NOTE: this adapter has not been executed against a real Ollama Cloud key from this
// environment. Model IDs, image-input support and free allowance must be verified with
// a real call before relying on it (§14, §20). It is wired behind MODEL_PROVIDER and
// is only used when explicitly configured.
//
// The structured-output contract: Ollama Cloud may not support response_format
// json_schema. We request JSON and, if the model wraps it in fences, peel them off.
// Citations / web grounding are NOT supported by Ollama Cloud chat, so searchedWeb
// is always false here (§11: web grounding via Gemini/Cloudflare where enabled).

import { appError } from '../lib/errors.js';
import { mapHttpError } from './provider.js';
import { GROUNDING_SCHEMA } from './groundingSchema.js';

// Peel ```json fences off model output.
function unfence(text) {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return (m ? m[1] : text).trim();
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export function buildOllamaCloudProvider({ baseUrl, apiKey, modelId, timeoutMs } = {}) {
  const resolvedBase = (baseUrl || 'https://ollama.com/v1').replace(/\/+$/, '');
  const resolvedModel = modelId || '';

  return {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    capabilities: { imageInput: true, structuredOutput: true, webGrounding: false },

    async healthCheck() {
      if (!apiKey) return { ok: false, detail: 'OLLAMA_API_KEY not configured' };
      try {
        const res = await fetch(`${resolvedBase}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: resolvedModel,
            messages: [{ role: 'user', content: 'Reply with OK only.' }],
            stream: false,
          }),
          signal: AbortSignal.timeout(timeoutMs || 15000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return { ok: false, detail: `HTTP ${res.status}: ${body.slice(0, 200)}` };
        }
        return { ok: true, detail: 'chat completions reachable' };
      } catch (err) {
        return { ok: false, detail: err.message || String(err) };
      }
    },

    async analyze({ instructions, userText, imageDataUrl, allowWebSearch, signal }) {
      if (!apiKey) throw appError('MODEL_API_KEY_MISSING', 'Ollama Cloud API key not configured.');
      if (!resolvedModel) throw appError('MODEL_UPSTREAM_ERROR', 'OLLAMA_MODEL not configured.');

      // Ollama Cloud chat does not do web grounding; ignore allowWebSearch here.
      const schemaHint = `\n\nReply with ONE JSON object only (no markdown) matching this schema:\n${JSON.stringify(GROUNDING_SCHEMA)}`;

      const body = {
        model: resolvedModel,
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

      const timeout = AbortSignal.timeout(timeoutMs || 45000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(`${resolvedBase}/chat/completions`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${apiKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: combined,
          });
          const raw = await res.text();
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
          if (!res.ok) throw mapHttpError(res.status, parsed ?? raw);
          if (!parsed) throw appError('MODEL_BAD_RESPONSE', 'Ollama Cloud returned an empty body.');

          const content = parsed?.choices?.[0]?.message?.content;
          const text = typeof content === 'string' ? content : (Array.isArray(content)
            ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
            : '');
          if (!text) throw appError('MODEL_BAD_RESPONSE', 'Ollama Cloud returned no content.');

          let rawJson;
          try { rawJson = JSON.parse(unfence(text)); } catch {
            throw appError('RESULT_SCHEMA_INVALID', 'Ollama Cloud did not return valid JSON.');
          }
          return rawJson;
        } catch (err) {
          if (signal?.aborted) throw err;
          lastError = err;
          if (err.name === 'TimeoutError' || err.name === 'AbortError') throw appError('MODEL_TIMEOUT');
          if (err.badRequest) throw err; // don't retry a bad request
          if (err.status && RETRYABLE_STATUS.has(err.status) && attempt < 2) continue;
          throw err;
        }
      }
      throw lastError || appError('MODEL_UPSTREAM_ERROR');
    },
  };
}
