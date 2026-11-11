// server/services/groqProvider.js — Groq adapter (OpenAI-compatible).
//
// Groq is fast and free-tier friendly. Vision is model-dependent: Llama 4 Scout
// and Maverick accept images, while Llama 3.3 / GPT-OSS / Qwen3 are text-only.
// The generic adapter enforces that distinction from the catalogue.

import { buildOpenAICompatibleProvider } from './openaiCompatibleProvider.js';

export function buildGroqProvider({ apiKey, modelId, timeoutMs } = {}) {
  if (!apiKey) throw new Error('Groq provider requires apiKey');
  if (!modelId) throw new Error('Groq provider requires an explicit model id');
  return buildOpenAICompatibleProvider({
    id: 'groq',
    name: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    host: 'api.groq.com',
    apiKey,
    modelId,
    timeoutMs: timeoutMs || 60000,
    maxTokens: 4096,
  });
}
