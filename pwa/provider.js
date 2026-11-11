// pwa/provider.js — direct browser → provider calls for the PWA.
//
// This file no longer carries its own catalogue. Providers, models, tiers,
// prices and CORS facts come from the shared modelRegistry.js, copied into
// pwa/lib by scripts/prepare-pwa.mjs. That keeps the phone and the desktop
// server from drifting apart.
//
// A static GitHub Pages app cannot hide a key or proxy a request. Providers
// whose hosts do not send CORS headers stay visible with their endpoint and
// reason, and are refused before any network call.
//
// Nothing here invents a fallback: if the chosen provider or model cannot do
// what was asked, the request fails with an explicit message.

import {
  PROVIDERS as REGISTRY_PROVIDERS,
  PROVIDER_MODELS,
  DEFAULT_PRIORITY,
  TIER_RANK,
  ACCESS_TIERS,
  browserCanCallProvider,
  defaultModelFor as registryDefaultModel,
  getModel,
  getProvider,
  isOpenWeightModel,
  listProviderIds,
  modelAllowedAtTier as registryAllowedAtTier,
  modelModality as registryModality,
  modelTier as registryTier,
  modelsFor as registryModelsFor,
  normalizeProviderId,
  providerEndpoint,
  providerSupportsModel,
  providerSupportsVisionModel,
} from './lib/modelRegistry.js';
import { budgetSnapshot, preflightBudget } from './lib/costCore.js';

export { PROVIDER_MODELS, ACCESS_TIERS, DEFAULT_PRIORITY };

/** Browser-facing provider view. Endpoints are resolved per request. */
export const PROVIDERS = Object.fromEntries(
  Object.entries(REGISTRY_PROVIDERS).map(([id, provider]) => {
    const blocked = provider.browserCors === 'blocked';
    return [id, {
      id,
      label: provider.label,
      description: provider.description,
      endpoint: provider.endpoint,
      host: provider.host,
      kind: provider.kind,
      defaultModel: registryDefaultModel(id, { tier: 'paid', visionOnly: false }) || '',
      visionDefaultModel: registryDefaultModel(id, { tier: 'paid', visionOnly: true }) || '',
      browserCors: provider.browserCors,
      freeTier: provider.freeTier,
      paidTier: provider.paidTier,
      requiresKey: provider.requiresKey !== false,
      requiresBaseUrl: provider.requiresBaseUrl === true,
      requiresAccountId: provider.requiresAccountId === true,
      local: provider.local === true,
      openWeight: provider.openWeight === true,
      docsUrl: provider.docsUrl || '',
      unavailableInBrowser: blocked,
      blockedMessage: blocked
        ? `${provider.label} cannot be called from this browser: ${provider.host} does not allow cross-origin requests. Use the desktop app, or point a custom HTTPS relay at it.`
        : '',
    }];
  }),
);

export const PROVIDER_ORDER = DEFAULT_PRIORITY.filter((id) => Boolean(PROVIDERS[id]));

/** Every fixed host the app may contact for inference. */
export const PROVIDER_HOSTS = Object.values(PROVIDERS).map((p) => p.host).filter(Boolean);

export function isBrowserCallable(providerId) {
  return browserCanCallProvider(providerId);
}

export function providerSupportsImages(providerId) {
  const id = normalizeProviderId(providerId);
  if (id === 'custom') return true; // the user's relay decides
  return providerSupportsVisionModel(id, registryDefaultModel(id, { tier: 'paid', visionOnly: true }));
}

/** Whether this exact known model accepts an image. Unknown custom ids: true. */
export function modelAcceptsImages(providerId, model) {
  const id = normalizeProviderId(providerId);
  const chosen = String(model || '').trim() || modelFor(id, model);
  if (!chosen) return false;
  const info = getModel(id, chosen);
  if (info) return info.vision === true;
  return id === 'custom';
}

