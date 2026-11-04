// pwa/provider.js — direct browser → provider calls for the PWA.
//
// Browser CORS was checked with real preflight requests from this GitHub Pages
// origin (2026-11-04):
//   OpenRouter -> access-control-allow-origin: *   allowed, real image verified
//   Groq       -> access-control-allow-origin: *   allowed, text verified
//   NVIDIA NIM -> no allow-origin header           blocked, not offered here
//   BlockRun   -> no allow-origin header           blocked, not offered here
//
// A static GitHub Pages app cannot hide a key or proxy a request. Only hosts
// that a browser can actually read are offered. NVIDIA NIM stays in the desktop
// app, where the local server makes the request. BlockRun is not offered
// anywhere: the supplied key returned HTTP 402 and the host has no CORS.
//
// Nothing here invents a fallback: if the chosen provider or model cannot do
// what was asked, the request fails with an explicit message.

export const PROVIDERS = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter — Meta Llama 4 (default)',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    host: 'openrouter.ai',
    defaultModel: 'meta-llama/llama-4-maverick',
    browserCors: 'verified-allowed',
    vision: 'verified',
    consent: false,
    retention: 'OpenRouter routes each request to the upstream model provider. Check that model page for its data policy; free does not automatically mean private.',
    note: 'Meta-first catalogue. The default is Meta Llama 4 Maverick, a paid vision model with its price shown; Scout and Meta text models are also listed. Free NVIDIA/Dots vision models remain selectable if you want a no-cost request. Direct browser CORS and real image requests were verified on 2026-11-04.',
  },
  groq: {
    id: 'groq',
    label: 'Groq — Meta Llama text (account dependent)',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    host: 'api.groq.com',
    defaultModel: 'meta-llama/llama-3.3-70b-versatile',
    browserCors: 'verified-allowed',
    vision: 'none',
    consent: false,
    retention: 'Groq API terms apply; text prompts are sent to Groq for this request.',
    note: 'Meta Llama 3.3 70B Versatile is listed first because Meta models are the priority. The supplied restricted Groq account on 2026-11-04 exposed only Prompt Guard 2 classifiers among Meta models, so this model may return 403/404 on that account; use Test key. GPT-OSS/Qwen remain labelled non-Meta text fallbacks. Groq has no vision model here, so images are refused before any network call.',
  },
  'nvidia-nim': {
    id: 'nvidia-nim',
    label: 'NVIDIA NIM — Meta vision (desktop only)',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    host: 'integrate.api.nvidia.com',
    defaultModel: 'meta/muse-glimmer-30b',
    browserCors: 'blocked',
    vision: 'verified-desktop',
    consent: false,
    unavailableInBrowser: true,
    retention: 'NVIDIA account terms apply. Requests are made by the desktop app server, not by the phone browser.',
    note: 'Meta Muse Glimmer 30B and Llama 3.2 Vision are hosted here. A real image request from the desktop path returned 200 and named a red circle and blue rectangle on 2026-11-04. The host sends no Access-Control-Allow-Origin, so a GitHub Pages browser cannot read the response. Use the PC app or your own relay.',
    blockedMessage: 'NVIDIA NIM cannot be called from the phone browser: https://integrate.api.nvidia.com returns no Access-Control-Allow-Origin, so the browser blocks the response. Use the desktop app (server-side request) or a user-owned relay. Endpoint: https://integrate.api.nvidia.com/v1/chat/completions.',
  },
  'cloudflare-workers-ai': {
    id: 'cloudflare-workers-ai',
    label: 'Cloudflare Workers AI — Meta vision (desktop only)',
    endpoint: 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}',
    host: 'api.cloudflare.com',
    defaultModel: '@cf/meta/llama-3.2-11b-vision-instruct',
    browserCors: 'blocked',
    vision: 'verified-desktop',
    consent: false,
    unavailableInBrowser: true,
    retention: 'Cloudflare account terms apply. Requests are made by the desktop app server, not by the phone browser.',
    note: 'Meta Llama 3.2 11B Vision returned 200 and correctly named a real synthetic image after licence acceptance on 2026-11-04. It needs a Cloudflare Account ID plus API token. Preflight OPTIONS returns 405 with no allow-origin header, so the phone browser cannot call it. Desktop only.',
    blockedMessage: 'Cloudflare Workers AI cannot be called from the phone browser: its preflight returns HTTP 405 without Access-Control-Allow-Origin. Use the desktop app (Account ID + token) or a user-owned relay. Endpoint template: https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}.',
  },
  blockrun: {
    id: 'blockrun',
    label: 'BlockRun — paid model marketplace',
    endpoint: 'https://api.blockrun.ai/v1/chat/completions',
    host: 'api.blockrun.ai',
    defaultModel: 'meta-llama/llama-4-maverick',
    browserCors: 'blocked',
    vision: 'unverified',
    consent: true,
    unavailableInBrowser: true,
    retention: 'BlockRun is a paid x402 marketplace. Check its terms and your wallet/payment configuration before sending anything.',
    note: 'BlockRun listed 115 models on 2026-11-04, including Meta models, but the supplied key returned HTTP 402 "Payment verification failed" and the host sends no Access-Control-Allow-Origin. It is paid and currently unusable with that key. The endpoint and reason are shown instead of hiding the provider.',
    blockedMessage: 'BlockRun cannot be called from the phone browser: https://api.blockrun.ai sends no Access-Control-Allow-Origin, and the supplied key returned HTTP 402 "Payment verification failed". It needs payment credit and desktop/server-side requests. Endpoint: https://api.blockrun.ai/v1/chat/completions.',
  },
  modal: {
    id: 'modal',
    label: 'Modal — your deployed endpoint (paid, untested)',
    endpoint: '',
    host: '',
    defaultModel: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct',
    browserCors: 'unknown',
    vision: 'unverified',
    consent: true,
    requiresBaseUrl: true,
    retention: 'Your Modal deployment decides retention. Modal is a paid compute platform; requests bill your Modal account.',
    note: 'Modal does not expose one universal chat endpoint. Paste the HTTPS URL of the OpenAI-compatible endpoint you deployed (usually https://<workspace>--<app>-<function>.modal.run). This path was NOT tested in the 2026-11-04 audit. It is paid and the model must be one your deployment serves; CORS is whatever your endpoint allows.',
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
    requiresBaseUrl: true,
    retention: 'Your relay decides retention and training. Do not point this at a service you do not trust.',
    note: 'Use your own HTTPS relay when a provider blocks browser CORS (NVIDIA NIM, Cloudflare Workers AI, BlockRun). The relay must forward to the model you trust and return Access-Control-Allow-Origin for this Pages origin. This app never operates a relay for you.',
  },
};

