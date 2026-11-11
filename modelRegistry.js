// modelRegistry.js — one shared provider/model catalogue for desktop and phone.
//
// This replaces the old Meta-only allowlist. Providers are grouped by how they
// are called, not by vendor:
//
//   - openai-compatible : POST <endpoint> with {model, messages:[...]}
//   - cloudflare        : account-scoped Workers AI endpoint
//   - anthropic         : Messages API (different request shape)
//   - ollama            : local OpenAI-compatible server, no key
//
// Every entry carries the facts the UI must show honestly: modality, access
// tier, context window, price per million tokens, browser CORS status and
// whether it is a known open-weight model. "Verified" means a real request was
// made on this project; most entries are catalogued but NOT verified, and the
// UI must not pretend otherwise.
//
// This file is pure (no Node imports) so it can be copied into pwa/lib by
// scripts/prepare-pwa.mjs and imported by both runtimes.

export const TIER_RANK = { free: 0, preview: 1, paid: 2, enterprise: 2 };
export const ACCESS_TIERS = ['free', 'preview', 'paid'];

// Keep a stable priority. Free/vision-capable hosts come first by default, but
// the user can reorder this in Settings.
export const DEFAULT_PRIORITY = [
  'openrouter',
  'groq',
  'google-ai-studio',
  'nvidia-nim',
  'cloudflare-workers-ai',
  'mistral',
  'cerebras',
  'together',
  'huggingface',
  'deepinfra',
  'openai',
  'anthropic',
  'ollama',
  'custom',
];

