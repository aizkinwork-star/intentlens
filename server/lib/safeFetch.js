// server/lib/safeFetch.js — enforced outbound fetch for provider calls.
import { isAllowedOutboundHost } from '../config.js';

const PRIVATE_RANGES = [
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, /^0\./, /^localhost$/i, /^::1$/,
];

export function isSafeUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (!isAllowedOutboundHost(url)) return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || PRIVATE_RANGES.some((r) => r.test(host))) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false; // no IP literals
  return true;
}

export async function safeFetch(url, options = {}) {
  if (!isSafeUrl(url)) {
    throw new Error(`Blocked unsafe outbound URL: ${url}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  const signal = options.signal
    ? (typeof AbortSignal !== 'undefined' && AbortSignal.any ? AbortSignal.any([options.signal, controller.signal]) : options.signal)
    : controller.signal;
  try {
    const res = await fetch(url, { ...options, signal, redirect: 'error' });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

export default { isSafeUrl, safeFetch };