export const PROVIDER_ORDER = [
  'openrouter',
  'groq',
  'nvidia-nim',
  'cloudflare-workers-ai',
  'blockrun',
  'modal',
  'custom',
];

// Every fixed host the app is allowed to contact for inference. Custom relays
// are user-supplied, so index.html allows arbitrary HTTPS origins for that case.
export const PROVIDER_HOSTS = Object.values(PROVIDERS)
  .map((provider) => provider.host)
  .filter(Boolean);

// OpenRouter catalogue checked live on 2026-11-04 (GET /api/v1/models) and,
// where marked verified, with a real synthetic image request.
// Free does not mean private; the model page's data policy still applies.
export const OPENROUTER_MODELS = {
  'nvidia/nemotron-3.5-super-vl:free': {
    label: 'NVIDIA Nemotron 3.5 Super VL — free, vision',
    pricing: 'free',
    modalities: ['text', 'image', 'video'],
    vision: true,
    verified: true,
    jsonMode: true,
    reasoning: true,
    note: 'Verified with a real image: correctly named a red circle and blue rectangle. Reasoning uses output tokens, so allow enough max_tokens.',
  },
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': {
    label: 'NVIDIA Nemotron 3 Nano Omni — free, vision',
    pricing: 'free',
    modalities: ['text', 'image', 'video', 'audio'],
    vision: true,
    verified: true,
    jsonMode: false,
    reasoning: true,
    note: 'Verified with a real image in this audit.',
  },
  'dots-studio/dots-3-note-preview:free': {
    label: 'Dots 3 Note Preview — free, vision',
    pricing: 'free',
    modalities: ['text', 'image'],
    vision: true,
    verified: true,
    jsonMode: true,
    reasoning: true,
    note: 'Verified with a real image in this audit.',
  },
  'meta-llama/llama-4-maverick': {
    label: 'Meta Llama 4 Maverick — vision, paid per token',
    pricing: '$0.1875/M input, $0.6525/M output',
    modalities: ['text', 'image'],
    vision: true,
    verified: true,
    jsonMode: true,
    reasoning: false,
    note: 'Paid Meta model. Verified with a real image; a small canary cost $0.0000219.',
  },
  'meta-llama/llama-4-scout': {
    label: 'Meta Llama 4 Scout — vision, paid per token',
    pricing: '$0.10/M input, $0.30/M output',
    modalities: ['text', 'image'],
    vision: true,
    verified: false,
    jsonMode: false,
    reasoning: false,
    note: 'Paid Meta model listed on this account. It was not image-tested in this audit; select it only if you accept that uncertainty and the price.',
  },
  'meta-llama/llama-3.3-70b-instruct': {
    label: 'Meta Llama 3.3 70B Instruct — text only, paid',
    pricing: '$0.10/M input, $0.32/M output',
    modalities: ['text'],
    vision: false,
    verified: false,
    note: 'Text-only. The app refuses to attach an image to this model.',
  },
  'meta-llama/llama-3.1-8b-instruct': {
    label: 'Meta Llama 3.1 8B Instruct — text only, paid',
    pricing: '$0.05/M input, $0.08/M output',
    modalities: ['text'],
    vision: false,
    verified: false,
    note: 'Text-only. The app refuses to attach an image to this model.',
  },
};

