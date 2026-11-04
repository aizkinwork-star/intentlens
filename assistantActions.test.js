import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatAnswer, explainAnswer } from './assistantActions.js';

test('Repeat reuses the stored answer and issues zero AI requests', async () => {
  let aiCalls = 0;
  const result = await repeatAnswer({
    lastAnswer: { text: 'Unplug the power before moving the wire.' },
    requestExplain: () => { aiCalls += 1; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.aiRequests, 0);
  assert.equal(aiCalls, 0);
  assert.equal(result.text, 'Unplug the power before moving the wire.');
});

test('Repeat without a previous answer makes no request', async () => {
  const result = await repeatAnswer();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_previous_answer');
  assert.equal(result.aiRequests, 0);
});

test('Explain issues exactly one AI request and returns the expanded text', async () => {
  let aiCalls = 0;
  const result = await explainAnswer({
    lastAnswer: { text: 'Check the LED polarity.' },
    requestExplain: async () => {
      aiCalls += 1;
      return { status: 'ok', answer: '1. Find the longer leg.\\n2. Put it toward the resistor.' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.aiRequests, 1);
  assert.equal(aiCalls, 1);
  assert.match(result.text, /longer leg/);
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
