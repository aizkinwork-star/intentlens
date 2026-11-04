// assistantActions.js — Repeat vs Explain, with explicit request accounting.
//
// REPEAT: reuse the exact stored answer. Zero inference requests, zero new turns.
// EXPLAIN: exactly one inference request, then speak the new answer.
// A text-to-speech failure never removes the text.

export async function safeSpeak(text, speak) {
  const value = String(text || '');
  if (!value) return { ok: false, reason: 'no_text', text: '', error: null };
  if (typeof speak !== 'function') return { ok: false, reason: 'tts_unavailable', text: value, error: null };
  try {
    await speak(value);
    return { ok: true, reason: 'spoken', text: value, error: null };
  } catch (err) {
    return { ok: false, reason: 'tts_failed', text: value, error: err?.message || String(err) };
  }
}

/**
 * Repeat the stored answer. `speak` is optional and must not perform inference.
 * The returned aiRequests is always 0.
 */
export async function repeatAnswer({ lastAnswer, speak } = {}) {
  const text = String(lastAnswer?.text || '');
  if (!text) {
    return { ok: false, reason: 'no_previous_answer', text: '', aiRequests: 0, speech: null };
  }
  const speech = await safeSpeak(text, speak);
  return { ok: true, reason: speech.reason, text, aiRequests: 0, speech };
}

/**
 * Request one explanation and speak it. `requestExplain` performs exactly one
 * network call; this function calls it exactly once and never retries.
 */
export async function explainAnswer({ lastAnswer, requestExplain, speak } = {}) {
  const previous = String(lastAnswer?.text || '');
  if (!previous) {
    return { ok: false, reason: 'no_previous_answer', text: '', aiRequests: 0, speech: null };
  }
  if (typeof requestExplain !== 'function') {
    return { ok: false, reason: 'explain_unavailable', text: previous, aiRequests: 0, speech: null };
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
      speech: null,
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
      speech: null,
    };
  }

  const speech = await safeSpeak(answer, speak);
  return { ok: true, reason: speech.reason, text: answer, aiRequests: 1, response, speech };
}
