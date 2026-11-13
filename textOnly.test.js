import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// Speaking an answer aloud is allowed. Listening is not: no microphone capture,
// no speech recognition, no recording and no transcription endpoint.
const listeningPattern = /SpeechRecognition|webkitSpeechRecognition|MediaRecorder|getUserMedia\(\s*\{[^}]*audio\s*:\s*true|\/api\/transcribe|transcribe\.js|IntentLensTTS/i;

test('desktop UI offers read-aloud but no microphone controls', () => {
  const html = read('./index.html');
  assert.match(html, /id="readAloudBtn"/);
  assert.match(html, /id="stopReadAloudBtn"/);
  assert.doesNotMatch(html, /id=["'](?:mic|micAuto|wsStop)["']/i);
  assert.doesNotMatch(html, /\b(?:start listening|mic on start)\b/i);
});

test('desktop runtime has no speech recognition, recording or transcription path', () => {
  const app = read('./app.js');
  assert.doesNotMatch(app, listeningPattern);
  assert.doesNotMatch(read('./assistantActions.js'), listeningPattern);
  // Synthesis lives in exactly one module so it stays auditable.
  assert.doesNotMatch(app, /speechSynthesis/i);
  assert.match(app, /from '\.\/speech\.js'/);
});

test('the speech module is synthesis-only', () => {
  const speech = read('./speech.js');
  assert.match(speech, /speechSynthesis/);
  assert.doesNotMatch(speech, /SpeechRecognition|webkitSpeechRecognition|MediaRecorder|getUserMedia|AudioContext/i);
});

test('PWA offers read-aloud but no microphone or recognition path', () => {
  const html = read('./pwa/index.html');
  assert.match(html, /id="readAloudBtn"/);
  assert.match(html, /id="stopReadAloudBtn"/);
  assert.doesNotMatch(html, /id=["'](?:micBtn|ttsToggle)["']/i);
  const app = read('./pwa/app.js');
  assert.doesNotMatch(app, listeningPattern);
  assert.doesNotMatch(app, /speechSynthesis/i);
  assert.match(app, /from '\.\/lib\/speech\.js'/);
});

test('server no longer exposes or ships a transcription endpoint', () => {
  assert.doesNotMatch(read('./server/index.js'), /\/api\/transcribe|routes\/transcribe/i);
  assert.equal(existsSync(new URL('./server/routes/transcribe.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('./transcribe.test.js', import.meta.url)), false);
});

test('packaging and service-worker shells ship only the browser speech module', () => {
  assert.doesNotMatch(read('./electron/package.json'), /intentlens_tts/i);
  assert.doesNotMatch(read('./scripts/prepare-pwa.mjs'), /intentlens_tts/i);
  assert.doesNotMatch(read('./pwa/sw.js'), /intentlens_tts/i);
  assert.doesNotMatch(read('./sw.js'), /intentlens_tts/i);
  assert.match(read('./scripts/prepare-pwa.mjs'), /'speech\.js'/);
  assert.match(read('./pwa/sw.js'), /\.\/lib\/speech\.js/);
});