export function modelFor(providerId, override, tier = 'paid') {
  const id = normalizeProviderId(providerId);
  const chosen = String(override || '').trim();
  if (chosen) return chosen;
  return registryDefaultModel(id, { tier, visionOnly: true })
    || registryDefaultModel(id, { tier, visionOnly: false })
    || '';
}

export function modelInfo(providerId, model) {
  const id = normalizeProviderId(providerId);
  return getModel(id, model || modelFor(id, model));
}

export function modelsFor(providerId, tier = 'paid', { visionOnly = false } = {}) {
  return registryModelsFor(providerId, { tier, visionOnly });
}

export function defaultModelFor(providerId, tier = 'paid', { visionOnly = true } = {}) {
  return registryDefaultModel(providerId, { tier, visionOnly }) || '';
}

export function modelTier(providerId, model) {
  return registryTier(providerId, model);
}

export function modelAllowedAtTier(providerId, model, tier = 'paid') {
  const id = normalizeProviderId(providerId);
  const info = getModel(id, String(model || '').trim());
  if (!info) return id === 'custom';
  return registryAllowedAtTier(id, info.id, tier);
}

/** Kept for older imports. There is no Meta-only rule anymore. */
export function isMetaModelId(model) {
  return Boolean(getModelForAnyProvider(model));
}

function getModelForAnyProvider(model) {
  const id = String(model || '').trim();
  if (!id) return null;
  for (const providerId of listProviderIds()) {
    const info = getModel(providerId, id);
    if (info) return { providerId, ...info };
  }
  return null;
}

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function endpointFor(providerId, { baseUrl = '', accountId = '', model = '' } = {}) {
  return providerEndpoint(providerId, { baseUrl, accountId, modelId: model });
}

function hostFor(provider, endpoint) {
  if (provider?.host) return provider.host;
  try { return new URL(endpoint).host; } catch { return ''; }
}

function friendlyHttpError(status, data, rawText) {
  const providerMessage = data?.error?.message || data?.message || '';
  const suffix = providerMessage ? ` Provider said: ${String(providerMessage).slice(0, 300)}` : '';
  if (status === 401) return `Key rejected (401). Check the key and that it belongs to this provider.${suffix}`;
  if (status === 402) return `Payment required (402). This provider key has no usable credit.${suffix}`;
  if (status === 403) return `Access denied (403). The key may not have this model enabled.${suffix}`;
  if (status === 404) return `Model not found (404). This account may not have access to the model.${suffix}`;
  if (status === 429) return `Rate limited (429). Wait a moment and retry.${suffix}`;
  if (status >= 500) return `Provider error (${status}). This is usually temporary.${suffix}`;
  const body = rawText ? ` Response: ${String(rawText).slice(0, 300)}` : '';
  return `Request failed (${status}).${suffix}${body}`;
}

function corsMessage(providerId) {
  const provider = PROVIDERS[normalizeProviderId(providerId)];
  if (!provider) return 'Network failure. Check the connection.';
  if (provider.browserCors === 'allowed') {
    return `Network failure. ${provider.label} allowed this origin before, so check the connection, a proxy, or a browser extension.`;
  }
  return `Network failure, or ${provider.label} refused this browser origin. Check the URL and the provider CORS policy.`;
}

