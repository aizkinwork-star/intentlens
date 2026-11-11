// server/services/providerGate.js — one honest gate for outbound vision calls.
//
// A capture is never lost because inference is unavailable. Callers get a
// structured reason and keep the locally stored capture.

import { localModelAvailable, outboundNetworkAllowed } from '../config.js';
import { buildRouter } from './router.js';

export function providerAvailability() {
  if (!localModelAvailable()) {
    return {
      available: false,
      code: 'AI_NOT_CONFIGURED',
      message: 'Online visual reasoning is unavailable: no vision provider is configured. Your capture is saved locally and you can still review it. Add a key in Settings.',
    };
  }
  if (!outboundNetworkAllowed()) {
    return {
      available: false,
      code: 'NETWORK_DISABLED',
      message: 'Online visual reasoning is unavailable: outbound network access is disabled (ALLOW_OUTBOUND_NETWORK=false). Your capture is saved locally.',
    };
  }
  return { available: true };
}

/** Build the multi-provider router, or return null with a reason. */
export function tryBuildRouter() {
  try {
    const router = buildRouter();
    if (!router || !router.providers?.length) {
      return {
        router: null,
        unavailable: {
          available: false,
          code: 'AI_NOT_CONFIGURED',
          message: 'No vision provider is configured. Add a key in Settings. Your capture is saved locally.',
        },
      };
    }
    return { router, unavailable: null };
  } catch (err) {
    return {
      router: null,
      unavailable: {
        available: false,
        code: 'AI_NOT_CONFIGURED',
        message: `No usable vision provider: ${err.message}. Your capture is saved locally.`,
      },
    };
  }
}