// Groq account models checked live on 2026-11-04. Whisper entries are audio
// transcription and Prompt Guard entries are classifiers, so neither is listed
// as a chat model. gpt-oss/qwen/allam are not Meta models; they are offered only
// for text chat and are labelled as such.
export const GROQ_TEXT_MODELS = {
  'meta-llama/llama-3.3-70b-versatile': {
    label: 'Meta Llama 3.3 70B Versatile — text, Meta',
    pricing: 'Groq account limits apply',
    modalities: ['text'],
    vision: false,
    verified: false,
    meta: true,
    note: 'Preferred Meta text model. It was not listed on the supplied restricted Groq account on 2026-11-04; Test key will show whether your account has it. It is text-only; images are refused.',
  },
  'openai/gpt-oss-120b': {
    label: 'OpenAI GPT-OSS 120B — text, verified (non-Meta)',
    pricing: 'Groq account limits apply',
    modalities: ['text'],
    vision: false,
    verified: true,
    note: 'Verified with a text-only request. Not a Meta model; kept as a fallback when a Meta model is unavailable on the account.',
  },
  'openai/gpt-oss-20b': {
    label: 'OpenAI GPT-OSS 20B — text (non-Meta)',
    pricing: 'Groq account limits apply',
    modalities: ['text'],
    vision: false,
    verified: false,
    note: 'Not a Meta model.',
  },
  'qwen/qwen3.8-27b': {
    label: 'Qwen 3.8 27B — text, verified',
    pricing: 'Groq account limits apply',
    modalities: ['text'],
    vision: false,
    verified: true,
    note: 'Verified with a text-only request. Not a Meta model.',
  },
  'allam-2-7b': {
    label: 'ALLaM 2 7B — text',
    pricing: 'Groq account limits apply',
    modalities: ['text'],
    vision: false,
    verified: false,
    note: 'Not a Meta model.',
  },
};

// Kept explicit so nothing can accidentally offer a classifier as a chat model.
export const GROQ_CLASSIFIERS = {
  'meta-llama/llama-prompt-guard-2-22m': 'Meta Llama Prompt Guard 2 22M — classifier only',
  'meta-llama/llama-prompt-guard-2-86m': 'Meta Llama Prompt Guard 2 86M — classifier only',
};

