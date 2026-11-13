import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ELECTROCOM61_CLASSES,
  displayLabel,
  isKnownComponentClass,
} from './componentVocabulary.js';
import { buildComponentPrompt } from './server/services/componentSchema.js';
import { buildComponentPrompt as buildPwaPrompt } from './pwa/prompt.js';

test('the committed vocabulary is the full, unique ElectroCom61 label set', () => {
  assert.equal(ELECTROCOM61_CLASSES.length, 61);
  assert.equal(new Set(ELECTROCOM61_CLASSES).size, 61, 'labels must be unique');
  for (const name of ELECTROCOM61_CLASSES) {
    assert.equal(typeof name, 'string');
    assert.ok(name.trim().length > 0, name);
    assert.equal(name, name.trim());
  }
});

test('dataset labels are readable without losing the raw id', () => {
  assert.equal(displayLabel('FT-232-USB-Serial-Module'), 'Ft 232 usb serial module');
  assert.equal(displayLabel('Resistor'), 'Resistor');
  assert.equal(displayLabel(''), '');
  assert.equal(isKnownComponentClass('Resistor'), true);
  assert.equal(isKnownComponentClass('resistor'), false, 'the model emits exact labels');
  assert.equal(isKnownComponentClass('Quantum Flux Capacitor'), false);
});

test('the desktop prompt carries the vocabulary as context, not a command', () => {
  const prompt = buildComponentPrompt({ datasetClasses: ELECTROCOM61_CLASSES });
  assert.match(prompt.userText, /"datasetVocabulary"/);
  assert.match(prompt.instructions, /unverified guesses|weak hints/i);
  assert.ok(prompt.userText.includes('"Resistor"'));
  assert.ok(prompt.userText.includes('"ESP32-CAM"'));
});

test('the PWA prompt has the same vocabulary and candidate contract', () => {
  const prompt = buildPwaPrompt({
    datasetClasses: ELECTROCOM61_CLASSES,
    localCandidates: [{ name: 'Resistor', confidence: 0.81 }],
  });
  assert.match(prompt.userText, /"datasetVocabulary"/);
  assert.match(prompt.userText, /not a guarantee/);
  assert.match(prompt.instructions, /unverified guesses/i);
  assert.ok(prompt.userText.includes('"name": "Resistor"'));
  assert.ok(prompt.userText.includes('"confidence": 0.81'));
});
