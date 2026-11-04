// assistantActions.js — text-only Repeat and Explain actions.
//
// REPEAT reuses the stored answer and makes zero inference requests.
// EXPLAIN performs exactly one inference request and returns the text result.

export async function repeatAnswer({ lastAnswer } = {}) {
  const text = String(lastAnswer?.text || '');
  if (!text) {
    return { ok: false, reason: 'no_previous_answer', text: '', aiRequests: 0 };
  }
  return { ok: true, reason: 'repeated', text, aiRequests: 0 };
}

/**
 * Request one explanation. `requestExplain` is called exactly once and never retried.
 */
export async function explainAnswer({ lastAnswer, requestExplain } = {}) {
  const previous = String(lastAnswer?.text || '');
  if (!previous) {
    return { ok: false, reason: 'no_previous_answer', text: '', aiRequests: 0 };
  }
  if (typeof requestExplain !== 'function') {
    return { ok: false, reason: 'explain_unavailable', text: previous, aiRequests: 0 };
  }

  let response;
  try {
    response = await requestExplain(lastAnswer);
  } catch (err) {
    return {
      ok: false,
      reason: 'request_failed',
      text: previous,
      aiRequests: 1,
      error: err?.message || String(err),
    };
  }

  const answer = String(response?.answer || '');
  if (!answer) {
    return {
      ok: false,
      reason: response?.status === 'unavailable' ? 'provider_unavailable' : 'empty_answer',
      text: previous,
      aiRequests: 1,
      message: response?.message || null,
    };
  }

  return { ok: true, reason: 'explained', text: answer, aiRequests: 1, response };
}
