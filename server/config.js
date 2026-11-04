// server/config.js — Meta-only provider configuration.
//
// Only Meta-published generative models are allowed. Every model in the
// catalogue below has an explicit modality; text-only models are never used
// for vision requests.

import { loadEnv } from './lib/env.js';

loadEnv();

const int = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === null) return fallback;
  return String(value).toLowerCase() === 'true' || String(value) === '1';
};

/**
 * Strict Meta-only catalogue. `modality` is part of the contract: the router
 * will not send an image to a text-only model.
 */
export const META_MODEL_CATALOG = {
  'nvidia-nim': {
    label: 'NVIDIA NIM',
    host: 'integrate.api.nvidia.com',
    models: {
      // Verified on this account: a real image request returned valid JSON.
      'meta/muse-glimmer-30b': {
        name: 'Meta Muse Glimmer 30B',
        modality: 'vision',
        verified: true,
        note: 'Verified with a real image. Reasoning model: responses can take 80-120s.',
      },
      // Listed by /v1/models on this account, but the endpoint currently fails.
      // Kept visible with verified:false so the UI can explain why; it is never
      // selected automatically and never makes a provider "configured".
      'meta/llama-3.2-11b-vision-instruct': {
        name: 'Meta Llama 3.2 Vision 11B',
        modality: 'vision',
        verified: false,
        note: 'HTTP 404 on this account: the function is not deployed for this key.',
      },
      'meta/llama-3.2-90b-vision-instruct': {
        name: 'Meta Llama 3.2 Vision 90B',
        modality: 'vision',
        verified: false,
        note: 'Timed out (>90s) on this account during the 2026-11-04 audit.',
      },
    },
  },
  'cloudflare-workers-ai': {
    label: 'Cloudflare Workers AI',
    host: 'api.cloudflare.com',
    models: {
      '@cf/meta/llama-4-scout-17b-16e-instruct': {
        name: 'Meta Llama 4 Scout 17B',
        modality: 'vision',
        verified: false,
        note: 'Listed in this account model search; it was not image-tested in the 2026-11-04 audit.',
      },
      '@cf/meta/llama-3.2-11b-vision-instruct': {
        name: 'Meta Llama 3.2 Vision 11B',
        modality: 'vision',
        verified: true,
        note: 'Verified with a real image after accepting the model licence: correctly named a red circle and blue rectangle.',
      },
      '@cf/meta/llama-3.1-8b-instruct': { name: 'Meta Llama 3.1 8B Instruct', modality: 'text' },
      '@cf/meta/llama-3.1-8b-instruct-fp8': { name: 'Meta Llama 3.1 8B Instruct FP8', modality: 'text' },
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { name: 'Meta Llama 3.3 70B Instruct FP8 Fast', modality: 'text' },
      '@cf/meta/llama-3.2-1b-instruct': { name: 'Meta Llama 3.2 1B Instruct', modality: 'text' },
      '@cf/meta/llama-3.2-3b-instruct': { name: 'Meta Llama 3.2 3B Instruct', modality: 'text' },
      '@cf/meta/llama-guard-3-8b': { name: 'Meta Llama Guard 3 8B (safety classifier)', modality: 'classifier' },
    },
  },
  'groq': {
    label: 'Groq (classifier only on this account)',
    host: 'api.groq.com',
    models: {
      // The live Groq account on 2026-11-04 listed only these Meta models.
      // Prompt Guard is a prompt-injection classifier; it must never be used
      // for chat or vision. No Meta chat or vision model was available.
      'meta-llama/llama-prompt-guard-2-22m': {
        name: 'Meta Llama Prompt Guard 2 22M (classifier only)',
        modality: 'classifier',
        verified: false,
        note: 'Classifier only: not a chat model and not a vision model.',
      },
      'meta-llama/llama-prompt-guard-2-86m': {
        name: 'Meta Llama Prompt Guard 2 86M (classifier only)',
        modality: 'classifier',
        verified: false,
        note: 'Classifier only: not a chat model and not a vision model.',
      },
    },
  },
};

