import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SPEECH_CHARS,
  DEFAULT_SPEECH_OPTIONS,
  normalizeSpeechText,
  createSpeechController,
  browserSpeechController,
} from './speech.js';

function fakeEngine() {
  const calls = [];
  return {
    calls,
    cancelled: 0,
    speak(text, options) { calls.push({ text, options }); },
    cancel() { this.cancelled += 1; },
  };
}

test('normalizeSpeechText strips markdown and collapses whitespace', () => {
  const out = normalizeSpeechText('  ### Check **the** `anode` lead.\n\nUse https://example.com now.  ');
  assert.equal(out, 'Check the lead. Use now.');
});

test('normalizeSpeechText drops code fences entirely', () => {
  const out = normalizeSpeechText('Wire it like this:\n```js\nanalogWrite(9, 128);\n```\nThen power on.');
  assert.equal(out, 'Wire it like this: Then power on.');
});

test('normalizeSpeechText is bounded and cuts on a sentence boundary', () => {
  const first = `${'a'.repeat(200)}.`;
  const text = `${first} ${'b'.repeat(400)}.`;
  const out = normalizeSpeechText(text, 250);
  assert.ok(out.length <= 250);
  assert.equal(out, first);
});

test('a long run with no sentence boundary still respects the limit', () => {
  const out = normalizeSpeechText('c'.repeat(1_000), 100);
  assert.equal(out.length, 100);
});

test('normalizeSpeechText returns empty for empty or whitespace input', () => {
  assert.equal(normalizeSpeechText(''), '');
  assert.equal(normalizeSpeechText(null), '');
  assert.equal(normalizeSpeechText('   \n '), '');
});

test('the default limit is a real bound', () => {
  assert.ok(MAX_SPEECH_CHARS > 0);
  assert.ok(normalizeSpeechText('word '.repeat(1000)).length <= MAX_SPEECH_CHARS);
});

test('an unsupported engine is inert and never throws', () => {
  const controller = createSpeechController(null);
  assert.equal(controller.supported, false);
  assert.deepEqual(controller.speak('hello'), { ok: false, reason: 'unsupported', spoken: '' });
  assert.deepEqual(controller.stop(), { ok: false, reason: 'idle' });
});

test('speak passes cleaned text and the default delivery options', () => {
  const engine = fakeEngine();
  const controller = createSpeechController(engine);
  const result = controller.speak('### Step one\n\nUnplug the board.');
  assert.equal(result.ok, true);
  assert.equal(result.spoken, 'Step one Unplug the board.');
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].text, 'Step one Unplug the board.');
  assert.equal(engine.calls[0].options.rate, DEFAULT_SPEECH_OPTIONS.rate);
  assert.equal(controller.speaking, true);
});

test('a second speak cancels the previous utterance instead of queueing', () => {
  const engine = fakeEngine();
  const controller = createSpeechController(engine);
  controller.speak('first');
  controller.speak('second');
  assert.equal(engine.cancelled, 2, 'cancel runs before each new utterance');
  assert.equal(engine.calls.at(-1).text, 'second');
});

test('the end callback clears the speaking flag', () => {
  const engine = fakeEngine();
  const controller = createSpeechController(engine);
  let ended = 0;
  controller.speak('hello', { onEnd: () => { ended += 1; } });
  engine.calls[0].options.onEnd();
  assert.equal(controller.speaking, false);
  assert.equal(ended, 1);
});

test('stop cancels speech and reports the transition', () => {
  const engine = fakeEngine();
  const controller = createSpeechController(engine);
  controller.speak('hello');
  assert.equal(controller.stop().reason, 'stopped');
  assert.equal(controller.stop().reason, 'idle');
  assert.equal(controller.speaking, false);
});

test('empty answers are refused rather than spoken', () => {
  const engine = fakeEngine();
  const controller = createSpeechController(engine);
  assert.equal(controller.speak('   ').reason, 'empty');
  assert.equal(engine.calls.length, 0);
});

test('a throwing engine reports an error and resets speaking', () => {
  const controller = createSpeechController({ speak() { throw new Error('voice busy'); } });
  const result = controller.speak('hello');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'engine_error');
  assert.match(result.error, /voice busy/);
  assert.equal(controller.speaking, false);
});

test('browserSpeechController is unsupported without the Web Speech API', () => {
  assert.equal(browserSpeechController({}).supported, false);
  assert.equal(browserSpeechController(undefined).supported, false);
});

test('browserSpeechController speaks through an injected speechSynthesis', () => {
  const spoken = [];
  const scope = {
    navigator: { language: 'en-GB' },
    speechSynthesis: {
      speak(utterance) { spoken.push(utterance); },
      cancel() {},
    },
    SpeechSynthesisUtterance: class {
      constructor(text) { this.text = text; }
    },
  };
  const controller = browserSpeechController(scope);
  assert.equal(controller.supported, true);
  const result = controller.speak('Unplug the board first.');
  assert.equal(result.ok, true);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, 'Unplug the board first.');
  assert.equal(spoken[0].lang, 'en-GB');
  assert.equal(spoken[0].rate, DEFAULT_SPEECH_OPTIONS.rate);
  // The browser reports completion through the utterance callback.
  spoken[0].onend();
  assert.equal(controller.speaking, false);
});
