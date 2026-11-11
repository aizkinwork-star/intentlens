// server/routes/providers.js — multi-provider setup, health, credentials and budget.
//
// Public responses never contain key material. Secrets are persisted by
// credentialStore.js (Electron safeStorage / Windows DPAPI) and only applied to
// process.env inside the server process.

import { readJson, json, recordServerLog } from '../lib/http.js';
import {
  config,
  isAllowedInferenceUrl,
  isPlaceholderCredential,
  modelAllowedAtTier,
  modelModality,
  modelTier,
  normalizeTier,
  providerConfigured,
  providerModelList,
  providerRuntime,
  effectiveModelId,
  getModel,
  getProvider,
  listProviderIds,
  normalizeProviderId,
} from '../config.js';
import { PROVIDERS, PROVIDER_MODELS, providerLabel } from '../../modelRegistry.js';
import {
  loadCredentials,
  saveCredentials,
  applyCredentialsToConfig,
  getCredentialSource,
  SECRET_ENV_KEYS,
} from '../lib/credentialStore.js';
import { resetProviderHealth } from '../services/provider.js';
import { costManager, costStatusForClient, budgetConfigForClient } from '../services/costManager.js';
import { buildOpenAICompatibleProvider } from '../services/openaiCompatibleProvider.js';
import { buildCloudflareProvider } from '../services/cloudflareProvider.js';
import { buildAnthropicProvider } from '../services/anthropicProvider.js';

const VALID_PROVIDER_IDS = new Set(listProviderIds());

function providerRecord(providerId) {
  return getProvider(providerId);
}

function publicModelList(providerId, tier) {
  return providerModelList(providerId, { tier, visionOnly: false }).map((model) => ({
    ...model,
    selected: selectedModel(providerId) === model.id,
  }));
}

function selectedModel(providerId) {
  const runtime = providerRuntime(providerId);
  return runtime?.modelId || '';
}

function providerKey(providerId) {
  return providerRuntime(providerId)?.apiKey || '';
}

function providerStatus(providerId) {
  const provider = providerRecord(providerId);
  if (!provider) return null;
  const runtime = providerRuntime(providerId);
  const key = providerKey(providerId);
  const modelId = runtime?.modelId || '';
  const info = getModel(providerId, modelId);
  return {
    id: providerId,
    label: provider.label,
    description: provider.description,
    kind: provider.kind,
    docsUrl: provider.docsUrl,
    configured: providerConfigured(providerId),
    hasKey: Boolean(key),
    placeholderKey: provider.requiresKey ? isPlaceholderCredential(key) : false,
    requiresKey: provider.requiresKey,
    requiresAccountId: provider.requiresAccountId === true,
    requiresBaseUrl: provider.requiresBaseUrl === true,
    browserCors: provider.browserCors,
    freeTier: provider.freeTier,
    paidTier: provider.paidTier,
    modelId: modelId || null,
    modelName: info?.name || null,
    modality: info?.modality || null,
    modelVerified: info?.verified === true,
    openWeight: info?.openWeight === true,
    pricing: info ? { inputPerM: info.inputPerM, outputPerM: info.outputPerM, contextWindow: info.contextWindow, maxOutput: info.maxOutput } : null,
    models: publicModelList(providerId, config.accessTier),
    eligibleForVision: Boolean(modelId && info?.vision === true && modelAllowedAtTier(providerId, modelId, config.accessTier)),
    baseUrl: runtime?.baseUrl || '',
    accountIdSet: Boolean(runtime?.accountId),
    note: provider.description,
  };
}

function providerSummary() {
  return {
    providers: listProviderIds().map(providerStatus).filter(Boolean),
    configured: listProviderIds().filter((id) => providerConfigured(id)),
    priority: config.providerPriority.filter((id) => VALID_PROVIDER_IDS.has(id)),
    accessTier: config.accessTier,
    accessTiers: ['free', 'preview', 'paid'],
    catalog: PROVIDER_MODELS,
    runtime: 'multi-provider',
    allowOutboundNetwork: config.allowOutboundNetwork,
    credentialStore: getCredentialSource(),
    localLlm: providerConfigured('ollama'),
    localPerception: true,
    localPerceptionNote: 'KNN reference classifier runs locally. It is not a large language model unless you configure Ollama.',
    budget: costStatusForClient(),
    budgetConfig: budgetConfigForClient(),
  };
}

