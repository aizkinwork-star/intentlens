// server/routes/providers.js — Meta-only provider setup, health and credentials.
//
// Public responses never contain key material. Secrets are persisted by
// credentialStore.js (Electron safeStorage / Windows DPAPI).

import { readJson, json, recordServerLog } from '../lib/http.js';
import {
  META_MODEL_CATALOG,
  config,
  isMetaModel,
  isAllowedOutboundHost,
  isPlaceholderCredential,
  modelModality,
  modelTier,
  modelAllowedAtTier,
  providerConfigured,
  providerSupportsModel,
  normalizeTier,
} from '../config.js';
import {
  loadCredentials,
  saveCredentials,
  applyCredentialsToConfig,
  getCredentialSource,
  SECRET_ENV_KEYS,
} from '../lib/credentialStore.js';
import { resetProviderHealth } from '../services/provider.js';
import { chatCompletionsUrl } from '../services/openaiCompatibleProvider.js';

const PROVIDER_ENV = {
  'nvidia-nim': { key: 'NIM_API_KEY', model: 'NIM_MODEL_ID', extra: ['NIM_BASE_URL', 'NIM_ENABLED'] },
  'cloudflare-workers-ai': { key: 'CLOUDFLARE_API_TOKEN', model: 'CLOUDFLARE_MODEL_ID', extra: ['CLOUDFLARE_ACCOUNT_ID'] },
  'groq': { key: 'GROQ_API_KEY', model: 'GROQ_VISION_MODEL', extra: ['GROQ_TEXT_MODEL'] },
  openrouter: { key: 'OPENROUTER_API_KEY', model: 'OPENROUTER_MODEL_ID', extra: [] },
  blockrun: { key: 'BLOCKRUN_API_KEY', model: 'BLOCKRUN_MODEL_ID', extra: [] },
  modal: { key: 'MODAL_API_KEY', model: 'MODAL_MODEL_ID', extra: ['MODAL_BASE_URL'] },
};

const PROVIDER_ALIASES = {
  cloudflare: 'cloudflare-workers-ai',
  nvidia: 'nvidia-nim',
  nim: 'nvidia-nim',
  'cloudflare-workers': 'cloudflare-workers-ai',
  'open-router': 'openrouter',
  'block-run': 'blockrun',
};

function normalizeProvider(id) {
  const raw = String(id || '').trim();
  return PROVIDER_ALIASES[raw] || raw;
}

function publicModelList(providerId) {
  const provider = META_MODEL_CATALOG[providerId];
  if (!provider) return [];
  return Object.entries(provider.models).map(([id, model]) => ({
    id,
    name: model.name,
    modality: model.modality,
    verified: model.verified === true,
    tier: model.tier || 'free',
    note: model.note || '',
    selected: selectedModel(providerId) === id,
  }));
}

function selectedModel(providerId) {
  if (providerId === 'nvidia-nim') return config.nimModelId;
  if (providerId === 'cloudflare-workers-ai') return config.cloudflareModelId;
  if (providerId === 'groq') return config.groqVisionModel || null;
  if (providerId === 'openrouter') return config.openrouterModelId;
  if (providerId === 'blockrun') return config.blockrunModelId;
  if (providerId === 'modal') return config.modalModelId;
  return null;
}

function providerKey(providerId) {
  if (providerId === 'nvidia-nim') return config.nimApiKey;
  if (providerId === 'cloudflare-workers-ai') return config.cloudflareApiToken;
  if (providerId === 'groq') return config.groqApiKey;
  if (providerId === 'openrouter') return config.openrouterApiKey;
  if (providerId === 'blockrun') return config.blockrunApiKey;
  if (providerId === 'modal') return config.modalApiKey;
  return '';
}

