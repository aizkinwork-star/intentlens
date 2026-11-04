// server/services/cloudflareProvider.js — Cloudflare Workers AI adapter.
//
// POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}
// Meta models only. The key lives in the backend process and is never logged.

import { mapHttpError, retryAfterMs } from './provider.js';
import { GROUNDING_SCHEMA } from './groundingSchema.js';
import { providerSupportsVisionModel } from '../config.js';

function unfence(text) {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return (m ? m[1] : text).trim();
}

const TINY_IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=';

export function buildCloudflareProvider({ accountId, apiToken, modelId, timeoutMs } = {}) {
  if (!accountId || !apiToken || !modelId) {
    throw new Error('Cloudflare provider requires accountId, apiToken and modelId');
  }
  if (!providerSupportsVisionModel('cloudflare-workers-ai', modelId)) {
    throw new Error(`Cloudflare model ${modelId} is not an allowlisted Meta vision model`);
  }

  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;

  return {
    id: 'cloudflare-workers-ai',
    name: 'Cloudflare Workers AI',
    modelId,
    capabilities: { imageInput: true, structuredOutput: true, webGrounding: false },

    async healthCheck() {
      if (!apiToken) return { ok: false, detail: 'CLOUDFLARE_API_TOKEN not configured' };
      try {
        const res = await fetch(baseUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: [
              { type: 'text', text: 'Reply with OK only.' },
              { type: 'image_url', image_url: { url: TINY_IMAGE } },
            ] }],
            stream: false,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return { ok: false, status: res.status, detail: `HTTP ${res.status}: ${body.slice(0, 200)}` };
        }
        return { ok: true, detail: 'Cloudflare Workers AI reachable' };
      } catch (err) {
        return { ok: false, detail: err.message || String(err) };
      }
    },

    async analyze({ instructions, userText, imageDataUrl, imageDataUrls, schema, signal }) {
      if (!apiToken) throw mapHttpError(401, 'Cloudflare API token not configured');

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
        stream: false,
        temperature: 0.2,
      };

      const timeout = AbortSignal.timeout(timeoutMs || 120000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let res;
      try {
        res = await fetch(baseUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err.name === 'TimeoutError' || err.name === 'AbortError') throw mapHttpError(504, 'Cloudflare timeout');
        throw mapHttpError(503, `Cloudflare unreachable: ${err.message || err}`);
      }

      const raw = await res.text();
      if (!res.ok) throw mapHttpError(res.status, raw, { retryAfterMs: retryAfterMs(res.headers) });

      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      if (!parsed) throw new Error('Cloudflare returned an empty body');

      const content = parsed?.result?.response ?? parsed?.choices?.[0]?.message?.content ?? '';
      const text = typeof content === 'string' ? content : (Array.isArray(content)
        ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
        : '');
      if (!text) throw new Error('Cloudflare returned no content');

      let rawJson;
      try { rawJson = JSON.parse(unfence(text)); } catch {
        throw new Error('Cloudflare did not return valid JSON');
      }
      return {
        text: JSON.stringify(rawJson),
        citations: [],
        searchedWeb: false,
        httpStatus: res.status,
        returnedModel: parsed?.model || modelId,
        endpoint: `https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/${modelId}`,
        host: 'api.cloudflare.com',
      };
    },
  };
}
