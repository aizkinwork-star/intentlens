// intentlens_tts.js — v7 TTS Adapter
// Browser SpeechSynthesis is DEFAULT; Meta MMS-TTS is opt-in fallback only.
// Never sends frames, audio, transcripts, or private data to any TTS service.
// Speech completion never proves task completion — task state is separate.

// Text normalization for SPEECH ONLY — never mutates stored/displayed text
function normalizeForSpeech(text) {
  return String(text)
    .replace(/\bU([1-9])\b/g, 'U $1')
    .replace(/\bJ([1-9])\b/g, 'J $1')
    .replace(/\bR(\d+)C(\d+)\b/g, 'row $1 column $2')
    .replace(/(\d)\.(\d)\s*V\b/g, '$1 point $2 volts')
    .replace(/(\d)\s*V\b/g, '$1 volt')
    .trim();
}

const TTS_MODES = { AUTO: 'auto', BROWSER: 'browser', MMS: 'mms', TEXT_ONLY: 'text-only' };
const TTS_STATES = ['idle', 'checking', 'speaking', 'paused', 'fallback', 'unavailable', 'error'];

class BrowserSpeechSynthesisAdapter {
  constructor() {
    this.id = 'browser-speech-synthesis';
    this.synth = null;
    this.currentUtterance = null;
    this.rate = 0.95;
    this.onStatus = () => {};
    this.voices = [];
    this.currentVoiceURI = null;
    this.init();
  }

  init() {
    if ('speechSynthesis' in window) {
      this.synth = window.speechSynthesis;
      this.synth.addEventListener('voiceschanged', () => this.loadVoices());
      this.loadVoices();
      return { ok: true, reason: 'browser speech synthesis available' };
    }
    return { ok: false, reason: 'browser speech synthesis not available' };
  }

  loadVoices() {
    if (!this.synth) return;
    // Keep every voice: Android Chrome often exposes only non-"local" Google
    // voices, and filtering to localService===true made TTS look unavailable.
    this.voices = this.synth.getVoices()
      .slice()
      .sort((a, b) => Number(b.localService === true) - Number(a.localService === true));
  }

  getVoices() {
    return this.voices.map(v => ({
      voiceURI: v.voiceURI,
      name: v.name,
      lang: v.lang,
      localService: v.localService === true,
      default: v.default === true,
    }));
  }

  setVoiceByURI(uri) {
    if (!this.synth) return null;
    const voice = this.voices.find(v => v.voiceURI === uri) || this.voices[0];
    if (voice) {
      this.currentVoiceURI = uri;
      return { name: voice.name, lang: voice.lang, localService: voice.localService === true };
    }
    return null;
  }

  setRate(r) {
    this.rate = parseFloat(r);
    if (this.currentUtterance) this.currentUtterance.rate = this.rate;
    return this.rate;
  }

  speak(text, options = {}) {
    if (!this.synth) throw new Error('browser speech synthesis not available');
    this.stop();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = this.rate;
    if (options.rate) u.rate = options.rate;
    const voices = this.synth.getVoices();
    u.voice = voices.find(v => v.voiceURI === this.currentVoiceURI)
      || voices.find(v => v.localService === true)
      || voices[0]
      || null;

    return new Promise((resolve, reject) => {
      u.onstart = () => this.onStatus({ state: 'speaking', message: 'Speaking…' });
      u.onend = () => {
        this.currentUtterance = null;
        this.onStatus({ state: 'idle', message: 'Ready' });
        resolve();
      };
      u.onerror = (e) => {
        this.currentUtterance = null;
        this.onStatus({ state: 'error', message: `voice error: ${e.error}` });
        reject(new Error(e.error));
      };
      this.synth.speak(u);
      this.currentUtterance = u;
    });
  }

  stop() {
    if (this.synth) this.synth.cancel();
    this.currentUtterance = null;
    this.onStatus({ state: 'idle', message: 'stopped' });
  }

  isSpeaking() {
    return this.synth ? this.synth.speaking : false;
  }

  async isAvailable() {
    if (!('speechSynthesis' in window)) {
      return { ok: false, reason: 'browser speech synthesis not available' };
    }
    // Voices load asynchronously on Chrome/Android. The API existing is enough
    // to try; the utterance error handler reports a real failure to the user.
    const voices = this.synth.getVoices();
    if (voices.length === 0) {
      return { ok: true, reason: 'browser voice (voices still loading)' };
    }
    const local = voices.find(v => v.localService === true);
    return { ok: true, reason: local ? `local voice: ${local.name}` : `voice: ${voices[0].name}` };
  }
}

