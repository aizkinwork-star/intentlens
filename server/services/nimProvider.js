// server/services/nimProvider.js — NVIDIA NIM adapter.
//
// NIM exposes an OpenAI-compatible chat endpoint. The generic adapter handles the
// request/response, including reasoning models that put text in
// reasoning_content. Any vision model in the NVIDIA catalogue is allowed.

import { buildOpenAICompatibleProvider, chatCompletionsUrl } from './openaiCompatibleProvider.js';

export function buildNimProvider({ baseUrl, apiKey, modelId, timeoutMs } = {}) {
  if (!apiKey || !modelId || !baseUrl) {
    throw new Error('NVIDIA NIM provider requires apiKey, modelId and baseUrl');
  }
  const endpoint = chatCompletionsUrl(baseUrl) || chatCompletionsUrl('https://integrate.api.nvidia.com');
  return buildOpenAICompatibleProvider({
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    endpoint,
    host: 'integrate.api.nvidia.com',
    apiKey,
    modelId,
    timeoutMs: timeoutMs || 180000,
    maxTokens: 4096,
  });
}