export const PROVIDERS = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'One key for many open-weight and frontier models. Browser CORS verified.',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    host: 'openrouter.ai',
    kind: 'openai',
    envKey: 'OPENROUTER_API_KEY',
    modelEnvKey: 'OPENROUTER_MODEL_ID',
    extraEnvKeys: [],
    docsUrl: 'https://openrouter.ai/keys',
    requiresKey: true,
    browserCors: 'allowed',
    freeTier: true,
    paidTier: true,
    openWeight: true,
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    description: 'Very fast free-tier inference for Llama, Qwen and GPT-OSS. Vision is account dependent.',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    host: 'api.groq.com',
    kind: 'openai',
    envKey: 'GROQ_API_KEY',
    modelEnvKey: 'GROQ_MODEL_ID',
    extraEnvKeys: ['GROQ_VISION_MODEL', 'GROQ_TEXT_MODEL'],
    docsUrl: 'https://console.groq.com/keys',
    requiresKey: true,
    browserCors: 'allowed',
    freeTier: true,
    paidTier: true,
    openWeight: true,
  },
  'google-ai-studio': {
    id: 'google-ai-studio',
    label: 'Google AI Studio',
    description: 'Gemini and Gemma models with a generous free tier and an OpenAI-compatible endpoint.',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    host: 'generativelanguage.googleapis.com',
    kind: 'openai',
    envKey: 'GEMINI_API_KEY',
    modelEnvKey: 'GEMINI_MODEL_ID',
    extraEnvKeys: ['GOOGLE_API_KEY'],
    docsUrl: 'https://aistudio.google.com/app/apikey',
    requiresKey: true,
    browserCors: 'unverified',
    freeTier: true,
    paidTier: true,
    openWeight: true,
  },
  'nvidia-nim': {
    id: 'nvidia-nim',
    label: 'NVIDIA NIM',
    description: 'Free hosted open-weight vision and text models. No browser CORS: desktop/server only.',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    host: 'integrate.api.nvidia.com',
    kind: 'openai',
    envKey: 'NIM_API_KEY',
    modelEnvKey: 'NIM_MODEL_ID',
    extraEnvKeys: ['NIM_BASE_URL', 'NIM_ENABLED'],
    docsUrl: 'https://build.nvidia.com/',
    requiresKey: true,
    browserCors: 'blocked',
    freeTier: true,
    paidTier: false,
    openWeight: true,
  },
  'cloudflare-workers-ai': {
    id: 'cloudflare-workers-ai',
    label: 'Cloudflare Workers AI',
    description: 'Free-tier open-weight models on Cloudflare. Account ID + token. No browser CORS.',
    endpoint: 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}',
    host: 'api.cloudflare.com',
    kind: 'cloudflare',
    envKey: 'CLOUDFLARE_API_TOKEN',
    modelEnvKey: 'CLOUDFLARE_MODEL_ID',
    extraEnvKeys: ['CLOUDFLARE_ACCOUNT_ID'],
    docsUrl: 'https://dash.cloudflare.com/',
    requiresKey: true,
    requiresAccountId: true,
    browserCors: 'blocked',
    freeTier: true,
    paidTier: false,
    openWeight: true,
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    description: 'Pixtral and Mistral open-weight models with a free experimentation tier.',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    host: 'api.mistral.ai',
    kind: 'openai',
    envKey: 'MISTRAL_API_KEY',
    modelEnvKey: 'MISTRAL_MODEL_ID',
    extraEnvKeys: [],
    docsUrl: 'https://console.mistral.ai/api-keys',
    requiresKey: true,
    browserCors: 'unverified',
    freeTier: true,
    paidTier: true,
    openWeight: true,
  },
  cerebras: {
    id: 'cerebras',
    label: 'Cerebras',
    description: 'Free-tier ultra-fast text models. No vision model in this catalogue.',
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    host: 'api.cerebras.ai',
    kind: 'openai',
    envKey: 'CEREBRAS_API_KEY',
    modelEnvKey: 'CEREBRAS_MODEL_ID',
    extraEnvKeys: [],
    docsUrl: 'https://cloud.cerebras.ai/',
    requiresKey: true,
    browserCors: 'unverified',
    freeTier: true,
    paidTier: true,
    openWeight: true,
    textOnly: true,
  },
  together: {
    id: 'together',
    label: 'Together AI',
    description: 'Open-weight model hosting with free and paid endpoints.',
    endpoint: 'https://api.together.xyz/v1/chat/completions',
    host: 'api.together.xyz',
    kind: 'openai',
    envKey: 'TOGETHER_API_KEY',
    modelEnvKey: 'TOGETHER_MODEL_ID',
    extraEnvKeys: [],
    docsUrl: 'https://api.together.ai/settings/api-keys',
    requiresKey: true,
    browserCors: 'unverified',
    freeTier: true,
    paidTier: true,
    openWeight: true,
  },
  huggingface: {
    id: 'huggingface',
    label: 'Hugging Face',
    description: 'Inference Providers router: one token, many open-weight models.',
    endpoint: 'https://router.huggingface.co/v1/chat/completions',
    host: 'router.huggingface.co',
    kind: 'openai',
    envKey: 'HF_TOKEN',
    modelEnvKey: 'HF_MODEL_ID',
    extraEnvKeys: ['HUGGINGFACE_API_KEY'],
    docsUrl: 'https://huggingface.co/settings/tokens',
    requiresKey: true,
    browserCors: 'unverified',
    freeTier: true,
    paidTier: true,
    openWeight: true,
  },
  deepinfra: {
    id: 'deepinfra',
    label: 'DeepInfra',
    description: 'Low-cost open-weight vision and text models.',
    endpoint: 'https://api.deepinfra.com/v1/openai/chat/completions',
    host: 'api.deepinfra.com',
    kind: 'openai',
    envKey: 'DEEPINFRA_API_KEY',
    modelEnvKey: 'DEEPINFRA_MODEL_ID',
    extraEnvKeys: [],
    docsUrl: 'https://deepinfra.com/dash/api_keys',
    requiresKey: true,
    browserCors: 'unverified',
    freeTier: false,
    paidTier: true,
    openWeight: true,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT-4.1 / GPT-4o paid vision models.',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    host: 'api.openai.com',
    kind: 'openai',
    envKey: 'OPENAI_API_KEY',
    modelEnvKey: 'OPENAI_MODEL_ID',
    extraEnvKeys: [],
    docsUrl: 'https://platform.openai.com/api-keys',
    requiresKey: true,
    browserCors: 'blocked',
    freeTier: false,
    paidTier: true,
    openWeight: false,
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude paid vision models through the Messages API.',
    endpoint: 'https://api.anthropic.com/v1/messages',
    host: 'api.anthropic.com',
    kind: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    modelEnvKey: 'ANTHROPIC_MODEL_ID',
    extraEnvKeys: ['ANTHROPIC_BASE_URL'],
    docsUrl: 'https://console.anthropic.com/settings/keys',
    requiresKey: true,
    browserCors: 'blocked',
    freeTier: false,
    paidTier: true,
    openWeight: false,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    description: 'Local open-weight models on your own PC. No key, no cloud bill, slower on low-end hardware.',
    endpoint: 'http://localhost:11434/v1/chat/completions',
    host: 'localhost',
    kind: 'openai',
    envKey: '',
    modelEnvKey: 'OLLAMA_MODEL_ID',
    extraEnvKeys: ['OLLAMA_BASE_URL'],
    docsUrl: 'https://ollama.com/',
    requiresKey: false,
    browserCors: 'local',
    freeTier: true,
    paidTier: false,
    openWeight: true,
    local: true,
  },
  custom: {
    id: 'custom',
    label: 'Custom OpenAI-compatible relay',
    description: 'Any HTTPS OpenAI-compatible endpoint you control, including an OpenAI-compatible proxy.',
    endpoint: '',
    host: '',
    kind: 'openai',
    envKey: 'CUSTOM_API_KEY',
    modelEnvKey: 'CUSTOM_MODEL_ID',
    extraEnvKeys: ['CUSTOM_BASE_URL'],
    docsUrl: '',
    requiresKey: false,
    requiresBaseUrl: true,
    browserCors: 'unverified',
    freeTier: true,
    paidTier: true,
    openWeight: true,
  },
};

