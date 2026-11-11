// server/services/anthropicProvider.js — Anthropic Messages API adapter.
//
// Anthropic does not use the OpenAI chat-completions shape. This adapter keeps
// the same internal contract as the other providers: analyze() returns JSON text
// plus usage. Claude models are paid and closed-weight; the UI labels them.

import { mapHttpError, retryAfterMs } from './provider.js';
import { GROUNDING_SCHEMA } from './groundingSchema.js';
import { getModel } from '../../modelRegistry.js';

function splitDataUrl(dataUrl) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  return { mediaType: m[1].toLowerCase(), data: m[2] };
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (block?.type === 'text' ? block.text : '')).join('').trim();
}

function extractJson(text) {
  const body = String(text || '').trim().replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  try { return JSON.parse(body); } catch { /* substring */ }
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(body.slice(start, end + 1)); } catch { /* give up */ }
  }
  return null;
}

export function buildAnthropicProvider({ apiKey, modelId, baseUrl, timeoutMs = 120000, maxTokens = 4096 } = {}) {
  if (!apiKey) throw new Error('Anthropic provider requires apiKey');
  if (!modelId) throw new Error('Anthropic provider requires an explicit model id');
  const info = getModel('anthropic', modelId);
  if (!info) throw new Error(`Anthropic model ${modelId} is not in the catalogue`);
  if (info.modality === 'classifier') throw new Error(`Anthropic model ${modelId} is a classifier only`);
  const endpoint = (() => {
    const raw = String(baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    return /\/v1\/messages$/i.test(raw) ? raw : `${raw}/v1/messages`;
  })();

  return {
    id: 'anthropic',
    name: 'Anthropic',
    modelId,
    capabilities: { imageInput: info.vision === true, structuredOutput: true, webGrounding: false },
    pricing: { inputPerM: info.inputPerM, outputPerM: info.outputPerM },

    async healthCheck() {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: modelId, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with OK only.' }] }),
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return { ok: false, status: res.status, detail: `HTTP ${res.status}: ${body.slice(0, 200)}` };
        }
        return { ok: true, detail: 'Anthropic reachable' };
      } catch (err) {
        return { ok: false, detail: err.message || String(err) };
      }
    },

    async analyze({ instructions, userText, imageDataUrl, imageDataUrls, schema, signal }) {
      const outputSchema = schema || GROUNDING_SCHEMA;
      const images = Array.isArray(imageDataUrls) && imageDataUrls.length
        ? imageDataUrls
        : (imageDataUrl ? [imageDataUrl] : []);
      if (images.length && info.vision !== true) {
        throw mapHttpError(400, `Anthropic model ${modelId} is text-only and cannot accept an image`);
      }
      const content = [{ type: 'text', text: `${userText}\n\nReply with ONE JSON object only (no markdown) matching this schema:\n${JSON.stringify(outputSchema)}` }];
      for (const url of images) {
        const parsed = splitDataUrl(url);
        if (!parsed) throw mapHttpError(400, 'Anthropic requires a base64 image data URL.');
        content.push({ type: 'image', source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data } });
      }

      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: modelId,
            system: instructions,
            max_tokens: Math.max(256, Math.min(8192, Number(maxTokens) || 4096)),
            temperature: 0.1,
            messages: [{ role: 'user', content }],
          }),
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err.name === 'TimeoutError' || err.name === 'AbortError') throw mapHttpError(504, 'Anthropic timeout');
        throw mapHttpError(503, `Anthropic unreachable: ${err.message || err}`);
      }

      const raw = await res.text();
      if (!res.ok) throw mapHttpError(res.status, raw, { retryAfterMs: retryAfterMs(res.headers) });
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      if (!parsed) throw new Error('Anthropic returned an empty body');
      if (parsed?.type === 'error') throw mapHttpError(400, parsed?.error?.message || 'Anthropic error');

      const text = textFromContent(parsed?.content);
      if (!text) throw new Error('Anthropic returned no content');
      const rawJson = extractJson(text);
      if (!rawJson) throw new Error('Anthropic did not return valid JSON');

      return {
        text: JSON.stringify(rawJson),
        citations: [],
        searchedWeb: false,
        httpStatus: res.status,
        returnedModel: parsed?.model || modelId,
        usage: parsed?.usage ? {
          input_tokens: parsed.usage.input_tokens,
          output_tokens: parsed.usage.output_tokens,
        } : null,
        endpoint,
        host: 'api.anthropic.com',
      };
    },
  };
}
