// server/services/costManager.js — persistent token/cost ledger and hard budgets.
//
// The ledger lives under intentlens-data/ (gitignored). It contains only token
// counts, model ids and prices; never prompts, images or API keys.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_BUDGET,
  budgetSnapshot,
  makeUsageEntry,
  normalizeBudget,
  preflightBudget,
  pruneEntries,
  sumUsage,
} from '../../costCore.js';
import { config } from '../config.js';

function ledgerPath() {
  return resolve(process.env.DATA_DIR || './intentlens-data', 'cost-ledger.json');
}

function readLedger() {
  const file = ledgerPath();
  if (!existsSync(file)) return { budget: { ...DEFAULT_BUDGET }, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      budget: normalizeBudget({ ...DEFAULT_BUDGET, ...(parsed?.budget || {}) }),
      entries: Array.isArray(parsed?.entries) ? parsed.entries : [],
    };
  } catch {
    return { budget: { ...DEFAULT_BUDGET }, entries: [] };
  }
}

function writeLedger(ledger) {
  const file = ledgerPath();
  mkdirSync(resolve(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({
    version: 1,
    budget: ledger.budget,
    entries: pruneEntries(ledger.entries),
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

function budgetFromEnv() {
  return normalizeBudget({
    ...DEFAULT_BUDGET,
    dailyUsd: process.env.DAILY_BUDGET_USD ?? DEFAULT_BUDGET.dailyUsd,
    monthlyUsd: process.env.MONTHLY_BUDGET_USD ?? DEFAULT_BUDGET.monthlyUsd,
    maxRequestUsd: process.env.MAX_REQUEST_USD ?? DEFAULT_BUDGET.maxRequestUsd,
    maxInputTokens: process.env.MAX_INPUT_TOKENS ?? DEFAULT_BUDGET.maxInputTokens,
    maxOutputTokens: process.env.MAX_OUTPUT_TOKENS ?? DEFAULT_BUDGET.maxOutputTokens,
  });
}

export class CostManager {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.ledger = readLedger();
    // Environment defaults win when the file has never been configured.
    if (!this.ledger.budget) this.ledger.budget = budgetFromEnv();
  }

  getBudget() {
    return { ...this.ledger.budget };
  }

  setBudget(partial = {}) {
    this.ledger.budget = normalizeBudget({ ...this.ledger.budget, ...partial });
    writeLedger(this.ledger);
    return this.getBudget();
  }

  snapshot() {
    return budgetSnapshot({ budget: this.ledger.budget, entries: this.ledger.entries, now: this.now() });
  }

  preflight(args) {
    return preflightBudget({
      budget: this.ledger.budget,
      entries: this.ledger.entries,
      now: this.now(),
      ...args,
    });
  }

  record(entry) {
    this.ledger.entries.push({
      at: this.now(),
      ...entry,
    });
    writeLedger(this.ledger);
    return this.snapshot();
  }

  recordUsage(args) {
    return this.record(makeUsageEntry({ ...args, at: this.now() }));
  }

  todayUsd() {
    return sumUsage(this.ledger.entries, 'day', this.now());
  }

  monthUsd() {
    return sumUsage(this.ledger.entries, 'month', this.now());
  }

  recent(limit = 50) {
    return [...this.ledger.entries].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  reset({ entriesOnly = false } = {}) {
    if (entriesOnly) this.ledger.entries = [];
    else this.ledger = { budget: budgetFromEnv(), entries: [] };
    writeLedger(this.ledger);
    return this.snapshot();
  }
}

// One manager per server process. Tests can construct their own.
export const costManager = new CostManager();

export function costStatusForClient() {
  const snap = costManager.snapshot();
  return {
    ...snap,
    currency: 'USD',
    approx: true,
    note: 'Estimates use catalogue prices and reserved max output. Provider invoices are authoritative.',
    recent: costManager.recent(20),
  };
}

export function budgetConfigForClient() {
  return {
    ...costManager.getBudget(),
    defaults: { ...DEFAULT_BUDGET },
    env: {
      dailyUsd: config?.dailyBudgetUsd ?? null,
      monthlyUsd: config?.monthlyBudgetUsd ?? null,
    },
  };
}
