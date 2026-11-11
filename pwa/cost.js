// pwa/cost.js — local token/cost ledger for the phone PWA.
//
// The phone has no server, so the budget is enforced in the browser and stored
// in IndexedDB. It contains token counts, model ids and prices only: never
// prompts, images or keys. The same pure rules as the desktop server come from
// costCore.js.

import * as db from './store.js';
import { DEFAULT_BUDGET, normalizeBudget, pruneEntries } from './lib/costCore.js';

const LEDGER_KEY = 'costLedger';
const BUDGET_KEY = 'costBudget';
const MAX_ENTRIES = 1000;

export async function loadBudget() {
  const saved = await db.getSetting(BUDGET_KEY, null);
  return normalizeBudget({ ...DEFAULT_BUDGET, ...(saved || {}) });
}

export async function saveBudget(partial) {
  const next = normalizeBudget({ ...(await loadBudget()), ...(partial || {}) });
  await db.setSetting(BUDGET_KEY, next);
  return next;
}

export async function loadLedger() {
  const rows = await db.getSetting(LEDGER_KEY, []);
  return pruneEntries(Array.isArray(rows) ? rows : [], { maxEntries: MAX_ENTRIES });
}

export async function appendUsage(entry) {
  if (!entry || typeof entry !== 'object') return loadLedger();
  const rows = await loadLedger();
  rows.push(entry);
  const kept = pruneEntries(rows, { maxEntries: MAX_ENTRIES });
  await db.setSetting(LEDGER_KEY, kept);
  return kept;
}

export async function clearLedger() {
  await db.setSetting(LEDGER_KEY, []);
}

export { DEFAULT_BUDGET };
