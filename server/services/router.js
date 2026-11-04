// server/services/router.js — Meta-only provider failover in user priority order.
//
// Default: NVIDIA NIM → Cloudflare Workers AI → Groq.
// Only providers with a configured, *verified* vision Meta model are eligible.
// The supplied Groq account has only Prompt Guard classifiers, so it is skipped.

import { ProviderRouter } from './provider.js';
import { buildCloudflareProvider } from './cloudflareProvider.js';
import { buildNimProvider } from './nimProvider.js';
import { buildGroqProvider } from './groqProvider.js';
import { providerConfigured } from '../config.js';

export function buildRouter(config) {
  const router = new ProviderRouter();
  const order = (config.providerPriority || ['nvidia-nim', 'cloudflare-workers-ai', 'groq'])
    .filter((id) => providerConfigured(id));

  for (const id of order) {
    try {
      if (id === 'nvidia-nim') {
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