// Pricing is USD per million tokens. Free-tier entries cost 0 on the free tier;
// the provider may bill overages. Keep the numbers conservative and visible in
// the UI instead of pretending they are exact.
const m = (id, name, opts = {}) => ({
  id,
  name,
  modality: 'text',
  vision: false,
  tier: 'free',
  contextWindow: 32768,
  maxOutput: 4096,
  inputPerM: 0,
  outputPerM: 0,
  verified: false,
  openWeight: false,
  note: '',
  ...opts,
});

export const PROVIDER_MODELS = {
  openrouter: {
    'meta-llama/llama-3.2-11b-vision-instruct:free': m('meta-llama/llama-3.2-11b-vision-instruct:free', 'Llama 3.2 11B Vision (free)', { modality: 'vision', vision: true, tier: 'free', inputPerM: 0, outputPerM: 0, contextWindow: 131072, maxOutput: 4096, openWeight: true, note: 'Free variant; availability changes. Good first choice when it is offered.' }),
    'qwen/qwen2.5-vl-72b-instruct:free': m('qwen/qwen2.5-vl-72b-instruct:free', 'Qwen2.5-VL 72B (free)', { modality: 'vision', vision: true, tier: 'free', contextWindow: 32768, maxOutput: 4096, openWeight: true, note: 'Strong open-weight vision model on the free tier.' }),
    'google/gemma-3-27b-it:free': m('google/gemma-3-27b-it:free', 'Gemma 3 27B (free)', { modality: 'vision', vision: true, tier: 'free', contextWindow: 131072, maxOutput: 4096, openWeight: true, note: 'Open-weight multimodal Gemma. Free-tier limits apply.' }),
    'mistralai/mistral-small-3.2-24b-instruct:free': m('mistralai/mistral-small-3.2-24b-instruct:free', 'Mistral Small 3.2 24B (free)', { modality: 'vision', vision: true, tier: 'free', contextWindow: 131072, maxOutput: 4096, openWeight: true, note: 'Open-weight vision model on the free tier.' }),
    'meta-llama/llama-4-maverick': m('meta-llama/llama-4-maverick', 'Llama 4 Maverick', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 0.1875, outputPerM: 0.6525, contextWindow: 1048576, maxOutput: 8192, openWeight: true, verified: true, note: 'Verified with a real image. Paid per token; strong general grounding.' }),
    'meta-llama/llama-4-scout': m('meta-llama/llama-4-scout', 'Llama 4 Scout', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 0.10, outputPerM: 0.30, contextWindow: 1048576, maxOutput: 8192, openWeight: true, note: 'Cheaper Llama 4 vision model; not image-tested here.' }),
    'qwen/qwen2.5-vl-72b-instruct': m('qwen/qwen2.5-vl-72b-instruct', 'Qwen2.5-VL 72B', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 0.25, outputPerM: 0.75, contextWindow: 32768, maxOutput: 8192, openWeight: true, note: 'Paid open-weight vision model with strong OCR/diagram reading.' }),
    'mistralai/pixtral-large-2411': m('mistralai/pixtral-large-2411', 'Pixtral Large', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 2.0, outputPerM: 6.0, contextWindow: 128000, maxOutput: 4096, openWeight: true, note: 'Paid high-quality open-weight vision model.' }),
    'google/gemini-2.5-flash': m('google/gemini-2.5-flash', 'Gemini 2.5 Flash', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 0.30, outputPerM: 2.50, contextWindow: 1048576, maxOutput: 8192, note: 'Fast paid multimodal model.' }),
    'openai/gpt-4.1-mini': m('openai/gpt-4.1-mini', 'GPT-4.1 mini', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 0.40, outputPerM: 1.60, contextWindow: 1048576, maxOutput: 8192, note: 'Paid closed-weight vision model.' }),
    'meta-llama/llama-3.3-70b-instruct': m('meta-llama/llama-3.3-70b-instruct', 'Llama 3.3 70B', { tier: 'paid', inputPerM: 0.10, outputPerM: 0.32, contextWindow: 131072, maxOutput: 4096, openWeight: true }),
    'qwen/qwen3-235b-a22b': m('qwen/qwen3-235b-a22b', 'Qwen3 235B A22B', { tier: 'paid', inputPerM: 0.20, outputPerM: 0.60, contextWindow: 131072, maxOutput: 8192, openWeight: true }),
    'deepseek/deepseek-r1': m('deepseek/deepseek-r1', 'DeepSeek R1', { tier: 'paid', inputPerM: 0.55, outputPerM: 2.19, contextWindow: 163840, maxOutput: 8192, openWeight: true }),
  },
  groq: {
    'meta-llama/llama-4-scout-17b-16e-instruct': m('meta-llama/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout 17B', { modality: 'vision', vision: true, tier: 'free', contextWindow: 131072, maxOutput: 8192, openWeight: true, note: 'Free-tier vision model. Rate limits are tight; a 429 moves to the next provider.' }),
    'meta-llama/llama-4-maverick-17b-128e-instruct': m('meta-llama/llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick 17B', { modality: 'vision', vision: true, tier: 'preview', contextWindow: 131072, maxOutput: 8192, openWeight: true, note: 'Preview access; may not exist on every Groq account.' }),
    'llama-3.3-70b-versatile': m('llama-3.3-70b-versatile', 'Llama 3.3 70B Versatile', { contextWindow: 131072, maxOutput: 8192, openWeight: true, note: 'Free-tier text model.' }),
    'openai/gpt-oss-120b': m('openai/gpt-oss-120b', 'GPT-OSS 120B', { contextWindow: 131072, maxOutput: 8192, openWeight: true, note: 'Open-weight reasoning model on Groq.' }),
    'openai/gpt-oss-20b': m('openai/gpt-oss-20b', 'GPT-OSS 20B', { contextWindow: 131072, maxOutput: 8192, openWeight: true }),
    'qwen/qwen3-32b': m('qwen/qwen3-32b', 'Qwen3 32B', { contextWindow: 131072, maxOutput: 8192, openWeight: true }),
    'meta-llama/llama-guard-4-12b': m('meta-llama/llama-guard-4-12b', 'Llama Guard 4 12B', { modality: 'classifier', contextWindow: 131072, openWeight: true, note: 'Safety classifier only; never used for chat or vision.' }),
  },
  'google-ai-studio': {
    'gemini-2.5-flash': m('gemini-2.5-flash', 'Gemini 2.5 Flash', { modality: 'vision', vision: true, tier: 'free', inputPerM: 0, outputPerM: 0, contextWindow: 1048576, maxOutput: 8192, note: 'Free tier with daily limits; paid overage uses the paid price.' }),
    'gemini-2.5-flash-lite': m('gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', { modality: 'vision', vision: true, tier: 'free', contextWindow: 1048576, maxOutput: 8192, note: 'Fastest/cheapest Gemini free-tier option.' }),
    'gemini-2.0-flash': m('gemini-2.0-flash', 'Gemini 2.0 Flash', { modality: 'vision', vision: true, tier: 'free', contextWindow: 1048576, maxOutput: 8192 }),
    'gemma-3-27b-it': m('gemma-3-27b-it', 'Gemma 3 27B', { modality: 'vision', vision: true, tier: 'free', contextWindow: 131072, maxOutput: 8192, openWeight: true }),
    'gemini-2.5-pro': m('gemini-2.5-pro', 'Gemini 2.5 Pro', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 1.25, outputPerM: 10.0, contextWindow: 1048576, maxOutput: 8192, note: 'Paid premium reasoning model.' }),
  },
  'nvidia-nim': {
    'meta/llama-3.2-11b-vision-instruct': m('meta/llama-3.2-11b-vision-instruct', 'Llama 3.2 11B Vision', { modality: 'vision', vision: true, contextWindow: 128000, maxOutput: 4096, openWeight: true, note: 'Free on NVIDIA; some accounts return 404 for this function.' }),
    'meta/llama-3.2-90b-vision-instruct': m('meta/llama-3.2-90b-vision-instruct', 'Llama 3.2 90B Vision', { modality: 'vision', vision: true, contextWindow: 128000, maxOutput: 4096, openWeight: true, note: 'Large and slow; may time out on free credits.' }),
    'meta/muse-glimmer-30b': m('meta/muse-glimmer-30b', 'Muse Glimmer 30B', { modality: 'vision', vision: true, contextWindow: 128000, maxOutput: 8192, openWeight: true, verified: true, note: 'Verified with a real image. Reasoning model: allow 80-120s.' }),
    'qwen/qwen2.5-vl-72b-instruct': m('qwen/qwen2.5-vl-72b-instruct', 'Qwen2.5-VL 72B', { modality: 'vision', vision: true, contextWindow: 32768, maxOutput: 8192, openWeight: true, note: 'Strong OCR and diagram grounding.' }),
    'microsoft/phi-3.5-vision-instruct': m('microsoft/phi-3.5-vision-instruct', 'Phi-3.5 Vision', { modality: 'vision', vision: true, contextWindow: 128000, maxOutput: 4096, openWeight: true }),
    'nvidia/llama-3.1-nemotron-nano-vl-8b-v1': m('nvidia/llama-3.1-nemotron-nano-vl-8b-v1', 'Nemotron Nano VL 8B', { modality: 'vision', vision: true, contextWindow: 128000, maxOutput: 4096, openWeight: true }),
    'meta/llama-3.3-70b-instruct': m('meta/llama-3.3-70b-instruct', 'Llama 3.3 70B', { contextWindow: 128000, maxOutput: 4096, openWeight: true }),
    'qwen/qwen2.5-72b-instruct': m('qwen/qwen2.5-72b-instruct', 'Qwen2.5 72B', { contextWindow: 32768, maxOutput: 4096, openWeight: true }),
    'deepseek-ai/deepseek-r1': m('deepseek-ai/deepseek-r1', 'DeepSeek R1', { contextWindow: 128000, maxOutput: 8192, openWeight: true }),
  },
  'cloudflare-workers-ai': {
    '@cf/meta/llama-3.2-11b-vision-instruct': m('@cf/meta/llama-3.2-11b-vision-instruct', 'Llama 3.2 11B Vision', { modality: 'vision', vision: true, contextWindow: 128000, maxOutput: 4096, openWeight: true, verified: true, note: 'Verified with a real image after accepting the model licence.' }),
    '@cf/meta/llama-4-scout-17b-16e-instruct': m('@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout 17B', { modality: 'vision', vision: true, contextWindow: 131072, maxOutput: 8192, openWeight: true }),
    '@cf/qwen/qwen2.5-vl-7b-instruct': m('@cf/qwen/qwen2.5-vl-7b-instruct', 'Qwen2.5-VL 7B', { modality: 'vision', vision: true, contextWindow: 32768, maxOutput: 4096, openWeight: true, note: 'Small, fast open-weight vision model.' }),
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast': m('@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Llama 3.3 70B FP8 Fast', { contextWindow: 131072, maxOutput: 4096, openWeight: true }),
    '@cf/qwen/qwen2.5-coder-32b-instruct': m('@cf/qwen/qwen2.5-coder-32b-instruct', 'Qwen2.5 Coder 32B', { contextWindow: 32768, maxOutput: 4096, openWeight: true }),
    '@cf/openai/gpt-oss-120b': m('@cf/openai/gpt-oss-120b', 'GPT-OSS 120B', { contextWindow: 131072, maxOutput: 4096, openWeight: true }),
  },
  mistral: {
    'pixtral-12b-2409': m('pixtral-12b-2409', 'Pixtral 12B', { modality: 'vision', vision: true, contextWindow: 128000, maxOutput: 4096, openWeight: true, note: 'Open-weight vision model available on the free experimentation tier.' }),
    'mistral-small-latest': m('mistral-small-latest', 'Mistral Small (latest)', { modality: 'vision', vision: true, contextWindow: 128000, maxOutput: 4096, openWeight: true, note: 'Multimodal and cheap; free-tier limits apply.' }),
    'open-mistral-nemo': m('open-mistral-nemo', 'Mistral Nemo 12B', { contextWindow: 128000, maxOutput: 4096, openWeight: true }),
    'pixtral-large-latest': m('pixtral-large-latest', 'Pixtral Large', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 2.0, outputPerM: 6.0, contextWindow: 128000, maxOutput: 4096, openWeight: true }),
    'mistral-large-latest': m('mistral-large-latest', 'Mistral Large', { tier: 'paid', inputPerM: 2.0, outputPerM: 6.0, contextWindow: 128000, maxOutput: 4096, openWeight: true }),
  },
  cerebras: {
    'llama-3.3-70b': m('llama-3.3-70b', 'Llama 3.3 70B', { contextWindow: 131072, maxOutput: 8192, openWeight: true, note: 'Text only; no image input.' }),
    'qwen-3-32b': m('qwen-3-32b', 'Qwen3 32B', { contextWindow: 131072, maxOutput: 8192, openWeight: true }),
    'gpt-oss-120b': m('gpt-oss-120b', 'GPT-OSS 120B', { contextWindow: 131072, maxOutput: 8192, openWeight: true }),
  },
  together: {
    'meta-llama/Llama-Vision-Free': m('meta-llama/Llama-Vision-Free', 'Llama Vision Free', { modality: 'vision', vision: true, contextWindow: 131072, maxOutput: 4096, openWeight: true, note: 'Free vision endpoint on Together.' }),
    'meta-llama/Llama-4-Scout-17B-16E-Instruct': m('meta-llama/Llama-4-Scout-17B-16E-Instruct', 'Llama 4 Scout 17B', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 0.18, outputPerM: 0.59, contextWindow: 1048576, maxOutput: 8192, openWeight: true }),
    'Qwen/Qwen2.5-VL-72B-Instruct': m('Qwen/Qwen2.5-VL-72B-Instruct', 'Qwen2.5-VL 72B', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 0.25, outputPerM: 0.75, contextWindow: 32768, maxOutput: 8192, openWeight: true }),
    'google/gemma-3-27b-it': m('google/gemma-3-27b-it', 'Gemma 3 27B', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 0.20, outputPerM: 0.60, contextWindow: 131072, maxOutput: 8192, openWeight: true }),
  },
  huggingface: {
    'meta-llama/Llama-3.2-11B-Vision-Instruct': m('meta-llama/Llama-3.2-11B-Vision-Instruct', 'Llama 3.2 11B Vision', { modality: 'vision', vision: true, contextWindow: 128000, maxOutput: 4096, openWeight: true }),
    'Qwen/Qwen2.5-VL-7B-Instruct': m('Qwen/Qwen2.5-VL-7B-Instruct', 'Qwen2.5-VL 7B', { modality: 'vision', vision: true, contextWindow: 32768, maxOutput: 4096, openWeight: true }),
    'mistralai/Pixtral-12B-2409': m('mistralai/Pixtral-12B-2409', 'Pixtral 12B', { modality: 'vision', vision: true, contextWindow: 128000, maxOutput: 4096, openWeight: true }),
    'google/gemma-3-27b-it': m('google/gemma-3-27b-it', 'Gemma 3 27B', { modality: 'vision', vision: true, contextWindow: 131072, maxOutput: 8192, openWeight: true }),
  },
  deepinfra: {
    'meta-llama/Llama-4-Scout-17B-16E-Instruct': m('meta-llama/Llama-4-Scout-17B-16E-Instruct', 'Llama 4 Scout 17B', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 0.08, outputPerM: 0.30, contextWindow: 1048576, maxOutput: 8192, openWeight: true }),
    'Qwen/Qwen2.5-VL-72B-Instruct': m('Qwen/Qwen2.5-VL-72B-Instruct', 'Qwen2.5-VL 72B', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 0.20, outputPerM: 0.60, contextWindow: 32768, maxOutput: 8192, openWeight: true }),
    'mistralai/Mistral-Small-3.1-24B-Instruct-2503': m('mistralai/Mistral-Small-3.1-24B-Instruct-2503', 'Mistral Small 3.1 24B', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 0.06, outputPerM: 0.18, contextWindow: 128000, maxOutput: 4096, openWeight: true }),
  },
  openai: {
    'gpt-4.1-mini': m('gpt-4.1-mini', 'GPT-4.1 mini', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 0.40, outputPerM: 1.60, contextWindow: 1048576, maxOutput: 8192 }),
    'gpt-4.1': m('gpt-4.1', 'GPT-4.1', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 2.00, outputPerM: 8.00, contextWindow: 1048576, maxOutput: 8192 }),
    'gpt-4o-mini': m('gpt-4o-mini', 'GPT-4o mini', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 0.15, outputPerM: 0.60, contextWindow: 128000, maxOutput: 4096 }),
    'gpt-4o': m('gpt-4o', 'GPT-4o', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 2.50, outputPerM: 10.0, contextWindow: 128000, maxOutput: 4096 }),
  },
  anthropic: {
    'claude-sonnet-4-20250514': m('claude-sonnet-4-20250514', 'Claude Sonnet 4', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 3.0, outputPerM: 15.0, contextWindow: 200000, maxOutput: 8192 }),
    'claude-3-5-haiku-20241022': m('claude-3-5-haiku-20241022', 'Claude 3.5 Haiku', { modality: 'vision', vision: true, tier: 'paid', inputPerM: 0.80, outputPerM: 4.0, contextWindow: 200000, maxOutput: 4096 }),
  },
  ollama: {
    'qwen2.5vl:7b': m('qwen2.5vl:7b', 'Qwen2.5-VL 7B (local)', { modality: 'vision', vision: true, contextWindow: 32768, maxOutput: 4096, openWeight: true, note: 'Local weights; needs ~6 GB RAM/VRAM. No cloud cost.' }),
    'llama3.2-vision:11b': m('llama3.2-vision:11b', 'Llama 3.2 Vision 11B (local)', { modality: 'vision', vision: true, contextWindow: 128000, maxOutput: 4096, openWeight: true, note: 'Local weights; needs ~8-10 GB RAM/VRAM.' }),
    'llava:7b': m('llava:7b', 'LLaVA 7B (local)', { modality: 'vision', vision: true, contextWindow: 4096, maxOutput: 2048, openWeight: true, note: 'Older local vision model; lower accuracy.' }),
    'gemma3:4b': m('gemma3:4b', 'Gemma 3 4B (local)', { modality: 'vision', vision: true, contextWindow: 131072, maxOutput: 4096, openWeight: true, note: 'Smallest local multimodal option; potato-PC friendly.' }),
    'mistral-small3.1:24b': m('mistral-small3.1:24b', 'Mistral Small 3.1 24B (local)', { modality: 'vision', vision: true, contextWindow: 128000, maxOutput: 4096, openWeight: true, note: 'Local weights; needs a strong GPU.' }),
  },
  custom: {},
};

