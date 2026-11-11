// server/config.js — multi-provider configuration.
//
// The old Meta-only allowlist is gone. The shared modelRegistry.js is the one
// source of truth for providers, models, tiers, prices and modalities. This file
// turns environment variables and saved credentials into runtime provider state.
//
// Security rules that remain:
//   - API keys live in the backend process / encrypted store, never in the page.
//   - Outbound inference hosts are limited to known providers plus explicit
//     user-owned HTTPS relays (and localhost for Ollama).
//   - A text-only or classifier model is never sent an image.

import { loadEnv } from './lib/env.js';
import {
  PROVIDERS,
  PROVIDER_MODELS,
  DEFAULT_PRIORITY,
  ACCESS_TIERS,
  TIER_RANK,
  ALL_SECRET_ENV_KEYS,
  getModel,
  getProvider,
  isOpenWeightModel,
  listProviderIds,
  modelAllowedAtTier,
  modelModality as registryModality,
  modelTier as registryModelTier,
  modelsFor,
  normalizeProviderId,
  providerEndpoint,
  providerHasVision,
  providerLabel,
  providerSupportsModel as registrySupportsModel,
  providerSupportsVisionModel as registrySupportsVision,
} from '../modelRegistry.js';

loadEnv();

const int = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === null) return fallback;
  return String(value).toLowerCase() === 'true' || String(value) === '1';
};

/** Provider catalogue in the legacy shape older modules expect. */
export const MODEL_CATALOG = Object.fromEntries(
  Object.entries(PROVIDERS).map(([id, provider]) => [
    id,
    {
      id,
      label: provider.label,
      host: provider.host,
      kind: provider.kind,
      browserCors: provider.browserCors,
      freeTier: provider.freeTier,
      paidTier: provider.paidTier,
      models: Object.fromEntries(
        Object.entries(PROVIDER_MODELS[id] || {}).map(([modelId, model]) => [
          modelId,
          {
            name: model.name,
            modality: model.modality,
            verified: model.verified === true,
            tier: model.tier,
            note: model.note,
            vision: model.vision === true,
            openWeight: model.openWeight === true,
            contextWindow: model.contextWindow,
            maxOutput: model.maxOutput,
            inputPerM: model.inputPerM,
            outputPerM: model.outputPerM,
          },
        ]),
      ),
    },
  ]),
);

// Backwards-compatible aliases. New code should use MODEL_CATALOG.
export const META_MODEL_CATALOG = MODEL_CATALOG;

export const META_MODELS = Object.fromEntries(
  Object.values(MODEL_CATALOG).flatMap((provider) =>
    Object.entries(provider.models)
      .filter(([, model]) => model.modality === 'vision')
      .map(([id, model]) => [id, { name: model.name, notes: provider.label }]),
  ),
);

export const CLOUD_PROVIDER_FIELDS = Object.fromEntries(
  Object.values(PROVIDERS).map((provider) => [
    provider.id,
    [provider.envKey, ...(provider.extraEnvKeys || [])].filter(Boolean),
  ]),
);

// Known inference hosts. Modal/relay wildcards are handled separately.
export const ALLOWED_HOSTS = [...new Set([
  ...Object.values(PROVIDERS).map((p) => p.host).filter(Boolean),
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.cerebras.ai',
  'api.together.xyz',
  'router.huggingface.co',
  'api.deepinfra.com',
  'api.openai.com',
  'api.anthropic.com',
])];

const PRIVATE_IP_RE = /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$)/i;

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  return PRIVATE_IP_RE.test(host);
}

/**
 * Coerce NIM_BASE_URL to the NVIDIA inference origin. Dashboard URLs are a
 * common copy/paste mistake.
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

/** Strict allowlist for built-in providers (kept for compatibility/tests). */
export function isAllowedOutboundHost(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (ALLOWED_HOSTS.includes(host)) return true;
    if (host.endsWith('.modal.run')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Custom/relay URLs are user-supplied. HTTPS is required for remote hosts;
 * plain HTTP is allowed only for loopback (Ollama or a local relay). Private
 * network literals are refused so a shared config cannot probe a LAN.
 */
export function isAllowedInferenceUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (u.protocol === 'https:') {
      if (isPrivateHostname(host) && host !== 'localhost') return false;
      return true;
    }
    if (u.protocol === 'http:') {
      return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    }
    return false;
  } catch {
    return false;
  }
}