// Backwards-compatible export used by older code/tests.
export const META_MODELS = Object.fromEntries(
  Object.values(META_MODEL_CATALOG).flatMap((provider) =>
    Object.entries(provider.models)
      .filter(([, model]) => model.modality === 'vision')
      .map(([id, model]) => [id, { name: model.name, notes: provider.label }]),
  ),
);

export const CLOUD_PROVIDER_FIELDS = {
  'cloudflare-workers-ai': ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'],
  'nvidia-nim': ['NIM_API_KEY'],
  'groq': ['GROQ_API_KEY'],
};

export const ALLOWED_HOSTS = [
  'api.cloudflare.com',
  'integrate.api.nvidia.com',
  'api.groq.com',
];

/**
 * Coerce NIM_BASE_URL to an allowlisted inference origin. A dashboard URL such
 * as build.nvidia.com is a common copy/paste mistake; it cannot serve inference.
 */
export function normalizeNimBaseUrl(value) {
  const fallback = 'https://integrate.api.nvidia.com';
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return fallback;
    if (u.hostname.toLowerCase() !== 'integrate.api.nvidia.com') return fallback;
    return `${u.protocol}//${u.host}`;
  } catch {
    return fallback;
  }
}

export function isAllowedOutboundHost(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Local speech-to-text only. The transcription endpoint is a process on this
 * machine (whisper.cpp, faster-whisper, ...), so a non-loopback STT_URL is
 * rejected instead of silently shipping audio to a remote host.
 */
export function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '0:0:0:0:0:0:0:1';
}

export function isLoopbackUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

export function isMetaModel(modelId) {
  return Object.values(META_MODEL_CATALOG).some((provider) =>
    Object.prototype.hasOwnProperty.call(provider.models, modelId));
}

export function modelModality(modelId) {
  for (const provider of Object.values(META_MODEL_CATALOG)) {
    if (provider.models[modelId]) return provider.models[modelId].modality;
  }
  return null;
}

export function isVisionModel(modelId) {
  return modelModality(modelId) === 'vision';
}

/** A provider may only use models listed in its own Meta-only catalog. */
export function providerSupportsModel(providerId, modelId) {
  return Boolean(META_MODEL_CATALOG[providerId]?.models?.[modelId]);
}

export function providerSupportsVisionModel(providerId, modelId) {
  return META_MODEL_CATALOG[providerId]?.models?.[modelId]?.modality === 'vision';
}

export const LOCAL_MODEL_DEFAULTS = {
  runtime: 'cloud-generative',
  baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
  modelId: 'meta/muse-glimmer-30b',
  timeoutMs: 180000,
};

export const localModelConfig = LOCAL_MODEL_DEFAULTS;

