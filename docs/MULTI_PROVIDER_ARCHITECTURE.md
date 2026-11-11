# Multi-provider architecture

This document describes the provider and budget design that replaced the old Meta-only allowlist. It records decisions, not just code.

## Why the change

The original build restricted every call to Meta-published models. That made the app unusable with free tiers, non-Meta vision models and local inference, and it scattered model metadata across several files. The replacement is a vendor-neutral catalogue with one shared source of truth.

## Single source of truth: `modelRegistry.js`

`modelRegistry.js` is a pure module with no I/O. It exports:

- `PROVIDERS` — id, label, host, kind (`openai`, `cloudflare`, `anthropic`), env key, extra env keys, browser CORS support, free/paid tier flags.
- `PROVIDER_MODELS` — per-provider models with `modality`, `vision`, `tier`, `verified`, `openWeight`, `contextWindow`, `maxOutput`, `inputPerM`, `outputPerM`.
- `ACCESS_TIERS` and `TIER_RANK` — `free`, `preview`, `paid`.
- Helpers: `getProvider`, `getModel`, `modelsFor`, `defaultModelFor`, `modelAllowedAtTier`, `providerEndpoint`, `estimateTextTokens`, `estimateImageTokens`, `estimateCostUsd`, `normalizeProviderId`.

Rules enforced by the registry:

1. A model must exist in that provider's catalogue to be selected. A typed id is never silently replaced.
2. A text-only or classifier model is never sent an image.
3. A model above the selected access tier is not listed and not selectable.
4. Prices are planning figures, not invoices.

The server (`server/config.js`), the desktop UI and the browser PWA all derive from this file. `scripts/prepare-pwa.mjs` copies it and the other pure shared modules into `pwa/lib/` so the static PWA cannot drift.

## Runtime provider state

`server/config.js` turns environment variables and saved credentials into runtime state:

- `providerPriority` — ordered ids, filtered to known providers.
- `accessTier` — `free`, `preview` or `paid`.
- Per-provider runtime: `modelId`, `baseUrl`, `accountId`, enabled flag.
- `ALLOW_OUTBOUND_NETWORK` — a hard switch for cloud calls.

Credentials are stored by `server/lib/credentialStore.js` (Electron `safeStorage` / Windows DPAPI) and applied to `process.env` only inside the server process. Public API responses return booleans such as `configured: true`, never key material.

## URL safety

Custom and relay URLs are constrained:

- HTTPS is required.
- Plain HTTP is allowed only for loopback (`localhost`, `127.0.0.1`, `::1`).
- Private LAN IP literals are refused for custom relays.
- Wildcards are limited to `*.modal.run` and explicit user relays.
- Ollama is the loopback exception and is contacted directly by the server.

The goal is to prevent a saved relay URL from turning the server into a local-network request proxy.

## Adapters

Each adapter returns a normalised answer plus usage metadata:

- `openaiCompatibleProvider.js` — OpenRouter, Groq, Google AI Studio, NVIDIA NIM, Mistral, Cerebras, Together, Hugging Face, DeepInfra, OpenAI, Ollama, custom.
- `cloudflareProvider.js` — Cloudflare Workers AI.
- `anthropicProvider.js` — Anthropic Messages API, including image blocks.

Images are encoded once and reused across attempts. Errors are classified into stable categories: `auth`, `quota`, `rate_limit`, `timeout`, `outage`, `model_unavailable`, `not_vision`, `budget`, `bad_response`.

## Failover

`server/services/provider.js` runs the sequence:

1. Build the ordered candidate list: providers with a usable key, a vision model selected, and a model allowed at the current tier.
2. For each candidate, run the budget preflight.
3. If the preflight refuses, stop and return the budget error; do not try a provider that could exceed the cap.
4. Attempt the request with a timeout.
5. On a retryable failure, record health and move to the next candidate.
6. On success, record usage in the cost ledger and return the answer.

`services/router.js` owns ordering and health. `server/services/providerGate.js` answers “is any vision provider usable at all?” for the health endpoint and UI.

## Hard budget

`costCore.js` is pure:

- `normalizeBudget` clamps caps to sane values.
- `windowStart`/`sumUsage` use UTC day and month windows.
- `preflightBudget` estimates text tokens, image tokens and reserves `maxOutputTokens`, prices the worst case, and refuses with a code and message.
- `makeUsageEntry` and `pruneEntries` keep the ledger bounded.

`server/services/costManager.js` persists the ledger to `intentlens-data/cost-ledger.json` with an atomic rename. It stores token counts, model ids and estimated cost only. It never stores prompts, images or keys.

The preflight is deliberately pessimistic. A model that ignores the requested output cap cannot silently exceed the daily budget; the next request is refused instead.

## API surface

| Route | Purpose |
| --- | --- |
| `GET /api/providers` | Providers, catalogue, priority, access tier, budget |
| `POST /api/providers` | Save a provider key, model, tier or base URL |
| `DELETE /api/providers/:id` | Remove a saved credential |
| `GET/POST /api/providers/test` | Test a provider/model with a real image |
| `POST /api/providers/network` | Session-only outbound switch |
| `GET /api/budget` | Ledger snapshot + caps |
| `POST /api/budget` | Set caps |
| `POST /api/budget/reset` | Clear recorded usage, keep caps |
| `POST /api/sync/code` | Create a one-time LAN upload code |
| `POST /api/sync/receive` | Phone upload (code-auth, not session-auth) |
| `GET /api/sync/items?code=` | List received items (session-auth) |
| `GET /api/sync/items/:code/:id` | Read one item (session-auth) |

## PWA differences

The phone has no server, so `pwa/provider.js`:

- calls the provider directly with the user's in-memory key,
- blocks providers that do not send CORS headers, with the reason shown,
- runs the same budget preflight locally using `pwa/lib/costCore.js`,
- keeps the ledger in IndexedDB,
- never persists a key beyond the tab.

This is why OpenRouter works on the phone while NVIDIA and Cloudflare are listed but blocked.

## Tests

- `providerRegistry.test.js` — catalogue integrity and tier rules.
- `multiProvider.test.js` — adapters, failover and endpoint safety.
- `costBudget.test.js` — preflight, windows, ledger pruning.
- `provider.test.js` / `pwa/provider.test.js` — browser rules and CORS.
- `server.test.js` — routes, validation and auth.

No test needs a live provider key.
