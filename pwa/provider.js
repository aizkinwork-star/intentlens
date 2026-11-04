// pwa/provider.js — direct browser → Meta model calls for the PWA.
//
// CORS reality (verified with real preflight requests):
//   Groq      -> access-control-allow-origin: *   (browser calls work)
//   NVIDIA NIM-> no allow-origin header            (browser calls blocked)
//   Cloudflare-> OPTIONS 405                       (browser calls blocked)
//
// So the PWA offers Groq directly, NIM only through a CORS-enabled relay, and
// a custom OpenAI-compatible base URL. There is no non-Meta fallback: every
// model in this file is a Meta model.

export const PROVIDERS = {
  groq: {
    id: 'groq',
    label: 'Groq — Meta Llama vision',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
    browserCors: 'allowed',
    note: 'Groq sends CORS headers, so this is the standalone phone path. Vision access still depends on your Groq account.',
  },
  nim: {
    id: 'nim',
    label: 'NVIDIA NIM — Meta Muse',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    defaultModel: 'meta/muse-glimmer-30b',
    browserCors: 'blocked',
    note: 'NIM does not send browser CORS headers. A direct call from GitHub Pages will fail; use a CORS-enabled relay or the desktop app.',
  },
  custom: {
    id: 'custom',
    label: 'Custom OpenAI-compatible relay',
    endpoint: '',
    defaultModel: 'meta/muse-glimmer-30b',
    browserCors: 'unknown',
    note: 'Point this at your own HTTPS relay that forwards to a Meta model and allows this Pages origin.',
  },
};

export const PROVIDER_ORDER = ['groq', 'nim', 'custom'];

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function endpointFor(providerId, baseUrl) {
  if (providerId !== 'custom') return PROVIDERS[providerId].endpoint;
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  if (!/^https:\/\//i.test(raw)) return '';
  const clean = raw.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(clean)) return clean;
  if (/\/v1$/i.test(clean)) return `${clean}/chat/completions`;
  return `${clean}/v1/chat/completions`;
}

export function modelFor(providerId, override) {
  const chosen = String(override || '').trim();
  if (chosen) return chosen;
  return PROVIDERS[providerId]?.defaultModel || PROVIDERS.groq.defaultModel;
}

function friendlyHttpError(status, data, rawText) {
  const providerMessage = data?.error?.message || data?.message || '';
  const suffix = providerMessage ? ` Provider said: ${String(providerMessage).slice(0, 300)}` : '';
  if (status === 401) return `Key rejected (401). Check the key and that it belongs to this provider.${suffix}`;
  if (status === 403) return `Access denied (403). The key may not have this model enabled.${suffix}`;
  if (status === 404) return `Model not found (404). This account may not have access to the model.${suffix}`;
  if (status === 429) return `Rate limited (429). Wait a moment and retry.${suffix}`;
  if (status >= 500) return `Provider error (${status}). This is usually temporary.${suffix}`;
  const body = rawText ? ` Response: ${String(rawText).slice(0, 300)}` : '';
  return `Request failed (${status}).${suffix}${body}`;
}

function corsMessage(providerId) {
  if (providerId === 'nim') {
    return 'Network/CORS failure. NVIDIA NIM does not allow calls from a browser page (no Access-Control-Allow-Origin). Use Groq, or a relay that allows this origin.';
  }
  if (providerId === 'custom') {
    return 'Network/CORS failure. The relay did not allow this browser origin, or the URL is wrong. It must be HTTPS and return Access-Control-Allow-Origin.';
  }
  return 'Network failure. Check the connection, the endpoint, and whether the provider allows this browser origin.';
}

/** Extract the first complete JSON object from model text (which may include prose). */
export function extractJson(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * One vision request. `imageDataUrl` is optional so Explain can reuse this
 * text-only. No retries are hidden here: the caller decides.
 */
export async function callModel({
  providerId = 'groq',
  apiKey,
  model,
  prompt,
  imageDataUrl = null,
  baseUrl = '',
  timeoutMs = 180000,
} = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) return fail('UNKNOWN_PROVIDER', 'Choose a provider.');
  const endpoint = endpointFor(providerId, baseUrl);
  if (!endpoint) {
    return fail('NO_ENDPOINT', 'This provider needs a valid HTTPS base URL in Settings.');
  }
  const key = String(apiKey || '').trim();
  if (!key) return fail('NO_KEY', 'Add a provider key in Settings first.');

  const content = [{ type: 'text', text: String(prompt || '') }];
  if (imageDataUrl) {
    content.push({ type: 'image_url', image_url: { url: imageDataUrl } });
  }

  const body = {
    model: modelFor(providerId, model),
    messages: [{ role: 'user', content }],
    max_tokens: 3072,
    temperature: 0.2,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rawText = await response.text();
    let data = null;
    try { data = JSON.parse(rawText); } catch { /* handled below */ }
    if (!response.ok) {
      return fail(`HTTP_${response.status}`, friendlyHttpError(response.status, data, rawText), {
        status: response.status,
        latencyMs: Date.now() - started,
      });
    }
    const message = data?.choices?.[0]?.message || {};
    const text = message.content || message.reasoning_content || message.reasoning || '';
    if (!text) {
      return fail('EMPTY_RESPONSE', 'The provider returned no text. The model may need a different id or more tokens.', {
        latencyMs: Date.now() - started,
      });
    }
    const json = extractJson(text);
    if (!json) {
      return fail('BAD_JSON', 'The model did not return a JSON object. Nothing was drawn.', {
        raw: String(text).slice(0, 500),
        latencyMs: Date.now() - started,
      });
    }
    return { ok: true, json, text, latencyMs: Date.now() - started };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return fail('TIMEOUT', `The request timed out after ${Math.round(timeoutMs / 1000)} s. Muse Glimmer can take 80–120 s; retry once.`);
    }
    return fail('NETWORK', corsMessage(providerId), { detail: String(error?.message || error) });
  } finally {
    clearTimeout(timer);
  }
}

/** A cheap key/model check. Sends text only — never a photo. */
export async function testProvider({ providerId, apiKey, model, baseUrl }) {
  return callModel({
    providerId,
    apiKey,
    model,
    baseUrl,
    prompt: 'Reply with exactly one JSON object: {"ok":true}',
    timeoutMs: 30000,
  });
}
