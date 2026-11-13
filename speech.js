// speech.js — read the written answer aloud with the browser's built-in voice.
//
// Synthesis only. This module never opens the microphone, never recognises
// speech and never records audio. It is deliberately the one place that touches
// `speechSynthesis`, so the rest of the app stays inspectable.
//
// The controller is injectable so tests (and a future native voice) can run
// without a DOM.

/** Answers are short by design; this bounds how much text a voice reads out. */
export const MAX_SPEECH_CHARS = 600;

/** Default delivery: slightly slower than normal, which helps beginners follow. */
export const DEFAULT_SPEECH_OPTIONS = Object.freeze({ rate: 0.95, pitch: 1 });

/**
 * Turn model/answer text into something worth hearing: strip code fences,
 * markdown punctuation and stray JSON braces, collapse whitespace, and cut at a
 * sentence boundary so the voice never stops mid-word.
 */
export function normalizeSpeechText(text, limit = MAX_SPEECH_CHARS) {
  const clean = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[#*_>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  if (!Number.isFinite(limit) || limit <= 0 || clean.length <= limit) return clean;

  const clipped = clean.slice(0, limit);
  const boundary = Math.max(
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf('! '),
    clipped.lastIndexOf('? '),
  );
  const cut = boundary >= limit * 0.5 ? clipped.slice(0, boundary + 1) : clipped;
  return cut.trim();
}

/**
 * Wrap a speech engine in a small state machine.
 *
 * `engine` is `{ speak(text, { onEnd }), cancel?() }` or null when unsupported.
 * Returns `{ supported, speaking, speak(text, options), stop() }`.
 */
export function createSpeechController(engine = null) {
  const supported = Boolean(engine && typeof engine.speak === 'function');
  let speaking = false;

  const finish = () => { speaking = false; };

  return {
    get supported() { return supported; },
    get speaking() { return speaking; },

    speak(text, options = {}) {
      if (!supported) return { ok: false, reason: 'unsupported', spoken: '' };
      const spoken = normalizeSpeechText(text, options.limit ?? MAX_SPEECH_CHARS);
      if (!spoken) return { ok: false, reason: 'empty', spoken: '' };

      // One answer at a time: a second tap replaces the first instead of queueing.
      try { engine.cancel?.(); } catch { /* an engine that cannot cancel is still usable */ }

      speaking = true;
      try {
        engine.speak(spoken, {
          ...DEFAULT_SPEECH_OPTIONS,
          ...options,
          onEnd: () => { finish(); options.onEnd?.(); },
        });
      } catch (err) {
        speaking = false;
        return { ok: false, reason: 'engine_error', spoken, error: err?.message || String(err) };
      }
      return { ok: true, reason: 'spoken', spoken };
    },

    stop() {
      if (supported) {
        try { engine.cancel?.(); } catch { /* ignore */ }
      }
      const wasSpeaking = speaking;
      speaking = false;
      return { ok: wasSpeaking, reason: wasSpeaking ? 'stopped' : 'idle' };
    },
  };
}

/**
 * Build a controller backed by the browser Web Speech API. Returns an
 * unsupported controller (all calls are inert) when the API is missing, which is
 * the case in Node, in some embedded webviews, and when the user has no voices.
 */
export function browserSpeechController(scope = globalThis) {
  const synth = scope?.speechSynthesis;
  const Utterance = scope?.SpeechSynthesisUtterance;
  if (!synth || typeof synth.speak !== 'function' || typeof Utterance !== 'function') {
    return createSpeechController(null);
  }

  return createSpeechController({
    speak(text, { onEnd, lang, rate, pitch } = {}) {
      const utterance = new Utterance(text);
      utterance.lang = lang || scope?.navigator?.language || 'en-US';
      utterance.rate = Number(rate) > 0 ? Number(rate) : DEFAULT_SPEECH_OPTIONS.rate;
      utterance.pitch = Number(pitch) > 0 ? Number(pitch) : DEFAULT_SPEECH_OPTIONS.pitch;
      utterance.onend = () => onEnd?.();
      utterance.onerror = () => onEnd?.();
      synth.speak(utterance);
      return utterance;
    },
    cancel() { synth.cancel(); },
  });
}
