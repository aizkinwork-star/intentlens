// Stable application errors (architecture.md §11.4).
// Routes throw these; one handler turns them into JSON. Messages are user-safe.
const TABLE = {
  COMMAND_MISSING: [400, 'Type or say a command first.'],
  CAMERA_FRAME_MISSING: [400, 'No camera frame was included. Start the camera or upload a photo.'],
  IMAGE_TOO_LARGE: [413, 'That image is too large to send. Try again with a smaller photo.'],
  BAD_JSON: [400, 'The request body was not valid JSON.'],
  MODEL_API_KEY_MISSING: [503, 'No cloud vision provider key is configured. Add one in Provider Setup.'],
  MODEL_AUTH_FAILED: [502, 'The provider rejected the saved key. Replace it in Provider Setup.'],
  MODEL_RATE_LIMITED: [429, 'The model is rate limited right now. Wait a moment and retry.'],
  MODEL_QUOTA_EXHAUSTED: [429, 'This provider quota is exhausted. Add credit or choose another provider.'],
  MODEL_TIMEOUT: [504, 'The model did not answer in time. Retry, or use a smaller image.'],
  MODEL_BAD_RESPONSE: [502, 'The model returned something that could not be read.'],
  MODEL_UPSTREAM_ERROR: [502, 'The model API returned an error.'],
  RESULT_SCHEMA_INVALID: [502, 'The model result failed validation, so nothing was drawn.'],
  SEARCH_FAILED: [502, 'Web search failed. The answer is not web-grounded.'],
  NOT_FOUND: [404, 'Not found.'],
  METHOD_NOT_ALLOWED: [405, 'Method not allowed.'],
  INTERNAL_ERROR: [500, 'Something went wrong on the server.'],
  AI_NOT_CONFIGURED: [503, 'No vision model is configured. Connect a provider first.'],
  NETWORK_DISABLED: [503, 'Outbound network is disabled. Set ALLOW_OUTBOUND_NETWORK=true to use a cloud provider.'],
  INPUT_TOKEN_LIMIT: [413, 'This request is larger than the configured input token cap.'],
  REQUEST_COST_LIMIT: [402, 'This request would exceed the per-request cost cap.'],
  BUDGET_EXCEEDED: [402, 'The daily or monthly cost budget is exhausted.'],
};

const RETRYABLE = new Set([
  'MODEL_RATE_LIMITED',
  'MODEL_QUOTA_EXHAUSTED',
  'MODEL_TIMEOUT',
  'MODEL_UPSTREAM_ERROR',
  'SEARCH_FAILED',
]);

export function appError(code, message) {
  const [status, fallback] = TABLE[code] || TABLE.INTERNAL_ERROR;
  const err = new Error(message || fallback);
  err.name = 'AppError';
  err.code = TABLE[code] ? code : 'INTERNAL_ERROR';
  err.status = status;
  err.retryable = RETRYABLE.has(code);
  err.expose = true;
  return err;
}

export function errorPayload(err) {
  const isApp = err?.name === 'AppError';
  const code = isApp ? err.code : (err?.code || 'INTERNAL_ERROR');
  const message = err?.message || 'Something went wrong on the server.';
  return {
    error: {
      code,
      message,
      detail: err?.detail,
      retryable: isApp ? Boolean(err.retryable) : false,
      category: providerErrorCategory(code),
      ...(err?.attempts ? { attempts: err.attempts } : {}),
      ...(err?.providerHealth ? { providerHealth: err.providerHealth } : {}),
    },
  };
}

export function providerErrorCategory(code) {
  if (code === 'MODEL_AUTH_FAILED') return 'provider_auth';
  if (code === 'MODEL_RATE_LIMITED') return 'rate_limit';
  if (code === 'MODEL_QUOTA_EXHAUSTED') return 'quota';
  if (code === 'MODEL_TIMEOUT') return 'timeout';
  if (code === 'MODEL_UPSTREAM_ERROR') return 'upstream';
  if (code === 'UNAUTHORIZED') return 'app_session';
  return 'application';
}