// Meta-first catalogues for the hosts that a browser cannot call directly.
// They are visible on the phone with the exact reason and endpoint, and are
// usable through the desktop app (server-side) or a user relay.
export const NVIDIA_MODELS = {
  'meta/muse-glimmer-30b': {
    label: 'Meta Muse Glimmer 30B — vision, verified on desktop',
    pricing: 'NVIDIA account limits apply',
    modalities: ['text', 'image'],
    vision: true,
    verified: true,
    note: 'Verified with a real image on 2026-11-04. Desktop/server-side only: no browser CORS.',
  },
  'meta/llama-3.2-11b-vision-instruct': {
    label: 'Meta Llama 3.2 Vision 11B — vision, desktop',
    pricing: 'NVIDIA account limits apply',
    modalities: ['text', 'image'],
    vision: true,
    verified: false,
    note: 'HTTP 404 on the supplied account during the audit. Desktop/server-side only.',
  },
  'meta/llama-3.2-90b-vision-instruct': {
    label: 'Meta Llama 3.2 Vision 90B — vision, desktop',
    pricing: 'NVIDIA account limits apply',
    modalities: ['text', 'image'],
    vision: true,
    verified: false,
    note: 'Timed out (>90 s) on the supplied account during the audit. Desktop/server-side only.',
  },
};

export const CLOUDFLARE_MODELS = {
  '@cf/meta/llama-3.2-11b-vision-instruct': {
    label: 'Meta Llama 3.2 Vision 11B — vision, verified on desktop',
    pricing: 'Cloudflare Workers AI pricing applies',
    modalities: ['text', 'image'],
    vision: true,
    verified: true,
    note: 'Verified with a real image after licence acceptance on 2026-11-04. Needs Account ID + token; desktop/server-side only.',
  },
  '@cf/meta/llama-4-scout-17b-16e-instruct': {
    label: 'Meta Llama 4 Scout 17B — vision, desktop',
    pricing: 'Cloudflare Workers AI pricing applies',
    modalities: ['text', 'image'],
    vision: true,
    verified: false,
    note: 'Listed on the account; not image-tested. Desktop/server-side only.',
  },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': {
    label: 'Meta Llama 3.3 70B Instruct — text, desktop',
    pricing: 'Cloudflare Workers AI pricing applies',
    modalities: ['text'],
    vision: false,
    verified: false,
    note: 'Text-only. Images are refused.',
  },
};

export const BLOCKRUN_MODELS = {
  'meta-llama/llama-4-maverick': {
    label: 'Meta Llama 4 Maverick — vision, paid',
    pricing: 'Paid x402 marketplace; price shown by BlockRun',
    modalities: ['text', 'image'],
    vision: true,
    verified: false,
    note: 'Supplied key returned HTTP 402 "Payment verification failed" and the host has no browser CORS. Paid; untested beyond the payment error.',
  },
  'meta-llama/llama-4-scout': {
    label: 'Meta Llama 4 Scout — vision, paid',
    pricing: 'Paid x402 marketplace; price shown by BlockRun',
    modalities: ['text', 'image'],
    vision: true,
    verified: false,
    note: 'Paid and untested. Needs credit and a server-side request.',
  },
  'meta-llama/llama-3.3-70b-instruct': {
    label: 'Meta Llama 3.3 70B Instruct — text, paid',
    pricing: 'Paid x402 marketplace; price shown by BlockRun',
    modalities: ['text'],
    vision: false,
    verified: false,
    note: 'Text-only. Images are refused.',
  },
};

export const MODAL_MODELS = {
  'meta-llama/Llama-4-Maverick-17B-128E-Instruct': {
    label: 'Meta Llama 4 Maverick — vision, your Modal deployment',
    pricing: 'Paid Modal compute; your deployment price',
    modalities: ['text', 'image'],
    vision: true,
    verified: false,
    note: 'NOT TESTED. Paste the HTTPS endpoint you deployed on Modal. The model must be one your deployment serves.',
  },
  'meta-llama/Llama-3.3-70B-Instruct': {
    label: 'Meta Llama 3.3 70B Instruct — text, your Modal deployment',
    pricing: 'Paid Modal compute; your deployment price',
    modalities: ['text'],
    vision: false,
    verified: false,
    note: 'NOT TESTED. Text-only; images are refused.',
  },
};