/** Extract the first complete JSON object from model text (which may include prose). */
export function extractJson(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function makeRequestId() {
  return `pwa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * One provider request. `imageDataUrl` is optional: text chat never passes it,
 * so no image_url content part is ever built.
 *
 * `budget` and `ledger` are optional. When supplied, a hard preflight refuses
 * a request whose worst-case cost exceeds the remaining daily/monthly budget.
 * A successful request returns a `usageEntry` the caller can append to its
 * local ledger.
 */
export async function callModel({
  providerId = 'openrouter',
  apiKey,
  model,
  prompt,
  imageDataUrl = null,
  baseUrl = '',
  accountId = '',
  accessTier = 'paid',
  timeoutMs = 180000,
  expectJson = true,
  requestMode = '',
  budget = null,
  ledger = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const id = normalizeProviderId(providerId);
  const provider = PROVIDERS[id];
  if (!provider) return fail('UNKNOWN_PROVIDER', 'Choose a provider.');
  const requestedModel = modelFor(id, model, accessTier);
  const mode = requestMode || (imageDataUrl ? 'vision' : 'chat');
  const endpoint = endpointFor(id, { baseUrl, accountId, model: requestedModel });
  const meta = {
    providerId: id,
    providerLabel: provider.label,
    method: 'POST',
    endpoint,
    host: hostFor(provider, endpoint),
    model: requestedModel,
    modelTier: modelTier(id, requestedModel),
    mode,
    requestId: makeRequestId(),
    startedAt: new Date().toISOString(),
  };

  if (!endpoint) {
    return fail('NO_ENDPOINT', provider.requiresAccountId
      ? 'Add the Cloudflare Account ID in Settings.'
      : 'This provider needs a valid HTTPS base URL in Settings.', meta);
  }
  if (!requestedModel) {
    return fail('NO_MODEL', 'Choose or type a model id in Settings. No model is sent and no request is made.', meta);
  }
  if (id !== 'custom' && !providerSupportsModel(id, requestedModel)) {
    return fail(
      'MODEL_NOT_IN_CATALOG',
      `${requestedModel} is not in the ${provider.label} catalogue. Pick a listed model, or use a custom relay.`,
      meta,
    );
  }
  if (!modelAllowedAtTier(id, requestedModel, accessTier)) {
    return fail(
      'MODEL_ACCESS_LOCKED',
      `${requestedModel} is a ${modelTier(id, requestedModel)} model and ${accessTier} access is selected. Enable the matching access level in Settings only if you have that account.`,
      meta,
    );
  }
  if (registryModality(id, requestedModel) === 'classifier') {
    return fail('MODEL_NOT_CHAT', `${requestedModel} is a classifier and cannot answer questions or analyse images.`, meta);
  }

  const key = String(apiKey || '').trim();
  if (provider.requiresKey && !key) return fail('NO_KEY', 'Add a provider key in Settings first.', meta);

  if (provider.unavailableInBrowser) {
    return fail('PROVIDER_CORS_BLOCKED', provider.blockedMessage, {
      ...meta,
      imageAttached: Boolean(imageDataUrl),
    });
  }

  if (imageDataUrl && !modelAcceptsImages(id, requestedModel)) {
    return fail(
      'MODEL_TEXT_ONLY',
      `The selected model (${requestedModel}) is text-only or not a vision model. Choose a vision model.`,
      { ...meta, imageAttached: false },
    );
  }

  // Hard budget preflight. Never send a request that cannot fit.
  if (budget) {
    const check = preflightBudget({
      budget,
      entries: ledger || [],
      providerId: id,
      modelId: requestedModel,
      inputText: String(prompt || ''),
      image: imageDataUrl ? { width: 1024, height: 1024 } : null,
    });
    if (!check.ok) {
      return fail(check.code, check.message, {
        ...meta,
        estimateUsd: check.estimateUsd,
        estimatedInputTokens: check.estimatedInputTokens,
        budget: check.snapshot,
        imageAttached: Boolean(imageDataUrl),
      });
    }
    meta.estimateUsd = check.estimateUsd;
    meta.estimatedInputTokens = check.estimatedInputTokens;
  }

  const content = [{ type: 'text', text: String(prompt || '') }];
  if (imageDataUrl) content.push({ type: 'image_url', image_url: { url: imageDataUrl } });

  const info = modelInfo(id, requestedModel);
  const body = {
    model: requestedModel,
    messages: [{ role: 'user', content }],
    max_tokens: expectJson ? Math.min(8192, info?.maxOutput || 8192) : 3072,
    temperature: 0.2,
  };
  if (id === 'openrouter' && expectJson) body.response_format = { type: 'json_object' };

  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (id === 'openrouter') headers['X-Title'] = 'IntentLens';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rawText = await response.text();
    let data = null;
    try { data = JSON.parse(rawText); } catch { /* handled below */ }
    if (!response.ok) {
      return fail(`HTTP_${response.status}`, friendlyHttpError(response.status, data, rawText), {
        ...meta,
        httpStatus: response.status,
        status: response.status,
        latencyMs: Date.now() - started,
        returnedModel: data?.model || null,
        imageAttached: Boolean(imageDataUrl),
      });
    }
    const message = data?.choices?.[0]?.message || {};
    const text = message.content || message.reasoning_content || message.reasoning || '';
    if (!text) {
      return fail('EMPTY_RESPONSE', 'The provider returned no text. The model may need a different id or more tokens.', {
        ...meta,
        httpStatus: response.status,
        status: response.status,
        latencyMs: Date.now() - started,
        returnedModel: data?.model || requestedModel,
        finishReason: data?.choices?.[0]?.finish_reason || null,
        usage: data?.usage || null,
        imageAttached: Boolean(imageDataUrl),
      });
    }
    return {
      ok: true,
      json: expectJson ? extractJson(text) : null,
      text,
      latencyMs: Date.now() - started,
      requestedModel,
      returnedModel: data?.model || requestedModel,
      providerId: id,
      ...meta,
      httpStatus: response.status,
      status: response.status,
      finishReason: data?.choices?.[0]?.finish_reason || null,
      usage: data?.usage || null,
      imageAttached: Boolean(imageDataUrl),
      usageEntry: usageEntryFrom({ providerId: id, modelId: requestedModel, usage: data?.usage, meta, imageAttached: Boolean(imageDataUrl) }),
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return fail('TIMEOUT', `The request timed out after ${Math.round(timeoutMs / 1000)} s. Retry only if you accept a possible duplicate request.`, {
        ...meta,
        latencyMs: Date.now() - started,
        imageAttached: Boolean(imageDataUrl),
      });
    }
    return fail('NETWORK', corsMessage(id), {
      ...meta,
      detail: String(error?.message || error),
      latencyMs: Date.now() - started,
      imageAttached: Boolean(imageDataUrl),
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Local cost bookkeeping. Prices come from the shared registry. */
function usageEntryFrom({ providerId, modelId, usage, meta, imageAttached }) {
  const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? meta?.estimatedInputTokens ?? 0) || 0;
  const outputTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;
  const info = getModel(providerId, modelId);
  const imageTokens = imageAttached ? 85 + 170 : 0;
  const costUsd = ((inputTokens + imageTokens) / 1e6) * (info?.inputPerM ?? 1)
    + (outputTokens / 1e6) * (info?.outputPerM ?? 3);
  return {
    at: Date.now(),
    providerId,
    modelId,
    inputTokens: inputTokens + imageTokens,
    outputTokens,
    imageTokens,
    costUsd: Number(costUsd.toFixed(8)),
    source: usage ? 'provider-usage' : 'estimate',
  };
}

/** A cheap key/model check. Sends text only — never a photo. */
export async function testProvider({ providerId, apiKey, model, baseUrl, accountId = '', accessTier = 'paid', fetchImpl } = {}) {
  return callModel({
    providerId,
    apiKey,
    model,
    baseUrl,
    accountId,
    accessTier,
    fetchImpl,
    requestMode: 'test',
    prompt: 'Reply with exactly one JSON object: {"ok":true}',
    timeoutMs: 30000,
  });
}

/** Text-only chat. Kept separate so it is impossible to attach an image by accident. */
export async function callChatModel(options) {
  return callModel({ ...options, imageDataUrl: null, expectJson: false, requestMode: 'chat' });
}

/** Read-only budget view for the PWA settings panel. */
export function localBudgetStatus(budget, ledger) {
  return budgetSnapshot({ budget, entries: ledger || [] });
}

export { isOpenWeightModel, TIER_RANK };
