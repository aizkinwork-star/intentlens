// server/services/provider.js — provider interface + failover router.
//
// Provider-agnostic: any catalogued vision provider with a usable key can be
// selected. See modelRegistry.js for the catalogue and server/services/router.js
// for ordering.
//
// Every provider returns the same contract. Failover is sequential and bounded:
// auth failures, quota exhaustion, rate limits, outages and timeouts move to the
// next configured eligible provider. A malformed request is never retried.
//
// Health is tracked per provider and exposed to the UI without secrets.

import { appError } from '../lib/errors.js';

const NEVER_FAILOVER = new Set([
  'COMMAND_MISSING', 'CAMERA_FRAME_MISSING', 'IMAGE_TOO_LARGE', 'IMAGE_DECODE_FAILED',
  'BAD_JSON', 'MODEL_BAD_RESPONSE', 'RESULT_SCHEMA_INVALID',
]);

const HEALTH = new Map();

function healthFor(id) {
  if (!HEALTH.has(id)) {
    HEALTH.set(id, {
      id,
      state: 'unknown',
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
      lastErrorCategory: null,
      cooldownUntil: 0,
      consecutiveFailures: 0,
    });
  }
  return HEALTH.get(id);
}

export function providerHealthSnapshot() {
  const now = Date.now();
  return Object.fromEntries([...HEALTH.entries()].map(([id, h]) => [id, {
    ...h,
    cooldownRemainingMs: Math.max(0, h.cooldownUntil - now),
    available: h.cooldownUntil <= now,
  }]));
}

export function resetProviderHealth(id = null) {
  if (id) HEALTH.delete(id);
  else HEALTH.clear();
}

export function classifyProviderError(err) {
  const code = err?.code || 'UNKNOWN';
  if (code === 'MODEL_AUTH_FAILED') return { category: 'auth', cooldownMs: 5 * 60_000, authInvalid: true };
  if (code === 'MODEL_RATE_LIMITED') return { category: 'rate_limit', cooldownMs: Number(err?.retryAfterMs) || 30_000 };
  if (code === 'MODEL_QUOTA_EXHAUSTED') return { category: 'quota', cooldownMs: 10 * 60_000 };
  if (code === 'MODEL_TIMEOUT') return { category: 'timeout', cooldownMs: 30_000 };
  if (code === 'MODEL_UPSTREAM_ERROR' && err?.badRequest) return { category: 'bad_request', cooldownMs: 0 };
  if (code === 'MODEL_UPSTREAM_ERROR') return { category: 'outage', cooldownMs: 60_000 };
  return { category: 'unknown', cooldownMs: 15_000 };
}

/** Sequential failover router. */
export class ProviderRouter {
  constructor(providers = []) {
    this.providers = providers;
  }

  use(provider) { this.providers.push(provider); return this; }

  get eligibleProviders() {
    return this.providers.filter((p) => p?.capabilities?.imageInput !== false);
  }

  async healthCheckAll() {
    const out = {};
    for (const p of this.eligibleProviders) {
      try { out[p.id] = await p.healthCheck(); } catch (err) {
        out[p.id] = { ok: false, detail: err.message || String(err) };
      }
    }
    return out;
  }

