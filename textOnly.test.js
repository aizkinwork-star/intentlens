import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const speechRuntimePattern = /SpeechRecognition|webkitSpeechRecognition|speechSynthesis|MediaRecorder|IntentLensTTS|\/api\/transcribe|transcribe\.js/i;

test('desktop UI has no microphone or speech controls', () => {
  const html = read('./index.html');
  assert.doesNotMatch(html, /id=["'](?:mic|micAuto|ttsSpeak|ttsTest|ttsStop|wsStop)["']/i);
  assert.doesNotMatch(html, /\b(?:start listening|mic on start|speak instruction|test voice|stop voice)\b/i);
});

test('desktop runtime has no speech recognition, recording, or synthesis path', () => {
  assert.doesNotMatch(read('./app.js'), speechRuntimePattern);
  assert.doesNotMatch(read('./assistantActions.js'), /safeSpeak|speak\s*:/i);
});

test('PWA UI and runtime have no microphone or speech path', () => {
  const html = read('./pwa/index.html');
  assert.doesNotMatch(html, /id=["'](?:micBtn|speakBtn|ttsToggle)["']/i);
  assert.doesNotMatch(read('./pwa/app.js'), speechRuntimePattern);
});

test('server no longer exposes or ships a transcription endpoint', () => {
  assert.doesNotMatch(read('./server/index.js'), /\/api\/transcribe|routes\/transcribe/i);
  assert.equal(existsSync(new URL('./server/routes/transcribe.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('./transcribe.test.js', import.meta.url)), false);
});

test('packaging and service-worker shells do not include the removed TTS module', () => {
  assert.doesNotMatch(read('./electron/package.json'), /intentlens_tts/i);
  assert.doesNotMatch(read('./scripts/prepare-pwa.mjs'), /intentlens_tts/i);
  assert.doesNotMatch(read('./pwa/sw.js'), /intentlens_tts/i);
  assert.doesNotMatch(read('./sw.js'), /intentlens_tts/i);
});