function providerStatus(providerId) {
  const fromEnv = providerConfigured(providerId);
  const key = providerKey(providerId);
  return {
    id: providerId,
    label: META_MODEL_CATALOG[providerId]?.label || providerId,
    configured: fromEnv,
    hasKey: Boolean(key),
    placeholderKey: isPlaceholderCredential(key) || (
      providerId === 'cloudflare-workers-ai' && isPlaceholderCredential(config.cloudflareAccountId)
    ),
    modelId: selectedModel(providerId),
    modality: selectedModel(providerId) ? modelModality(selectedModel(providerId)) : null,
    modelVerified: Boolean(META_MODEL_CATALOG[providerId]?.models?.[selectedModel(providerId)]?.verified),
    models: publicModelList(providerId),
    eligibleForVision: Boolean(selectedModel(providerId) && modelModality(selectedModel(providerId)) === 'vision'),
    baseUrl: providerId === 'modal' ? config.modalBaseUrl || null : undefined,
  };
}

function providerSummary() {
  return {
    providers: Object.keys(META_MODEL_CATALOG).map(providerStatus),
    configured: Object.keys(META_MODEL_CATALOG).filter((id) => providerConfigured(id)),
    priority: config.providerPriority.filter((id) => META_MODEL_CATALOG[id]),
    accessTier: config.accessTier,
    catalog: META_MODEL_CATALOG,
    runtime: 'cloud-generative',
    baseUrl: config.nimBaseUrl,
    modelId: selectedModel('nvidia-nim'),
    isMetaModel: isMetaModel(selectedModel('nvidia-nim')),
    allowOutboundNetwork: config.allowOutboundNetwork,
    credentialStore: getCredentialSource(),
    localLlm: false,
    localPerception: true,
    localPerceptionNote: 'KNN reference classifier runs locally. It is not a large language model.',
  };
}

export async function handleGetCloudProviders(req, res) {
  json(res, 200, providerSummary());
}

