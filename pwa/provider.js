// pwa/provider.js — direct browser → provider calls for the PWA.
//
// Browser CORS was checked with real preflight requests from a GitHub Pages
// origin (2026-11-04):
//   Groq       -> access-control-allow-origin: *        allowed
//   OpenRouter -> access-control-allow-origin: *        allowed
//   NVIDIA NIM -> no allow-origin header                blocked
//   BlockRun   -> OPTIONS 204/200 without allow-origin  blocked in a browser
//
// BlockRun is still offered because the user explicitly asked for it, but the
// UI must say that browser calls were observed to be CORS-blocked and that its
// vision quality is unverified. There is no silent fallback anywhere.

export const PROVIDERS = {
  groq: {
    id: 'groq',
    label: 'Groq — Meta Llama vision',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    host: 'api.groq.com',
    defaultModel: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    browserCors: 'allowed',
    vision: 'unverified-live',
    consent: false,
    retention: 'Groq API terms apply; prompts/images are sent to Groq for this request.',
    note: 'Groq sends CORS headers, so this is the standalone phone path. Llama 4 Scout is retired on this account; Maverick is the replacement. Vision access still depends on your Groq account.',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter — choose a free or Meta model',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    host: 'openrouter.ai',
    defaultModel: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    browserCors: 'allowed',
    vision: 'free-vision-candidate',
    consent: false,
    retention: 'OpenRouter routes to the upstream model provider. Check the model page for its data policy.',
    note: 'OpenRouter allows browser CORS. The default is the free image-capable NVIDIA Nemotron Omni model. Paid Meta options are listed below; nothing is charged unless you pick one.',
  },
  blockrun: {
    id: 'blockrun',
    label: 'BlockRun — NVIDIA Llama 3.2 11B vision (warning)',
    endpoint: 'https://blockrun.ai/api/v1/chat/completions',
    host: 'blockrun.ai',
    defaultModel: 'nvidia/llama-3.2-11b-vision',
    browserCors: 'blocked-observed',
    vision: 'disputed',
    consent: true,
    retention: 'BlockRun privacy policy (21 Oct 2026) says prompts, completions and tool calls are retained until deletion, with no fixed expiry. Its marketing page claims no retention beyond the request; those statements conflict.',
    note: 'WARNING: BlockRun says this model is free and image-capable, but its own SDK README reports HTTP 200 with incorrect answers on real image probes. Do not send private documents, personal data or sensitive project history. A browser CORS preflight from GitHub Pages returned no Access-Control-Allow-Origin, so direct phone calls will likely fail.',
  },
  nim: {
    id: 'nim',
    label: 'NVIDIA NIM — Meta Muse',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    host: 'integrate.api.nvidia.com',
    defaultModel: 'meta/muse-glimmer-30b',
    browserCors: 'blocked',
    vision: 'catalog-only',
    consent: false,
    retention: 'NVIDIA API terms apply. Not reachable directly from a browser.',
    note: 'NIM does not send browser CORS headers. A direct call from GitHub Pages will fail; use a CORS-enabled relay or the desktop app.',
  },
  custom: {
    id: 'custom',
    label: 'Custom OpenAI-compatible relay',
    endpoint: '',
    host: '',
    defaultModel: 'meta-llama/llama-4-maverick',
    browserCors: 'unknown',
    vision: 'unknown',
    consent: false,
    retention: 'Your relay decides retention. Do not point this at a service you do not trust.',
    note: 'Point this at your own HTTPS relay that forwards to a model you trust and allows this Pages origin.',
  },
};

export const PROVIDER_ORDER = ['groq', 'openrouter', 'blockrun', 'nim', 'custom'];

// Every host the app is allowed to contact for inference. Used by tests and by
// the CSP connect-src list in index.html.
export const PROVIDER_HOSTS = Object.values(PROVIDERS)
  .map((provider) => provider.host)
  .filter(Boolean);

// Exact OpenRouter models checked live on 2026-11-04 (GET /api/v1/models).
// Free does not mean private; the model page's data policy still applies.
export const OPENROUTER_MODELS = {
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': {
    label: 'NVIDIA Nemotron 3 Nano Omni — free, vision',
    pricing: 'free',
    modalities: ['text', 'image', 'video', 'audio'],
  },
  'meta-llama/llama-4-maverick': {
    label: 'Meta Llama 4 Maverick — vision, paid per token',
    pricing: '$0.1875/M input, $0.6525/M output',
    modalities: ['text', 'image'],
  },
  'meta-llama/llama-4-scout': {
    label: 'Meta Llama 4 Scout — vision, paid per token',
    pricing: '$0.10/M input, $0.30/M output',
    modalities: ['text', 'image'],
  },
};

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function endpointFor(providerId, baseUrl) {
  if (providerId !== 'custom') return PROVIDERS[providerId]?.endpoint || '';
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
    return 'Network/CORS failure. NVIDIA NIM does not allow calls from a browser page (no Access-Control-Allow-Origin). Use Groq/OpenRouter, or a relay that allows this origin.';
  }
  if (providerId === 'blockrun') {
    return 'Network/CORS failure. BlockRun did not return Access-Control-Allow-Origin in a preflight from GitHub Pages, so a browser page cannot read its response. Use its server SDK, a relay you control, or another provider.';
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
 * One provider request. `imageDataUrl` is optional: text chat never passes it,
 * so no image_url content part is ever built. No retries are hidden here.
 */
export async function callModel({
  providerId = 'groq',
  apiKey,
  model,
  prompt,
  imageDataUrl = null,
  baseUrl = '',
  timeoutMs = 180000,
  expectJson = true,
  fetchImpl = globalThis.fetch,
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

  const requestedModel = modelFor(providerId, model);
  const body = {
    model: requestedModel,
    messages: [{ role: 'user', content }],
    max_tokens: 3072,
    temperature: 0.2,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(endpoint, {
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
        requestedModel,
      });
    }
    const message = data?.choices?.[0]?.message || {};
    const text = message.content || message.reasoning_content || message.reasoning || '';
    if (!text) {
      return fail('EMPTY_RESPONSE', 'The provider returned no text. The model may need a different id or more tokens.', {
        latencyMs: Date.now() - started,
        requestedModel,
      });
    }
    return {
      ok: true,
      json: expectJson ? extractJson(text) : null,
      text,
      latencyMs: Date.now() - started,
      requestedModel,
      returnedModel: data?.model || requestedModel,
      providerId,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return fail('TIMEOUT', `The request timed out after ${Math.round(timeoutMs / 1000)} s. Retry only if you accept a possible duplicate request.`);
    }
    return fail('NETWORK', corsMessage(providerId), { detail: String(error?.message || error) });
  } finally {
    clearTimeout(timer);
  }
}

/** A cheap key/model check. Sends text only — never a photo. */
export async function testProvider({ providerId, apiKey, model, baseUrl, fetchImpl }) {
  return callModel({
    providerId,
    apiKey,
    model,
    baseUrl,
    fetchImpl,
    prompt: 'Reply with exactly one JSON object: {"ok":true}',
    timeoutMs: 30000,
  });
}

/** Text-only chat. Kept separate so it is impossible to attach an image by accident. */
export async function callChatModel(options) {
  return callModel({ ...options, imageDataUrl: null, expectJson: false });
}