export function providerSupportsModel(providerId, modelId) {
  return registrySupportsModel(providerId, modelId);
}

export function providerSupportsVisionModel(providerId, modelId) {
  return registrySupportsVision(providerId, modelId);
}

/** Legacy provider-unaware lookups: first matching catalogue entry wins. */
export function modelModality(modelId) {
  for (const provider of listProviderIds()) {
    const info = getModel(provider, modelId);
    if (info) return info.modality;
  }
  return null;
}

export function isVisionModel(modelId) {
  return modelModality(modelId) === 'vision';
}

export function isKnownModel(modelId) {
  return Boolean(modelModality(modelId));
}

/** Kept for old imports; no longer means "Meta only". */
export function isMetaModel(modelId) {
  return isKnownModel(modelId);
}

export function modelTier(providerId, modelId) {
  return registryModelTier(providerId, modelId);
}

export { modelAllowedAtTier, ACCESS_TIERS, TIER_RANK, getModel, getProvider, modelsFor, listProviderIds, normalizeProviderId, providerLabel, isOpenWeightModel };

/** Unset or legacy 'free' is upgraded to paid (the superset). */
export function normalizeTier(value) {
  const t = String(value || '').trim().toLowerCase();
  if (t === 'free' || t === 'preview') return t;
  return 'paid';
}

const ENV_MODEL_KEYS = {
  openrouter: ['OPENROUTER_MODEL_ID'],
  groq: ['GROQ_MODEL_ID', 'GROQ_VISION_MODEL', 'GROQ_TEXT_MODEL'],
  'google-ai-studio': ['GEMINI_MODEL_ID', 'GOOGLE_MODEL_ID'],
  'nvidia-nim': ['NIM_MODEL_ID'],
  'cloudflare-workers-ai': ['CLOUDFLARE_MODEL_ID'],
  mistral: ['MISTRAL_MODEL_ID'],
  cerebras: ['CEREBRAS_MODEL_ID'],
  together: ['TOGETHER_MODEL_ID'],
  huggingface: ['HF_MODEL_ID', 'HUGGINGFACE_MODEL_ID'],
  deepinfra: ['DEEPINFRA_MODEL_ID'],
  openai: ['OPENAI_MODEL_ID'],
  anthropic: ['ANTHROPIC_MODEL_ID'],
  ollama: ['OLLAMA_MODEL_ID'],
  custom: ['CUSTOM_MODEL_ID'],
};

function firstEnv(keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && String(value).trim()) return String(value).trim();
  }
  return '';
}

export function providerKeyEnv(id) {
  const provider = getProvider(id);
  return provider?.envKey || '';
}

export function providerApiKey(id) {
  const provider = getProvider(id);
  if (!provider) return '';
  if (id === 'google-ai-studio') return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (id === 'huggingface') return (process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY || '').trim();
  if (id === 'ollama') return '';
  return provider.envKey ? (process.env[provider.envKey] || '').trim() : '';
}

export function providerSelectedModel(id) {
  const provider = getProvider(id);
  if (!provider) return '';
  const explicit = firstEnv(ENV_MODEL_KEYS[provider.id] || []);
  if (explicit) return explicit;
  return '';
}

export function providerBaseUrl(id) {
  const provider = getProvider(id);
  if (!provider) return '';
  if (id === 'nvidia-nim') return normalizeNimBaseUrl(process.env.NIM_BASE_URL);
  if (id === 'ollama') return (process.env.OLLAMA_BASE_URL || provider.endpoint.replace(/\/v1\/chat\/completions$/, '')).trim();
  if (id === 'custom') return (process.env.CUSTOM_BASE_URL || '').trim();
  if (id === 'modal') return (process.env.MODAL_BASE_URL || '').trim();
  if (id === 'anthropic') return (process.env.ANTHROPIC_BASE_URL || '').trim();
  return provider.endpoint;
}