export async function handleSaveCloudProvider(req, res) {
  const body = await readJson(req, 64_000);
  let provider = normalizeProvider(body?.provider);
  const apiKey = String(body?.apiKey || '').trim();
  const accountId = String(body?.accountId || '').trim();
  const baseUrl = String(body?.baseUrl || '').trim();
  const modelId = String(body?.modelId || '').trim();
  const textModel = String(body?.textModel || '').trim();
  const tierInput = String(body?.accessTier || '').toLowerCase();
  const requestedTier = tierInput ? normalizeTier(tierInput) : null;
  const accessTier = requestedTier || config.accessTier;

  // Priority-only update.
  if (!provider && Array.isArray(body?.priority)) {
    const priority = body.priority.map(normalizeProvider).filter((id) => META_MODEL_CATALOG[id]);
    if (!priority.length) {
      json(res, 400, { error: { code: 'BAD_JSON', message: 'priority must contain at least one known provider.', retryable: false } });
      return;
    }
    const current = (await loadCredentials()).credentials;
    current.PROVIDER_PRIORITY = priority.join(',');
    try { await saveCredentials(current); } catch (err) {
      json(res, 503, { error: { code: 'SECURE_STORAGE_FAILED', message: err.message, retryable: false } });
      return;
    }
    process.env.PROVIDER_PRIORITY = priority.join(',');
    config.providerPriority = priority;
    json(res, 200, { ok: true, ...providerSummary() });
    return;
  }

  if (!META_MODEL_CATALOG[provider]) {
    // Tier-only update: lets an existing saved key switch between free/preview/
    // paid without re-entering the key.
    if (!provider && requestedTier) {
      const current = (await loadCredentials()).credentials;
      current.MODEL_ACCESS_TIER = requestedTier;
      try { await saveCredentials(current); } catch (err) {
        json(res, 503, { error: { code: 'SECURE_STORAGE_FAILED', message: err.message, retryable: false } });
        return;
      }
      process.env.MODEL_ACCESS_TIER = requestedTier;
      config.accessTier = requestedTier;
      json(res, 200, { ok: true, ...providerSummary() });
      return;
    }
    json(res, 400, { error: { code: 'BAD_JSON', message: `Unknown provider ${provider || '(missing)'}.`, retryable: false } });
    return;
  }
  if (!apiKey) {
    json(res, 400, { error: { code: 'BAD_JSON', message: 'apiKey is required. Use Remove to delete a saved key.', retryable: false } });
    return;
  }
  if (isPlaceholderCredential(apiKey)) {
    json(res, 400, { error: { code: 'BAD_JSON', message: 'That looks like a placeholder key. Paste a real provider key.', retryable: false } });
    return;
  }
  if (provider === 'cloudflare-workers-ai' && accountId && isPlaceholderCredential(accountId)) {
    json(res, 400, { error: { code: 'BAD_JSON', message: 'That looks like a placeholder Cloudflare Account ID.', retryable: false } });
    return;
  }

  if (baseUrl && !isAllowedOutboundHost(baseUrl)) {
    json(res, 400, { error: { code: 'BAD_JSON', message: 'baseUrl must be an allowlisted HTTPS inference host (Modal endpoints must be *.modal.run).', retryable: false } });
    return;
  }
  if (provider === 'modal' && !baseUrl && !config.modalBaseUrl) {
    json(res, 400, { error: { code: 'BAD_JSON', message: 'Modal needs the HTTPS URL of your deployed OpenAI-compatible endpoint (*.modal.run).', retryable: false } });
    return;
  }

  const resolvedModel = modelId || selectedModel(provider) || defaultVisionModel(provider);
  if (resolvedModel && !isMetaModel(resolvedModel)) {
    json(res, 400, { error: { code: 'MODEL_NOT_META', message: `Only Meta-published models are permitted. Got ${resolvedModel}.`, retryable: false } });
    return;
  }
  if (resolvedModel && !providerSupportsModel(provider, resolvedModel)) {
    json(res, 400, { error: { code: 'BAD_JSON', message: `${resolvedModel} is not in the ${META_MODEL_CATALOG[provider].label} catalog.`, retryable: false } });
    return;
  }
  if (resolvedModel && !modelAllowedAtTier(provider, resolvedModel, accessTier)) {
    json(res, 400, {
      error: {
        code: 'MODEL_ACCESS_LOCKED',
        message: `${resolvedModel} is a ${modelTier(provider, resolvedModel)} model and ${accessTier} access is selected. Enable preview/paid access only if you have that account, or choose a free model.`,
        retryable: false,
      },
    });
    return;
  }
  if (resolvedModel && modelModality(resolvedModel) === 'classifier') {
    json(res, 400, {
      error: {
        code: 'MODEL_NOT_CHAT',
        message: `${resolvedModel} is a safety/prompt-injection classifier. It cannot answer questions or analyse images and cannot be configured as a vision model.`,
        retryable: false,
      },
    });
    return;
  }
  if (resolvedModel && modelModality(resolvedModel) === 'text') {
    // A text-only model is configurable, but it is not a vision model and will
    // never be silently used for an image request.
    recordServerLog({ level: 'warn', category: 'provider', message: `${provider} model ${resolvedModel} is text-only; it is not eligible for vision analysis.` });
  }
  if (resolvedModel && modelModality(resolvedModel) === 'vision' && META_MODEL_CATALOG[provider]?.models?.[resolvedModel]?.verified !== true) {
    recordServerLog({
      level: 'warn',
      category: 'provider',
      message: `${provider} model ${resolvedModel} is catalogued but not verified on this account yet; Test connection will check it.`,
    });
  }

  const stored = (await loadCredentials()).credentials;
  const next = { ...stored };
  if (requestedTier) next.MODEL_ACCESS_TIER = requestedTier;

  if (provider === 'cloudflare-workers-ai') {
    next.CLOUDFLARE_API_TOKEN = apiKey;
    if (accountId) next.CLOUDFLARE_ACCOUNT_ID = accountId;
    next.CLOUDFLARE_MODEL_ID = resolvedModel || '@cf/meta/llama-3.2-11b-vision-instruct';
  } else if (provider === 'nvidia-nim') {
    next.NIM_API_KEY = apiKey;
    next.NIM_ENABLED = 'true';
    next.NIM_BASE_URL = baseUrl || 'https://integrate.api.nvidia.com';
    next.NIM_MODEL_ID = resolvedModel || 'meta/muse-glimmer-30b';
  } else if (provider === 'groq') {
    next.GROQ_API_KEY = apiKey;
    if (resolvedModel) next.GROQ_VISION_MODEL = resolvedModel;
    if (textModel) next.GROQ_TEXT_MODEL = textModel;
  } else if (provider === 'openrouter') {
    next.OPENROUTER_API_KEY = apiKey;
    next.OPENROUTER_MODEL_ID = resolvedModel || 'meta-llama/llama-4-maverick';
  } else if (provider === 'blockrun') {
    next.BLOCKRUN_API_KEY = apiKey;
    next.BLOCKRUN_MODEL_ID = resolvedModel || 'meta-llama/llama-4-maverick';
  } else if (provider === 'modal') {
    next.MODAL_API_KEY = apiKey;
    next.MODAL_BASE_URL = baseUrl || config.modalBaseUrl;
    next.MODAL_MODEL_ID = resolvedModel || 'meta-llama/Llama-4-Maverick-17B-128E-Instruct';
  }

  try {
    await saveCredentials(next);
  } catch (err) {
    json(res, 503, { error: { code: 'SECURE_STORAGE_FAILED', message: err.message, retryable: false } });
    return;
  }

  applyEnv(next);
  await applyCredentialsToConfig(config);
  resetProviderHealth(normalizeProvider(provider));
  recordServerLog({ level: 'ok', category: 'provider', message: `${provider} credentials saved securely (${getCredentialSource()}).` });
  json(res, 200, { ok: true, provider, ...providerSummary() });
}

