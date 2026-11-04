// server/services/groqProvider.js — Groq adapter (Meta models only).
//
// Groq is only eligible for vision when the account has a Meta vision model.
// A text-only Meta model is never presented or used as a vision model.

import { mapHttpError, retryAfterMs } from './provider.js';
import { GROUNDING_SCHEMA } from './groundingSchema.js';
import { providerSupportsVisionModel } from '../config.js';

function unfence(text) {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return (m ? m[1] : text).trim();
}

export function buildGroqProvider({ apiKey, modelId, timeoutMs = 60000 } = {}) {
  if (!apiKey) throw new Error('Groq provider requires apiKey');
  if (!modelId) throw new Error('Groq provider requires an explicit Meta vision model id');
  if (!providerSupportsVisionModel('groq', modelId)) {
    throw new Error(`Groq model ${modelId} is not an allowlisted Meta vision model`);
  }

  const endpoint = 'https://api.groq.com/openai/v1/chat/completions';

  return {
    id: 'groq',
    name: 'Groq',
    modelId,
    capabilities: { imageInput: true, structuredOutput: true, webGrounding: false },

    async healthCheck() {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return { ok: false, status: res.status, detail: `HTTP ${res.status}: ${body.slice(0, 200)}` };
        }
        const data = await res.json().catch(() => null);
        const ids = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
        return {
          ok: ids.includes(modelId),
          detail: ids.includes(modelId) ? 'Groq reachable and Meta vision model available' : `Key is valid but ${modelId} is not listed on this account`,
          models: ids.filter((id) => /llama|meta/i.test(id)).slice(0, 20),
        };
      } catch (err) {
        return { ok: false, detail: err.message || String(err) };
      }
    },

    async analyze({ instructions, userText, imageDataUrl, imageDataUrls, schema, signal }) {
      const outputSchema = schema || GROUNDING_SCHEMA;
      const images = Array.isArray(imageDataUrls) && imageDataUrls.length
        ? imageDataUrls
        : (imageDataUrl ? [imageDataUrl] : []);
      const schemaHint = `\n\nReply with ONE valid JSON object only (no markdown, no backticks) matching this schema:\n${JSON.stringify(outputSchema)}`;
      const body = {
        model: modelId,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: [
            { type: 'text', text: userText + schemaHint },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ] },
        ],
        temperature: 0.1,
      };

      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err.name === 'TimeoutError' || err.name === 'AbortError') throw mapHttpError(504, 'Groq timeout');
        throw mapHttpError(503, `Groq unreachable: ${err.message || err}`);
      }

      const raw = await res.text();
      if (!res.ok) throw mapHttpError(res.status, raw, { retryAfterMs: retryAfterMs(res.headers) });

      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      const content = parsed?.choices?.[0]?.message?.content ?? '';
      const text = typeof content === 'string' ? content : '';
      if (!text) throw new Error('Groq returned an empty response');

      let rawJson;
      try { rawJson = JSON.parse(unfence(text)); } catch {
        throw new Error('Groq did not return valid JSON');
      }
      return { text: JSON.stringify(rawJson), citations: [], searchedWeb: false };
    },
  };
}
