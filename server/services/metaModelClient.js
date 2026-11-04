// Meta Model API adapter (Responses API). The only file that knows the provider.
//
// Verified against dev.meta.ai on 2026-10-26:
//   POST https://api.meta.ai/v1/responses
//   model muse-spark-1.3
//   image  -> user message content block { type:'input_image', image_url }  (string)
//   schema -> text.format = { type:'json_schema', name, schema, strict }
//   search -> tools:[{type:'web_search'}], include:['web_search_call.results']
//   proof of search -> an output item with type 'web_search_call'
//   citations -> output_text blocks carry annotations[{type:'url_citation',url,title,...}]
//
// Nothing here trusts the model's prose about citations or searching: only the
// structured response items count.
import { config } from '../config.js';
import { appError } from '../lib/errors.js';
import { GROUNDING_SCHEMA } from './groundingSchema.js';

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function mapHttpError(status, body) {
  const detail = typeof body === 'string' ? body.slice(0, 400) : JSON.stringify(body ?? {}).slice(0, 400);
  if (status === 401 || status === 403) {
    return appError('MODEL_AUTH_FAILED', `The model API rejected the key (HTTP ${status}). ${detail}`);
  }
  if (status === 429) return appError('MODEL_RATE_LIMITED');
  if (status === 408 || status === 504) return appError('MODEL_TIMEOUT');
  if (status === 400) {
    // Most likely a parameter this deployment does not accept. The caller can retry
    // without `instructions`; surface the provider message so that is debuggable.
    const err = appError('MODEL_UPSTREAM_ERROR', `The model API rejected the request (HTTP 400). ${detail}`);
    err.badRequest = true;
    return err;
  }
  return appError('MODEL_UPSTREAM_ERROR', `The model API returned HTTP ${status}. ${detail}`);
}

function buildBody({ instructions, userText, imageDataUrl, allowWebSearch, keepInstructions }) {
  const body = {
    model: config.modelId,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: keepInstructions ? `${instructions}\n\n${userText}` : userText },
          { type: 'input_image', image_url: imageDataUrl },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'intentlens_grounding',
        schema: GROUNDING_SCHEMA,
        strict: true,
      },
    },
  };
  if (keepInstructions === false) body.instructions = instructions;
  if (allowWebSearch) {
    body.tools = [{ type: 'web_search' }];
    body.include = ['web_search_call.results'];
  }
  return body;
}

async function postOnce(body, signal) {
  const res = await fetch(`${config.modelBaseUrl}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.modelApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const err = mapHttpError(res.status, parsed ?? text);
    err.status = res.status;
    throw err;
  }
  if (!parsed) throw appError('MODEL_BAD_RESPONSE', 'The model API returned an empty body.');
  return parsed;
}

// Pull the parts we are allowed to trust out of a Responses API payload.
export function readResponsePayload(payload) {
  const output = Array.isArray(payload.output) ? payload.output : [];

  const searchedWeb = output.some((item) => item?.type === 'web_search_call');

  let text = typeof payload.output_text === 'string' ? payload.output_text : '';
  const textParts = [];
  const citations = [];

  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (block?.type !== 'output_text' || typeof block.text !== 'string') continue;
      textParts.push(block.text);
      for (const ann of block.annotations || []) {
        if (ann?.type !== 'url_citation' || typeof ann.url !== 'string') continue;
        const cited =
          typeof ann.start_index === 'number' && typeof ann.end_index === 'number'
            ? block.text.slice(ann.start_index, ann.end_index).trim()
            : '';
        citations.push({ title: ann.title || ann.url, url: ann.url, citedText: cited });
      }
    }
  }

  if (!text) text = textParts.join('\n');

  // The same page is often cited several times; keep one entry per (url, snippet).
  const seen = new Set();
  const uniqueCitations = citations.filter((c) => {
    const key = `${c.url}|${c.citedText}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    text,
    searchedWeb,
    citations: uniqueCitations,
    usage: payload.usage || null,
    responseId: payload.id || null,
  };
}

export async function callGroundingModel({ instructions, userText, imageDataUrl, allowWebSearch, signal }) {
  if (!config.modelApiKey) throw appError('MODEL_API_KEY_MISSING');

  // One retry for transient provider trouble, plus one adaptation if the deployment
  // rejects `instructions`. Never more than three attempts in total.
  const timeout = AbortSignal.timeout(config.modelTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let attempt = 0;
  let keepInstructions = false; // false => instructions passed as a top-level field
  let lastError = null;

  while (attempt < 3) {
    attempt += 1;
    try {
      const payload = await postOnce(buildBody({ instructions, userText, imageDataUrl, allowWebSearch, keepInstructions }), combined);
      return readResponsePayload(payload);
    } catch (err) {
      if (signal?.aborted) throw err; // the browser cancelled; nothing to retry
      lastError = err;

      if (err.name === 'TimeoutError') throw appError('MODEL_TIMEOUT');
      if (err.name === 'AbortError') throw appError('MODEL_TIMEOUT');

      if (err.badRequest && !keepInstructions) {
        // Retry once with the policy text folded into the user message.
        keepInstructions = true;
        continue;
      }
      if (err.status && RETRYABLE_STATUS.has(err.status) && attempt < 2) continue;
      throw err;
    }
  }

  throw lastError || appError('MODEL_UPSTREAM_ERROR');
}