export async function handleDeleteCloudProvider(req, res, providerFromPath = null) {
  let provider = normalizeProvider(providerFromPath || (await readJson(req, 16_000))?.provider);
  if (!META_MODEL_CATALOG[provider]) {
    json(res, 400, { error: { code: 'BAD_JSON', message: `Unknown provider ${provider || '(missing)'}.`, retryable: false } });
    return;
  }

  const stored = { ...(await loadCredentials()).credentials };
  if (provider === 'nvidia-nim') {
    for (const key of ['NIM_API_KEY', 'NIM_BASE_URL', 'NIM_MODEL_ID', 'NIM_ENABLED']) delete stored[key];
  } else if (provider === 'cloudflare-workers-ai') {
    for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_MODEL_ID']) delete stored[key];
  } else if (provider === 'groq') {
    for (const key of ['GROQ_API_KEY', 'GROQ_VISION_MODEL', 'GROQ_TEXT_MODEL']) delete stored[key];
  } else if (provider === 'openrouter') {
    for (const key of ['OPENROUTER_API_KEY', 'OPENROUTER_MODEL_ID']) delete stored[key];
  } else if (provider === 'blockrun') {
    for (const key of ['BLOCKRUN_API_KEY', 'BLOCKRUN_MODEL_ID']) delete stored[key];
  } else if (provider === 'modal') {
    for (const key of ['MODAL_API_KEY', 'MODAL_BASE_URL', 'MODAL_MODEL_ID']) delete stored[key];
  }

  try { await saveCredentials(stored); } catch (err) {
    json(res, 503, { error: { code: 'SECURE_STORAGE_FAILED', message: err.message, retryable: false } });
    return;
  }
  // Remove only this provider's environment overrides; other providers that are
  // configured through .env must keep working.
  const envKeys = [PROVIDER_ENV[provider].key, PROVIDER_ENV[provider].model, ...(PROVIDER_ENV[provider].extra || [])];
  for (const key of envKeys) delete process.env[key];
  applyEnv(stored);
  await applyCredentialsToConfig(config);
  resetProviderHealth(normalizeProvider(provider));
  recordServerLog({ level: 'info', category: 'provider', message: `${provider} credentials removed.` });
  json(res, 200, { ok: true, provider, ...providerSummary() });
}

/** Explicit, session-only opt-in for cloud requests when the app shipped with
 * outbound disabled. Requires { allow: true, confirm: true } so nothing flips
 * the gate by accident. Never persists: a restart returns to the env default. */