export const MAX_JSON_BODY_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: int(process.env.PORT, 8000),
  dataDir: process.env.DATA_DIR || './intentlens-data',
  inferenceMode: (process.env.INFERENCE_MODE || 'meta-cloud-only').toLowerCase(),
  cloudflareAccountId: (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim(),
  cloudflareApiToken: (process.env.CLOUDFLARE_API_TOKEN || '').trim(),
  cloudflareModelId: (process.env.CLOUDFLARE_MODEL_ID || '@cf/meta/llama-3.2-11b-vision-instruct').trim(),
  nimApiKey: (process.env.NIM_API_KEY || '').trim(),
  nimBaseUrl: normalizeNimBaseUrl(process.env.NIM_BASE_URL),
  nimModelId: (process.env.NIM_MODEL_ID || 'meta/muse-glimmer-30b').trim(),
  nimEnabled: bool(process.env.NIM_ENABLED, true),
  groqApiKey: (process.env.GROQ_API_KEY || '').trim(),
  // Groq's supplied account has no Meta chat/vision model, only Prompt Guard
  // classifiers. Keep text/vision model fields empty rather than naming a
  // retired or non-Meta model.
  groqTextModel: (process.env.GROQ_TEXT_MODEL || '').trim(),
  groqVisionModel: (process.env.GROQ_VISION_MODEL || '').trim(),
  providerPriority: (process.env.PROVIDER_PRIORITY || 'nvidia-nim,cloudflare-workers-ai,groq')
    .split(',').map((s) => s.trim()).filter(Boolean),
  allowOutboundNetwork: bool(process.env.ALLOW_OUTBOUND_NETWORK, true),
  // Local speech-to-text. Empty unless STT_URL points at this machine.
  sttUrl: isLoopbackUrl(process.env.STT_URL) ? String(process.env.STT_URL).trim() : '',
  sttUrlRejected: Boolean(String(process.env.STT_URL || '').trim()) && !isLoopbackUrl(process.env.STT_URL),
  sttModel: (process.env.STT_MODEL || 'whisper-1').trim(),
  sttApiKey: (process.env.STT_API_KEY || '').trim(),
  sttLanguage: (process.env.STT_LANGUAGE || 'en').trim(),
  sttTimeoutMs: int(process.env.STT_TIMEOUT_MS, 60000),
  localSourceDir: process.env.LOCAL_SOURCE_DIR || './intentlens-data/sources',
  sam2Enabled: false,
  dinoV2Enabled: false,
  faissEnabled: bool(process.env.FAISS_ENABLED, false),
  version: '0.4.0-v8',
  maxBodyBytes: int(process.env.MAX_BODY_BYTES, MAX_JSON_BODY_BYTES),
  maxImageBytes: int(process.env.MAX_IMAGE_BYTES, MAX_IMAGE_BYTES),
};

/**
 * Placeholder values ship in .env.example. Treating them as real keys makes the
 * UI claim a provider is ready and then fail on the first request, so reject the
 * obvious placeholder patterns up front. Real provider formats are never
 * hard-checked here (providers can change their key prefixes).
 */
export function isPlaceholderCredential(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  if (/(your[-_ ]|replace[-_ ]|change[-_ ]?me|placeholder|example[-_ ]|dummy|xxxx|sample[-_ ]?key)/.test(lower)) return true;
  if (/^<.*>$/.test(text)) return true;
  return false;
}

/** A model is only eligible when it has an explicit modality and is verified. */
function verifiedVisionModel(providerId, modelId) {
  const model = META_MODEL_CATALOG[providerId]?.models?.[modelId];
  return Boolean(model && model.modality === 'vision' && model.verified === true);
}

/** Provider has credentials for a verified, vision-capable Meta model. */
export function providerConfigured(id) {
  if (id === 'nvidia-nim') return Boolean(config.nimApiKey && !isPlaceholderCredential(config.nimApiKey) && config.nimEnabled && verifiedVisionModel(id, config.nimModelId));
  if (id === 'cloudflare-workers-ai') return Boolean(config.cloudflareAccountId && !isPlaceholderCredential(config.cloudflareAccountId) && config.cloudflareApiToken && !isPlaceholderCredential(config.cloudflareApiToken) && verifiedVisionModel(id, config.cloudflareModelId));
  if (id === 'groq') return Boolean(config.groqApiKey && !isPlaceholderCredential(config.groqApiKey) && config.groqVisionModel && verifiedVisionModel(id, config.groqVisionModel));
  return false;
}

export const modelMode = () => (localModelAvailable() ? 'meta-cloud' : 'offline');

export const localModelAvailable = () =>
  config.providerPriority.some((id) => providerConfigured(id));

export const outboundNetworkAllowed = () => config.allowOutboundNetwork === true;

/** The UI must distinguish local perception from cloud generative inference. */
export function perceptionStatus() {
  return {
    localPerception: true,
    localLlm: false,
    localLlmDetail: 'No local LLM is installed. Local classification is the KNN reference classifier, not a Llama model.',
    camera: 'browser',
  };
}
