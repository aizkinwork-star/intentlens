// server/services/searchAdapter.js — v7 Local Source Vault.
//
// v7 non-negotiable: No live web search at runtime. The user imports official
// manuals/datasheets/BOMs into the local evidence vault. Store canonical URL,
// revision, page and excerpt; never upload task context to that URL.
//
// This adapter searches the local SQLite/FTS5 source vault using BM25 ranking.
// Exact part_number matches rank highest.
//
// Usage:
//   const router = buildSearchProviders(config);
//   const results = await router.search('battery connector part number');

import { appError } from '../lib/errors.js';

/**
 * @typedef {Object} SearchProvider
 * @property {string} id
 * @property {string} name
 * @property {function(string, object): Promise<Array<{id, title, url, claim, kind}>>} search
 */

/**
 * Sequential search router — tries providers one at a time.
 * Only local vault providers are added; no external search APIs.
 */
export class SearchRouter {
  constructor(providers = []) {
    this.providers = providers;
  }

  use(provider) { this.providers.push(provider); return this; }

  async search(query) {
    const results = [];
    for (const provider of this.providers) {
      try {
        const providerResults = await provider.search(query);
        if (Array.isArray(providerResults) && providerResults.length) {
          results.push(...providerResults);
        }
      } catch {
        // Skip failed providers, try next
      }
    }
    return results;
  }
}

/**
 * Build local vault search provider from config.
 * Only providers with keys are added.
 */
export function buildSearchProviders(config) {
  const router = new SearchRouter();

  // Only local vault source search is available; no external search APIs
  router.use({
    id: 'local-vault',
    name: 'Local Source Vault (FTS5)',
    async search(query) {
      // This will be wired to the store in analyze.js
      return [];
    },
  });

  return router;
}

export function buildLocalVaultSearchProvider(store, projectId = null) {
  return {
    id: 'local-vault',
    name: 'Local Source Vault (FTS5)',
    capabilities: { imageInput: false, structuredOutput: true, webGrounding: false },
    async search(query) {
      if (!store || !store.searchSources) return [];
      return store.searchSources(projectId, query, 10);
    },
  };
}

// Rank results: exact part_number matches first, then FTS BM25 score
export function rankResults(results, query) {
  const q = query.toLowerCase();
  return results
    .map((r) => {
      const titleLower = (r.title || '').toLowerCase();
      const claimLower = (r.claim || '').toLowerCase();
      let score = 0;
      q.split(/\s+/).forEach((token) => {
        if (token.length > 2) {
          if (titleLower.includes(token)) score += 10;
          if (claimLower.includes(token)) score += 5;
        }
      });
      if ((r.part_number || '').toLowerCase().includes(q)) score += 20;
      return { ...r, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}