export async function handleGetCloudProviders(req, res) {
  json(res, 200, providerSummary());
}

function envKeysFor(providerId) {
  const provider = providerRecord(providerId);
  if (!provider) return [];
  return [provider.envKey, provider.modelEnvKey, ...(provider.extraEnvKeys || [])].filter(Boolean);
}

function setEnv(entries) {
  for (const [key, value] of Object.entries(entries)) {
    if (!key) continue;
    if (value === undefined || value === null || value === '') delete process.env[key];
    else process.env[key] = String(value);
  }
}

export async function handleSaveCloudProvider(req, res) {
  const body = await readJson(req, 96_000);
  let provider = normalizeProviderId(body?.provider || body?.providerId || '');
  const apiKey = String(body?.apiKey || '').trim();
  const accountId = String(body?.accountId || '').trim();
  const baseUrl = String(body?.baseUrl || '').trim();
  const modelId = String(body?.modelId || '').trim();
  const tierInput = String(body?.accessTier || '').toLowerCase();
  const keepKey = body?.keepKey === true;
  const requestedTier = tierInput ? normalizeTier(tierInput) : null;

  // Priority-only update.
  if (!provider && Array.isArray(body?.priority)) {
    const priority = body.priority.map(normalizeProviderId).filter((id) => VALID_PROVIDER_IDS.has(id));
    if (!priority.length) {
      json(res, 400, { error: { code: 'BAD_JSON', message: 'priority must contain at least one known provider.', retryable: false } });
      return;
    }
    process.env.PROVIDER_PRIORITY = priority.join(',');
    const stored = (await loadCredentials()).credentials;
    stored.PROVIDER_PRIORITY = priority.join(',');
    try { await saveCredentials(stored); } catch (err) {
      json(res, 503, { error: { code: 'SECURE_STORAGE_FAILED', message: err.message, retryable: false } });
      return;
    }
    await applyCredentialsToConfig(config);
    json(res, 200, { ok: true, ...providerSummary() });
    return;
  }

  // Budget-only update.
  if (!provider && body?.budget && typeof body.budget === 'object') {
    const budget = costManager.setBudget(body.budget);
    recordServerLog({ level: 'info', category: 'provider', message: 'Cost budget updated.' });
    json(res, 200, { ok: true, budget, ...providerSummary() });
    return;
  }

  // Tier-only update.
  if (!provider && requestedTier) {
    process.env.MODEL_ACCESS_TIER = requestedTier;
    const stored = (await loadCredentials()).credentials;
    stored.MODEL_ACCESS_TIER = requestedTier;
    try { await saveCredentials(stored); } catch (err) {
      json(res, 503, { error: { code: 'SECURE_STORAGE_FAILED', message: err.message, retryable: false } });
      return;
    }
    await applyCredentialsToConfig(config);
    json(res, 200, { ok: true, ...providerSummary() });
    return;
  }

  if (!VALID_PROVIDER_IDS.has(provider)) {
    json(res, 400, { error: { code: 'BAD_JSON', message: `Unknown provider ${provider || '(missing)'}.`, retryable: false } });
    return;
  }

  const record = providerRecord(provider);
  const existing = providerRuntime(provider);
  const resolvedKey = apiKey || (keepKey ? existing?.apiKey || '' : '');
  if (record.requiresKey && !resolvedKey) {
    json(res, 400, { error: { code: 'BAD_JSON', message: 'apiKey is required. Use Remove to delete a saved key.', retryable: false } });
    return;
  }
  if (resolvedKey && isPlaceholderCredential(resolvedKey)) {
    json(res, 400, { error: { code: 'BAD_JSON', message: 'That looks like a placeholder key. Paste a real provider key.', retryable: false } });
    return;
  }
  if (record.requiresAccountId && !accountId && !existing?.accountId) {
    json(res, 400, { error: { code: 'BAD_JSON', message: `${record.label} needs the Cloudflare Account ID.`, retryable: false } });
    return;
  }
  if (record.requiresBaseUrl && !baseUrl && !existing?.baseUrl) {
    json(res, 400, { error: { code: 'BAD_JSON', message: `${record.label} needs an HTTPS base URL.`, retryable: false } });
    return;
  }
  if (baseUrl && !isAllowedInferenceUrl(baseUrl)) {
    json(res, 400, { error: { code: 'BAD_JSON', message: 'baseUrl must be HTTPS (plain HTTP only for localhost/Ollama) and must not target a private LAN address.', retryable: false } });
    return;
  }

  const accessTier = requestedTier || config.accessTier;
  const resolvedModel = modelId || selectedModel(provider) || effectiveModelId(provider);
  if (resolvedModel && provider !== 'custom') {
    const info = getModel(provider, resolvedModel);
    if (!info) {
      json(res, 400, { error: { code: 'MODEL_NOT_IN_CATALOG', message: `${resolvedModel} is not in the ${record.label} catalogue.`, retryable: false } });
      return;
    }
    if (!modelAllowedAtTier(provider, resolvedModel, accessTier)) {
      json(res, 400, {
        error: {
          code: 'MODEL_ACCESS_LOCKED',
          message: `${resolvedModel} is a ${modelTier(provider, resolvedModel)} model and ${accessTier} access is selected. Enable paid/preview access only if you have that account.`,
          retryable: false,
        },
      });
      return;
    }
    if (modelModality(provider, resolvedModel) === 'classifier') {
      json(res, 400, { error: { code: 'MODEL_NOT_CHAT', message: `${resolvedModel} is a classifier and cannot answer questions or analyse images.`, retryable: false } });
      return;
    }
    if (info.vision !== true) {
      recordServerLog({ level: 'warn', category: 'provider', message: `${provider} model ${resolvedModel} is text-only; it is not eligible for vision analysis.` });
    }
  }

  const stored = (await loadCredentials()).credentials;
  const next = { ...stored };
  if (requestedTier) next.MODEL_ACCESS_TIER = requestedTier;

  // Save the provider-specific key/model and optional extras.
  if (record.envKey && (resolvedKey || keepKey)) next[record.envKey] = resolvedKey;
  if (record.modelEnvKey) next[record.modelEnvKey] = resolvedModel;
  if (provider === 'cloudflare-workers-ai') {
    if (accountId) next.CLOUDFLARE_ACCOUNT_ID = accountId;
  } else if (provider === 'nvidia-nim') {
    next.NIM_ENABLED = 'true';
    if (baseUrl) next.NIM_BASE_URL = baseUrl;
  } else if (provider === 'ollama') {
    next.OLLAMA_ENABLED = 'true';
    if (baseUrl) next.OLLAMA_BASE_URL = baseUrl;
  } else if (provider === 'custom') {
    if (baseUrl) next.CUSTOM_BASE_URL = baseUrl;
    if (!resolvedModel) {
      json(res, 400, { error: { code: 'BAD_JSON', message: 'A custom relay needs the exact model id it serves.', retryable: false } });
      return;
    }
  } else if (provider === 'anthropic' && baseUrl) {
    next.ANTHROPIC_BASE_URL = baseUrl;
  }

  try {
    await saveCredentials(next);
    setEnv(next);
  } catch (err) {
    json(res, 503, { error: { code: 'SECURE_STORAGE_FAILED', message: err.message, retryable: false } });
    return;
  }

  await applyCredentialsToConfig(config);
  if (body?.budget && typeof body.budget === 'object') costManager.setBudget(body.budget);
  resetProviderHealth(provider);
  recordServerLog({ level: 'ok', category: 'provider', message: `${provider} credentials saved securely (${getCredentialSource()}).` });
  json(res, 200, { ok: true, provider, ...providerSummary() });
}

