// server/services/metaProvider.js — v7 Strictly Local Meta-Only.
//
// Wraps the local Meta Llama Vision runtime (e.g. Ollama at 127.0.0.1).
// v7 non-negotiables:
//   - Loopback only (127.0.0.1). No remote hosts.
//   - No web search, no hosted inference, no external model endpoints.
//   - Meta Llama Vision models only.
//   - No API keys accepted or stored.

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
