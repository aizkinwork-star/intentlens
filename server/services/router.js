// server/services/router.js — multi-provider failover in user priority order.
//
// Every configured provider is built from modelRegistry.js. The router performs
// a hard cost preflight before each attempt and records real token usage after
// a success. Auth, quota, rate-limit and outage errors move to the next
// provider; schema/input errors do not.

import { ProviderRouter } from './provider.js';
import { buildCloudflareProvider } from './cloudflareProvider.js';
import { buildOpenAICompatibleProvider, chatCompletionsUrl } from './openaiCompatibleProvider.js';
import { buildAnthropicProvider } from './anthropicProvider.js';
import { config, providerRuntime, providerConfigured } from '../config.js';
import { costManager } from './costManager.js';

function timeoutFor(providerId, model) {
  if (providerId === 'ollama') return 300000;
  if (model?.reasoning) return 180000;
  if (model?.vision) return 120000;
  return 60000;
}

function maxTokensFor(model, { fast = false } = {}) {
  const cap = fast ? 1024 : 8192;
  return Math.min(cap, Math.max(256, Number(model?.maxOutput) || 3072));
}

function buildOne(id) {
  const runtime = providerRuntime(id);
  if (!runtime) return null;
  const { modelId, model, endpoint, apiKey, accountId, baseUrl } = runtime;

  if (runtime.kind === 'cloudflare') {
    return buildCloudflareProvider({
      accountId,
      apiToken: apiKey,
      modelId,
      timeoutMs: timeoutFor(id, model),
    });
  }
  if (runtime.kind === 'anthropic') {
    return buildAnthropicProvider({
      apiKey,
      modelId,
      baseUrl,
      timeoutMs: timeoutFor(id, model),
      maxTokens: maxTokensFor(model, { fast: config.answerDeadlineMs > 0 && config.answerDeadlineMs <= 12_000 }),
    });
  }
  if (!endpoint) throw new Error(`${runtime.label} has no endpoint`);
  return buildOpenAICompatibleProvider({
    id,
    name: runtime.label,
    endpoint,
    host: (() => { try { return new URL(endpoint).hostname; } catch { return ''; } })(),
    apiKey,
    modelId,
    timeoutMs: timeoutFor(id, model),
    maxTokens: maxTokensFor(model, { fast: config.answerDeadlineMs > 0 && config.answerDeadlineMs <= 12_000 }),
    allowUnknownModel: id === 'custom',
  });
}

export function buildRouter(cfg = config) {
  const router = new ProviderRouter();
  const order = (cfg.providerPriority || [])
    .map((id) => String(id || '').trim())
    .filter((id, i, all) => id && all.indexOf(id) === i)
    .filter((id) => providerConfigured(id));

  for (const id of order) {
    try {
      const provider = buildOne(id);
      if (provider) router.use(provider);
    } catch {
      // Misconfigured provider is skipped; provider setup shows the reason.
    }
  }

  router.costManager = costManager;
  return router;
}