export async function handleSetOutboundNetwork(req, res) {
  const body = await readJson(req, 4_000);
  if (body?.allow === true && body?.confirm !== true) {
    json(res, 400, { error: { code: 'CONFIRMATION_REQUIRED', message: 'Set confirm:true to allow cloud requests for this session.', retryable: false } });
    return;
  }
  config.allowOutboundNetwork = body?.allow === true;
  recordServerLog({
    level: 'info',
    category: 'provider',
    message: `Outbound cloud requests ${config.allowOutboundNetwork ? 'enabled for this session by the user' : 'disabled'}.`,
  });
  json(res, 200, { ok: true, allowOutboundNetwork: config.allowOutboundNetwork, sessionOnly: true });
}

/** Test credentials without saving them. Accepts a supplied key or saved key. */
export async function handleTestCloudProvider(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  let provider = normalizeProvider(url.searchParams.get('provider'));
  let body = {};
  if (req.method === 'POST') {
    try { body = await readJson(req, 64_000); } catch { body = {}; }
    provider = normalizeProvider(body.provider || provider);
  }
  if (!provider) {
    // Backward-compatible behaviour: test the highest-priority configured provider.
    provider = config.providerPriority.find((id) => providerConfigured(id)) || config.providerPriority[0];
  }
  if (!META_MODEL_CATALOG[provider]) {
    json(res, 400, { ok: false, category: 'not_configured', detail: `Unknown provider ${provider || '(missing)'}.` });
    return;
  }

  const stored = (await loadCredentials()).credentials;
  const envKey = PROVIDER_ENV[provider].key;
  const apiKey = String(body.apiKey || stored[envKey] || process.env[envKey] || '').trim();
  const modelId = String(body.modelId || stored[PROVIDER_ENV[provider].model] || selectedModel(provider) || '').trim();
  const accountId = String(body.accountId || stored.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const accessTier = normalizeTier(body.accessTier || config.accessTier);

  if (!config.allowOutboundNetwork) {
    json(res, 200, {
      ok: false,
      provider,
      category: 'network_disabled',
      modelId: modelId || null,
      detail: 'Outbound network is disabled by ALLOW_OUTBOUND_NETWORK=false. Set it to true and restart the server to test a cloud provider.',
    });
    return;
  }

  if (!apiKey) {
    json(res, 200, { ok: false, provider, category: 'not_configured', modelId: modelId || null, detail: 'No API key saved for this provider.' });
    return;
  }
  if (isPlaceholderCredential(apiKey)) {
    json(res, 200, { ok: false, provider, category: 'not_configured', modelId: modelId || null, detail: 'The configured key is a placeholder. Replace it in provider setup.' });
    return;
  }
  if (provider === 'cloudflare-workers-ai' && isPlaceholderCredential(accountId)) {
    json(res, 200, { ok: false, provider, category: 'not_configured', modelId: modelId || null, detail: 'The Cloudflare Account ID is missing or a placeholder.' });
    return;
  }
  if (modelId && !isMetaModel(modelId)) {
    json(res, 200, { ok: false, provider, category: 'not_meta', modelId, detail: 'Rejected: model is not in the Meta-only allowlist.' });
    return;
  }
  if (modelId && !providerSupportsModel(provider, modelId)) {
    json(res, 200, { ok: false, provider, category: 'model_unavailable', modelId, detail: `This Meta model is not in the ${META_MODEL_CATALOG[provider].label} catalog.` });
    return;
  }
  if (modelId && !modelAllowedAtTier(provider, modelId, accessTier)) {
    json(res, 200, {
      ok: false,
      provider,
      category: 'model_access_locked',
      modelId,
      detail: `${modelId} is a ${modelTier(provider, modelId)} model and ${accessTier} access is selected. Enable paid/preview access only if you have that account.`,
    });
    return;
  }
  if (modelId && modelModality(modelId) === 'classifier') {
    json(res, 200, { ok: false, provider, category: 'not_chat', modelId, detail: 'This Meta model is a classifier. It cannot answer questions or analyse images.' });
    return;
  }
  if (modelId && modelModality(modelId) !== 'vision') {
    json(res, 200, { ok: false, provider, category: 'not_vision', modelId, detail: 'This Meta model is text-only and cannot analyse images.' });
    return;
  }

  const effectiveModel = modelId || defaultVisionModel(provider);
  if (!effectiveModel) {
    json(res, 200, {
      ok: false,
      provider,
      category: 'no_vision_model',
      modelId: null,
      detail: `${META_MODEL_CATALOG[provider].label} has no verified Meta vision model on this account. Configure a different provider.`,
    });
    return;
  }

  const testBaseUrl = String(body.baseUrl || (provider === 'modal' ? config.modalBaseUrl : '') || '').trim();
  if (testBaseUrl && !isAllowedOutboundHost(testBaseUrl)) {
    json(res, 200, { ok: false, provider, category: 'bad_request', modelId: effectiveModel, detail: 'baseUrl must be an allowlisted HTTPS inference host (Modal endpoints must be *.modal.run).' });
    return;
  }
  if (provider === 'modal' && !testBaseUrl) {
    json(res, 200, { ok: false, provider, category: 'not_configured', modelId: effectiveModel, detail: 'Modal needs your deployed OpenAI-compatible endpoint URL (*.modal.run).' });
    return;
  }

  const result = await testProvider({ provider, apiKey, accountId, modelId: effectiveModel, baseUrl: testBaseUrl });
  recordServerLog({
    level: result.ok ? 'ok' : 'warn',
    category: 'provider',
    message: `POST ${result.endpoint || '(endpoint unknown)'} provider=${provider} host=${result.host || '(unknown)'} model=${result.modelId || '(none)'} mode=test http=${result.httpStatus ?? 'n/a'} status=${result.ok ? 'ok' : result.category} latency=${result.ms ?? 'n/a'}ms request=${result.requestId || '(none)'}`,
  });
  json(res, 200, { ...result, provider });
}

async function testProvider({ provider, apiKey, accountId, modelId, baseUrl }) {
  const started = Date.now();
  const requestId = `srvtest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const meta = {
    requestId,
    method: 'POST',
    provider,
    mode: 'test',
    modelId,
  };
  try {
    if (provider === 'nvidia-nim') {
      const endpoint = `${(baseUrl || config.nimBaseUrl || 'https://integrate.api.nvidia.com').replace(/\/+$/, '')}/v1/chat/completions`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Reply with OK only.' }],
          max_tokens: 8,
          stream: false,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text().catch(() => '');
      return summarizeTest(res, text, modelId, started, {
        ...meta, endpoint, host: 'integrate.api.nvidia.com',
      });
    }
    if (provider === 'cloudflare-workers-ai') {
      if (!accountId) return { ok: false, category: 'not_configured', modelId, detail: 'Cloudflare Account ID is required.', ms: Date.now() - started, ...meta, endpoint: '', host: 'api.cloudflare.com' };
      const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${modelId}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Reply with OK only.' }], stream: false }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text().catch(() => '');
      return summarizeTest(res, text, modelId, started, {
        ...meta,
        endpoint: `https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/${modelId}`,
        host: 'api.cloudflare.com',
      });
    }
    if (provider === 'groq') {
      const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Reply with OK only.' }],
          max_tokens: 8,
          stream: false,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text().catch(() => '');
      return summarizeTest(res, text, modelId, started, {
        ...meta, endpoint, host: 'api.groq.com',
      });
    }
    if (provider === 'openrouter' || provider === 'blockrun' || provider === 'modal') {
      const endpoint = provider === 'openrouter'
        ? 'https://openrouter.ai/api/v1/chat/completions'
        : provider === 'blockrun'
          ? 'https://api.blockrun.ai/v1/chat/completions'
          : chatCompletionsUrl(baseUrl);
      const host = provider === 'openrouter' ? 'openrouter.ai'
        : provider === 'blockrun' ? 'api.blockrun.ai'
          : (() => { try { return new URL(endpoint).hostname; } catch { return ''; } })();
      if (!endpoint) {
        return { ok: false, category: 'not_configured', modelId, detail: 'The deployment endpoint URL is missing.', ms: Date.now() - started, ...meta, endpoint: '', host: '' };
      }
      if (!isAllowedOutboundHost(endpoint)) {
        return { ok: false, category: 'bad_request', modelId, detail: 'The endpoint host is not allowlisted.', ms: Date.now() - started, ...meta, endpoint: '', host: '' };
      }
      const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
      if (provider === 'openrouter') headers['x-title'] = 'IntentLens';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Reply with OK only.' }],
          max_tokens: 8,
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text().catch(() => '');
      return summarizeTest(res, text, modelId, started, {
        ...meta, endpoint, host,
      });
    }
    return { ok: false, category: 'not_configured', modelId, detail: 'Unknown provider.', ms: Date.now() - started, ...meta, endpoint: '', host: '' };
  } catch (err) {
    const category = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network';
    return { ok: false, category, modelId, detail: scrub(String(err?.message || err)), ms: Date.now() - started, ...meta, endpoint: '', host: '' };
  }
}

function summarizeTest(res, text, modelId, started, meta = {}) {
  const ms = Date.now() - started;
  if (res.ok) return { ok: true, category: 'ok', modelId, detail: 'Credentials accepted; the Meta model answered.', ms, httpStatus: res.status, ...meta };
  const category = res.status === 401 || res.status === 403 ? 'auth'
    : res.status === 429 ? 'rate_limit'
      : res.status === 402 ? 'quota'
        : res.status === 404 ? 'model_unavailable'
          : res.status >= 500 ? 'provider_outage'
            : res.status === 400 ? 'bad_request'
              : 'upstream_error';
  return {
    ok: false,
    category,
    modelId,
    httpStatus: res.status,
    detail: scrub(text).slice(0, 240),
    ms,
    ...meta,
  };
}

function scrub(text) {
  return String(text || '')
    .replace(/nvapi-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/gsk_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/sk-(?:or-v1-)?[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/"(api[_-]?key|token|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/\s+/g, ' ')
    .trim();
}

function defaultVisionModel(provider) {
  if (provider === 'nvidia-nim') return 'meta/muse-glimmer-30b';
  if (provider === 'cloudflare-workers-ai') return '@cf/meta/llama-3.2-11b-vision-instruct';
  if (provider === 'openrouter') return 'meta-llama/llama-4-maverick';
  if (provider === 'blockrun') return 'meta-llama/llama-4-maverick';
  if (provider === 'modal') return 'meta-llama/Llama-4-Maverick-17B-128E-Instruct';
  // Groq has no Meta vision model on this account. Never invent one.
  if (provider === 'groq') return null;
  return null;
}

function applyEnv(credentials) {
  for (const [key, value] of Object.entries(credentials || {})) {
    if (SECRET_ENV_KEYS.includes(key) && value !== undefined && value !== null) process.env[key] = String(value);
  }
}

/** Called by server/index.js before the HTTP listener starts. */
export async function loadCloudProviderEnv() {
  const { credentials } = await loadCredentials();
  applyEnv(credentials);
  await applyCredentialsToConfig(config);

  // The old app shipped Llama 3.2 11B as the NIM default. On this account that
  // endpoint returns 404 and Maverick is EOL, so a saved old default would make
  // every test fail with no explanation. Migrate only those two historic
  // defaults; anything the user picked from the current list is left alone.
  const legacyDefaults = new Set([
    'meta/llama-3.2-11b-vision-instruct',
    'meta/llama-4-maverick-17b-128e-instruct',
  ]);
  if (legacyDefaults.has(config.nimModelId)) {
    config.nimModelId = 'meta/muse-glimmer-30b';
    process.env.NIM_MODEL_ID = config.nimModelId;
    try {
      await saveCredentials({ ...credentials, NIM_MODEL_ID: config.nimModelId });
    } catch { /* keep the runtime value even if persistence fails */ }
    recordServerLog({
      level: 'info',
      category: 'provider',
      message: 'Migrated the saved NVIDIA NIM default to meta/muse-glimmer-30b (the previous default is unavailable on this account).',
    });
  }

  return getCredentialSource();
}