export const OPEN_WEIGHT_MARKERS = /(?:llama|qwen|mistral|mixtral|pixtral|gemma|deepseek|phi-|nemotron|gpt-oss|olmo|internvl|molmo|glm|kimi|ernie|command-r|yi-|falcon|dbrx|granite|minicpm|smol)/i;

const CLOSED_WEIGHT_MARKERS = /(?:^|\/)(?:gpt-|o[134]|claude|gemini-2\.5-pro)/i;

export function normalizeProviderId(id) {
  const raw = String(id || '').trim().toLowerCase();
  const aliases = {
    cloudflare: 'cloudflare-workers-ai',
    'cloudflare-ai': 'cloudflare-workers-ai',
    nvidia: 'nvidia-nim',
    nim: 'nvidia-nim',
    google: 'google-ai-studio',
    gemini: 'google-ai-studio',
    'google-ai': 'google-ai-studio',
    togetherai: 'together',
    hf: 'huggingface',
    'hugging-face': 'huggingface',
    'open-router': 'openrouter',
    'local': 'ollama',
    relay: 'custom',
  };
  return aliases[raw] || raw;
}

export function getProvider(id) {
  return PROVIDERS[normalizeProviderId(id)] || null;
}

export function listProviderIds() {
  return Object.keys(PROVIDERS);
}