export function providerAccountId(id) {
  if (id === 'cloudflare-workers-ai') return (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  return '';
}

export function providerEnabled(id) {
  if (id === 'ollama') return bool(process.env.OLLAMA_ENABLED, false);
  if (id === 'nvidia-nim') return bool(process.env.NIM_ENABLED, true);
  if (id === 'modal') return bool(process.env.MODAL_ENABLED, Boolean(process.env.MODAL_BASE_URL));
  return true;
}

/**
 * Build the runtime state object used by routes and the router. It is rebuilt
 * after every credential save, so changes take effect without a restart.
 */
export function buildRuntimeState() {
  const providers = {};
  for (const id of listProviderIds()) {
    const provider = getProvider(id);
    const modelId = providerSelectedModel(id);
    const key = providerApiKey(id);
    providers[id] = {
      id,
      label: provider.label,
      kind: provider.kind,
      enabled: providerEnabled(id),
      apiKey: key,
      modelId,
      baseUrl: providerBaseUrl(id),
      accountId: providerAccountId(id),
      browserCors: provider.browserCors,
      requiresKey: provider.requiresKey,
      requiresAccountId: provider.requiresAccountId === true,
      requiresBaseUrl: provider.requiresBaseUrl === true,
    };
  }
  return {
    providers,
    priority: (process.env.PROVIDER_PRIORITY || DEFAULT_PRIORITY.join(','))
      .split(',').map((s) => normalizeProviderId(s.trim())).filter((id) => getProvider(id)),
    accessTier: normalizeTier(process.env.MODEL_ACCESS_TIER),
  };
}

const runtime = buildRuntimeState();

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: int(process.env.PORT, 8000),
  dataDir: process.env.DATA_DIR || './intentlens-data',
  inferenceMode: (process.env.INFERENCE_MODE || 'multi-provider').toLowerCase(),

  // Generic provider runtime, also flattened below for older code paths.
  providers: runtime.providers,
  providerPriority: runtime.priority,
  accessTier: runtime.accessTier,

  // Budget defaults (the ledger lives in costManager.js).
  dailyBudgetUsd: Number(process.env.DAILY_BUDGET_USD || 1.0),
  monthlyBudgetUsd: Number(process.env.MONTHLY_BUDGET_USD || 10.0),
  maxRequestUsd: Number(process.env.MAX_REQUEST_USD || 0.25),
  maxInputTokens: int(process.env.MAX_INPUT_TOKENS, 12000),
  maxOutputTokens: int(process.env.MAX_OUTPUT_TOKENS, 2048),

  // Flattened legacy fields.
  cloudflareAccountId: (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim(),
  cloudflareApiToken: (process.env.CLOUDFLARE_API_TOKEN || '').trim(),
  cloudflareModelId: (process.env.CLOUDFLARE_MODEL_ID || '@cf/meta/llama-3.2-11b-vision-instruct').trim(),
  nimApiKey: (process.env.NIM_API_KEY || '').trim(),
  nimBaseUrl: normalizeNimBaseUrl(process.env.NIM_BASE_URL),
  nimModelId: (process.env.NIM_MODEL_ID || 'meta/muse-glimmer-30b').trim(),
  nimEnabled: bool(process.env.NIM_ENABLED, true),
  groqApiKey: (process.env.GROQ_API_KEY || '').trim(),
  groqTextModel: (process.env.GROQ_TEXT_MODEL || '').trim(),
  groqVisionModel: (process.env.GROQ_VISION_MODEL || process.env.GROQ_MODEL_ID || '').trim(),
  openrouterApiKey: (process.env.OPENROUTER_API_KEY || '').trim(),
  openrouterModelId: (process.env.OPENROUTER_MODEL_ID || 'meta-llama/llama-4-maverick').trim(),
  blockrunApiKey: (process.env.BLOCKRUN_API_KEY || '').trim(),
  blockrunModelId: (process.env.BLOCKRUN_MODEL_ID || '').trim(),
  modalApiKey: (process.env.MODAL_API_KEY || '').trim(),
  modalBaseUrl: (process.env.MODAL_BASE_URL || '').trim(),
  modalModelId: (process.env.MODAL_MODEL_ID || '').trim(),

  allowOutboundNetwork: bool(process.env.ALLOW_OUTBOUND_NETWORK, true),
  localSourceDir: process.env.LOCAL_SOURCE_DIR || './intentlens-data/sources',
  sam2Enabled: false,
  dinoV2Enabled: false,
  faissEnabled: bool(process.env.FAISS_ENABLED, false),
  version: '0.5.0-multiprovider',
  maxBodyBytes: int(process.env.MAX_BODY_BYTES, 12 * 1024 * 1024),
  maxImageBytes: int(process.env.MAX_IMAGE_BYTES, 8 * 1024 * 1024),
};

export const LOCAL_MODEL_DEFAULTS = {
  runtime: 'cloud-generative',
  baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
  modelId: 'meta/muse-glimmer-30b',
  timeoutMs: 180000,
};

export const localModelConfig = LOCAL_MODEL_DEFAULTS;

export const MAX_JSON_BODY_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Placeholder values ship in .env.example. Treating them as real keys makes the
 * UI claim a provider is ready and then fail on the first request.
 */
export function isPlaceholderCredential(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  if (/(your[-_ ]|replace[-_ ]|change[-_ ]?me|placeholder|example[-_ ]|dummy|xxxx|sample[-_ ]?key)/.test(lower)) return true;
  if (/^<.*>$/.test(text)) return true;
  return false;
}

/** Resolve the effective model for a provider, falling back to its default. */
export function effectiveModelId(id, modelId = '') {
  const chosen = String(modelId || '').trim() || providerSelectedModel(id);
  if (chosen) return chosen;
  const defaults = modelsFor(id, { tier: config.accessTier, visionOnly: true });
  const entry = Object.values(defaults).find((m) => m.verified) || Object.values(defaults)[0];
  return entry?.id || '';
}

/** Provider has credentials and a usable vision model at the selected tier. */
export function providerConfigured(id) {
  const provider = getProvider(id);
  if (!provider) return false;
  const state = config.providers?.[provider.id];
  if (!state?.enabled) return false;
  if (provider.id === 'ollama') {
    return Boolean(state.baseUrl) && providerHasVision(provider.id);
  }
  if (provider.requiresKey && (!state.apiKey || isPlaceholderCredential(state.apiKey))) return false;
  if (provider.requiresAccountId && isPlaceholderCredential(state.accountId)) return false;
  if (provider.requiresBaseUrl && !state.baseUrl) return false;
  if (provider.requiresBaseUrl && !isAllowedInferenceUrl(state.baseUrl)) return false;
  const model = effectiveModelId(provider.id);
  if (!model) return false;
  if (provider.id !== 'custom' && !registrySupportsModel(provider.id, model)) return false;
  if (provider.id !== 'custom' && !modelAllowedAtTier(provider.id, model, config.accessTier)) return false;
  return registrySupportsVision(provider.id, model);
}

export const modelMode = () => (localModelAvailable() ? 'cloud-generative' : 'offline');

export const localModelAvailable = () =>
  config.providerPriority.some((id) => providerConfigured(id));

export const outboundNetworkAllowed = () => config.allowOutboundNetwork === true;

/** The UI must distinguish local perception from cloud generative inference. */
export function perceptionStatus() {
  const ollama = providerConfigured('ollama');
  return {
    localPerception: true,
    localLlm: ollama,
    localLlmDetail: ollama
      ? 'Ollama is configured locally. Requests still stay on this machine.'
      : 'No local LLM is configured. Local classification is the KNN reference classifier, not a language model.',
    camera: 'browser',
  };
}

/** Runtime provider object used by the router and provider setup UI. */
export function providerRuntime(id) {
  const provider = getProvider(id);
  if (!provider) return null;
  const state = config.providers?.[provider.id] || {};
  const modelId = effectiveModelId(provider.id);
  return {
    ...state,
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    modelId,
    endpoint: providerEndpoint(provider.id, {
      baseUrl: state.baseUrl,
      accountId: state.accountId,
      modelId,
    }),
    model: getModel(provider.id, modelId),
    openWeight: isOpenWeightModel(provider.id, modelId),
  };
}

export function providerModelList(id, { tier = config.accessTier, visionOnly = false } = {}) {
  return Object.entries(modelsFor(id, { tier, visionOnly })).map(([modelId, info]) => ({
    ...info,
    id: modelId,
    providerId: id,
    providerLabel: providerLabel(id),
    openWeight: info.openWeight === true || isOpenWeightModel(id, modelId),
  }));
}

export { ALL_SECRET_ENV_KEYS };
