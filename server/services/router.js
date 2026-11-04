// server/services/router.js — Meta-model provider failover in user priority order.
//
// Default: OpenRouter → NVIDIA NIM → Cloudflare Workers AI → BlockRun → Modal → Groq.
// Only providers with a configured, vision-capable Meta model are eligible.
// Groq is only eligible when the account exposes a Meta vision model; the
// supplied restricted account does not, so it is skipped.

import { ProviderRouter } from './provider.js';
import { buildCloudflareProvider } from './cloudflareProvider.js';
import { buildNimProvider } from './nimProvider.js';
import { buildGroqProvider } from './groqProvider.js';
import { buildOpenAICompatibleProvider, chatCompletionsUrl } from './openaiCompatibleProvider.js';
import { isAllowedOutboundHost, providerConfigured } from '../config.js';

export function buildRouter(config) {
  const router = new ProviderRouter();
  const order = (config.providerPriority || ['openrouter', 'nvidia-nim', 'cloudflare-workers-ai', 'blockrun', 'modal', 'groq'])
    .filter((id) => providerConfigured(id));

  for (const id of order) {
    try {
      if (id === 'openrouter') {
        router.use(buildOpenAICompatibleProvider({
          id,
          name: 'OpenRouter',
          endpoint: 'https://openrouter.ai/api/v1/chat/completions',
          host: 'openrouter.ai',
          apiKey: config.openrouterApiKey,
          modelId: config.openrouterModelId,
          timeoutMs: 120000,
        }));
      } else if (id === 'nvidia-nim') {
        router.use(buildNimProvider({
          baseUrl: config.nimBaseUrl,
          apiKey: config.nimApiKey,
          modelId: config.nimModelId,
          timeoutMs: 120000,
        }));
      } else if (id === 'cloudflare-workers-ai') {
        router.use(buildCloudflareProvider({
          accountId: config.cloudflareAccountId,
          apiToken: config.cloudflareApiToken,
          modelId: config.cloudflareModelId,
          timeoutMs: 120000,
        }));
      } else if (id === 'blockrun') {
        router.use(buildOpenAICompatibleProvider({
          id,
          name: 'BlockRun',
          endpoint: 'https://api.blockrun.ai/v1/chat/completions',
          host: 'api.blockrun.ai',
          apiKey: config.blockrunApiKey,
          modelId: config.blockrunModelId,
          timeoutMs: 120000,
        }));
      } else if (id === 'modal') {
        const endpoint = chatCompletionsUrl(config.modalBaseUrl);
        if (!endpoint || !isAllowedOutboundHost(endpoint)) throw new Error('Modal base URL is missing or not a *.modal.run endpoint');
        router.use(buildOpenAICompatibleProvider({
          id,
          name: 'Modal',
          endpoint,
          host: new URL(endpoint).hostname,
          apiKey: config.modalApiKey,
          modelId: config.modalModelId,
          timeoutMs: 180000,
        }));
      } else if (id === 'groq') {
        router.use(buildGroqProvider({
          apiKey: config.groqApiKey,
          modelId: config.groqVisionModel,
          timeoutMs: 60000,
        }));
      }
    } catch {
      // Misconfigured provider is skipped; provider setup shows the reason.
    }
  }

  return router;
}
