// server/services/huggingfaceProvider.js — legacy Hugging Face helper (two services).
// 1. Inference Providers (serverless): OpenAI-compatible chat completions with HF token.
// 2. Spaces (Gradio API): queue + SSE event stream.
//
// DEPRECATED: the active Hugging Face path is openaiCompatibleProvider.js driven
// by modelRegistry.js. This file is kept for reference and is not wired in.

import { appError } from '../lib/errors.js';

export function buildHfInferenceProvider({ apiToken, modelId, timeoutMs = 120000 } = {}) {
  if (!apiToken || !modelId) throw new Error('HF inference requires apiToken and modelId');
  const endpoint = `https://router.huggingface.co/v1/chat/completions`;
  return {
    id: 'huggingface-inference',
    name: `Hugging Face Inference (${modelId})`,
    capabilities: { imageInput: true, structuredOutput: true, webGrounding: false },
    async healthCheck() {
      try {
        const res = await fetch('https://huggingface.co/api/whoami-v2', {
          headers: { authorization: `Bearer ${apiToken}` },
          signal: AbortSignal.timeout(10000),
        });
        return res.ok ? { ok: true, detail: 'HF token valid' } : { ok: false, detail: `HTTP ${res.status}` };
      } catch (e) { return { ok: false, detail: e.message }; }
    },
    async analyze({ instructions, userText, imageDataUrl, signal }) {
      const body = {
        model: modelId,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ] },
        ],
        temperature: 0.2,
      };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal || AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw appError('MODEL_UPSTREAM_ERROR', `HF HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      const parsed = await res.json();
      const content = parsed?.choices?.[0]?.message?.content || '';
      return { text: content, citations: [], searchedWeb: false };
    },
  };
}

// Gradio Space adapter (queue + SSE)
export function buildHfSpaceProvider({ spaceId, apiName, apiToken, timeoutMs = 120000 } = {}) {
  if (!spaceId || !apiName) throw new Error('HF Space requires spaceId and apiName');
  const base = `https://${spaceId}.hf.space`;
  return {
    id: 'huggingface-space',
    name: `Hugging Face Space (${spaceId})`,
    capabilities: { imageInput: true, structuredOutput: true, webGrounding: false },
    async healthCheck() {
      try {
        const res = await fetch(`${base}/gradio_api/openapi.json`, {
          headers: apiToken ? { authorization: `Bearer ${apiToken}` } : {},
          signal: AbortSignal.timeout(10000),
        });
        return res.ok ? { ok: true, detail: 'Space reachable' } : { ok: false, detail: `HTTP ${res.status}` };
      } catch (e) { return { ok: false, detail: e.message }; }
    },
    async analyze({ userText, imageDataUrl, signal }) {
      // Enqueue
      const enqueueRes = await fetch(`${base}/gradio_api/call/${apiName}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}) },
        body: JSON.stringify({ data: [imageDataUrl, userText] }),
        signal: signal || AbortSignal.timeout(timeoutMs),
      });
      if (!enqueueRes.ok) throw appError('MODEL_UPSTREAM_ERROR', `HF Space enqueue HTTP ${enqueueRes.status}`);
      const { event_id } = await enqueueRes.json();
      // Read SSE result
      const resultRes = await fetch(`${base}/gradio_api/call/${apiName}/${event_id}`, {
        headers: { ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}) },
        signal: signal || AbortSignal.timeout(timeoutMs),
      });
      if (!resultRes.ok) throw appError('MODEL_UPSTREAM_ERROR', `HF Space result HTTP ${resultRes.status}`);
      const text = await resultRes.text();
      // Parse last data line
      const lines = text.split('\n').filter((l) => l.startsWith('data:'));
      const last = lines[lines.length - 1];
      let data;
      try { data = JSON.parse(last.replace(/^data:\s*/, '')); } catch { data = null; }
      const output = Array.isArray(data) ? data[0] : data;
      return { text: typeof output === 'string' ? output : JSON.stringify(output), citations: [], searchedWeb: false };
    },
  };
}