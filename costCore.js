// costCore.js — pure token/cost budgeting shared by the desktop server and PWA.
//
// The hard rule: a request is refused BEFORE it is sent when its worst-case
// estimate would exceed the per-request cap or the remaining daily/monthly
// budget. The estimate is intentionally pessimistic (max output tokens are
// reserved, image tokens are estimated), so a long answer cannot silently
// blow past the budget.
//
// Prices come from modelRegistry.js. They are planning figures, not invoices.

import { estimateCostUsd, estimateImageTokens, estimateTextTokens } from './modelRegistry.js';

export const DEFAULT_BUDGET = {
  dailyUsd: 1.0,
  monthlyUsd: 10.0,
  maxRequestUsd: 0.25,
  maxInputTokens: 12000,
  maxOutputTokens: 2048,
  warnAtPercent: 80,
};

const finitePositive = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function normalizeBudget(input = {}) {
  return {
    dailyUsd: finitePositive(input.dailyUsd, DEFAULT_BUDGET.dailyUsd),
    monthlyUsd: finitePositive(input.monthlyUsd, DEFAULT_BUDGET.monthlyUsd),
    maxRequestUsd: finitePositive(input.maxRequestUsd, DEFAULT_BUDGET.maxRequestUsd),
    maxInputTokens: Math.max(256, Math.round(finitePositive(input.maxInputTokens, DEFAULT_BUDGET.maxInputTokens))),
    maxOutputTokens: Math.max(64, Math.round(finitePositive(input.maxOutputTokens, DEFAULT_BUDGET.maxOutputTokens))),
    warnAtPercent: Math.min(100, Math.max(1, Math.round(finitePositive(input.warnAtPercent, DEFAULT_BUDGET.warnAtPercent)))),
  };
}

/** Start of the UTC day/month containing `now`. */
export function windowStart(window, now = Date.now()) {
  const d = new Date(now);
  if (window === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function sumUsage(entries, window, now = Date.now()) {
  const since = windowStart(window, now);
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => Number(e?.at || 0) >= since)
    .reduce((sum, e) => sum + (Number(e?.costUsd) || 0), 0);
}

export function budgetSnapshot({ budget, entries, now = Date.now() } = {}) {
  const b = normalizeBudget(budget);
  const todayUsd = sumUsage(entries, 'day', now);
  const monthUsd = sumUsage(entries, 'month', now);
  const dayRemainingUsd = Math.max(0, b.dailyUsd - todayUsd);
  const monthRemainingUsd = Math.max(0, b.monthlyUsd - monthUsd);
  const remainingUsd = Math.min(dayRemainingUsd, monthRemainingUsd);
  const dayPercent = b.dailyUsd > 0 ? Math.round((todayUsd / b.dailyUsd) * 100) : 100;
  const monthPercent = b.monthlyUsd > 0 ? Math.round((monthUsd / b.monthlyUsd) * 100) : 100;
  return {
    budget: b,
    todayUsd: Number(todayUsd.toFixed(6)),
    monthUsd: Number(monthUsd.toFixed(6)),
    dayRemainingUsd: Number(dayRemainingUsd.toFixed(6)),
    monthRemainingUsd: Number(monthRemainingUsd.toFixed(6)),
    remainingUsd: Number(remainingUsd.toFixed(6)),
    dayPercent,
    monthPercent,
    warn: dayPercent >= b.warnAtPercent || monthPercent >= b.warnAtPercent,
    exhausted: remainingUsd <= 0,
    requests: (Array.isArray(entries) ? entries : []).filter((e) => Number(e?.at || 0) >= windowStart('month', now)).length,
  };
}

/**
 * Decide whether a request may run. Returns:
 *   ok, code, message, estimateUsd, estimatedInputTokens, maxOutputTokens, snapshot
 *
 * `inputText` and `image` are optional convenience inputs. Callers may pass an
 * explicit inputTokens estimate instead.
 */
export function preflightBudget({
  budget,
  entries,
  providerId,
  modelId,
  inputText = '',
  image = null,
  inputTokens = null,
  maxOutputTokens = null,
  now = Date.now(),
} = {}) {
  const b = normalizeBudget(budget);
  const snapshot = budgetSnapshot({ budget: b, entries, now });
  const textTokens = inputTokens != null ? Math.max(0, Number(inputTokens) || 0) : estimateTextTokens(inputText);
  const imageTokens = image ? estimateImageTokens(image.width, image.height) : 0;
  const reservedOutput = Math.max(64, Math.min(b.maxOutputTokens, Number(maxOutputTokens) || b.maxOutputTokens));
  const estimatedInputTokens = textTokens + imageTokens;
  const estimateUsd = estimateCostUsd(providerId, modelId, {
    inputTokens: textTokens,
    outputTokens: reservedOutput,
    imageCount: image ? 1 : 0,
    width: image?.width,
    height: image?.height,
  });

  const base = {
    estimateUsd: Number(estimateUsd.toFixed(6)),
    estimatedInputTokens,
    maxOutputTokens: reservedOutput,
    snapshot,
  };

  if (estimatedInputTokens > b.maxInputTokens) {
    return {
      ...base,
      ok: false,
      code: 'INPUT_TOKEN_LIMIT',
      message: `This request needs about ${estimatedInputTokens} tokens but the input cap is ${b.maxInputTokens}. Shorten the command/context or raise the cap in Settings.`,
    };
  }
  if (estimateUsd > b.maxRequestUsd) {
    return {
      ...base,
      ok: false,
      code: 'REQUEST_COST_LIMIT',
      message: `Worst-case cost is $${estimateUsd.toFixed(4)} but the per-request cap is $${b.maxRequestUsd.toFixed(2)}. Choose a cheaper/free model or raise the cap.`,
    };
  }
  if (estimateUsd > snapshot.remainingUsd) {
    return {
      ...base,
      ok: false,
      code: 'BUDGET_EXCEEDED',
      message: `Worst-case cost is $${estimateUsd.toFixed(4)} but only $${snapshot.remainingUsd.toFixed(4)} remains in the daily/monthly budget. Increase the budget or wait for the next window.`,
    };
  }
  return { ...base, ok: true, code: 'OK', message: 'Within budget.' };
}

/** Build a ledger entry from provider usage when available, otherwise estimate. */
export function makeUsageEntry({
  providerId,
  modelId,
  inputTokens = 0,
  outputTokens = 0,
  imageTokens = 0,
  usage = null,
  requestId = '',
  at = Date.now(),
} = {}) {
  const promptTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? inputTokens) || 0;
  const completionTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? outputTokens) || 0;
  const totalInput = promptTokens + (Number(imageTokens) || 0);
  const costUsd = estimateCostUsd(providerId, modelId, {
    inputTokens: promptTokens + imageTokens,
    outputTokens: completionTokens,
  });
  return {
    at,
    providerId,
    modelId,
    requestId,
    inputTokens: totalInput,
    outputTokens: completionTokens,
    imageTokens: Number(imageTokens) || 0,
    costUsd: Number(costUsd.toFixed(8)),
    source: usage ? 'provider-usage' : 'estimate',
  };
}

/** Keep the ledger bounded without losing the current month's totals. */
export function pruneEntries(entries, { now = Date.now(), maxEntries = 5000 } = {}) {
  const since = windowStart('month', now);
  const kept = (Array.isArray(entries) ? entries : [])
    .filter((e) => Number(e?.at || 0) >= since)
    .sort((a, b) => Number(a.at) - Number(b.at));
  return kept.slice(-maxEntries);
}

export { estimateCostUsd, estimateImageTokens, estimateTextTokens };