export const PROVIDER_MODELS = {
  openrouter: OPENROUTER_MODELS,
  groq: GROQ_TEXT_MODELS,
  'nvidia-nim': NVIDIA_MODELS,
  'cloudflare-workers-ai': CLOUDFLARE_MODELS,
  blockrun: BLOCKRUN_MODELS,
  modal: MODAL_MODELS,
};

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function endpointFor(providerId, baseUrl) {
  const provider = PROVIDERS[providerId];
  if (!provider?.requiresBaseUrl) return provider?.endpoint || '';
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
  return PROVIDERS[providerId]?.defaultModel || PROVIDERS.openrouter.defaultModel;
}

export function modelInfo(providerId, model) {
  const id = modelFor(providerId, model);
  return PROVIDER_MODELS[providerId]?.[id] || null;
}

/** Whether this provider can accept an image at all. Groq has no vision model. */
export function providerSupportsImages(providerId) {
  return providerId !== 'groq';
}

/** Known text-only models are refused before a request is made. */
export function modelAcceptsImages(providerId, model) {
  const info = modelInfo(providerId, model);
  if (info) return Boolean(info.vision);
  return providerSupportsImages(providerId);
}

function hostFor(provider, endpoint) {
  if (provider?.host) return provider.host;
  try { return new URL(endpoint).host; } catch { return ''; }
}

function friendlyHttpError(status, data, rawText) {
  const providerMessage = data?.error?.message || data?.message || '';
  const suffix = providerMessage ? ` Provider said: ${String(providerMessage).slice(0, 300)}` : '';
  if (status === 401) return `Key rejected (401). Check the key and that it belongs to this provider.${suffix}`;
  if (status === 402) return `Payment required (402). This provider key has no usable credit.${suffix}`;
  if (status === 403) return `Access denied (403). The key may not have this model enabled.${suffix}`;
  if (status === 404) return `Model not found (404). This account may not have access to the model.${suffix}`;
  if (status === 429) return `Rate limited (429). Wait a moment and retry.${suffix}`;
  if (status >= 500) return `Provider error (${status}). This is usually temporary.${suffix}`;
  const body = rawText ? ` Response: ${String(rawText).slice(0, 300)}` : '';
  return `Request failed (${status}).${suffix}${body}`;
}

