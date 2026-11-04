// server/services/geminiProvider.js — Gemini API vision provider.
// Real HTTP calls to Google AI Studio Gemini Developer API.
// Get a free key at https://aistudio.google.com/app/apikey
// Keys are BYOK — entered by the user via the Providers menu, stored locally.

import { appError } from '../lib/errors.js';
import { mapHttpError } from './provider.js';
import { GROUNDING_SCHEMA } from './groundingSchema.js';

// Peel ```json fences off model output.
function unfence(text) {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return (m ? m[1] : text).trim();
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export function buildGeminiProvider({ apiKey, modelId, timeoutMs } = {}) {
  const resolvedModel = modelId || 'gemini-1.5-flash-latest';
  const resolvedBase = 'https://generativelanguage.googleapis.com/v1beta';

  return {
    id: 'gemini',
    name: 'Gemini API',
    capabilities: { imageInput: true, structuredOutput: true, webGrounding: false },

    async healthCheck() {
      if (!apiKey) return { ok: false, detail: 'GEMINI_API_KEY not configured' };
      try {
        const res = await fetch(`${resolvedBase}/models/${resolvedModel}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Reply with OK only.' }] }],
            generationConfig: { maxOutputTokens: 10 },
          }),
          signal: AbortSignal.timeout(timeoutMs || 15000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return { ok: false, detail: `HTTP ${res.status}: ${body.slice(0, 200)}` };
        }
        return { ok: true, detail: 'Gemini API reachable' };
      } catch (err) {
        return { ok: false, detail: err.message || String(err) };
      }
    },

    async analyze({ instructions, userText, imageDataUrl, signal }) {
      if (!apiKey) throw appError('MODEL_API_KEY_MISSING', 'Gemini API key not configured.');
      if (!modelId && !process.env.GEMINI_MODEL) {
        // modelId may be empty, use default
      }

      const schemaHint = `\n\nReply with ONE JSON object only (no markdown) matching this schema:\n${JSON.stringify(GROUNDING_SCHEMA)}`;

      const body = {
        contents: [
          {
            parts: [
              { text: instructions + '\n\n' + userText + schemaHint },
              { inlineData: { mimeType: 'image/jpeg', data: imageDataUrl.split(',')[1] } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1024,
        },
      };

      const timeout = AbortSignal.timeout(timeoutMs || 45000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(`${resolvedBase}/models/${resolvedModel}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: combined,
          });
          const raw = await res.text();
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
          if (!res.ok) throw mapHttpError(res.status, parsed ?? raw);
          if (!parsed) throw appError('MODEL_BAD_RESPONSE', 'Gemini returned an empty body.');

          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (!text) throw appError('MODEL_BAD_RESPONSE', 'Gemini returned no content.');

          let rawJson;
          try { rawJson = JSON.parse(unfence(text)); } catch {
            throw appError('RESULT_SCHEMA_INVALID', 'Gemini did not return valid JSON.');
          }
          return rawJson;
        } catch (err) {
          if (signal?.aborted) throw err;
          lastError = err;
          if (err.name === 'TimeoutError' || err.name === 'AbortError') throw appError('MODEL_TIMEOUT');
          if (err.badRequest) throw err;
          if (err.status && RETRYABLE_STATUS.has(err.status) && attempt < 2) continue;
          throw err;
        }
      }
      throw lastError || appError('MODEL_UPSTREAM_ERROR');
    },
  };
}
