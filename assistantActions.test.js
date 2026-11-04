import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatAnswer, explainAnswer, safeSpeak } from './assistantActions.js';

function speechSpy({ fail = false } = {}) {
  const calls = [];
  const speak = async (text) => {
    calls.push(text);
    if (fail) throw new Error('speech synthesis unavailable');
  };
  return { speak, calls };
}

test('Repeat reuses the stored answer and issues zero AI requests', async () => {
  const spy = speechSpy();
  let aiCalls = 0;
  const result = await repeatAnswer({
    lastAnswer: { text: 'Unplug the power before moving the wire.' },
    speak: spy.speak,
    requestExplain: () => { aiCalls += 1; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.aiRequests, 0);
  assert.equal(aiCalls, 0);
  assert.equal(result.text, 'Unplug the power before moving the wire.');
  assert.deepEqual(spy.calls, ['Unplug the power before moving the wire.']);
});

test('Explain issues exactly one AI request and speaks the expanded answer', async () => {
  const spy = speechSpy();
  let aiCalls = 0;
  const result = await explainAnswer({
    lastAnswer: { text: 'Check the LED polarity.' },
    requestExplain: async () => {
      aiCalls += 1;
      return { status: 'ok', answer: '1. Find the longer leg.\n2. Put it toward the resistor.' };
    },
    speak: spy.speak,
  });
  assert.equal(result.ok, true);
  assert.equal(result.aiRequests, 1);
  assert.equal(aiCalls, 1);
  assert.match(result.text, /longer leg/);
  assert.deepEqual(spy.calls, [result.text]);
});

test('Explain does not retry a failed request', async () => {
  let aiCalls = 0;
  const result = await explainAnswer({
    lastAnswer: { text: 'Previous answer' },
    requestExplain: async () => { aiCalls += 1; throw new Error('network down'); },
  });
  assert.equal(aiCalls, 1);
  assert.equal(result.aiRequests, 1);
  assert.equal(result.ok, false);
  assert.equal(result.text, 'Previous answer');
});

test('a TTS failure keeps the text response', async () => {
  const spy = speechSpy({ fail: true });
  const result = await explainAnswer({
    lastAnswer: { text: 'Unplug the power.' },
    requestExplain: async () => ({ status: 'ok', answer: 'Step 1: unplug the power.' }),
    speak: spy.speak,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Step 1: unplug the power.');
  assert.equal(result.speech.ok, false);
  assert.equal(result.speech.reason, 'tts_failed');
  assert.equal(result.speech.text, result.text);
});

test('provider unavailable is reported without losing the previous answer', async () => {
  const result = await explainAnswer({
    lastAnswer: { text: 'Previous answer' },
    requestExplain: async () => ({
      status: 'unavailable',
      message: 'No Meta vision provider is configured.',
    }),
  });
  assert.equal(result.aiRequests, 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'provider_unavailable');
  assert.equal(result.text, 'Previous answer');
});

test('safeSpeak with no function reports unavailability and retains text', async () => {
  const result = await safeSpeak('Keep this instruction', null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'tts_unavailable');
  assert.equal(result.text, 'Keep this instruction');
});
