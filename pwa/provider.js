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
    label: 'OpenRouter — free vision + Meta models',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    host: 'openrouter.ai',
    defaultModel: 'nvidia/nemotron-3.5-super-vl:free',
    browserCors: 'verified-allowed',
    vision: 'verified-free',
    consent: false,
    retention: 'OpenRouter routes each request to the upstream model provider. Check that model page for its data policy; free does not automatically mean private.',
    note: 'Direct browser CORS and a real image request were verified on 2026-11-04: CORS from a GitHub Pages origin, the image request against the provider with the real key. The default is a free vision model. Paid Meta Maverick/Scout are selectable with their price shown; nothing is charged unless you choose one.',
  },
  groq: {
    id: 'groq',
    label: 'Groq — text only on this account',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    host: 'api.groq.com',
    defaultModel: 'openai/gpt-oss-120b',
    browserCors: 'verified-allowed',
    vision: 'none',
    consent: false,
    retention: 'Groq API terms apply; text prompts are sent to Groq for this request.',
    note: 'Live account check on 2026-11-04 listed 11 models. The only Meta entries are Llama Prompt Guard 2 22M/86M, which are prompt-injection classifiers and cannot answer questions or read images. There is no vision model here, so image requests are refused before any network call. Text chat works with the listed non-Meta models.',
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
    retention: 'Your relay decides retention and training. Do not point this at a service you do not trust.',
    note: 'Use your own HTTPS relay when a provider blocks browser CORS (for example NVIDIA NIM or Cloudflare Workers AI). The relay must forward to the model you trust and return Access-Control-Allow-Origin for this Pages origin. This app never operates a relay for you.',
  },
};

export const PROVIDER_ORDER = ['openrouter', 'groq', 'custom'];

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
  'openai/gpt-oss-120b': {
    label: 'OpenAI GPT-OSS 120B — text, verified',
    pricing: 'Groq account limits apply',
    modalities: ['text'],
    vision: false,
    verified: true,
    note: 'Verified with a text-only request. Not a Meta model.',
  },
  'openai/gpt-oss-20b': {
    label: 'OpenAI GPT-OSS 20B — text',
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
  return PROVIDERS[providerId]?.defaultModel || PROVIDERS.openrouter.defaultModel;
}

export function modelInfo(providerId, model) {
  const id = modelFor(providerId, model);
  if (providerId === 'openrouter') return OPENROUTER_MODELS[id] || null;
  if (providerId === 'groq') return GROQ_TEXT_MODELS[id] || null;
  return null;
}

/** Whether this provider can accept an image at all. Groq cannot on this account. */
export function providerSupportsImages(providerId) {
  return providerId === 'openrouter' || providerId === 'custom';
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

  if (imageDataUrl && !providerSupportsImages(providerId)) {
    return fail(
      'VISION_UNSUPPORTED',
      `${provider.label} cannot accept images on this account. Its Meta entries are Prompt Guard classifiers, not visual models. Switch to OpenRouter or use a relay for images, or use Chat for text.`,
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