  /**
   * Returns { result, providerUsed, modelId, fallbackOccurred, attempts }.
   * Throws the last AppError with .attempts if every provider fails.
   */
  async analyze(input, signal) {
    const attempts = [];
    let lastError = null;
    const now = Date.now();
    const candidates = this.eligibleProviders;
    let attempted = 0;
    const deadlineMs = Number(input?.deadlineMs);
    const deadlineAt = Number.isFinite(deadlineMs) && deadlineMs > 0 ? now + deadlineMs : 0;

    for (const provider of candidates) {
      const health = healthFor(provider.id);
      if (health.cooldownUntil > now) {
        attempts.push({
          id: provider.id,
          modelId: provider.modelId || null,
          ok: false,
          skipped: true,
          code: 'PROVIDER_COOLDOWN',
          cooldownRemainingMs: health.cooldownUntil - now,
        });
        continue;
      }

      // Hard answer deadline: never start an attempt that cannot finish inside
      // the remaining budget. A fast fallback is more useful than a late answer.
      const remainingMs = deadlineAt ? deadlineAt - Date.now() : 0;
      if (deadlineAt && remainingMs <= 250) {
        attempts.push({
          id: provider.id,
          modelId: provider.modelId || null,
          ok: false,
          skipped: true,
          code: 'ANSWER_DEADLINE_REACHED',
        });
        if (!lastError) lastError = appError('MODEL_TIMEOUT', 'The 10-second answer deadline was reached.');
        break;
      }

      // Hard budget preflight. A request that cannot fit is skipped in favour
      // of a cheaper provider; if no provider fits, the last budget error wins.
      let preflight = null;
      if (this.costManager) {
        const inputText = `${input.instructions || ''}\n${input.userText || ''}`;
        const image = input.imageMeta || (input.imageDataUrl ? { width: 1024, height: 1024 } : null);
        preflight = this.costManager.preflight({
          providerId: provider.id,
          modelId: provider.modelId,
          inputText,
          image,
        });
        if (!preflight.ok) {
          lastError = appError(preflight.code, preflight.message);
          attempts.push({
            id: provider.id,
            modelId: provider.modelId || null,
            ok: false,
            skipped: true,
            code: preflight.code,
            category: 'budget',
            estimateUsd: preflight.estimateUsd,
            estimatedInputTokens: preflight.estimatedInputTokens,
          });
          continue;
        }
      }

      const started = Date.now();
      let attemptController = null;
      let deadlineTimer = null;
      let removeAbortListener = null;
      try {
        let attemptSignal = signal;
        if (deadlineAt) {
          attemptController = new AbortController();
          attemptSignal = attemptController.signal;
          if (signal) {
            const forwardAbort = () => attemptController.abort();
            signal.addEventListener('abort', forwardAbort, { once: true });
            removeAbortListener = () => signal.removeEventListener('abort', forwardAbort);
          }
          deadlineTimer = setTimeout(() => attemptController.abort(), Math.max(1, deadlineAt - Date.now()));
        }
        const raw = await provider.analyze(input, attemptSignal);
        const ms = Date.now() - started;
        health.state = 'healthy';
        health.lastSuccessAt = new Date().toISOString();
        health.consecutiveFailures = 0;
        health.cooldownUntil = 0;
        health.lastError = null;
        health.lastErrorCategory = null;
        attempts.push({ id: provider.id, modelId: provider.modelId || null, ok: true, ms, estimateUsd: preflight?.estimateUsd ?? null });
        if (this.costManager) {
          try {
            this.costManager.recordUsage({
              providerId: provider.id,
              modelId: provider.modelId,
              requestId: input.requestId || '',
              inputTokens: raw?.usage ? 0 : (preflight?.estimatedInputTokens || 0),
              outputTokens: raw?.usage ? 0 : (preflight?.maxOutputTokens || 0),
              usage: raw?.usage || null,
            });
          } catch { /* ledger persistence must not fail the request */ }
        }
        return {
          result: raw,
          providerUsed: provider.id,
          providerName: provider.name,
          modelId: provider.modelId || null,
          fallbackOccurred: attempted > 0,
          attempts,
          budget: preflight ? { estimateUsd: preflight.estimateUsd, remainingUsd: preflight.snapshot.remainingUsd } : null,
        };
      } catch (err) {
        attempted += 1;
        const timedOut = Boolean(attemptController?.signal.aborted) && !Boolean(signal?.aborted) && !err?.code;
        const effectiveError = timedOut
          ? appError('MODEL_TIMEOUT', 'The provider did not answer before the answer deadline.')
          : err;
        lastError = effectiveError;
        const info = classifyProviderError(effectiveError);
        health.state = info.authInvalid ? 'auth_invalid' : info.category === 'quota' ? 'quota_exhausted' : 'unhealthy';
        health.lastErrorAt = new Date().toISOString();
        health.lastError = String(effectiveError?.message || effectiveError).slice(0, 300);
        health.lastErrorCategory = info.category;
        health.consecutiveFailures += 1;
        health.cooldownUntil = info.cooldownMs ? Date.now() + info.cooldownMs : 0;
        attempts.push({
          id: provider.id,
          modelId: provider.modelId || null,
          ok: false,
          ms: Date.now() - started,
          code: effectiveError.code || 'UNKNOWN',
          category: info.category,
          retryable: Boolean(effectiveError.retryable),
        });

        if (NEVER_FAILOVER.has(effectiveError.code) || effectiveError?.badRequest) throw effectiveError; // diagnose locally
        if (signal?.aborted) throw effectiveError;
        if (provider.id === candidates[candidates.length - 1]?.id) break;
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (removeAbortListener) removeAbortListener();
      }
    }

    const final = lastError || appError('AI_NOT_CONFIGURED', 'No vision provider is configured or available.');
    final.attempts = attempts;
    final.providerHealth = providerHealthSnapshot();
    throw final;
  }
}

/** Map an upstream HTTP response to a stable AppError. */
export function mapHttpError(status, body, { retryAfterMs } = {}) {
  const detail = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body ?? {}).slice(0, 300);
  if (status === 401 || status === 403) {
    const err = appError('MODEL_AUTH_FAILED', `Provider rejected the key (HTTP ${status}). Replace the key to continue.`);
    err.providerDetail = detail;
    return err;
  }
  if (status === 429) {
    const err = appError('MODEL_RATE_LIMITED', 'Provider rate limit reached. Waiting or using another provider.');
    err.retryAfterMs = retryAfterMs;
    err.providerDetail = detail;
    return err;
  }
  if (status === 402) {
    const err = appError('MODEL_QUOTA_EXHAUSTED', 'Provider quota is exhausted. Add credit or use another provider.');
    err.providerDetail = detail;
    return err;
  }
  if (status === 404) {
    const err = appError('MODEL_UPSTREAM_ERROR', 'The selected model is not available on this account or provider.');
    err.providerDetail = detail;
    err.modelUnavailable = true;
    return err;
  }
  if (status === 408 || status === 504) {
    const err = appError('MODEL_TIMEOUT', 'Provider timed out.');
    err.providerDetail = detail;
    return err;
  }
  if (status === 400 || status === 422) {
    const err = appError('MODEL_UPSTREAM_ERROR', 'Provider rejected the request. The context or model parameters need attention.');
    err.badRequest = true;
    err.providerDetail = detail;
    return err;
  }
  const err = appError('MODEL_UPSTREAM_ERROR', `Provider returned HTTP ${status}.`);
  err.providerDetail = detail;
  return err;
}

export function retryAfterMs(headers) {
  try {
    const value = headers?.get?.('retry-after');
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(1000, date - Date.now());
  } catch {}
  return undefined;
}