export function getModel(providerId, modelId) {
  const provider = normalizeProviderId(providerId);
  const id = String(modelId || '').trim();
  return PROVIDER_MODELS[provider]?.[id] || null;
}

export function modelModality(providerId, modelId) {
  return getModel(providerId, modelId)?.modality || null;
}

export function isVisionModel(providerId, modelId) {
  return getModel(providerId, modelId)?.vision === true;
}

export function modelTier(providerId, modelId) {
  return getModel(providerId, modelId)?.tier || null;
}

export function providerSupportsModel(providerId, modelId) {
  return Boolean(getModel(providerId, modelId));
}

export function providerSupportsVisionModel(providerId, modelId) {
  return isVisionModel(providerId, modelId);
}

export function modelAllowedAtTier(providerId, modelId, tier = 'paid') {
  const rank = TIER_RANK[modelTier(providerId, modelId)];
  if (rank === undefined) return true;
  return rank <= (TIER_RANK[tier] ?? TIER_RANK.paid);
}

/** Models a provider exposes, optionally filtered by access tier and modality. */
export function modelsFor(providerId, { tier = 'paid', visionOnly = false, includeClassifiers = false } = {}) {
  const catalogue = PROVIDER_MODELS[normalizeProviderId(providerId)] || {};
  const limit = TIER_RANK[tier] ?? TIER_RANK.paid;
  return Object.fromEntries(Object.entries(catalogue).filter(([, info]) => {
    if ((TIER_RANK[info.tier] ?? TIER_RANK.paid) > limit) return false;
    if (visionOnly && info.vision !== true) return false;
    if (!includeClassifiers && info.modality === 'classifier') return false;
    return true;
  }));
}