export async function handleDeleteCloudProvider(req, res, providerFromPath = null) {
  const provider = normalizeProviderId(providerFromPath || (await readJson(req, 16_000))?.provider);
  const record = providerRecord(provider);
  if (!record) {
    json(res, 400, { error: { code: 'BAD_JSON', message: `Unknown provider ${provider || '(missing)'}.`, retryable: false } });
    return;
  }

  const stored = { ...(await loadCredentials()).credentials };
  for (const key of envKeysFor(provider)) delete stored[key];
  if (provider === 'nvidia-nim') delete stored.NIM_ENABLED;
  if (provider === 'ollama') delete stored.OLLAMA_ENABLED;

  try { await saveCredentials(stored); } catch (err) {
    json(res, 503, { error: { code: 'SECURE_STORAGE_FAILED', message: err.message, retryable: false } });
    return;
  }
  for (const key of envKeysFor(provider)) delete process.env[key];
  setEnv(stored);
  await applyCredentialsToConfig(config);
  resetProviderHealth(provider);
  recordServerLog({ level: 'info', category: 'provider', message: `${provider} credentials removed.` });
  json(res, 200, { ok: true, provider, ...providerSummary() });
}

/** Explicit, session-only opt-in for cloud requests when the app shipped with
 * outbound disabled. Requires { allow: true, confirm: true }. */
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
  let provider = normalizeProviderId(url.searchParams.get('provider'));
  let body = {};
  if (req.method === 'POST') {
    try { body = await readJson(req, 64_000); } catch { body = {}; }
    provider = normalizeProviderId(body.provider || body.providerId || provider);
  }
  if (!provider) {
    provider = config.providerPriority.find((id) => providerConfigured(id)) || config.providerPriority[0];
  }
  const record = providerRecord(provider);
  if (!record) {
    json(res, 400, { ok: false, category: 'not_configured', detail: `Unknown provider ${provider || '(missing)'}.` });
    return;
  }

  const stored = (await loadCredentials()).credentials;
  const runtime = providerRuntime(provider) || {};
  const apiKey = String(body.apiKey || runtime.apiKey || stored[record.envKey] || process.env[record.envKey] || '').trim();
  const modelId = String(body.modelId || runtime.modelId || effectiveModelId(provider) || '').trim();
  const accountId = String(body.accountId || runtime.accountId || stored.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const baseUrl = String(body.baseUrl || runtime.baseUrl || '').trim();
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
  if (record.requiresKey && !apiKey) {
    json(res, 200, { ok: false, provider, category: 'not_configured', modelId: modelId || null, detail: 'No API key saved for this provider.' });
    return;
  }
  if (apiKey && isPlaceholderCredential(apiKey)) {
    json(res, 200, { ok: false, provider, category: 'not_configured', modelId: modelId || null, detail: 'The configured key is a placeholder. Replace it in provider setup.' });
    return;
  }
  if (record.requiresAccountId && !accountId) {
    json(res, 200, { ok: false, provider, category: 'not_configured', modelId: modelId || null, detail: 'The Cloudflare Account ID is missing.' });
    return;
  }
  if (provider !== 'custom' && modelId && !getModel(provider, modelId)) {
    json(res, 200, { ok: false, provider, category: 'model_unavailable', modelId, detail: `${modelId} is not in the ${record.label} catalogue.` });
    return;
  }
  if (provider !== 'custom' && modelId && !modelAllowedAtTier(provider, modelId, accessTier)) {
    json(res, 200, {
      ok: false,
      provider,
      category: 'model_access_locked',
      modelId,
      detail: `${modelId} is a ${modelTier(provider, modelId)} model and ${accessTier} access is selected.`,
    });
    return;
  }
  if (provider !== 'custom' && modelId && modelModality(provider, modelId) === 'classifier') {
    json(res, 200, { ok: false, provider, category: 'not_chat', modelId, detail: 'This model is a classifier and cannot answer questions or analyse images.' });
    return;
  }

  const effectiveModel = modelId || effectiveModelId(provider);
  if (!effectiveModel) {
    json(res, 200, { ok: false, provider, category: 'no_model', modelId: null, detail: `${record.label} has no selected model. Choose one in Settings.` });
    return;
  }
  if (baseUrl && !isAllowedInferenceUrl(baseUrl)) {
    json(res, 200, { ok: false, provider, category: 'bad_request', modelId: effectiveModel, detail: 'baseUrl must be HTTPS (plain HTTP only for localhost) and not a private LAN address.' });
    return;
  }

  const result = await testProvider({ provider, apiKey, accountId, modelId: effectiveModel, baseUrl });
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
  const meta = { requestId, method: 'POST', provider, mode: 'test', modelId };
  try {
    const adapter = buildTestAdapter({ provider, apiKey, accountId, modelId, baseUrl });
    const result = await adapter.healthCheck();
    const endpoint = adapter.endpoint || '';
    const host = adapter.host || '';
    return {
      ok: result.ok === true,
      category: result.ok ? 'ok' : categoryFor(result),
      modelId,
      detail: result.detail || (result.ok ? 'Credentials accepted; the model answered.' : 'Provider rejected the test.'),
      httpStatus: result.status,
      ms: Date.now() - started,
      ...meta,
      endpoint,
      host,
    };
  } catch (err) {
    return {
      ok: false,
      category: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network',
      modelId,
      detail: scrub(String(err?.message || err)),
      ms: Date.now() - started,
      ...meta,
      endpoint: '',
      host: '',
    };
  }
}

