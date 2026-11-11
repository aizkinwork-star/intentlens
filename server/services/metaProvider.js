// server/services/metaProvider.js — legacy loopback-only local model helper.
//
// DEPRECATED: the active local path is Ollama through
// openaiCompatibleProvider.js, selected via modelRegistry.js. This file is kept
// for reference and is not imported by the server.
//
// Original scope: wraps a local vision runtime (e.g. Ollama at 127.0.0.1) over
// loopback only, with no hosted inference and no API keys.

import { callLocalModel } from './localModelClient.js';

export function buildMetaProvider({ baseUrl, modelId, timeoutMs, allowWebSearch = false } = {}) {
  // v7: allowWebSearch is always false. No web search at runtime.
  return {
    id: 'meta-llama-local',
    name: 'Meta Llama Vision (local)',
    capabilities: { imageInput: true, structuredOutput: true, webGrounding: false },

    async healthCheck() {
      return { ok: true, detail: 'Local Meta Llama runtime configured (loopback only)' };
    },

    async analyze({ instructions, userText, imageDataUrl, signal }) {
      const response = await callLocalModel({
        baseUrl,
        modelId,
        instructions,
        userText,
        imageDataUrl,
        timeoutMs,
        signal,
      });
      return {
        text: response.text,
        citations: response.citations || [],
        searchedWeb: false, // v7: never searches web at runtime
      };
    },
  };
}