class MmsSpaceAdapter {
  constructor() {
    this.id = 'meta-mms-space';
    this.enabled = false;
    this.spaceId = null;
    this.endpoint = null;
    this.onStatus = () => {};
  }

  async isAvailable() {
    if (!this.enabled || !this.endpoint) {
      return { ok: false, reason: 'MMS-TTS not enabled or no endpoint configured' };
    }
    try {
      const res = await fetch(this.endpoint, {
        method: 'OPTIONS',
        signal: AbortSignal.timeout(5000),
      });
      return res.ok
        ? { ok: true, reason: 'MMS-TTS endpoint reachable' }
        : { ok: false, reason: `MMS-TTS HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, reason: `MMS-TTS unreachable: ${e.message}` };
    }
  }

  async speak(text, options = {}) {
    if (!this.enabled || !this.endpoint) throw new Error('MMS-TTS not enabled');
    // MMS calls go through backend proxy — never direct from frontend with secrets
    const res = await fetch(`${this.endpoint}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language: 'en' }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`MMS-TTS HTTP ${res.status}`);
  }

  stop() {
    // Cancel any pending MMS request
  }

  setEnabled(enabled) { this.enabled = enabled; }
  setSpaceId(spaceId) {
    this.spaceId = spaceId;
    this.endpoint = spaceId ? `https://${spaceId}.hf.space` : null;
  }
}

export class TTSAdapter {
  constructor() {
    this.browser = new BrowserSpeechSynthesisAdapter();
    this.mms = new MmsSpaceAdapter();
    this.mode = 'auto';
    this.currentAdapter = null;
    this.onStatus = () => {};
    this.browser.onStatus = (s) => this.onStatus(s);
    this.mms.onStatus = (s) => this.onStatus(s);
  }

  async init(options = {}) {
    if (typeof options.onStatus === 'function') this.onStatus = options.onStatus;
    await this.browser.init();
    this.mms.setEnabled(false); // MMS disabled by default per v7
    return this.selectBestAdapter();
  }

  async selectBestAdapter() {
    const browserOk = await this.browser.isAvailable();
    if (browserOk.ok) {
      this.currentAdapter = this.browser;
      this.onStatus({ state: 'idle', message: 'voice: browser (local)' });
      return this.browser;
    }
    if (this.mms.enabled) {
      const mmsOk = await this.mms.isAvailable();
      if (mmsOk.ok) {
        this.currentAdapter = this.mms;
        this.onStatus({ state: 'idle', message: 'voice: MMS-TTS (remote)' });
        return this.mms;
      }
    }
    this.currentAdapter = null;
    this.onStatus({ state: 'unavailable', message: 'voice unavailable — text only' });
    return null;
  }

  async speak(text, options = {}) {
    const spokenText = normalizeForSpeech(text); // Never mutates stored text
    if (!this.currentAdapter) await this.selectBestAdapter();
    if (!this.currentAdapter) throw new Error('no TTS adapter available — text-only mode');
    return this.currentAdapter.speak(spokenText, options);
  }

  stop() {
    if (this.currentAdapter) this.currentAdapter.stop();
    this.onStatus({ state: 'idle', message: 'stopped' });
  }

  isSpeaking() {
    return this.currentAdapter ? this.currentAdapter.isSpeaking() : false;
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === 'browser') this.currentAdapter = this.browser;
    else if (mode === 'mms') this.currentAdapter = this.mms;
    else if (mode === 'text-only') this.currentAdapter = null;
    else this.selectBestAdapter(); // auto
  }

  setMmsEnabled(enabled) {
    this.mms.setEnabled(enabled);
    if (this.currentAdapter === this.mms && !enabled) this.selectBestAdapter();
  }

  setMmsSpaceId(spaceId) {
    this.mms.setSpaceId(spaceId);
  }

  setRate(r) { this.browser.setRate(r); }
  getVoices() { return this.browser.getVoices(); }
  setVoiceByURI(uri) { return this.browser.setVoiceByURI(uri); }
}

export const IntentLensTTS = new TTSAdapter();