function categoryFor(result) {
  const status = Number(result?.status);
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'quota';
  if (status === 404) return 'model_unavailable';
  if (status >= 500) return 'provider_outage';
  if (status === 400) return 'bad_request';
  return 'upstream_error';
}

function buildTestAdapter({ provider, apiKey, accountId, modelId, baseUrl }) {
  const record = providerRecord(provider);
  if (record.kind === 'cloudflare') {
    const adapter = buildCloudflareProvider({ accountId, apiToken: apiKey, modelId, timeoutMs: 20000 });
    adapter.endpoint = 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/' + modelId;
    adapter.host = 'api.cloudflare.com';
    return adapter;
  }
  if (record.kind === 'anthropic') {
    const adapter = buildAnthropicProvider({ apiKey, modelId, baseUrl, timeoutMs: 30000 });
    adapter.endpoint = 'https://api.anthropic.com/v1/messages';
    adapter.host = 'api.anthropic.com';
    return adapter;
  }
  const endpoint = provider === 'cloudflare-workers-ai'
    ? ''
    : (() => {
      const runtime = providerRuntime(provider);
      return runtime?.endpoint || '';
    })();
  if (!endpoint) throw new Error(`${record.label} has no endpoint. Add a base URL.`);
  const adapter = buildOpenAICompatibleProvider({
    id: provider,
    name: record.label,
    endpoint,
    host: (() => { try { return new URL(endpoint).hostname; } catch { return ''; } })(),
    apiKey,
    modelId,
    timeoutMs: 30000,
    allowUnknownModel: provider === 'custom',
  });
  adapter.endpoint = endpoint;
  adapter.host = adapter.host || '';
  return adapter;
}