export function defaultModelFor(providerId, { tier = 'paid', visionOnly = true } = {}) {
  const catalogue = modelsFor(providerId, { tier, visionOnly });
  const entries = Object.values(catalogue);
  // Prefer a verified entry, then a free entry, then the first one.
  const pick = entries.find((e) => e.verified) || entries.find((e) => e.tier === 'free') || entries[0];
  return pick?.id || '';
}

export function providerHasVision(providerId) {
  return Object.values(PROVIDER_MODELS[normalizeProviderId(providerId)] || {}).some((info) => info.vision === true);
}

export function isOpenWeightModel(providerId, modelId) {
  const info = getModel(providerId, modelId);
  if (info) return info.openWeight === true;
  const id = String(modelId || '');
  if (CLOSED_WEIGHT_MARKERS.test(id)) return false;
  return OPEN_WEIGHT_MARKERS.test(id);
}

export function providerEndpoint(providerId, { baseUrl = '', accountId = '', modelId = '' } = {}) {
  const provider = getProvider(providerId);
  if (!provider) return '';
  if (provider.id === 'custom') {
    const raw = String(baseUrl || '').trim();
    if (!raw) return '';
    const clean = raw.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(clean)) return clean;
    if (/\/v1$/i.test(clean)) return `${clean}/chat/completions`;
    return `${clean}/v1/chat/completions`;
  }
  if (provider.id === 'ollama') {
    const raw = String(baseUrl || globalThis.process?.env?.OLLAMA_BASE_URL || provider.endpoint).trim();
    const clean = raw.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(clean)) return clean;
    if (/\/v1$/i.test(clean)) return `${clean}/chat/completions`;
    return `${clean}/v1/chat/completions`;
  }
  if (provider.id === 'cloudflare-workers-ai') {
    const account = String(accountId || '').trim();
    const model = String(modelId || '').trim();
    if (!account || !model) return '';
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${model}`;
  }
  if (provider.id === 'anthropic') {
    const raw = String(baseUrl || provider.endpoint).trim().replace(/\/+$/, '');
    return /\/v1\/messages$/i.test(raw) ? raw : `${raw}/v1/messages`;
  }
  return provider.endpoint;
}

/** Rough token estimate, documented as a planning figure rather than exact. */
export function estimateTextTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

/** Vision token estimate: 85 base + one 512px tile per ~262k pixels, capped. */
export function estimateImageTokens(width, height) {
  const w = Number(width) > 0 ? Number(width) : 1024;
  const h = Number(height) > 0 ? Number(height) : 1024;
  const tiles = Math.max(1, Math.ceil((w * h) / 262144));
  return Math.min(4096, 85 + tiles * 170);
}

/** Estimated USD cost for a request. Unknown prices use a conservative cap. */
export function estimateCostUsd(providerId, modelId, { inputTokens = 0, outputTokens = 0, imageCount = 0, width, height } = {}) {
  const info = getModel(providerId, modelId);
  const inputPrice = info?.inputPerM ?? 1.0;
  const outputPrice = info?.outputPerM ?? 3.0;
  const imageTokens = imageCount > 0 ? estimateImageTokens(width, height) * imageCount : 0;
  const totalInput = Math.max(0, inputTokens) + imageTokens;
  return (totalInput / 1e6) * inputPrice + (Math.max(0, outputTokens) / 1e6) * outputPrice;
}

/** All environment keys the credential store is allowed to persist. */
export const ALL_SECRET_ENV_KEYS = [...new Set(
  Object.values(PROVIDERS).flatMap((p) => [p.envKey, p.modelEnvKey, ...(p.extraEnvKeys || [])]).filter(Boolean),
)].concat(['PROVIDER_PRIORITY', 'MODEL_ACCESS_TIER', 'DAILY_BUDGET_USD', 'MONTHLY_BUDGET_USD', 'MAX_REQUEST_USD']);

export function providerEnvKey(providerId) {
  return getProvider(providerId)?.envKey || '';
}

export function providerLabel(providerId) {
  return getProvider(providerId)?.label || String(providerId || '');
}

export function browserCanCallProvider(providerId) {
  const cors = getProvider(providerId)?.browserCors;
  return cors === 'allowed' || cors === 'unverified' || cors === 'local';
}

export function providerTierSummary(providerId) {
  const models = Object.values(PROVIDER_MODELS[normalizeProviderId(providerId)] || {});
  return {
    free: models.filter((x) => x.tier === 'free').length,
    paid: models.filter((x) => x.tier === 'paid').length,
    preview: models.filter((x) => x.tier === 'preview').length,
    vision: models.filter((x) => x.vision).length,
  };
}