function corsMessage(providerId) {
  if (providerId === 'custom') {
    return 'Network/CORS failure. The relay did not allow this browser origin, or the URL is wrong. It must be HTTPS and return Access-Control-Allow-Origin for this Pages origin.';
  }
  if (providerId === 'openrouter') {
    return 'Network failure. Check the connection. OpenRouter allowed this Pages origin in the audit, so a failure here is usually the network, a proxy, or a browser extension.';
  }
  if (providerId === 'groq') {
    return 'Network failure. Check the connection. Groq allowed this Pages origin in the audit, so a failure here is usually the network, a proxy, or a browser extension.';
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

function makeRequestId() {
  return `pwa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * One provider request. `imageDataUrl` is optional: text chat never passes it,
 * so no image_url content part is ever built. No retries are hidden here.
 *
 * The returned object always carries the exact request metadata the UI log
 * needs: endpoint, host, model, mode, HTTP status, request id and latency.
 * The API key is never included in the result or in any log text.
 */
export async function callModel({
  providerId = 'openrouter',
  apiKey,
  model,
  prompt,
  imageDataUrl = null,
  baseUrl = '',
  timeoutMs = 180000,
  expectJson = true,
  requestMode = '',
  fetchImpl = globalThis.fetch,
} = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) return fail('UNKNOWN_PROVIDER', 'Choose a provider.');
  const endpoint = endpointFor(providerId, baseUrl);
  if (!endpoint) {
    return fail('NO_ENDPOINT', 'This provider needs a valid HTTPS base URL in Settings.', {
      providerId,
      method: 'POST',
      endpoint: '',
      host: '',
      model: modelFor(providerId, model),
      mode: requestMode || (imageDataUrl ? 'vision' : 'chat'),
    });
  }
  const key = String(apiKey || '').trim();
  const requestedModel = modelFor(providerId, model);
  const mode = requestMode || (imageDataUrl ? 'vision' : 'chat');
  const requestId = makeRequestId();
  const host = hostFor(provider, endpoint);
  const meta = {
    providerId,
    providerLabel: provider.label,
    method: 'POST',
    endpoint,
    host,
    model: requestedModel,
    mode,
    requestId,
    startedAt: new Date().toISOString(),
  };

  if (!key) return fail('NO_KEY', 'Add a provider key in Settings first.', meta);

  if (provider.unavailableInBrowser) {
    return fail('PROVIDER_CORS_BLOCKED', provider.blockedMessage || `${provider.label} cannot be called from this browser because the host does not allow CORS. Use the desktop app or a user-owned relay.`, {
      ...meta,
      imageAttached: Boolean(imageDataUrl),
    });
  }

  if (imageDataUrl && !providerSupportsImages(providerId)) {
    return fail(
      'VISION_UNSUPPORTED',
      `${provider.label} has no vision model on this account. Its Meta entries are Prompt Guard classifiers, not visual models. Switch to OpenRouter, NVIDIA NIM (desktop) or Cloudflare (desktop), or use Chat for text.`,
      { ...meta, imageAttached: false },
    );
  }
  if (imageDataUrl && !modelAcceptsImages(providerId, requestedModel)) {
    return fail(
      'MODEL_TEXT_ONLY',
      `The selected model (${requestedModel}) is text-only. Choose a vision model such as ${PROVIDERS.openrouter.defaultModel}.`,
      { ...meta, imageAttached: false },
    );
  }

  const content = [{ type: 'text', text: String(prompt || '') }];
  if (imageDataUrl) {
    content.push({ type: 'image_url', image_url: { url: imageDataUrl } });
  }

  const info = modelInfo(providerId, requestedModel);
  const body = {
    model: requestedModel,
    messages: [{ role: 'user', content }],
    // Reasoning vision models can spend thousands of tokens before the JSON
    // answer. 3072 was not enough for the default free model with this prompt.
    max_tokens: expectJson ? 8192 : 3072,
    temperature: 0.2,
  };
  if (providerId === 'openrouter' && expectJson && info?.jsonMode) {
    body.response_format = { type: 'json_object' };
  }
  if (providerId === 'openrouter' && expectJson && info?.reasoning) {
    body.reasoning = { effort: 'low' };
  }

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
        ...meta,
        httpStatus: response.status,
        status: response.status,
        latencyMs: Date.now() - started,
        returnedModel: data?.model || null,
        imageAttached: Boolean(imageDataUrl),
      });
    }
    const message = data?.choices?.[0]?.message || {};
    const text = message.content || message.reasoning_content || message.reasoning || '';
    if (!text) {
      return fail('EMPTY_RESPONSE', 'The provider returned no text. The model may need a different id or more tokens.', {
        ...meta,
        httpStatus: response.status,
        status: response.status,
        latencyMs: Date.now() - started,
        returnedModel: data?.model || requestedModel,
        finishReason: data?.choices?.[0]?.finish_reason || null,
        usage: data?.usage || null,
        imageAttached: Boolean(imageDataUrl),
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
      ...meta,
      httpStatus: response.status,
      status: response.status,
      finishReason: data?.choices?.[0]?.finish_reason || null,
      usage: data?.usage || null,
      imageAttached: Boolean(imageDataUrl),
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return fail('TIMEOUT', `The request timed out after ${Math.round(timeoutMs / 1000)} s. Retry only if you accept a possible duplicate request.`, {
        ...meta,
        latencyMs: Date.now() - started,
        imageAttached: Boolean(imageDataUrl),
      });
    }
    return fail('NETWORK', corsMessage(providerId), {
      ...meta,
      detail: String(error?.message || error),
      latencyMs: Date.now() - started,
      imageAttached: Boolean(imageDataUrl),
    });
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
    requestMode: 'test',
    prompt: 'Reply with exactly one JSON object: {"ok":true}',
    timeoutMs: 30000,
  });
}

/** Text-only chat. Kept separate so it is impossible to attach an image by accident. */
export async function callChatModel(options) {
  return callModel({ ...options, imageDataUrl: null, expectJson: false, requestMode: 'chat' });
}