function scrub(text) {
  return String(text || '')
    .replace(/nvapi-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/gsk_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/hf_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/"(api[_-]?key|token|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/\s+/g, ' ')
    .trim();
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

  // Migrate only the old Meta-only defaults that no longer exist. Anything the
  // user explicitly picked from the new catalogue is left alone.
  if (config.nimModelId === 'meta/llama-4-maverick-17b-128e-instruct') {
    config.nimModelId = 'meta/muse-glimmer-30b';
    process.env.NIM_MODEL_ID = config.nimModelId;
    try { await saveCredentials({ ...credentials, NIM_MODEL_ID: config.nimModelId }); } catch { /* runtime value still wins */ }
  }
  return getCredentialSource();
}

// ---------------------------------------------------------------- budget API

export async function handleGetBudget(req, res) {
  json(res, 200, { ...costStatusForClient(), config: budgetConfigForClient() });
}

export async function handleSetBudget(req, res) {
  const body = await readJson(req, 16_000);
  if (body?.reset === true) {
    costManager.reset({ entriesOnly: body?.entriesOnly === true });
  } else {
    costManager.setBudget(body?.budget && typeof body.budget === 'object' ? body.budget : body);
  }
  recordServerLog({ level: 'info', category: 'provider', message: 'Cost budget updated.' });
  json(res, 200, { ok: true, ...costStatusForClient(), config: budgetConfigForClient() });
}

export { providerSummary };
