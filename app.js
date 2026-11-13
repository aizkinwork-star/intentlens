// app.js — v8 Any-provider vision + local component recognition.
//
// Wires the screen together (landscape layout).
//
// Idea: the camera stays LIVE all the time. A frame is captured only when you press
// Find it, and that exact frame is what the backend analyses. The marker is drawn on
// the captured frame, never on the live preview, because a live preview moves.
//
// Nothing here talks to the model directly: every request goes to /api/analyze or
// /api/component/analyze, which are the only places that know about the configured
// provider runtime. Which provider and model is used is decided server-side from
// the user's own key and access tier.

import {
  clientToNormalized,
  fitContain,
  rectToNormalized,
  isInsideNormalizedRect,
} from './grid.js';
import { validateResult } from './schema.js';
import { COMPONENTS } from './phoneBoard.js';
import {
  TargetTracker,
  setHandOutline as trackerSetHandOutline,
  handOutlineEnabled,
  setAdminSilhouette as trackerSetAdminSilhouette,
  adminSilhouetteEnabled,
  setChipOutline as trackerSetChipOutline,
  chipOutlineEnabled,
  OBJECT_COLORS,
  MultiTargetTracker,
} from './tracker.js';
import { cameraAdapter } from './platform/index.js';
import { browserSpeechController } from './speech.js';

// ---------------------------------------------------------------------------
// Startup telemetry: keep the stages separate so a fast HTTP listener cannot
// hide a slow first-use path. Read window.__intentlensStartup in DevTools.
// ---------------------------------------------------------------------------
const startup = {
  startedAt: performance.now(),
  marks: {},
  details: {},
};
window.__intentlensStartup = startup;

function markStartup(name, detail) {
  if (startup.marks[name] != null) return;
  startup.marks[name] = Number((performance.now() - startup.startedAt).toFixed(1));
  if (detail) startup.details[name] = detail;
  console.info(`[startup] ${name}: ${startup.marks[name]} ms`, detail || '');
}

// Attach session token to all /api requests (local pairing).
//
// The token is persisted by the backend, but a page can still be open across a
// backend restart or a data-dir change. On a 401 we re-read the injected token
// from the current HTML once, then retry the original request exactly once.
const _origFetch = window.fetch.bind(window);
let _tokenRefresh = null;

function readInjectedToken() {
  try {
    const meta = document.querySelector('meta[name="intentlens-token"]');
    return meta ? meta.getAttribute('content') : null;
  } catch { return null; }
}

async function refreshSessionToken() {
  if (_tokenRefresh) return _tokenRefresh;
  _tokenRefresh = (async () => {
    try {
      const res = await _origFetch('/', { cache: 'no-store' });
      const html = await res.text();
      const match = /name="intentlens-token" content="([^"]+)"/.exec(html);
      if (!match) return null;
      let meta = document.querySelector('meta[name="intentlens-token"]');
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'intentlens-token';
        document.head.appendChild(meta);
      }
      meta.setAttribute('content', match[1]);
      return match[1];
    } catch {
      return null;
    } finally {
      _tokenRefresh = null;
    }
  })();
  return _tokenRefresh;
}

function withToken(input, init, token) {
  if (!token) return init;
  // Drop any caller-supplied token in any casing, then set exactly one header.
  // Headers handles plain objects, arrays and Headers instances consistently.
  const headers = new Headers(init.headers || {});
  headers.delete('x-intentlens-token');
  headers.set('X-IntentLens-Token', token);
  return { ...init, headers };
}

window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input && input.url);
  const isApi = Boolean(url && url.startsWith('/api/'));
  if (!isApi) return _origFetch(input, init);

  const first = withToken(input, init, readInjectedToken());
  const res = await _origFetch(input, first);
  if (res.status !== 401 || url === '/api/pair') return res;

  const token = await refreshSessionToken();
  if (!token) return res;
  return _origFetch(input, withToken(input, init, token));
};
import { initHandTracker, detectHands, getHandTrackerMode } from './handTracker.js';
import { loadOpenCV } from './opencvLoader.js';
import { buildPcbSceneContext } from './pcbContextBuilder.js';
window.buildPcbSceneContext = buildPcbSceneContext;
import { BoardRegistrar } from './perception/pcb/BoardRegistrar.js';
import { ComponentPresenceVerifier } from './perception/pcb/ComponentPresenceVerifier.js';
import { OpticalFlowTracker } from './perception/tracking/OpticalFlowTracker.js';
import { HingeTracker, classifyHinge } from './perception/tracking/HingeTracker.js';
import { adaptivePreprocess, analyzeLighting } from './perception/lighting/adaptivePreprocess.js';
import { aggregateConfidence, boardQuadQuality, componentConfidence } from './perception/pcb/gridConfidence.js';
window.OpticalFlowTrackerCtor = OpticalFlowTracker;
window.BoardRegistrarCtor = BoardRegistrar;
window.ComponentPresenceVerifierCtor = ComponentPresenceVerifier;
import { initComponentDetector, detectComponents, getComponentDetectorMode } from './componentDetector.js';
import {
  createProjectFromIntent,
  deserializeProject,
  currentStepOf,
  advanceProjectStep,
  updateProjectObject,
  confirmProjectObject,
} from './projectPlanner.js';
import { repeatAnswer, explainAnswer } from './assistantActions.js';
import { buildEvidenceCard, toggleExpanded } from './evidencePanel.js';
import { lookupCandidates } from './localReferenceLookup.js';
import { inspectMobileSupport, describeMobileSupport } from './mobileSupport.js';
import { validateNormalizedComponentResult } from './componentResult.js';

const $ = (id) => document.getElementById(id);

// Cloud provider diagnostics state (§6 — hamburger menu item 6)
let localModelStatus = null;

const W = 1280, H = 720; // frame pixels; also the SVG viewBox and what the model sees
const SESSION_KEY = 'intentlens.session.v1';
const UNCERTAIN_BELOW = 0.7; // marker turns amber and asks for confirmation
const MAX_LOGS = 200;

const canvas = $('frame'), overlay = $('overlay'), view = $('view');
const snap = $('snap'), snapOverlay = $('snapOverlay'), snapBox = $('snapBox'), snapInfo = $('snapInfo');
// Offscreen canvas used to read pixels for local tracking (never shown).
const trackCanvas = document.createElement('canvas');
trackCanvas.width = W;
trackCanvas.height = H;
const trackCtx = trackCanvas.getContext('2d');
// Small offscreen copy used only for lighting measurement and the coarse hinge
// estimator. Reading a 1280x720 frame once per second would waste CPU on a
// low-power laptop; 320x180 is enough to classify exposure and orientation.
const lightingCanvas = document.createElement('canvas');
lightingCanvas.width = 320;
lightingCanvas.height = 180;
const lightingCtx = lightingCanvas.getContext('2d', { willReadFrequently: true });
const statusEl = $('status'), answerEl = $('answer'), metaEl = $('meta'), sourcesEl = $('sources'), input = $('command');
const modeEl = $('mode');
const submitBtn = $('submit'), cancelBtn = $('cancel');
const camBtn = $('cam'), liveBtn = $('live'), uploadBtn = $('upload'), clearBtn = $('clear'), fileIn = $('file');

// Beginner workflow UI
const wsEl = $('workspace'), wsTitle = $('wsTitle'), wsGoal = $('wsGoal'), wsStep = $('wsStep');
const wsParts = $('wsParts'), wsSafety = $('wsSafety'), wsBar = $('wsBar'), wsStatus = $('wsStatus');
const wsAlignBtn = $('wsAlign'), wsCaptureBtn = $('wsCapture'), wsNextBtn = $('wsNext');
const wsRepeatBtn = $('wsRepeat'), wsEditBtn = $('wsEdit');
const wsExplainBtn = $('wsExplain');
const evPanel = $('evidencePanel'), evTitle = $('evTitle'), evStatus = $('evStatus');
const evOriginal = $('evOriginal'), evCorners = $('evCorners'), evEmpty = $('evEmpty');
const evMeta = $('evMeta'), evInstruction = $('evInstruction'), evCandidates = $('evCandidates');
const evExpandBtn = $('evExpand'), evConfirmBtn = $('evConfirm'), evCorrectBtn = $('evCorrect');
const evRetakeBtn = $('evRetake'), evRepeatBtn = $('evRepeat');
const evExplainBtn = $('evExplain');
const evCorrectRow = $('evCorrectRow'), evNameInput = $('evNameInput'), evNameSave = $('evNameSave');
const projectPopup = $('projectPopup'), projectBackdrop = $('projectBackdrop');
const projectIntent = $('projectIntent'), projectCreateBtn = $('projectCreate');
const projectResumeBtn = $('projectResume'), projectMsg = $('projectMsg');
const projectRecent = $('projectRecent'), projectBtn = $('projectBtn');
const projectCloseBtn = $('projectClose'), mobileStatusEl = $('mobileStatus');
const projectProviderBtn = $('projectProvider');
const PROJECT_KEY = 'intentlens.project.v1';

// Provider diagnostics elements
const lmRuntimeEl = $('lmRuntime');
const lmProviderEl = $('lmProvider');
const lmModelIdEl = $('lmModelId');
const lmIsMetaEl = $('lmIsMeta');
const lmPriorityEl = $('lmPriority');
const lmOutboundEl = $('lmOutbound');
const lmStatusEl = $('lmStatus');

const PROVIDER_NAMES = {
  openrouter: 'OpenRouter',
  'nvidia-nim': 'NVIDIA NIM',
  'cloudflare-workers-ai': 'Cloudflare Workers AI',
  groq: 'Groq',
  'google-ai-studio': 'Google AI Studio',
  mistral: 'Mistral',
  cerebras: 'Cerebras',
  together: 'Together AI',
  huggingface: 'Hugging Face',
  deepinfra: 'DeepInfra',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama (local)',
  custom: 'Custom HTTPS relay',
};

function configuredProviders() {
  const data = localModelStatus;
  if (!data) return [];
  return data.priority?.filter((id) => data.configured?.includes(id)) || [];
}

function activeProvider() {
  return configuredProviders()[0] || null;
}

function providerLabel(id) {
  if (!id) return 'none';
  const fromCatalog = localModelStatus?.providers?.find((p) => p.id === id)?.label;
  return fromCatalog || PROVIDER_NAMES[id] || id;
}

/** Format a USD amount without implying invoice precision. */
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

/**
 * Populate the budget controls and status line from /api/providers.
 * Fields are only overwritten when they match the last rendered values, so a
 * half-typed number is never replaced by a background refresh.
 */
function renderBudgetUi({ force = false } = {}) {
  const data = localModelStatus;
  const cfg = data?.budgetConfig;
  const budget = data?.budget;
  const setField = (id, value) => {
    const el = $(id);
    if (!el || value == null) return;
    const next = String(value);
    if (force || document.activeElement !== el) {
      if (el.dataset.rendered !== next) el.value = next;
      el.dataset.rendered = next;
    }
  };
  if (cfg) {
    setField('setupBudgetDaily', cfg.dailyUsd);
    setField('setupBudgetMonthly', cfg.monthlyUsd);
    setField('setupBudgetRequest', cfg.maxRequestUsd);
  }
  const status = $('setupBudgetStatus');
  if (status) {
    if (!budget) {
      status.textContent = 'Budget status unavailable until the backend responds.';
    } else {
      const warn = budget.exhausted
        ? ' — budget exhausted, requests are refused'
        : (budget.warn ? ' — near the configured cap' : '');
      status.textContent = `Today ${money(budget.todayUsd)} / ${money(budget.budget?.dailyUsd)} · `
        + `this month ${money(budget.monthUsd)} / ${money(budget.budget?.monthlyUsd)} · `
        + `${budget.requests || 0} request(s) this month. Estimates only; provider invoices are authoritative.${warn}`;
      status.className = 'setupHint' + (budget.exhausted || budget.warn ? ' warn' : '');
    }
  }
}

function renderProviderStatus() {
  const data = localModelStatus;
  if (lmRuntimeEl) lmRuntimeEl.textContent = data?.runtime === 'cloud-generative' ? 'cloud generative (optional)' : 'local perception only';
  const active = activeProvider();
  if (lmProviderEl) lmProviderEl.textContent = active ? providerLabel(active) : 'none configured';
  if (lmModelIdEl) lmModelIdEl.textContent = active ? (data.providers?.find((p) => p.id === active)?.modelId || '—') : 'offline';
  if (lmIsMetaEl) {
    const activeRow = data?.providers?.find((p) => p.id === active);
    const info = activeRow?.modelId ? data?.catalog?.[active]?.models?.[activeRow.modelId] : null;
    lmIsMetaEl.textContent = active
      ? (info ? `${info.modality}${info.openWeight ? ' · open weights' : ''}` : 'unknown')
      : 'n/a';
  }
  if (lmPriorityEl) lmPriorityEl.textContent = (data?.priority || []).map(providerLabel).join(' → ') || '—';
  if (lmOutboundEl) {
    lmOutboundEl.textContent = data?.allowOutboundNetwork === false
      ? 'disabled by ALLOW_OUTBOUND_NETWORK=false'
      : 'allowlisted inference hosts only';
    lmOutboundEl.className = 'menuValue' + (data?.allowOutboundNetwork === false ? ' warn' : '');
  }
  if (lmStatusEl && data) {
    const rows = data.providers || [];
    lmStatusEl.textContent = rows.map((p) => {
      const state = p.configured ? `ready · ${p.modelId}` : (!p.hasKey ? 'no key' : (p.placeholderKey ? 'placeholder key — replace it' : 'key saved, not usable'));
      return `${p.label}: ${state}`;
    }).join(' · ');
    lmStatusEl.className = 'menuValue' + (active ? '' : ' warn');
  }
}

/** Fetch provider summary. This is the single source of truth for the UI. */
async function loadLocalModelStatus() {
  try {
    const res = await fetch('/api/providers', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    localModelStatus = await res.json();
    renderProviderStatus();
    renderBudgetUi();
    if (state.menuOpen) renderMenu();
    return localModelStatus;
  } catch {
    if (lmStatusEl) {
      lmStatusEl.textContent = 'Could not reach the backend for provider status.';
      lmStatusEl.className = 'menuValue warn';
    }
    return null;
  }
}

function updateTrainCount() {
  const classifier = state.looseTracker?.classifier;
  const refs = classifier?.compact?.count || 0;
  const mine = classifier?.examples?.length || 0;
  const el = $('trainCount');
  if (el) el.textContent = `${refs} refs · ${mine} mine`;
}

function describeTestResult(data) {
  if (data?.ok) return `OK · ${data.modelId || 'model'} answered in ${data.ms || 0} ms.`;
  const category = String(data?.category || 'failed').replaceAll('_', ' ');
  const detail = data?.detail ? ` — ${data.detail}` : '';
  const hint = {
    network_disabled: 'Outbound network is off. Set ALLOW_OUTBOUND_NETWORK=true in .env (or the app launcher) and restart, then test again.',
    auth: 'The provider rejected the key. Re-copy it, or create a new token with the right permissions.',
    model_unavailable: 'This model is not served on this account. Pick a different vision model above.',
    not_vision: 'That model is text-only; choose a vision model.',
    not_configured: 'No usable key is saved for this provider yet.',
    timeout: 'The provider did not answer in time. A reasoning model can take 80–120 s on a first request.',
    rate_limit: 'Provider rate limit. Wait a minute and retry.',
    provider_outage: 'Provider outage. Try again later or pick another provider.',
    budget: 'The configured daily/monthly or per-request budget would be exceeded. Raise it in Budget settings or pick a cheaper model.',
  }[data?.category];
  return `${category}${data?.httpStatus ? ` (HTTP ${data.httpStatus})` : ''}${detail}${hint ? ` ${hint}` : ''}`;
}

if ($('lmTest')) {
  $('lmTest').addEventListener('click', async () => {
    const provider = activeProvider() || $('setupProv')?.value || 'openrouter';
    if (lmStatusEl) lmStatusEl.textContent = `Testing ${providerLabel(provider)}…`;
    try {
      const res = await fetch(`/api/providers/test?provider=${encodeURIComponent(provider)}`, { cache: 'no-store' });
      const data = await res.json();
      if (lmStatusEl) {
        lmStatusEl.textContent = describeTestResult(data);
        lmStatusEl.className = 'menuValue' + (data.ok ? '' : ' warn');
      }
      log({ stage: 'model', kind: data.ok ? 'ok' : 'warn', text: `${providerLabel(provider)} test: ${describeTestResult(data)}` });
      await loadLocalModelStatus();
    } catch {
      if (lmStatusEl) lmStatusEl.textContent = 'Backend not reachable.';
    }
  });
}

const W2 = 1280, H2 = 720; // frame pixels; also the SVG viewBox and what the model sees

const state = {
  sessionId: `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
  projectId: `proj_${Date.now().toString(36)}`,
  frameCount: 0,
  scene: [],              // SceneItem[] — semantic memory, coordinates may go stale
  corrections: [],        // small log of user corrections, sent with the next request
  lastTargetId: null,
  lastResult: null,       // last GroundingResult (it belongs to lastResultFrameId)
  lastResultFrameId: null,
  capturedFrameId: null,  // frameId of the most recent capture
  mainMarker: null,       // marker on the big view, only when the frame is frozen
  hint: null,             // point/box the user tapped, sent with the next command
  imageRect: null,        // where real image content sits inside the frame (letterboxing)
  active: null,           // { requestId, controller, frameId } while a request is in flight
  busy: false,
  modelMode: 'unknown',
  taskSummary: 'Inspecting an unpowered phone motherboard with a phone camera',

  // UI chrome (§6)
  logs: [],           // { when, stage, provider, ms, kind, text }
  menuOpen: false,
  contextBudget: null,
  handTrackerMode: 'uninitialized',
  componentDetectorMode: 'uninitialized',
  componentModelUrl: null,
  handDetections: null,
  componentDetections: null,

  // Screenshot-driven beginner workflow. This is intentionally separate from the
  // legacy single-target tracker above; the new flow never tracks across frames.
  assistant: {
    project: null,
    capture: null,
    analysis: null,
    object: null,
    localLookup: null,
    candidates: [],
    aligned: false,
    busy: false,
    photoLoaded: false,
    analysisState: null,
    lastAnswer: null,
    evidence: null,
    mobile: null,
  },
};

// Local tracker (§8): one active target, browser-side only. No per-frame AI calls.
const tracker = new TargetTracker({
  frameWidth: W, frameHeight: H,
  onStateChange: ({ prev, next, targetId }) => {
    log({ stage: 'tracking', provider: 'local', text: `target ${targetId || '—'}: ${prev} → ${next}` });
    if (state.menuOpen) renderMenu();
  },
});
state.tracker = tracker;
state.multiTracker = new MultiTargetTracker();
state.pcbBoard = null; // { id, referenceImageData, components: [{id,type,x,y,w,h}] }
state.pcbRegistrar = null;
state.pcbVerifier = null;
state.looseTracker = null;
state.identityRegistry = null;
state.looseMode = false;
state.looseTrackedObjects = [];
state.diagOverlayEnabled = false;
state.lastFrameTime = 0;
state.prevGrayMat = null;
state.looseFlowPoints = null;
state.looseFlowTracker = null;
state.opencvReady = false;
state.looseLastRun = 0;
// Perception diagnostics. These never gate a request on their own; they explain
// what the local pipeline saw and whether the outgoing still was adjusted.
state.lightingReport = null;
state.lastPreprocess = null;
state.lastLightingAt = 0;
state.hingeModeEnabled = false;
state.hingeTracker = new HingeTracker({ smoothing: 0.3, lostAfterMs: 1200 });
state.hingeReport = null;
state.pcbConfidence = null;
state.pcbBoardQuality = null;

// Heavy perception code is loaded only when it is actually needed. Startup and
// camera preview stay light; OpenCV (11 MB) and the reference index never block
// the first paint.
let _opencvPromise = null;
function ensureOpenCV() {
  if (_opencvPromise) return _opencvPromise;
  _opencvPromise = loadOpenCV().then(async (cv) => {
    state.opencvReady = !!cv;
    log({ stage: 'tracking', provider: 'local', text: cv ? 'OpenCV.js loaded' : 'OpenCV.js unavailable' });
    if (cv) {
      initHandTracker().then((r) => { state.handTrackerMode = r.mode; }).catch(() => {});
      initComponentDetector().then((r) => { state.componentDetectorMode = r.mode; }).catch(() => {});
    }
    return cv;
  });
  return _opencvPromise;
}

let _loosePromise = null;
function ensureLooseTracker() {
  if (_loosePromise) return _loosePromise;
  _loosePromise = (async () => {
    const initStarted = performance.now();
    const m = await import('./looseObjectTracker.js');
    const trackerInstance = new m.LooseObjectTracker();
    state.looseTracker = trackerInstance;
    const initResult = await trackerInstance.init();
    const initMs = Number((performance.now() - initStarted).toFixed(1));
    markStartup('knnReady', {
      initMs,
      refs: trackerInstance.classifier?.referenceCount || 0,
      classes: trackerInstance.classifier?.compact?.classNames?.length || 0,
      dim: trackerInstance.classifier?.compact?.dim || 0,
    });
    log({
      stage: 'tracking',
      provider: 'local',
      text: `loose tracker: scaler=${initResult.scaler.ok}, refDb=${initResult.db.ok}${initResult.db.error ? ` (${initResult.db.error})` : ''} (${initMs} ms)`,
    });
    updateTrainCount();
    return trackerInstance;
  })().catch((e) => {
    _loosePromise = null;
    log({ stage: 'tracking', provider: 'local', kind: 'warn', text: `loose tracker unavailable: ${e.message || e}` });
    return null;
  });
  return _loosePromise;
}

// Small, independent registries; they do not touch the network or OpenCV.
// Hand/person silhouettes work without OpenCV (JS fallback), so initialise the
// tracker eagerly; OpenCV only upgrades accuracy later.
initHandTracker().then((r) => { state.handTrackerMode = r.mode; }).catch(() => {});
import('./spatial/IdentityRegistry.js').then((m) => { state.identityRegistry = new m.IdentityRegistry(); }).catch(() => {});
import('./crossModeTransfer.js').then((m) => { state.crossModeTransfer = new m.CrossModeTransfer(state.identityRegistry); }).catch(() => {});
import('./perception/PerceptionProfile.js').then((m) => { state.perceptionProfile = new m.PerceptionProfile('balanced'); }).catch(() => {});

// Camera source behind the §3.4 adapter contract (phone rear camera is the MVP path).
const camera = cameraAdapter;

// Read-aloud: synthesis only, through speech.js. No microphone, no recognition.
const speech = browserSpeechController(window);

function setSpeechButtons() {
  const readBtn = $('readAloudBtn');
  const stopBtn = $('stopReadAloudBtn');
  if (!readBtn || !stopBtn) return;
  const text = answerEl.textContent.trim();
  readBtn.disabled = !speech.supported || text.length < 12;
  stopBtn.disabled = !speech.speaking;
  readBtn.textContent = speech.speaking ? 'Read again' : 'Read aloud';
}

function speakAnswer() {
  const result = speech.speak(answerEl.textContent, { onEnd: setSpeechButtons });
  if (result.ok) {
    markStartup('speech', `${result.spoken.length} chars`);
  } else if (result.reason === 'unsupported') {
    setStatus("This browser has no speech voice installed, so the answer cannot be read aloud.", 'warn');
  }
  setSpeechButtons();
}

function setStatus(text, tone = 'ready') { statusEl.textContent = text; statusEl.dataset.tone = tone; }

function setAnswer(text, tone = '') {
  answerEl.textContent = text;
  answerEl.dataset.tone = tone;
  setSpeechButtons();
}

function setMeta(parts) {
  metaEl.replaceChildren();
  if (!parts || !parts.length) { metaEl.hidden = true; return; }
  for (const part of parts) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    if (part.kind) chip.dataset.kind = part.kind;
    chip.textContent = part.text;
    metaEl.append(chip);
  }
  metaEl.hidden = false;
}

// ---------------------------------------------------------------------------
// Comprehensive Diagnostics & Logs (§15)
// Tracks client code execution, camera/tracker, network API calls, and upstream errors.
// ---------------------------------------------------------------------------
let currentLogFilter = 'all';

function log({ stage = 'system', provider = '', ms, kind = 'info', text, detail }) {
  const entry = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    when: new Date().toLocaleTimeString(),
    stage,
    provider,
    ms,
    kind, // 'info' | 'warn' | 'error' | 'ok'
    text: String(text || ''),
    detail: detail ? String(detail).slice(0, 500) : '',
    source: 'client',
  };
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, MAX_LOGS);
  updateLogBadge();
  if (!$('logsPopup')?.hidden) renderLogsList();
  return entry;
}

function updateLogBadge() {
  const count = state.logs.length;
  if ($('logCountBadge')) $('logCountBadge').textContent = `${count} event${count === 1 ? '' : 's'}`;
  if ($('logCount')) $('logCount').textContent = count;
}

async function syncServerLogs() {
  try {
    const res = await fetch('/api/logs', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.logs)) {
      const existingIds = new Set(state.logs.map((l) => l.id));
      for (const sLog of data.logs) {
        if (!existingIds.has(sLog.id)) {
          state.logs.push({
            id: sLog.id,
            when: new Date(sLog.time).toLocaleTimeString(),
            stage: sLog.category,
            provider: 'server',
            ms: sLog.ms,
            kind: sLog.level === 'error' ? 'error' : sLog.level === 'warn' ? 'warn' : sLog.level === 'ok' ? 'ok' : 'info',
            text: sLog.message,
            detail: sLog.detail || (sLog.code ? `Code: ${sLog.code}` : ''),
            source: 'server',
          });
        }
      }
      state.logs.sort((a, b) => (b.id > a.id ? 1 : -1));
      state.logs = state.logs.slice(0, MAX_LOGS);
      updateLogBadge();
      if (!$('logsPopup')?.hidden) renderLogsList();
    }
  } catch (err) {
    console.debug('Server logs sync skipped:', err);
  }
}

function renderLogsList() {
  const list = $('logsList');
  if (!list) return;
  list.replaceChildren();

  const filtered = state.logs.filter((e) => {
    if (currentLogFilter === 'all') return true;
    if (currentLogFilter === 'error') return e.kind === 'error' || e.kind === 'warn';
    if (currentLogFilter === 'api') return e.stage === 'api' || e.stage === 'provider' || e.stage === 'model';
    if (currentLogFilter === 'tracking') return e.stage === 'tracking' || e.stage === 'camera' || e.stage === 'vision';
    if (currentLogFilter === 'server') return e.source === 'server';
    return true;
  });

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.style.padding = '24px';
    empty.style.textAlign = 'center';
    empty.style.color = 'var(--muted)';
    empty.textContent = currentLogFilter === 'all' ? 'No log events recorded yet.' : `No events matching filter "${currentLogFilter}".`;
    list.append(empty);
    return;
  }

  for (const e of filtered) {
    const row = document.createElement('div');
    row.className = `logEntry ${e.kind || 'info'}`;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'logTime';
    timeSpan.textContent = e.when;

    const tagSpan = document.createElement('span');
    tagSpan.className = 'logTag';
    tagSpan.textContent = e.stage || 'SYS';

    const textSpan = document.createElement('span');
    const parts = [];
    if (e.provider) parts.push(`[${e.provider}]`);
    if (Number.isFinite(e.ms)) parts.push(`${e.ms}ms`);
    parts.push(e.text);
    textSpan.textContent = parts.join(' ');

    row.append(timeSpan, tagSpan, textSpan);

    if (e.detail) {
      const detailEl = document.createElement('div');
      detailEl.className = 'logDetail';
      detailEl.textContent = e.detail;
      row.append(detailEl);
    }

    list.append(row);
  }
}

async function showLogs(show) {
  const popup = $('logsPopup'), backdrop = $('logsBackdrop');
  if (show) {
    if (popup) popup.hidden = false;
    if (backdrop) backdrop.hidden = false;
    await syncServerLogs();
    renderLogsList();
  } else {
    if (popup) popup.hidden = true;
    if (backdrop) backdrop.hidden = true;
  }
}

// Global runtime error hooks
window.addEventListener('error', (event) => {
  log({
    stage: 'code',
    kind: 'error',
    text: `Uncaught Exception: ${event.message}`,
    detail: `${event.filename}:${event.lineno} ${event.error?.stack || ''}`,
  });
});

window.addEventListener('unhandledrejection', (event) => {
  log({
    stage: 'code',
    kind: 'error',
    text: `Unhandled Promise Rejection: ${event.reason?.message || event.reason}`,
    detail: event.reason?.stack || '',
  });
});

// ---------------------------------------------------------------------------
// Hamburger menu (§6) - serial accordion, vision provider at top
// ---------------------------------------------------------------------------
function openMenu() {
  state.menuOpen = true;
  $('menuPanel').hidden = false;
  $('menuBackdrop').hidden = false;
  renderMenu();
  if (syncState.code) refreshSyncItems();
}

function closeMenu() {
  state.menuOpen = false;
  $('menuPanel').hidden = true;
  $('menuBackdrop').hidden = true;
  showLogs(false);
}

function formatTrackerState(s) {
  const map = {
    INACTIVE: 'inactive',
    INITIALIZING: 'initializing',
    TRACKING: 'tracking',
    LOW_CONFIDENCE: 'low confidence',
    LOST: 'lost',
    REACQUIRING: 'reacquiring',
  };
  return map[s] || s;
}

function renderMenu() {
  if (!state.menuOpen) return;

  // 1. Vision provider & model
  renderProviderStatus();
  renderSyncPanel();

  // 2. Tracking
  const menuTarget = $('menuTarget'), menuTrackState = $('menuTrackState');
  if (menuTarget) menuTarget.textContent = state.tracker.targetId || '—';
  if (menuTrackState) menuTrackState.textContent = formatTrackerState(state.tracker.state);

  // 3. Context window
  const cb = state.contextBudget;
  const ctxTokens = $('ctxTokens'), ctxUsage = $('ctxUsage'), ctxCompression = $('ctxCompression');
  if (cb) {
    if (ctxTokens) ctxTokens.textContent = cb.estimatedTokens?.toLocaleString() || '—';
    if (ctxUsage) ctxUsage.textContent = (cb.usagePercent ?? 0) + '%';
    if (ctxCompression) {
      const comp = cb.compressionLevel || 'none';
      ctxCompression.textContent = comp;
      ctxCompression.className = 'menuValue' + (comp !== 'none' ? ' warn' : '');
    }
  } else {
    if (ctxTokens) ctxTokens.textContent = '—';
    if (ctxUsage) ctxUsage.textContent = '—';
    if (ctxCompression) { ctxCompression.textContent = 'none'; ctxCompression.className = 'menuValue'; }
  }

  // 5. Logs
  const logCount = $('logCount');
  if (logCount) logCount.textContent = state.logs.length;

  // 6. Objects
  const recent = (state.scene || []).slice(0, 8);
  const menuObjects = $('menuObjects');
  if (menuObjects) {
    menuObjects.replaceChildren();
    if (recent.length) {
      for (const item of recent) {
        const row = document.createElement('div');
        row.textContent = `${item.id} — ${item.label || item.id}`;
        menuObjects.append(row);
      }
    } else {
      const empty = document.createElement('div');
      empty.textContent = 'No remembered objects yet. Point the camera at an object and type “remember this component”.';
      empty.style.color = 'var(--muted)';
      menuObjects.append(empty);
    }
  }

  // 7. Q&A
  const menuQA = $('menuQA');
  if (menuQA) {
    menuQA.replaceChildren();
    if (recent.length) {
      for (const item of recent) {
        const row = document.createElement('div');
        row.textContent = `${item.id} — ${item.label || item.id} (${item.status || 'current'})`;
        menuQA.append(row);
      }
    } else {
      const empty = document.createElement('div');
      empty.textContent = 'No remembered objects yet. Point the camera at an object and type “remember this component”.';
      empty.style.color = 'var(--muted)';
      menuQA.append(empty);
    }
  }

  // 8. Session - no changes needed
}

function renderProviders() {
  // v7: No provider menu. Kept for backward compatibility.
  const list = $('menuProviders');
  if (list) list.replaceChildren();
}

// ---------------------------------------------------------------------------
// Pipeline bars — current analysis stages (§6)
// ---------------------------------------------------------------------------
const pipeEls = {};
document.querySelectorAll('.pipe-bar').forEach((el) => { pipeEls[el.dataset.key] = el.querySelector('.pipe-fill'); });
const PIPE_KEYS = ['contextualizing', 'api', 'searching', 'localising'];
const pipeStatusEl = $('pipeStatus');

const setPipe = (key, stateName) => {
  const fill = pipeEls[key];
  if (!fill) return;
  fill.className = 'pipe-fill ' + (stateName || 'idle');
};
const resetPipes = () => PIPE_KEYS.forEach((k) => setPipe(k, 'idle'));
const setPipeStatus = (text) => { if (pipeStatusEl) pipeStatusEl.textContent = text; };
const failActive = () => {
  PIPE_KEYS.forEach((k) => { const f = pipeEls[k]; if (f && f.classList.contains('active')) setPipe(k, 'error'); });
};

// ---------------------------------------------------------------------------
// Evidence — only what the API actually returned.
// ---------------------------------------------------------------------------
const KIND_LABEL = {
  web_source: 'web',
  verified_reference: 'verified',
  visual_inference: 'visual guess',
  user_confirmed: 'you confirmed',
  none: '',
};

function showEvidence(result) {
  sourcesEl.replaceChildren();
  const list = result.evidence || [];
  if (!list.length) { sourcesEl.hidden = true; return; }

  const head = document.createElement('span');
  head.textContent = 'Evidence: ';
  sourcesEl.append(head);

  list.forEach((e) => {
    const line = document.createElement('span');
    line.className = 'ev';
    const tag = document.createElement('span');
    tag.className = 'ev-kind';
    tag.textContent = `[${KIND_LABEL[e.kind] || e.kind}]`;
    line.append(tag);
    if (/^https?:\/\//i.test(e.url || '')) {
      const a = document.createElement('a');
      a.href = e.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = e.title || e.url;
      line.append(a);
    } else {
      line.append(e.title || 'source');
    }
    sourcesEl.append(line);
  });
  sourcesEl.hidden = false;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
const NS = 'http://www.w3.org/2000/svg';
function el(name, attrs) {
  const node = document.createElementNS(NS, name);
  for (const k in attrs) if (attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
  return node;
}

// The demo board, drawn from phoneBoard.js. Used until a camera or photo exists.
function drawMockScene() {
  const g = canvas.getContext('2d');
  g.fillStyle = '#10161d'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#1e6b4a'; g.fillRect(0.03 * W, 0.04 * H, 0.94 * W, 0.92 * H);
  const colors = { chip: '#15181c', shield: '#9aa7b3', conn: '#d4af37', port: '#c0c7cf', tray: '#6b7785' };
  g.font = '15px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const p of COMPONENTS) {
    g.fillStyle = colors[p.kind] || '#444';
    g.fillRect((p.x - p.w / 2) * W, (p.y - p.h / 2) * H, p.w * W, p.h * H);
    g.fillStyle = p.kind === 'conn' || p.kind === 'port' || p.kind === 'shield' ? '#000' : '#8fa3b8';
    g.fillText(p.id, p.x * W, p.y * H);
  }
  g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = '#8fa3b8'; g.font = '16px system-ui';
  g.fillText('demo phone board (placeholder) — start the camera or upload a photo', 0.04 * W, 0.035 * H);
  state.imageRect = { x0: 0, y0: 0, x1: 1, y1: 1 };
}

// Draw a source image letterboxed inside the frame, and remember where it landed.
// "Contain" (not "cover"): nothing is cropped away, so the marker can never point
// at a part of the image the user cannot see.
function drawContain(source, sw, sh) {
  const g = canvas.getContext('2d');
  g.fillStyle = '#05080b'; g.fillRect(0, 0, W, H);
  const r = fitContain(sw, sh, W, H);
  g.drawImage(source, 0, 0, sw, sh, r.left, r.top, r.width, r.height);
  state.imageRect = rectToNormalized(r, W, H);
}

// One marker: optional box, crosshair, label.
// stale markers are dashed, have no crosshair, and say so — never a fake lock.
function drawMarker(svg, opts) {
  const { point, box, label, color, stale = false, small = false, cls } = opts;
  const g = el('g', cls ? { class: cls } : {});

  if (box) {
    const bw = Math.max(box.width * W, 8), bh = Math.max(box.height * H, 8);
    g.append(el('rect', {
      x: box.x * W, y: box.y * H, width: bw, height: bh,
      fill: 'none', stroke: color, 'stroke-width': small ? 1.5 : 2.5,
      'stroke-dasharray': stale ? '8 6' : undefined,
    }));
  }

  if (!stale) {
    const px = point.x * W, py = point.y * H;
    const r = small ? 4 : 7, arm = small ? 9 : 16;
    g.append(el('circle', { cx: px, cy: py, r, fill: color }));
    g.append(el('line', { x1: px - arm, y1: py, x2: px + arm, y2: py, stroke: color, 'stroke-width': 2 }));
    g.append(el('line', { x1: px, y1: py - arm, x2: px, y2: py + arm, stroke: color, 'stroke-width': 2 }));
  }

  const anchorX = box ? box.x * W : point.x * W;
  const anchorY = box ? box.y * H : point.y * H;
  const text = el('text', {
    x: Math.min(anchorX + 12, W - 300),
    y: Math.max(anchorY - 12, 24),
    fill: color,
    'font-size': small ? 15 : 20,
    'font-weight': 600,
  });
  text.textContent = `${label}${stale ? ' (stale)' : ''}`;
  g.append(text);
  svg.append(g);
}

// Selection reticle for the region the user picked.
// ONLY draws the outer perimeter outline with fill: 'none' (zero fill overlay),
// keeping the middle components and circuitry completely visible!
function drawHint(svg) {
  if (!state.hint) return;
  const g = el('g', { class: 'user-selection-reticle' });
  const color = '#50c8ff';

  let bx, by, bw, bh;
  if (state.hint.box) {
    bx = state.hint.box.x * W;
    by = state.hint.box.y * H;
    bw = state.hint.box.width * W;
    bh = state.hint.box.height * H;
  } else {
    const half = 0.02;
    bx = Math.max(0, (state.hint.x - half)) * W;
    by = Math.max(0, (state.hint.y - half)) * H;
    bw = Math.min(1, state.hint.x + half) * W - bx;
    bh = Math.min(1, state.hint.y + half) * H - by;
  }

  // Outer outline ONLY: fill: 'none' ensures the underlying chips/contacts are completely visible
  g.append(el('rect', {
    x: bx, y: by, width: bw, height: bh,
    fill: 'none',
    stroke: color,
    'stroke-width': 2.5,
  }));

  // Corner brackets to highlight the outer boundary
  const clen = Math.min(14, bw / 2, bh / 2);
  g.append(el('path', { d: `M ${bx} ${by + clen} L ${bx} ${by} L ${bx + clen} ${by}`, fill: 'none', stroke: color, 'stroke-width': 3.5 }));
  g.append(el('path', { d: `M ${bx + bw - clen} ${by} L ${bx + bw} ${by} L ${bx + bw} ${by + clen}`, fill: 'none', stroke: color, 'stroke-width': 3.5 }));
  g.append(el('path', { d: `M ${bx} ${by + bh - clen} L ${bx} ${by + bh} L ${bx + clen} ${by + bh}`, fill: 'none', stroke: color, 'stroke-width': 3.5 }));
  g.append(el('path', { d: `M ${bx + bw - clen} ${by + bh} L ${bx + bw} ${by + bh} L ${bx + bw} ${by + bh - clen}`, fill: 'none', stroke: color, 'stroke-width': 3.5 }));

  // Header label
  const text = el('text', {
    x: Math.min(bx + 4, W - 260),
    y: Math.max(by - 8, 20),
    fill: color,
    'font-size': 14,
    'font-weight': 600,
  });
  text.textContent = 'Search area';
  g.append(text);

  svg.append(g);
}

function drawLive() {
  overlay.replaceChildren();
  if (state.mainMarker) {
    const { result, stale } = state.mainMarker;
    drawResultMarkers(overlay, result, { stale, small: false });
  } else {
    drawHint(overlay);
  }
  drawSilhouettes(overlay);
  drawLooseTracks(overlay);
}

function ensureLayer(svg, id) {
  let g = svg.querySelector(`#${id}`);
  if (!g) {
    g = el('g', { id });
    svg.appendChild(g);
  }
  return g;
}

/** Draw loose-object candidates from the local k-NN/optical-flow pipeline. */
function drawLooseTracks(svg) {
  const layer = ensureLayer(svg, 'looseLayer');
  layer.replaceChildren();
  if (!state.looseMode) return;
  const tracks = state.looseTracker?.getTracks?.() || [];
  const color = '#ff9f43';
  for (const t of tracks) {
    if (!t.box || t.state === 'lost') continue;
    const b = t.box;
    const label = t.label && t.label !== 'unknown' ? `${t.label} (candidate)` : 'unclassified candidate';
    layer.append(el('rect', {
      x: b.x * W, y: b.y * H, width: Math.max(b.width * W, 4), height: Math.max(b.height * H, 4),
      fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-dasharray': t.state === 'tracking' ? undefined : '6 4',
      opacity: 0.9,
    }));
    const text = el('text', {
      x: Math.min(b.x * W + 4, W - 300),
      y: Math.max(b.y * H - 6, 16),
      fill: color, 'font-size': 13, 'font-weight': 600,
    });
    text.textContent = `${t.id} · ${label}`;
    layer.append(text);
  }
}

// Draw the locally-tracked target marker on the live preview. Honest about state:
// a lost target is not drawn as a locked marker.
let trackedPill = null;
function getTrackedPill() {
  if (!trackedPill) {
    trackedPill = document.createElement('div');
    trackedPill.className = 'tracked-pill';
    view.appendChild(trackedPill);
  }
  return trackedPill;
}

function normToScreen(nx, ny) {
  const r = view.getBoundingClientRect();
  const imageRect = state.imageRect || { x0: 0, y0: 0, x1: 1, y1: 1 };
  const vbX = (imageRect.x0 + nx * (imageRect.x1 - imageRect.x0)) * W;
  const vbY = (imageRect.y0 + ny * (imageRect.y1 - imageRect.y0)) * H;
  return { x: r.left + (vbX / W) * r.width, y: r.top + (vbY / H) * r.height };
}

function drawTrackerMarker(snap) {
  const pill = getTrackedPill();
  // Per-frame layer: redraw without duplicating markers.
  const layer = ensureLayer(overlay, 'trackerLayer');
  layer.replaceChildren();
  if (!snap || !snap.box || !snap.anchor || snap.state === 'LOST' || snap.state === 'INACTIVE') {
    pill.hidden = true;
    return;
  }
  const { state: st, confidence, box, anchor, targetId } = snap;
  const color = st === 'LOW_CONFIDENCE' || st === 'REACQUIRING' ? '#ffb020' : '#ff4d5e';
  const stale = st !== 'TRACKING';
  drawMarker(layer, {
    point: anchor,
    box,
    label: targetId,
    color,
    stale,
    small: false,
  });
  const pct = confidence == null ? '?' : Math.round(confidence * 100);
  setStatus(`Tracking ${targetId || 'target'} · ${pct}%`, stale ? 'warn' : 'done');

  // Position the labeled pill at the anchor point so the AI-guided target stays
  // visible on the live view while the user follows text instructions.
  const sp = normToScreen(anchor.x, anchor.y);
  pill.className = 'tracked-pill' + (stale ? ' warn' : '');
  pill.textContent = `${targetId || 'target'} · ${pct}%`;
  pill.style.left = sp.x + 'px';
  pill.style.top = sp.y + 'px';
  pill.hidden = false;
}

// Silhouette & Outline drawing (Hand, Admin, Chips)
function drawSilhouettes(svg) {
  let g = svg.querySelector('#silhouettesLayer');
  if (!g) {
    g = el('g', { id: 'silhouettesLayer' });
    svg.appendChild(g);
  }
  g.replaceChildren();

  if (!state.detectedSilhouettes) return;
  const { hand, admin, chips } = state.detectedSilhouettes;
  const { x0, y0, x1, y1 } = state.imageRect || { x0: 0, y0: 0, x1: 1, y1: 1 };
  const toFrame = (box) => ({
    x: (x0 + box.x * (x1 - x0)) * W,
    y: (y0 + box.y * (y1 - y0)) * H,
    w: box.width * (x1 - x0) * W,
    h: box.height * (y1 - y0) * H,
  });
  // Contour points are already normalized to the source frame, so they use the
  // same image-rect mapping as the bounding boxes.
  const contourPoints = (box) => {
    if (!box || !Array.isArray(box.contour) || box.contour.length < 3) return null;
    return box.contour
      .map((p) => {
        const fx = (x0 + p.x * (x1 - x0)) * W;
        const fy = (y0 + p.y * (y1 - y0)) * H;
        return `${fx.toFixed(1)},${fy.toFixed(1)}`;
      })
      .join(' ');
  };
  const scoreLabel = (box) => (box && Number.isFinite(box.score) ? ` ${Math.round(box.score * 100)}%` : '');

  // 1. Hand outline (Neon Green)
  if (handOutlineEnabled && hand) {
    const b = toFrame(hand);
    const poly = contourPoints(hand);
    if (poly) {
      g.append(el('polygon', {
        points: poly,
        fill: 'rgba(0,255,136,0.14)',
        stroke: OBJECT_COLORS.hand,
        'stroke-width': 2.5,
        'stroke-linejoin': 'round',
      }));
    } else {
      g.append(el('rect', {
        x: b.x, y: b.y, width: b.w, height: b.h,
        fill: 'none',
        stroke: OBJECT_COLORS.hand,
        'stroke-width': 2.5,
        'stroke-dasharray': '6 4',
      }));
    }
    const text = el('text', {
      x: Math.min(b.x + 6, W - 180),
      y: Math.max(b.y - 8, 20),
      fill: OBJECT_COLORS.hand,
      'font-size': 13,
      'font-weight': 600,
    });
    text.textContent = `🖐️ Hand${scoreLabel(hand)}`;
    g.append(text);
  }

  // 2. Admin Silhouette (Neon Purple)
  if (adminSilhouetteEnabled && admin) {
    const b = toFrame(admin);
    const poly = contourPoints(admin);
    if (poly) {
      g.append(el('polygon', {
        points: poly,
        fill: 'rgba(224,86,253,0.14)',
        stroke: OBJECT_COLORS.admin,
        'stroke-width': 2.5,
        'stroke-linejoin': 'round',
      }));
    } else {
      g.append(el('rect', {
        x: b.x, y: b.y, width: b.w, height: b.h,
        fill: 'none',
        stroke: OBJECT_COLORS.admin,
        'stroke-width': 2.5,
        'stroke-dasharray': '8 5',
      }));
    }
    const text = el('text', {
      x: Math.min(b.x + 6, W - 180),
      y: Math.max(b.y - 8, 20),
      fill: OBJECT_COLORS.admin,
      'font-size': 13,
      'font-weight': 600,
    });
    text.textContent = `👤 Person${scoreLabel(admin)}`;
    g.append(text);
  }

  // 3. Chip & Component outlines with distinct colors per kind
  if (chipOutlineEnabled && Array.isArray(chips)) {
    for (const c of chips) {
      const b = toFrame(c);
      g.append(el('rect', {
        x: b.x, y: b.y, width: b.w, height: b.h,
        fill: 'none',
        stroke: c.color || OBJECT_COLORS.chip,
        'stroke-width': 1.8,
      }));
      const text = el('text', {
        x: Math.min(b.x + 4, W - 160),
        y: Math.max(b.y - 4, 16),
        fill: c.color || OBJECT_COLORS.chip,
        'font-size': 11,
        'font-weight': 600,
      });
      text.textContent = `${c.id || ''} ${c.kind ? `[${c.kind}]` : ''}`;
      g.append(text);
    }
  }
}

function clearSilhouettes(svg) {
  const g = svg.querySelector('#silhouettesLayer');
  if (g) g.replaceChildren();
}

function hideHandOutline() {
  clearSilhouettes(overlay);
}

function drawResultMarkers(svg, result, { stale = false, small = false } = {}) {
  const t = result.target;
  if (!t || !t.point) return;
  const unsure = t.confidence < UNCERTAIN_BELOW;
  const color = stale ? '#ffb020' : unsure ? '#ffb020' : '#ff4d5e';
  drawMarker(svg, {
    point: t.point,
    box: t.box || null,
    label: t.targetId,
    color,
    stale,
    small,
  });
}

// The analysed frame, with the target and (when enlarged) the context parts sent.
function drawSnapshot(result) {
  snapOverlay.replaceChildren();
  if (!result) return;
  if (result.target) {
    state.scene
      .filter((s) => s.id !== result.target.targetId && s.point)
      .slice(0, 4)
      .forEach((s) => drawMarker(snapOverlay, {
        point: s.point, label: s.id, color: '#50c8ff', small: true, cls: 'ctx',
        stale: s.status === 'stale',
      }));
    drawResultMarkers(snapOverlay, result, { small: false });
  }
}

function fillSnapInfo(result) {
  snapInfo.replaceChildren();
  const line = (text) => { const d = document.createElement('div'); d.textContent = text; snapInfo.append(d); };
  const fmt = (p) => `x=${p.x.toFixed(3)}  y=${p.y.toFixed(3)}`;
  if (!result) return;

  // Don't let the readout cover the thing it is describing.
  snapBox.classList.toggle('info-top', Boolean(result.target && result.target.point.y > 0.6));

  if (result.target) {
    const t = result.target;
    line(`Target ${t.targetId} — ${t.label}\n${fmt(t.point)} · ${Math.round(t.confidence * 100)}% confident · ${t.freshness}`);
  } else {
    line(`No target drawn (${result.resultStatus}).`);
  }
  if (result.uncertaintyNote) line(`Uncertainty: ${result.uncertaintyNote}`);
  const scene = state.scene.filter((s) => s.id !== result.target?.targetId && s.point);
  if (scene.length) line('Context sent: ' + scene.map((s) => `${s.id} ${fmt(s.point)} (${s.status})`).join(' | '));
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
let live = false;

// Silhouette detection is deliberately throttled. handTracker.js runs classical
// segmentation over the frame; doing that on every 60 fps tick would starve the
// preview. ~11 fps is enough for a hand/person overlay to feel live.
const VISION_INTERVAL_MS = 90;
let lastVisionAt = 0;
let visionInFlight = false;

async function updateSilhouettes(img) {
  if (visionInFlight) return false;
  const now = performance.now();
  if (now - lastVisionAt < VISION_INTERVAL_MS) return false;
  lastVisionAt = now;
  visionInFlight = true;
  try {
    state.handTrackerMode = getHandTrackerMode();
    // skin:false — handTracker owns the hand/person masking, so this call only
    // supplies known chip boxes and never produces competing skin boxes.
    let sil = tracker.detectSilhouettesAndChips(img, COMPONENTS, { skin: false });

    if (handOutlineEnabled || adminSilhouetteEnabled) {
      let detections = [];
      try {
        detections = await detectHands(img);
      } catch {
        detections = [];
      }
      for (const d of detections) {
        if (!d || !d.box) continue;
        const region = {
          ...d.box,
          kind: d.kind,
          score: d.score,
          contour: d.contour || null,
          source: 'handTracker',
          label: d.kind === 'hand' ? 'Hand / Pointer' : 'Admin Silhouette',
        };
        if (d.kind === 'hand' && handOutlineEnabled) sil.hand = region;
        if (d.kind === 'person' && adminSilhouetteEnabled) sil.admin = region;
      }
    }

    if (chipOutlineEnabled && getComponentDetectorMode() === 'opencv') {
      try {
        const comps = await detectComponents(img);
        if (comps && comps.length) {
          sil.chips = comps.map((c, i) => ({ ...c, id: `C${i + 1}`, color: OBJECT_COLORS.chip }));
        }
      } catch { /* keep heuristic boxes */ }
    }

    state.detectedSilhouettes = sil;
    return true;
  } finally {
    visionInFlight = false;
  }
}

// Only the canvas is repainted per frame. The SVG overlay is static while live, so
// redrawing it 60x/second would burn phone battery for nothing.
async function loop() {
  if (!live) return;
  if (camera.video && camera.video.videoWidth) {
    drawContain(camera.video, camera.video.videoWidth, camera.video.videoHeight);

    const isTrackingActive = tracker.state !== 'INACTIVE';
    const isVisionActive = handOutlineEnabled || adminSilhouetteEnabled || chipOutlineEnabled;
    const isLooseActive = state.looseMode && state.looseTracker;

    if (isTrackingActive || isVisionActive || isLooseActive) {
      trackCtx.drawImage(camera.video, 0, 0, W, H);
      const img = trackCtx.getImageData(0, 0, W, H);

      if (isTrackingActive) {
        const snap = tracker.update(img);
        drawTrackerMarker(snap);
      } else if (trackedPill) {
        trackedPill.hidden = true;
      }

      // Lighting and hinge diagnostics run at ~1 Hz on a small copy. They are
      // advisory: a black or backlit frame is reported, never "corrected" into
      // a false confidence.
      const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (nowMs - state.lastLightingAt > 1000) {
        state.lastLightingAt = nowMs;
        try {
          lightingCtx.drawImage(camera.video, 0, 0, lightingCanvas.width, lightingCanvas.height);
          const lightImg = lightingCtx.getImageData(0, 0, lightingCanvas.width, lightingCanvas.height);
          state.lightingReport = analyzeLighting(lightImg);
          if (state.hingeModeEnabled) {
            state.hingeReport = state.hingeTracker.update({ image: lightImg, timestamp: Date.now() });
          }
        } catch {
          // A measurement failure must never stop the camera preview.
        }
      }

      // PCB tracking via homography (only when board registered and alignment valid).
      if (state.pcbBoard && state.pcbRegistrar) {
        try {
          const res = state.pcbRegistrar.estimateHomography(img);
          if (res.ok) {
            state.pcbProjected = state.pcbBoard.components.map((c) => {
              const pt = state.pcbRegistrar.projectPoint(res.H, c.x, c.y);
              const box = pt ? { x: (pt.x - (c.width*W)/2)/W, y: (pt.y - (c.height*H)/2)/H, width: c.width, height: c.height } : null;
              let verification = null;
              if (state.pcbVerifier && box) {
                try { const refRegion = state.pcbVerifier.referenceRegions?.[c.id] || null; verification = state.pcbVerifier.verify({ id: c.id, projectedBox: box, box }, img, refRegion); } catch (e) { verification = { state: 'uncertain' }; }
              }
              return { ...c, projected: pt, valid: !!pt, box, verification };
            });
            state.pcbAlignmentOk = true;
            state.pcbMatchCount = res.matches;
            // Explainable per-component confidence, plus a sanity check on the
            // four projected board corners. A bow-tie homography is rejected
            // before it is presented as a registered board.
            const presenceFor = (s) => ({
              visible: 1, reacquired: 0.95, uncertain: 0.55, occluded: 0.25, possibly_absent: 0.1,
            }[s] ?? 0.4);
            state.pcbConfidence = aggregateConfidence(state.pcbProjected.map((c) => componentConfidence({
              similarity: c.verification?.similarity ?? 0,
              sharpness: c.verification?.quality?.sharpness ?? 0,
              presence: presenceFor(c.verification?.state),
            }).score));
            const quad = [[0, 0], [1, 0], [1, 1], [0, 1]]
              .map(([u, v]) => state.pcbRegistrar.projectPoint(res.H, u, v))
              .filter(Boolean)
              .map((p) => ({ x: p.x / W, y: p.y / H }));
            state.pcbBoardQuality = boardQuadQuality(quad);
          } else {
            state.pcbAlignmentOk = false;
            state.pcbMatchCount = res.matches || 0;
            state.pcbProjected = null;
            state.pcbConfidence = null;
            state.pcbBoardQuality = null;
          }
        } catch (e) {
          state.pcbAlignmentOk = false;
          state.pcbProjected = null;
          state.pcbConfidence = null;
          state.pcbBoardQuality = null;
        }
      }

      // Loose-object tracking is independent of PCB registration.
      if (isLooseActive) runLooseTracking(img);

      // Diagnostics overlay.
     if (state.diagOverlayEnabled && $('diagOverlay')) {
       const parts = [];
       if (state.perceptionProfile) parts.push(`Profile: ${state.perceptionProfile.name}`);
       const light = state.lightingReport;
       if (light) parts.push(`Light: ${light.state} ${Math.round(light.score * 100)}%`);
       if (state.hingeModeEnabled) {
         const h = state.hingeReport;
         parts.push(h?.angleDeg != null
           ? `Hinge: ${h.angleDeg.toFixed(0)}° ${classifyHinge(h.angleDeg)} (conf ${Math.round((h.confidence || 0) * 100)}%)`
           : 'Hinge: searching');
       }
       if (state.pcbBoardQuality) parts.push(`Board: ${Math.round(state.pcbBoardQuality.score * 100)}%`);
       if (state.pcbConfidence?.mean != null) parts.push(`Parts: ${Math.round(state.pcbConfidence.mean * 100)}%`);
       $('diagOverlay').textContent = parts.join(' · ');
     }

     if (isVisionActive) {
        // Hand/person detection comes from handTracker.js (OpenCV or JS backend);
        // chip detection stays independent.
        const updated = await updateSilhouettes(img);
        if (updated) drawSilhouettes(overlay);
      } else {
        clearSilhouettes(overlay);
      }
    } else {
      if (trackedPill) trackedPill.hidden = true;
      clearSilhouettes(overlay);
    }
  }

  requestAnimationFrame(loop);
}

function resumeLive() {
  if (camera.getStatus().state !== 'ready') return;
  live = true;
  state.mainMarker = null;   // a live preview moves, so no frozen marker on it
  liveBtn.disabled = true;
  setStatus('Camera live', 'done');
  drawLive();
  loop();
}

async function startCamera() {
  log({ stage: 'camera', kind: 'info', text: 'Requesting camera stream via getUserMedia...' });
  try {
    setStatus('Starting camera…', 'busy');
    await camera.start();
    await populateCamSel(); // device labels only exist after permission
    state.assistant.photoLoaded = false;
    state.assistant.aligned = false;
    renderWorkspace();
    markStartup('firstCameraFrame', {
      width: camera.video?.videoWidth || null,
      height: camera.video?.videoHeight || null,
    });
    camBtn.textContent = 'Stop camera';
    resumeLive();
    setAnswer('Camera is live. Point it at the board, type a command, then press Find it.');
    log({ stage: 'camera', kind: 'ok', text: `Camera connected: ${camera.video?.videoWidth || 1280}x${camera.video?.videoHeight || 720}` });
  } catch (err) {
    const msg = err.message || String(err);
    setStatus('Camera unavailable', 'error');
    setAnswer(msg + ' Use localhost or an https:// link, or use Upload photo.', 'error');
    log({ stage: 'camera', kind: 'error', text: `Camera start failed: ${msg}`, detail: err.stack || err.name });
  }
}

async function stopCamera() {
  log({ stage: 'camera', kind: 'info', text: 'Stopping camera stream' });
  live = false;
  await camera.stop();
  camBtn.textContent = 'Start camera';
  liveBtn.disabled = true;
  setStatus('Camera stopped', 'warn');
  if (trackedPill) trackedPill.hidden = true;
  hideHandOutline();
}

const camSel = $('camSel');
const CAM_KEY = 'intentlens.cameraId';
try { camera.deviceId = localStorage.getItem(CAM_KEY) || ''; } catch { /* optional */ }

async function populateCamSel() {
  if (!camSel || !camera.listDevices) return;
  const devices = await camera.listDevices();
  const keep = camera.deviceId || '';
  camSel.replaceChildren(new Option('Default camera', ''));
  devices.forEach((d, i) => camSel.appendChild(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  camSel.value = devices.some((d) => d.deviceId === keep) ? keep : '';
  camSel.hidden = devices.length < 2;
}

camSel?.addEventListener('change', async () => {
  camera.deviceId = camSel.value;
  try { localStorage.setItem(CAM_KEY, camSel.value); } catch { /* optional */ }
  if (camera.getStatus().state === 'ready') {
    await stopCamera();
    await startCamera();
  }
});
navigator.mediaDevices?.addEventListener?.('devicechange', () => populateCamSel());

camBtn.addEventListener('click', async () => {
  if (camera.getStatus().state === 'ready') await stopCamera();
  else await startCamera();
});
liveBtn.addEventListener('click', () => resumeLive());
uploadBtn.addEventListener('click', () => fileIn.click());

fileIn.addEventListener('change', async () => {
  const f = fileIn.files[0];
  if (!f) return;
  try {
    const bmp = await createImageBitmap(f);
    showBitmapAsFrame(bmp);
  } catch (err) {
    setAnswer(`That file could not be read as an image (${err.message}).`, 'error');
  }
  fileIn.value = '';
});

// ---------------------------------------------------------------------------
// Region selection (§12.1).
// Tap to pick a point; drag to mark a search region. Highlights ONLY the outer
// boundary perimeter (fill: none) so the middle components remain clear.
// ---------------------------------------------------------------------------
const pointerSelection = {
  active: false,
  dragging: false,
  startX: 0,
  startY: 0,
  start: null,
};

function getPointerNorm(e) {
  const rect = canvas.getBoundingClientRect();
  return clientToNormalized(e.clientX, e.clientY, rect);
}

view.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.toolbar, .bar, .hud, .pipe-bar, .setupPopup, .logsPopup, .menuPanel, .assistantCard, .projectPopup')) return;
  // The screenshot workflow uses a still capture, not live tap-to-track.
  if (state.assistant.project) return;
  if (view.classList.contains('zoomed')) {
    view.classList.remove('zoomed');
    return;
  }

  const p = getPointerNorm(e);
  if (state.imageRect && !isInsideNormalizedRect(p.x, p.y, state.imageRect)) {
    return;
  }

  pointerSelection.active = true;
  pointerSelection.dragging = false;
  pointerSelection.startX = e.clientX;
  pointerSelection.startY = e.clientY;
  pointerSelection.start = p;

  state.hint = { x: p.x, y: p.y };

  drawLive();
  drawSnapshot(state.lastResult);
});

view.addEventListener('pointermove', (e) => {
  if (!pointerSelection.active || !pointerSelection.start) return;
  const dist = Math.hypot(e.clientX - pointerSelection.startX, e.clientY - pointerSelection.startY);
  if (dist > 6) {
    pointerSelection.dragging = true;
  }
  if (!pointerSelection.dragging) return;

  const p = getPointerNorm(e);
  const x0 = Math.min(pointerSelection.start.x, p.x);
  const y0 = Math.min(pointerSelection.start.y, p.y);
  const x1 = Math.max(pointerSelection.start.x, p.x);
  const y1 = Math.max(pointerSelection.start.y, p.y);
  const bw = Math.max(x1 - x0, 0.004);
  const bh = Math.max(y1 - y0, 0.004);

  state.hint = {
    x: x0 + bw / 2,
    y: y0 + bh / 2,
    box: { x: x0, y: y0, width: bw, height: bh },
  };

  drawLive();
  drawSnapshot(state.lastResult);
});

/** Start local optical-flow tracking from the selected region. No cloud call. */
function startLocalTrackingFromHint() {
  if (!state.hint) return false;
  const box = state.hint.box || {
    x: Math.max(0, state.hint.x - 0.04),
    y: Math.max(0, state.hint.y - 0.04),
    width: 0.08,
    height: 0.08,
  };
  const targetId = `LOCAL_${String(state.frameCount + 1).padStart(2, '0')}`;
  tracker.init({
    targetId,
    anchor: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    box,
  });
  state.lastTargetId = targetId;
  log({ stage: 'tracking', provider: 'local', text: `local target ${targetId} started` });
  return true;
}

function finishPointerSelection() {
  if (!pointerSelection.active) return;
  pointerSelection.active = false;
  if (!state.hint) return;

  const trackingStarted = !pointerSelection.dragging && camera.getStatus().state === 'ready'
    ? startLocalTrackingFromHint()
    : false;

  if (pointerSelection.dragging) {
    setAnswer('Selected search region. Outer perimeter outline marked — centre clear.');
  } else if (trackingStarted) {
    setAnswer('Local tracking started. This is a candidate region, not a verified component. Ask a question to identify it.', 'warn');
    if (state.menuOpen) renderMenu();
  } else {
    setAnswer('Point marked. Ask a question to identify what is there.');
  }

  drawLive();
  drawSnapshot(state.lastResult);
}

view.addEventListener('pointerup', finishPointerSelection);
view.addEventListener('pointercancel', finishPointerSelection);

snapBox.addEventListener('click', (e) => {
  e.stopPropagation();
  view.classList.toggle('zoomed');
  drawSnapshot(state.lastResult);
});

// ---------------------------------------------------------------------------
// Capture + submit
// ---------------------------------------------------------------------------
/**
 * Repair a still in place when the measurement says it needs it. This runs on
 * the capture path only (once per request), never per preview frame.
 */
function preprocessStill(ctx, width, height) {
  try {
    const frame = ctx.getImageData(0, 0, width, height);
    const repaired = adaptivePreprocess(frame, { mode: 'auto' });
    const report = {
      before: {
        state: repaired.before.state,
        score: repaired.before.score,
        mean: repaired.before.mean,
        uniformity: repaired.before.uniformity,
      },
      after: {
        state: repaired.after.state,
        score: repaired.after.score,
        mean: repaired.after.mean,
        uniformity: repaired.after.uniformity,
      },
      steps: repaired.steps,
      changed: repaired.changed,
      improved: repaired.improved,
    };
    state.lightingReport = repaired.after;
    state.lastPreprocess = report;
    if (repaired.changed && repaired.improved) ctx.putImageData(repaired.image, 0, 0);
    return report;
  } catch {
    // Enhancement is best-effort; a capture must still work if it fails.
    return null;
  }
}

function captureFrame() {
  const ctx = snap.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  const lighting = preprocessStill(ctx, snap.width, snap.height);
  snapBox.hidden = false;
  state.frameCount += 1;
  const frameId = `frame_${String(state.frameCount).padStart(3, '0')}`;
  state.capturedFrameId = frameId;
  return {
    frameId,
    dataUrl: snap.toDataURL('image/jpeg', 0.82),
    width: W,
    height: H,
    capturedAt: new Date().toISOString(),
    lighting,
  };
}

// ---------------------------------------------------------------------------
// Beginner project workflow (screenshot -> local lookup -> one vision request)
// ---------------------------------------------------------------------------
const ASSISTANT_IDLE = 'Create a project to begin.';

function setWsStatus(text, tone = 'ready') {
  if (!wsStatus) return;
  wsStatus.textContent = String(text || '');
  wsStatus.dataset.tone = tone;
}

async function assistantApi(url, { method = 'GET', body = null } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Request failed (HTTP ${res.status})`);
    err.code = data?.error?.code || 'REQUEST_FAILED';
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

function showInstructionText(text) {
  if (text) setAnswer(String(text));
}

function renderWorkspace() {
  const project = state.assistant.project;
  if (!project) {
    wsEl.hidden = true;
    return;
  }
  wsEl.hidden = false;
  wsTitle.textContent = project.title || 'Project';
  wsGoal.textContent = project.userGoal || '';

  const step = currentStepOf(project);
  wsStep.textContent = step ? step.instructionText : 'All planned steps are done. Capture a new component or ask a question.';

  const steps = Array.isArray(project.orderedSteps) ? project.orderedSteps : [];
  const done = steps.filter((s) => s.status === 'done').length;
  wsBar.style.width = `${Math.round((done / Math.max(1, steps.length)) * 100)}%`;

  wsParts.replaceChildren();
  const expected = project.componentsExpected || [];
  const available = new Set(project.availableMaterials || []);
  const confirmed = new Set(project.confirmedComponents || []);
  if (expected.length) {
    const line = document.createElement('div');
    line.textContent = `Parts: ${expected.map((name) => (
      confirmed.has(name) ? `${name} ✓`
        : available.has(name) ? `${name} (you have it)`
          : `${name} (not confirmed)`
    )).join(', ')}`;
    wsParts.append(line);
  } else {
    wsParts.textContent = 'No parts extracted yet. Add them in your project description.';
  }

  wsSafety.replaceChildren();
  if (Array.isArray(project.safetyNotes) && project.safetyNotes.length) {
    const ul = document.createElement('ul');
    for (const note of project.safetyNotes.slice(0, 3)) {
      const li = document.createElement('li');
      li.textContent = note;
      ul.append(li);
    }
    wsSafety.append(ul);
  }

  wsAlignBtn.textContent = state.assistant.aligned ? 'Aligned ✓' : "I'm aligned";
  wsCaptureBtn.disabled = state.assistant.busy || !state.assistant.aligned;
}

function drawEvidenceCorners(card) {
  if (!evCorners) return;
  evCorners.replaceChildren();
  if (!card?.drawOutline) return;
  const ns = 'http://www.w3.org/2000/svg';
  const polygon = document.createElementNS(ns, 'polygon');
  polygon.setAttribute('points', card.corners
    .map((p) => `${(p.x * 1000).toFixed(2)},${(p.y * 1000).toFixed(2)}`)
    .join(' '));
  evCorners.append(polygon);
  for (const p of card.corners) {
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', (p.x * 1000).toFixed(2));
    dot.setAttribute('cy', (p.y * 1000).toFixed(2));
    dot.setAttribute('r', '9');
    evCorners.append(dot);
  }
}

async function ensureEvidenceImages(capture) {
  const id = capture?.captureId || null;
  if (state.assistant._loadedCaptureId === id) return;
  state.assistant._loadedCaptureId = id;
  for (const url of state.assistant._blobUrls || []) URL.revokeObjectURL(url);
  state.assistant._blobUrls = [];
  evOriginal.hidden = true;
  if (!capture) return;

  const load = async (url, img) => {
    if (!url) return;
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      state.assistant._blobUrls.push(objectUrl);
      img.src = objectUrl;
      img.hidden = false;
    } catch (err) {
      log({ stage: 'capture', kind: 'warn', text: `Evidence image failed: ${err.message || err}` });
    }
  };
  await load(capture.originalUrl, evOriginal);
}

function renderEvidence() {
  const project = state.assistant.project;
  const capture = state.assistant.capture;
  if (!project && !capture) {
    evPanel.hidden = true;
    return;
  }
  evPanel.hidden = false;
  const card = state.assistant.evidence
    || buildEvidenceCard({ capture, object: state.assistant.object, analysis: state.assistant.analysis, candidates: state.assistant.candidates, analysisState: state.assistant.analysisState });
  state.assistant.evidence = card;

  evPanel.classList.toggle('expanded', Boolean(card.expanded));
  evTitle.textContent = card.title || 'Component evidence';
  evStatus.textContent = card.statusLabel || '';
  evStatus.dataset.tone = card.confirmed ? 'ok'
    : ['unavailable', 'rejected', 'invalid'].includes(state.assistant.analysisState) ? 'error'
      : card.identityStatus === 'ai_candidate' ? 'warn'
        : capture && !state.assistant.analysis ? 'warn' : '';

  evEmpty.hidden = Boolean(capture);
  if (!capture) evEmpty.textContent = 'No capture yet. Align the board, then press Capture component.';
  drawEvidenceCorners(card);
  ensureEvidenceImages(capture);

  evMeta.replaceChildren();
  if (capture) {
    const meta = document.createElement('div');
    const size = document.createTextNode(`${capture.width}×${capture.height}`);
    meta.append(size);
    if (card.uncertainty) {
      const unc = document.createElement('div');
      unc.textContent = `AI uncertainty: ${card.uncertainty}. ${card.identityStatus === 'confirmed_by_user' ? 'You confirmed this identity.' : 'This is a candidate, not a verified fact.'}`;
      meta.append(unc);
    }
    evMeta.append(meta);
  }

  const hasObject = Boolean(state.assistant.object);
  evConfirmBtn.disabled = !hasObject || Boolean(state.assistant.object?.confirmed);
  evCorrectBtn.disabled = !hasObject;
  evRetakeBtn.disabled = !capture;
  evRepeatBtn.disabled = !(state.assistant.lastAnswer?.text || state.assistant.project?.lastAnswer?.text);
  if (evExplainBtn) evExplainBtn.disabled = evRepeatBtn.disabled;
  evExpandBtn.disabled = !card.canExpand;
  evExpandBtn.textContent = card.expanded ? 'Collapse' : 'Expand';

  evInstruction.textContent = card.instruction || '';
  if (card.evidence.length) {
    const evidenceLine = document.createElement('div');
    evidenceLine.className = 'evMeta';
    evidenceLine.textContent = `Visible evidence: ${card.evidence.join('; ')}`;
    evInstruction.append(evidenceLine);
  }

  evCandidates.replaceChildren();
  const candidates = Array.isArray(card.candidates) ? card.candidates : [];
  const title = document.createElement('div');
  title.className = 'evCandidatesTitle';
  title.textContent = candidates.length ? 'Local reference lookup (unverified)' : 'Local reference lookup';
  evCandidates.append(title);
  if (candidates.length) {
    for (const candidate of candidates) {
      const row = document.createElement('div');
      row.className = 'evCandidate';
      const name = document.createElement('span');
      name.textContent = candidate.name;
      const right = document.createElement('span');
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'UNVERIFIED';
      const dist = document.createElement('span');
      dist.className = 'dist';
      dist.textContent = candidate.distance == null ? '' : ` d=${candidate.distance}`;
      right.append(badge, dist);
      row.append(name, right);
      evCandidates.append(row);
    }
    const note = document.createElement('div');
    note.className = 'evCandidate';
    note.textContent = 'Distance is not a probability. AI analysis and your confirmation decide identity.';
    evCandidates.append(note);
  } else {
    const none = document.createElement('div');
    none.className = 'evCandidate';
    none.textContent = state.assistant.localLookup
      ? 'No local reference candidate. This does not prevent the AI analysis.'
      : 'Runs after capture.';
    evCandidates.append(none);
  }
}

function showProjectPopup(show) {
  projectPopup.hidden = !show;
  projectBackdrop.hidden = !show;
  if (!show) return;
  // One modal at a time: the project dialog takes over from provider setup.
  const setupPopup = $('setupPopup'), setupBackdrop = $('setupBackdrop');
  if (setupPopup) setupPopup.hidden = true;
  if (setupBackdrop) setupBackdrop.hidden = true;
  const info = inspectMobileSupport({
    secureContext: Boolean(window.isSecureContext),
    hasMediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
    userAgent: navigator.userAgent,
    viewportWidth: window.innerWidth,
    isLocalhost: ['localhost', '127.0.0.1', '::1'].includes(location.hostname),
  });
  state.assistant.mobile = info;
  if (mobileStatusEl) mobileStatusEl.textContent = describeMobileSupport(info);
  loadRecentProjects();
}

async function loadRecentProjects() {
  if (!projectRecent) return;
  projectRecent.replaceChildren();
  try {
    const data = await assistantApi('/api/projects');
    const projects = Array.isArray(data.projects) ? data.projects.slice(0, 8) : [];
    if (!projects.length) {
      const empty = document.createElement('div');
      empty.className = 'setupHint';
      empty.textContent = 'No saved projects yet.';
      projectRecent.append(empty);
      return;
    }
    for (const item of projects) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'projectRecentItem';
      const title = document.createElement('span');
      title.textContent = item.title || item.userGoal || item.projectId;
      const meta = document.createElement('small');
      meta.textContent = `${item.currentStep || 'no current step'} · ${item.captureCount || 0} capture(s)`;
      button.append(title, meta);
      button.addEventListener('click', () => loadAssistantProject(item.projectId).catch((err) => {
        projectMsg.textContent = err.message;
      }));
      projectRecent.append(button);
    }
  } catch (err) {
    projectMsg.textContent = `Could not list projects: ${err.message}`;
  }
}

async function drawRestoredCapture(capture) {
  if (!capture?.originalUrl) return;
  try {
    const res = await fetch(capture.originalUrl, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    // The restored capture becomes the frozen frame, exactly like an upload.
    live = false;
    state.assistant.photoLoaded = true;
    drawContain(bmp, capture.width || bmp.width, capture.height || bmp.height);
    drawLive();
  } catch (err) {
    log({ stage: 'capture', kind: 'warn', text: `Could not redraw restored capture: ${err.message || err}` });
  }
}

async function restoreLastCapture(project) {
  const captureId = project.lastAnswer?.captureId
    || (Array.isArray(project.capturedImages) ? project.capturedImages[project.capturedImages.length - 1]?.captureId : null);
  if (!captureId) return false;
  try {
    const data = await assistantApi(`/api/captures/${encodeURIComponent(captureId)}`);
    const capture = data.capture;
    const object = [...(project.objects || [])].reverse().find((item) => item.captureId === captureId) || null;
    state.assistant.capture = capture;
    state.assistant.object = object;
    state.assistant.analysis = object ? {
      component: {
        name: object.name,
        identity_status: object.identityStatus,
        evidence: object.evidence || [],
        uncertainty: object.uncertainty || 'medium',
      },
      location: object.corners ? {
        center: object.center,
        corners: object.corners,
      } : null,
      next_action: object.nextAction || 'instruction',
      instruction: object.instruction || '',
    } : null;
    state.assistant.candidates = [];
    state.assistant.localLookup = null;
    const outcome = project.lastAnalysis?.captureId === captureId ? project.lastAnalysis.status : null;
    state.assistant.analysisState = object
      ? 'ok'
      : ['unavailable', 'rejected', 'invalid'].includes(outcome) ? outcome : null;
    state.assistant.evidence = buildEvidenceCard({
      capture,
      object,
      analysis: state.assistant.analysis,
      analysisState: state.assistant.analysisState,
      expanded: false,
    });
    await drawRestoredCapture(capture);
    return true;
  } catch (err) {
    log({ stage: 'project', kind: 'warn', text: `Could not restore last capture: ${err.message}` });
    return false;
  }
}

async function loadAssistantProject(projectId) {
  const data = await assistantApi(`/api/projects/${encodeURIComponent(projectId)}`);
  const project = deserializeProject(data.project) || data.project;
  state.assistant.project = project;
  state.assistant.lastAnswer = project.lastAnswer || null;
  state.assistant.capture = null;
  state.assistant.analysis = null;
  state.assistant.object = null;
  state.assistant.candidates = [];
  state.assistant.localLookup = null;
  state.assistant.evidence = null;
  state.assistant.analysisState = null;
  state.assistant.aligned = false;
  state.assistant._loadedCaptureId = null;
  localStorage.setItem(PROJECT_KEY, projectId);
  await restoreLastCapture(project);
  renderWorkspace();
  renderEvidence();
  showProjectPopup(false);
  setWsStatus(`Loaded "${project.title}". Align the board and capture a component.`, 'ok');
  const step = currentStepOf(project);
  if (step) showInstructionText(step.instructionText);
}

async function createAssistantProject() {
  const intent = projectIntent.value.trim();
  if (!intent) {
    projectMsg.textContent = 'Describe what you want to build first.';
    return;
  }
  projectCreateBtn.disabled = true;
  projectMsg.className = 'setupMsg busy';
  projectMsg.textContent = 'Creating project…';
  try {
    const data = await assistantApi('/api/projects', { method: 'POST', body: { intent } });
    const project = deserializeProject(data.project) || data.project;
    state.assistant.project = project;
    state.assistant.lastAnswer = project.lastAnswer || null;
    state.assistant.capture = null;
    state.assistant.analysis = null;
    state.assistant.object = null;
    state.assistant.candidates = [];
    state.assistant.localLookup = null;
    state.assistant.evidence = null;
    state.assistant.analysisState = null;
    state.assistant.aligned = false;
    localStorage.setItem(PROJECT_KEY, project.projectId);
    renderWorkspace();
    renderEvidence();
    showProjectPopup(false);
    projectMsg.className = 'setupMsg ok';
    projectMsg.textContent = 'Project created.';
    const step = currentStepOf(project);
    const text = step ? step.instructionText : project.userGoal;
    setWsStatus('Project created. Press "I\'m aligned", then capture a component.', 'ok');
    showInstructionText(text);
    log({ stage: 'project', kind: 'ok', text: `Created ${project.projectId} (${project.title})` });
  } catch (err) {
    projectMsg.className = 'setupMsg error';
    projectMsg.textContent = err.message;
  } finally {
    projectCreateBtn.disabled = false;
  }
}

async function persistAssistantProject(next, { render = true } = {}) {
  state.assistant.project = next;
  localStorage.setItem(PROJECT_KEY, next.projectId);
  try {
    const data = await assistantApi(`/api/projects/${encodeURIComponent(next.projectId)}`, {
      method: 'PUT',
      body: { project: next },
    });
    state.assistant.project = data.project;
  } catch (err) {
    log({ stage: 'project', kind: 'warn', text: `Project save failed: ${err.message}` });
    setWsStatus(`Could not save project state: ${err.message}`, 'error');
  }
  if (render) renderWorkspace();
  return state.assistant.project;
}

function makeCleanCapture() {
  const clean = document.createElement('canvas');
  clean.width = W;
  clean.height = H;
  const ctx = clean.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, W, H);
  const lighting = preprocessStill(ctx, W, H);
  return { clean, ctx, lighting };
}

/**
 * Ask the measured local recogniser about the centre of the capture. The
 * camera workflow asks the user to point one component at the centre, so a
 * centre crop is the honest region to classify. A low-confidence result is
 * discarded instead of being dressed up as an identification.
 */
async function recognizerCandidates(clean) {
  try {
    const side = Math.max(32, Math.round(Math.min(W, H) * 0.6));
    const sx = Math.round((W - side) / 2);
    const sy = Math.round((H - side) / 2);
    const crop = document.createElement('canvas');
    crop.width = 224;
    crop.height = 224;
    const ctx = crop.getContext('2d');
    ctx.drawImage(clean, sx, sy, side, side, 0, 0, 224, 224);
    const dataUrl = crop.toDataURL('image/png');
    const result = await assistantApi('/api/recognizer/classify', {
      method: 'POST',
      body: { dataUrl, topK: 5 },
    });
    if (!result?.available) return null;
    return result;
  } catch {
    // The recogniser is optional; the AI analysis must still run without it.
    return null;
  }
}

async function captureComponent() {  const project = state.assistant.project;
  if (!project) {
    setWsStatus('Create a project first.', 'error');
    return;
  }
  if (!state.assistant.aligned) {
    setWsStatus('Confirm alignment first: press "I\'m aligned".', 'warn');
    return;
  }
  if (camera.getStatus().state !== 'ready' && !state.assistant.photoLoaded) {
    setWsStatus('Open the camera or upload a photo first.', 'warn');
    return;
  }
  if (state.assistant.busy) return;

  state.assistant.busy = true;
  state.assistant.aligned = false;
  renderWorkspace();
  setWsStatus('Capturing…', 'busy');
  setStatus('Capturing…', 'busy');

  try {
    const { clean, ctx } = makeCleanCapture();
    const dataUrl = clean.toDataURL('image/jpeg', 0.85);
    const capturedAt = new Date().toISOString();

    const captureResponse = await assistantApi('/api/captures', {
      method: 'POST',
      body: {
        projectId: project.projectId,
        width: W,
        height: H,
        capturedAt,
        dataUrl,
      },
    });
    const capture = captureResponse.capture;
    state.assistant.capture = capture;
    state.assistant.object = null;
    state.assistant.analysis = null;
    state.assistant.analysisState = null;
    state.assistant.candidates = [];
    state.assistant.localLookup = null;
    state.assistant._loadedCaptureId = null;
    if (captureResponse.project) {
      state.assistant.project = deserializeProject(captureResponse.project) || captureResponse.project;
      renderWorkspace();
    }
    state.assistant.evidence = buildEvidenceCard({ capture });
    renderEvidence();
    setWsStatus('Local reference lookup…', 'busy');
    setStatus('Local reference lookup', 'busy');

    // Supporting local lookup. The measured ONNX recogniser is preferred; the
    // older k-NN index remains a fallback and is always shown as unverified.
    let lookup = null;
    try {
      const trackerInstance = await ensureLooseTracker();
      const imageData = ctx.getImageData(0, 0, W, H);
      lookup = lookupCandidates({ tracker: trackerInstance, imageData });
    } catch (err) {
      lookup = { available: false, reason: err.message || String(err), candidates: [] };
    }
    const recognition = await recognizerCandidates(clean);
    const recognized = (recognition?.candidates || [])
      .filter((candidate) => Number(candidate.confidence) >= 0.35)
      .slice(0, 3);
    if (recognized.length) {
      lookup = {
        available: true,
        source: 'component_classifier_onnx',
        recognizer: {
          label: recognition.label,
          confidence: recognition.confidence,
          model: recognition.model,
        },
        candidates: recognized.map((candidate) => ({
          name: candidate.name,
          confidence: candidate.confidence,
          status: 'measured_model_candidate',
          note: 'Unverified local model candidate. AI analysis and user confirmation decide identity.',
        })),
      };
    }
    state.assistant.localLookup = lookup;
    state.assistant.candidates = lookup?.candidates || [];
    state.assistant.evidence = buildEvidenceCard({ capture, candidates: state.assistant.candidates });
    renderEvidence();

    setWsStatus('Sending image to provider…', 'busy');
    setStatus('Sending image to provider', 'busy');
    const started = performance.now();
    const result = await assistantApi('/api/component/analyze', {
      method: 'POST',
      body: {
        projectId: project.projectId,
        captureId: capture.captureId,
        question: project.userGoal,
        localCandidates: state.assistant.candidates.map((c) => ({
          name: c.name,
          distance: c.distance,
          confidence: c.confidence,
        })),
      },
    });
    const latency = Math.round(performance.now() - started);

    if (result.status === 'unavailable') {
      state.assistant.analysisState = 'unavailable';
      state.assistant.evidence = buildEvidenceCard({ capture, candidates: state.assistant.candidates, analysisState: 'unavailable' });
      renderEvidence();
      const message = result.message || 'Online visual reasoning is unavailable. Your capture is saved locally.';
      setWsStatus(message, 'error');
      setStatus('Analysis unavailable — capture saved', 'warn');
      setAnswer(message, 'warn');
      log({ stage: 'model', kind: 'warn', text: result.message || result.code });
      return;
    }

    if (result.status !== 'ok') {
      const message = result.message || 'The AI response could not be validated. No box was drawn.';
      state.assistant.analysisState = 'rejected';
      state.assistant.evidence = buildEvidenceCard({ capture, candidates: state.assistant.candidates, analysisState: 'rejected' });
      renderEvidence();
      setWsStatus(message, 'error');
      setStatus('Analysis rejected — capture saved', 'error');
      setAnswer(`${message} Your capture is saved locally.`, 'error');
      log({ stage: 'model', kind: 'warn', text: message, detail: (result.errors || []).join(' ') });
      return;
    }

    // Independent client-side validation: never draw an unvalidated box.
    const check = validateNormalizedComponentResult(result.analysis);
    if (!check.ok) {
      state.assistant.analysisState = 'invalid';
      state.assistant.evidence = buildEvidenceCard({ capture, candidates: state.assistant.candidates, analysisState: 'invalid' });
      renderEvidence();
      setWsStatus('AI coordinates failed client validation. No box was drawn.', 'error');
      setStatus('Invalid coordinates rejected', 'error');
      setAnswer('AI coordinates failed validation, so no box was drawn. Your capture is saved locally.', 'error');
      log({ stage: 'model', kind: 'warn', text: 'Client rejected coordinates', detail: check.errors.join(' ') });
      return;
    }

    state.assistant.analysis = result.analysis;
    state.assistant.analysisState = 'ok';
    state.assistant.object = result.object || null;
    state.assistant.lastAnswer = {
      text: result.analysis.instruction,
      objectId: result.object?.id || null,
      captureId: capture.captureId,
      nextAction: result.analysis.next_action,
      provider: result.provider?.id || null,
      at: new Date().toISOString(),
    };
    state.assistant.evidence = buildEvidenceCard({
      capture,
      object: result.object,
      analysis: result.analysis,
      candidates: state.assistant.candidates,
      analysisState: 'ok',
    });
    renderEvidence();

    // Re-read the project so the persisted object/conversation is authoritative.
    try {
      const fresh = await assistantApi(`/api/projects/${encodeURIComponent(project.projectId)}`);
      state.assistant.project = deserializeProject(fresh.project) || fresh.project;
      renderWorkspace();
    } catch { /* keep the local copy */ }

    setWsStatus(`Coordinate received (${latency} ms). Confirm or correct the component.`, 'ok');
    setStatus('Coordinate received', 'done');
    showInstructionText(result.analysis.instruction);
    log({
      stage: 'model',
      kind: 'ok',
      text: `${result.provider?.name || result.provider?.id || 'provider'} returned ${result.analysis.location ? 'a location' : 'no location'} in ${latency} ms`,
    });
  } catch (err) {
    const message = err.message || String(err);
    setWsStatus(`Error: ${message}. Your capture is kept locally.`, 'error');
    setStatus('Error — retry', 'error');
    setAnswer(`Something went wrong: ${message}. Your capture is saved; press Capture component to retry.`, 'error');
    log({ stage: 'model', kind: 'error', text: `Capture/analysis failed: ${message}` });
  } finally {
    state.assistant.busy = false;
    renderWorkspace();
  }
}

function findLastAnswer() {
  return state.assistant.lastAnswer
    || state.assistant.project?.lastAnswer
    || null;
}

async function handleRepeat() {
  const result = await repeatAnswer({ lastAnswer: findLastAnswer() });
  if (!result.ok) {
    setWsStatus('There is no previous answer to repeat yet.', 'warn');
    return;
  }
  setAnswer(result.text);
  setWsStatus('Showing the stored answer again. No AI request was made.', 'ok');
}

async function handleExplain() {
  const lastAnswer = findLastAnswer();
  if (!lastAnswer?.text) {
    setWsStatus('There is no previous answer to explain yet.', 'warn');
    return;
  }
  setWsStatus('Asking for a simpler explanation (one AI request)…', 'busy');
  const result = await explainAnswer({
    lastAnswer,
    requestExplain: (previous) => assistantApi('/api/explain', {
      method: 'POST',
      body: {
        projectId: state.assistant.project?.projectId,
        previousAnswer: previous.text,
        captureId: state.assistant.capture?.captureId || previous.captureId || null,
        question: state.assistant.project?.userGoal || '',
      },
    }),
  });

  if (!result.ok) {
    const message = result.message || (result.reason === 'provider_unavailable'
      ? 'Online explanation is unavailable. The previous answer is kept.'
      : `Explanation failed: ${result.error || result.reason}`);
    setWsStatus(message, 'error');
    if (result.text) setAnswer(result.text);
    return;
  }

  state.assistant.lastAnswer = { ...lastAnswer, text: result.text, at: new Date().toISOString(), kind: 'explanation' };
  if (state.assistant.project) {
    state.assistant.project = { ...state.assistant.project, lastAnswer: state.assistant.lastAnswer };
  }
  setAnswer(result.text);
  setWsStatus('Explanation received.', 'ok');
}

async function confirmCurrentObject(correctedName = null) {
  const project = state.assistant.project;
  const object = state.assistant.object;
  if (!project || !object) return;
  const next = confirmProjectObject(project, object.id, correctedName);
  const updatedObject = (next.objects || []).find((item) => item.id === object.id) || object;
  state.assistant.project = next;
  state.assistant.object = updatedObject;
  state.assistant.evidence = buildEvidenceCard({
    capture: state.assistant.capture,
    object: updatedObject,
    analysis: state.assistant.analysis,
    candidates: state.assistant.candidates,
    analysisState: state.assistant.analysisState,
    expanded: state.assistant.evidence?.expanded,
  });
  evCorrectRow.hidden = true;
  renderWorkspace();
  renderEvidence();
  setWsStatus(`Confirmed as "${updatedObject.name}". This is now your identification, not an AI guess.`, 'ok');
  await persistAssistantProject(next);
}

async function nextProjectStep() {
  const project = state.assistant.project;
  if (!project) return;
  const next = advanceProjectStep(project, project.currentStep);
  state.assistant.project = next;
  renderWorkspace();
  await persistAssistantProject(next);
  const step = currentStepOf(next);
  if (step) showInstructionText(step.instructionText);
  setWsStatus(step ? `Next step: ${step.action}.` : 'All planned steps are done.', 'ok');
}

function wireAssistant() {
  // Read-aloud controls (synthesis only; no microphone anywhere in this app).
  $('readAloudBtn')?.addEventListener('click', speakAnswer);
  $('stopReadAloudBtn')?.addEventListener('click', () => {
    speech.stop();
    setSpeechButtons();
  });
  setSpeechButtons();

  // Hide legacy tracking/training/PCB/transfer panels from this release's UI.
  for (const key of ['tracking', 'training', 'pcb', 'transfer']) {
    const heading = document.querySelector(`.menuHeading[data-section="${key}"]`);
    const section = heading?.closest('.menuSection');
    if (section) section.hidden = true;
  }

  // This release does not render legacy hand/person/chip contours or loose
  // tracks. The frozen tracking code stays in the build, but an unverified
  // contour must never look like a component detection. Only validated AI
  // results and the evidence panel draw boxes.
  trackerSetHandOutline(false);
  trackerSetAdminSilhouette(false);
  trackerSetChipOutline(false);
  state.looseMode = false;
  for (const id of ['handOutlineToggle', 'adminSilhouetteToggle', 'chipOutlineToggle', 'looseModeToggle']) {
    const toggle = $(id);
    if (toggle) {
      toggle.checked = false;
      toggle.disabled = true;
    }
  }
  hideHandOutline();

  projectBtn?.addEventListener('click', () => showProjectPopup(true));
  projectCloseBtn?.addEventListener('click', () => showProjectPopup(false));
  projectBackdrop?.addEventListener('click', () => showProjectPopup(false));
  wsEditBtn?.addEventListener('click', () => showProjectPopup(true));
  projectCreateBtn?.addEventListener('click', createAssistantProject);
  projectProviderBtn?.addEventListener('click', () => showSetupPopup(true));
  projectResumeBtn?.addEventListener('click', async () => {
    // localStorage only knows about projects opened in this browser profile.
    // Fall back to the newest project on the local server so a resumed project
    // still works after clearing site data or opening the app on another device.
    let id = localStorage.getItem(PROJECT_KEY);
    if (!id) {
      try {
        const data = await assistantApi('/api/projects');
        id = Array.isArray(data.projects) ? data.projects[0]?.projectId || null : null;
      } catch (err) {
        projectMsg.textContent = `Could not list projects: ${err.message}`;
        return;
      }
    }
    if (!id) {
      projectMsg.textContent = 'No saved project yet. Describe what you want to build, then press Create project.';
      return;
    }
    loadAssistantProject(id).catch((err) => { projectMsg.textContent = err.message; });
  });

  wsAlignBtn?.addEventListener('click', () => {
    state.assistant.aligned = !state.assistant.aligned;
    renderWorkspace();
    setWsStatus(state.assistant.aligned
      ? 'Alignment confirmed. Keep the board still, then press Capture component.'
      : 'Alignment cleared. Position the board inside the frame.', state.assistant.aligned ? 'ok' : 'ready');
  });
  wsCaptureBtn?.addEventListener('click', captureComponent);
  wsNextBtn?.addEventListener('click', nextProjectStep);
  wsRepeatBtn?.addEventListener('click', handleRepeat);
  wsExplainBtn?.addEventListener('click', handleExplain);

  evExpandBtn?.addEventListener('click', () => {
    if (!state.assistant.evidence) return;
    state.assistant.evidence = toggleExpanded(state.assistant.evidence);
    renderEvidence();
  });
  evConfirmBtn?.addEventListener('click', () => confirmCurrentObject());
  evCorrectBtn?.addEventListener('click', () => {
    if (!state.assistant.object) return;
    evNameInput.value = state.assistant.object.name || '';
    evCorrectRow.hidden = false;
    evNameInput.focus();
  });
  evNameSave?.addEventListener('click', () => {
    const name = evNameInput.value.trim();
    if (!name) {
      setWsStatus('Type a component name before saving.', 'warn');
      return;
    }
    confirmCurrentObject(name);
  });
  evRetakeBtn?.addEventListener('click', () => {
    state.assistant.aligned = false;
    state.assistant.analysis = null;
    state.assistant.analysisState = null;
    state.assistant.object = null;
    state.assistant.lastAnswer = null;
    state.assistant.evidence = state.assistant.capture
      ? buildEvidenceCard({ capture: state.assistant.capture, candidates: state.assistant.candidates })
      : null;
    evCorrectRow.hidden = true;
    renderWorkspace();
    renderEvidence();
    setWsStatus('Retake: keep the board still, press "I\'m aligned", then Capture component.', 'warn');
  });
  evRepeatBtn?.addEventListener('click', handleRepeat);
  evExplainBtn?.addEventListener('click', handleExplain);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !projectPopup.hidden) showProjectPopup(false);
  });

  // Resume the last project on this device, or show the setup popup once.
  const savedId = localStorage.getItem(PROJECT_KEY);
  if (savedId) {
    loadAssistantProject(savedId).catch(() => {
      localStorage.removeItem(PROJECT_KEY);
      showProjectPopup(true);
    });
  } else {
    showProjectPopup(true);
  }
}

function scenePayload() {
  const base = state.scene.map((s) => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    point: s.point,
    box: s.box,
    sourceFrameId: s.sourceFrameId,
    confidence: s.confidence,
    evidenceKind: s.evidenceKind,
    status: s.status,
    updatedAt: s.updatedAt,
  }));
  // Inject PCB-registered components when alignment is valid.
  if (state.pcbAlignmentOk && Array.isArray(state.pcbProjected)) {
    for (const c of state.pcbProjected) {
      if (!c.valid || !c.projected) continue;
      base.push({
        id: c.id,
        label: c.type,
        kind: 'component',
        point: { x: c.projected.x / W, y: c.projected.y / H },
        box: { x: c.projected.x / W - c.width/2, y: c.projected.y / H - c.height/2, width: c.width, height: c.height },
        sourceFrameId: state.capturedFrameId,
        confidence: 0.9,
        evidenceKind: 'verified_reference',
        status: 'current',
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return base;
}

function markSceneStale() {
  let changed = false;
  for (const item of state.scene) {
    if (item.status !== 'stale') { item.status = 'stale'; changed = true; }
  }
  if (changed) saveSession();
}

function upsertSceneItem(target, frame, result) {
  const existing = state.scene.find((s) => s.id === target.targetId);
  const item = {
    id: target.targetId,
    label: target.label,
    kind: existing ? existing.kind : 'unknown',
    point: target.point,
    box: target.box || undefined,
    sourceFrameId: frame.frameId,
    confidence: target.confidence,
    evidenceKind: result.evidenceKind,
    status: 'current',
    updatedAt: new Date().toISOString(),
  };
  if (existing) Object.assign(existing, item);
  else state.scene.push(item);
  state.scene = state.scene.slice(-16);
  state.lastTargetId = target.targetId;
  saveSession();
}

function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      scene: state.scene,
      corrections: state.corrections,
      lastTargetId: state.lastTargetId,
      taskSummary: state.taskSummary,
    }));
  } catch { /* private mode / quota: session memory is optional */ }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.scene)) {
      state.scene = data.scene.filter((s) => s && typeof s.id === 'string');
    }
    if (Array.isArray(data.corrections)) state.corrections = data.corrections.slice(-5);
    if (typeof data.lastTargetId === 'string') state.lastTargetId = data.lastTargetId;
    if (typeof data.taskSummary === 'string' && data.taskSummary) state.taskSummary = data.taskSummary;
  } catch { /* ignore a corrupt saved session */ }
}

class RequestError extends Error {
  constructor(message, code, retryable) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
    this.retryable = retryable;
  }
}

async function postAnalyze(payload, signal) {
  let res;
  const started = Date.now();
  log({ stage: 'api', kind: 'info', text: `Analyzing frame for: "${payload.command}"` });
  try {
    res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      log({ stage: 'api', kind: 'warn', text: 'Analysis request cancelled by user.' });
      throw err;
    }
    log({ stage: 'api', kind: 'error', text: `Network error reaching backend: ${err.message}` });
    throw new RequestError('Cannot reach the backend. Is the server running (start.cmd)?', 'NETWORK', true);
  }
  const data = await res.json().catch(() => null);
  const latency = Date.now() - started;
  if (!res.ok) {
    log({
      stage: 'api',
      kind: 'error',
      ms: latency,
      text: `Inference failed (HTTP ${res.status}): ${data?.error?.message || 'Unknown error'}`,
      detail: `Code: ${data?.error?.code || 'INTERNAL_ERROR'}`,
    });
    throw new RequestError(
      data?.error?.message || `The server returned HTTP ${res.status}.`,
      data?.error?.code || 'INTERNAL_ERROR',
      Boolean(data?.error?.retryable),
    );
  }
  if (!data) throw new RequestError('The server returned an empty response.', 'LOCAL_MODEL_BAD_RESPONSE', true);
  const target = data.meta?.request;
  log({
    stage: 'api',
    provider: data.meta?.providerUsed || 'model',
    ms: latency,
    kind: 'ok',
    text: target
      ? `POST ${target.endpoint} · ${target.host} · ${target.model} · HTTP ${target.httpStatus} · ${latency}ms · ${data.resultStatus}`
      : `Result: ${data.resultStatus} — ${data.answerShort?.slice(0, 75) || ''}`,
    detail: target
      ? `request=${target.requestId} provider=${target.provider} mode=${target.mode} model=${target.model}`
      : undefined,
  });
  return data;
}

const FRIENDLY = {
  LOCAL_MODEL_NOT_INSTALLED: 'No vision provider is configured. Open ☰ → Vision Provider & Model → Configure provider. Local camera and tracking still work without one.',
  LOCAL_MODEL_LOAD_FAILED: 'The provider failed to connect. Check the key and model in ☰ → Vision Provider & Model.',
  LOCAL_MODEL_TIMEOUT: 'The vision model took too long to answer. Press Find it to retry.',
  LOCAL_MODEL_BAD_RESPONSE: 'The vision model returned an unreadable format. Press Find it to retry.',
  LOCAL_MODEL_UPSTREAM_ERROR: 'The cloud AI provider returned an error. Check ☰ → Logs.',
  MODEL_AUTH_FAILED: 'API authentication failed. Verify the key in ☰ → Vision Provider & Model → Configure provider.',
  MODEL_NOT_VISION: 'That model cannot read images. Choose a vision-capable model.',
  MODEL_QUOTA_EXHAUSTED: 'The provider quota is exhausted. Failover will try the next configured provider.',
  NETWORK_DISABLED: 'Outbound network is disabled in .env (ALLOW_OUTBOUND_NETWORK=false). Local camera, tracking and k-NN still work.',
  IMAGE_TOO_LARGE: 'That frame was too large to send. Try again.',
  NETWORK: 'Cannot reach the backend server. Start it with start.cmd and reload.',
};

async function submit() {
  if (state.busy) return;
  const command = input.value.trim();
  if (!command) { setAnswer('Type a command first.', 'warn'); input.focus(); return; }

  state.busy = true;
  submitBtn.disabled = true;
  cancelBtn.hidden = false;
  resetPipes();
  setPipeStatus('Starting…');

  try {
    setStatus('Capturing current frame…', 'busy');
    const frame = captureFrame();
    markSceneStale();
    state.lastResult = null;
    state.mainMarker = null;
    if (!live) setStatus('Capturing current frame…', 'busy');

    setPipe('contextualizing', 'active');
    setPipeStatus('Building context…');
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
      requestId,
      sessionId: state.sessionId,
      projectId: state.projectId,
      command,
      frame,
      userSelectedRegion: state.hint ? { x: state.hint.x, y: state.hint.y } : null,
      sceneMap: scenePayload(),
      pcbContext: state.pcbBoard ? (window.buildPcbSceneContext ? window.buildPcbSceneContext(state) : null) : null,
      taskSummary: state.taskSummary,
      referencePack: null,
      recentCorrections: state.corrections.slice(-3),
      lastTargetId: state.lastTargetId,
      allowWebSearch: false,
    };
    const controller = new AbortController();
    state.active = { requestId, controller, frameId: frame.frameId };
    setPipe('contextualizing', 'done');

    setPipe('api', 'active');
    setPipeStatus('Analysing image…');
    setStatus('Analysing image…', 'busy');
    const result = await postAnalyze(payload, controller.signal);

    // A late response from an older request is ignored, not rendered.
    if (!state.active || state.active.requestId !== requestId) return;
    setPipe('api', 'done');

    // Searching shows as done ONLY when the response proves a search ran.
    setPipe('searching', result.meta?.searchedWeb ? 'done' : 'skipped');

    setPipe('localising', 'active');
    setPipeStatus('Localising target…');
    setStatus('Localising target…', 'busy');

    // Never trust the model blindly: re-validate on this side too.
    const check = validateResult(result, { requestId, frameId: frame.frameId });
    if (!check.ok) throw new RequestError(check.reason, 'RESULT_SCHEMA_INVALID', false);

    applyResult(result, frame);
    setPipe('localising', 'done');
    setPipeStatus('Done');
    state.hint = null;
  } catch (err) {
    if (err.name === 'AbortError') {
      failActive();
      setPipeStatus('Cancelled');
      setStatus('Ready — cancelled', 'warn');
      setAnswer('Cancelled. Your command is still in the box.', 'warn');
    } else {
      failActive();
      setPipeStatus('Error');
      const text = FRIENDLY[err.code] || err.message || 'Something went wrong.';
      const suffix = err.retryable ? ' Press Find it to retry.' : '';
      setAnswer(`${text}${suffix}`, 'error');
      setStatus('Error — retry', 'error');
      showEvidence({ evidence: [] });
      setMeta([]);
    }
  } finally {
    state.busy = false;
    state.active = null;
    submitBtn.disabled = false;
    cancelBtn.hidden = true;
    drawLive();
  }
}

function renderInstructionSteps(result) {
  // Persist progress.
  try { if (result?.plan?.taskId) localStorage.setItem('intentlens_instruction_progress', JSON.stringify({ taskId: result.plan.taskId, currentStepId: result.currentStepId, ts: Date.now() })); } catch {}
  const container = $('instructionSteps');
  if (!container) return;
  const steps = result?.plan?.steps || result?.steps || null;
  if (!Array.isArray(steps) || steps.length === 0) { container.hidden = true; container.innerHTML = ''; return; }
  container.hidden = false;
  container.innerHTML = '';
  const current = result.currentStepId || steps[0]?.stepId;
  for (const s of steps) {
    const div = document.createElement('div');
    div.className = 'step ' + (s.stepId === current ? 'active' : (steps.indexOf(s) < steps.findIndex(x => x.stepId === current) ? 'done' : 'pending'));
    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.textContent = `${s.stepId}: ${s.instructionText || s.spokenText || ''}`;
    div.appendChild(title);
    if (s.riskClass) {
      const r = document.createElement('div');
      r.style.fontSize = '.7rem';
      r.style.color = 'var(--muted)';
      r.textContent = `risk: ${s.riskClass}${s.requiresUserConfirmation ? ' · confirm before proceeding' : ''}`;
      div.appendChild(r);
    }
    // Navigation buttons
    const nav = document.createElement('div');
    nav.style.marginTop = '4px';
    if (s.stepId !== current) {
      const btn = document.createElement('button');
      btn.className = 'small';
      btn.textContent = 'Go to step';
      btn.addEventListener('click', () => { state.currentStepId = s.stepId; renderInstructionSteps({ ...result, currentStepId: s.stepId }); });
      nav.appendChild(btn);
    }
    if (s.requiresUserConfirmation) {
      const cbtn = document.createElement('button');
      cbtn.className = 'small';
      cbtn.textContent = 'Confirm done';
      cbtn.addEventListener('click', () => {
        // advance to next step
        const idx = steps.findIndex(x => x.stepId === s.stepId);
        const next = steps[idx + 1];
        if (next) { state.currentStepId = next.stepId; renderInstructionSteps({ ...result, currentStepId: next.stepId }); }
        else { setAnswer('All steps complete.', 'done'); }
      });
      nav.appendChild(cbtn);
    }
    div.appendChild(nav);
    container.appendChild(div);
  }
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b)=>a-b);
  const m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}

async function runLooseTracking(img) {
  if (!window.cv || !state.looseTracker || !state.looseMode) return;
  if (state.looseRunning) return; // never overlap a slow classification pass
  const cv = window.cv;
  const W = img.width, H = img.height;
  const now = performance.now();
  // Classification is CPU-bound: ~4 passes/second, not one per animation frame.
  if (now - (state.looseLastRun || 0) < 250) return;
  state.looseLastRun = now;
  state.looseRunning = true;

  const grayMat = new cv.Mat();
  let srcMat = null;
  try {
    srcMat = cv.matFromImageData(img);
    cv.cvtColor(srcMat, grayMat, cv.COLOR_RGBA2GRAY);

    if (!state.prevGrayMat) {
      state.prevGrayMat = grayMat;
      state.looseFlowTracker = new OpticalFlowTrackerCtor();
      await refreshLooseDetections(img);
      return;
    }

    const flowRes = state.looseFlowTracker.update(img);
    let survivalRatio = 1;
    let fbError = 0;
    if (flowRes) {
      const valid = flowRes.filter(Boolean);
      survivalRatio = valid.length / Math.max(1, flowRes.length);
      const dxs = valid.map((p, i) => p.x - (state.looseFlowPoints?.[i]?.x || p.x));
      const dys = valid.map((p, i) => p.y - (state.looseFlowPoints?.[i]?.y || p.y));
      if (valid.length >= 3) {
        state.looseFlowDisplacement = { x: median(dxs), y: median(dys) };
      }
      fbError = valid.reduce((a, p, i) => {
        const dx = p.x - (state.looseFlowPoints?.[i]?.x || p.x);
        const dy = p.y - (state.looseFlowPoints?.[i]?.y || p.y);
        return a + Math.sqrt(dx * dx + dy * dy);
      }, 0) / Math.max(1, valid.length);
    }
    state.looseFlowPoints = flowRes;

    if (!state.looseRedetectCounter) state.looseRedetectCounter = 0;
    state.looseRedetectCounter += 1;
    const pp = state.perceptionProfile;
    const cfg = pp ? pp.normalizeThresholds(W, H) : { redetectMaxFrames: 90, survivalThreshold: 0.5, fbErrorThreshold: 15 };
    const qualityTrigger = survivalRatio < cfg.survivalThreshold || fbError > cfg.fbErrorThreshold;
    const timeTrigger = state.looseRedetectCounter >= cfg.redetectMaxFrames;
    if (qualityTrigger || timeTrigger || survivalRatio < 0.3) {
      await refreshLooseDetections(img);
      state.looseRedetectCounter = 0;
    }
  } catch (e) {
    // A failed frame never fabricates a position.
    log({ stage: 'tracking', provider: 'local', kind: 'warn', text: `loose frame skipped: ${e?.message || e}` });
  } finally {
    if (srcMat) { try { srcMat.delete(); } catch {} }
    if (state.prevGrayMat !== grayMat) grayMat.delete();
    state.looseRunning = false;
    drawLooseTracks(overlay);
    if (state.menuOpen) renderMenu();
  }
}

async function refreshLooseDetections(img) {
  const W = img.width, H = img.height;
  const regions = await detectComponents(img);
  try {
    state.looseTrackedObjects = state.looseTracker.update(img, regions || []);
    if ((regions || []).length || state.looseTrackedObjects.length) {
      markStartup('firstLocalDetectionCycle', {
        regions: (regions || []).length,
        tracks: state.looseTrackedObjects.length,
      });
    }
  } catch (e) {
    log({ stage: 'tracking', provider: 'local', kind: 'warn', text: `loose classification failed: ${e.message || e}` });
  }
  const points = [];
  for (const r of (regions || []).slice(0, 12)) {
    points.push(r.box.x * W + r.box.width * W / 2, r.box.y * H + r.box.height * H / 2);
  }
  state.looseFlowPoints = null;
  if (points.length >= 2) {
    state.looseFlowTracker?.reset?.();
    state.looseFlowTracker?.init?.(img, points);
  }
}

function applyResult(result, frame) {
  state.lastResult = result;
  state.lastResultFrameId = frame.frameId;
  renderInstructionSteps(result);
  if (result.meta?.contextBudget) {
    state.contextBudget = result.meta.contextBudget;
    if (state.menuOpen) renderMenu();
  }

  if (result.target) {
    upsertSceneItem(result.target, frame, result);
    if (!live) state.mainMarker = { result, stale: false };
    // Initialize the local tracker from the model-proposed target.
    tracker.init({
      targetId: result.target.targetId,
      anchor: result.target.point,
      box: result.target.box || { x: result.target.point.x - 0.03, y: result.target.point.y - 0.03, width: 0.06, height: 0.06 },
    });
  } else {
    // No target this frame: stop tracking anything.
    if (tracker.state !== 'INACTIVE') tracker.lose();
  }

  drawSnapshot(result);
  fillSnapInfo(result);
  showEvidence(result);

  const chips = [];
  if (result.target) {
    const t = result.target;
    const pct = Math.round(t.confidence * 100);
    const confident = t.confidence >= UNCERTAIN_BELOW;
    chips.push({ text: t.targetId, kind: 'target' });
    chips.push({ text: confident ? `${pct}% confident` : `${pct}% — weak`, kind: confident ? 'confident' : 'unsure' });
    if (result.needsConfirmation) chips.push({ text: 'needs confirmation', kind: 'unsure' });
  }
  if (result.evidenceKind === 'visual_inference' && result.target) chips.push({ text: 'visual guess', kind: 'unsure' });
  if (result.meta?.modelMode === 'mock') chips.push({ text: 'mock — not the camera', kind: 'fake' });
  if (result.meta?.searchedWeb) chips.push({ text: 'web-grounded' });
  if (result.meta?.modelId && result.meta.modelMode === 'live') chips.push({ text: result.meta.modelId });
  if (result.meta?.latencyMs) chips.push({ text: `${(result.meta.latencyMs / 1000).toFixed(1)}s` });
  setMeta(chips);

  if (result.resultStatus === 'target_found' && result.target) {
    setAnswer(result.answerShort + (result.uncertaintyNote ? ` ${result.uncertaintyNote}` : ''), result.needsConfirmation ? 'warn' : '');
    setStatus('Ready — target proposed', 'done');
  } else if (result.resultStatus === 'needs_clarification') {
    setAnswer(result.requestedClarification || result.answerShort, 'warn');
    setStatus('Needs a clearer view', 'warn');
  } else {
    setAnswer(result.answerShort, 'warn');
    setStatus('No target in this view', 'warn');
  }

}

submitBtn.addEventListener('click', submit);
cancelBtn.addEventListener('click', () => state.active?.controller.abort());
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

// ---------------------------------------------------------------------------
// Clear session (§13.1)
// ---------------------------------------------------------------------------
clearBtn.addEventListener('click', () => {
  state.scene = [];
  state.corrections = [];
  state.lastTargetId = null;
  state.lastResult = null;
  state.lastResultFrameId = null;
  state.mainMarker = null;
  state.hint = null;
  tracker.reset();
  if (trackedPill) trackedPill.hidden = true;
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  snapBox.hidden = true;
  snapInfo.replaceChildren();
  showEvidence({ evidence: [] });
  setMeta([]);
  drawLive();
  resetPipes();
  setPipeStatus('Idle');
  setStatus('Ready');
  setAnswer('Session cleared. Cached scene information and corrections are gone.');
});

// Silhouette & Outline tracking toggles
if ($('handOutlineToggle')) {
  $('handOutlineToggle').addEventListener('change', (e) => {
    trackerSetHandOutline(e.target.checked);
    if (e.target.checked) {
      // Hand/person tracking is pure JS. Do NOT load OpenCV here: its 11 MB
      // bundle blocks the renderer and made the whole preview freeze.
      initHandTracker().then((r) => { state.handTrackerMode = r.mode; }).catch(() => {});
    }
    drawLive();
  });
}
if ($('adminSilhouetteToggle')) {
  $('adminSilhouetteToggle').addEventListener('change', (e) => {
    trackerSetAdminSilhouette(e.target.checked);
    if (e.target.checked) {
      initHandTracker().then((r) => { state.handTrackerMode = r.mode; }).catch(() => {});
    }
    drawLive();
  });
}
if ($('chipOutlineToggle')) {
  $('chipOutlineToggle').addEventListener('change', async (e) => {
    trackerSetChipOutline(e.target.checked);
    if (e.target.checked) {
      await ensureOpenCV();
      if (!live) {
        state.detectedSilhouettes = tracker.detectSilhouettesAndChips({ data: new Uint8ClampedArray(4), width: 1, height: 1 }, COMPONENTS);
      }
    }
    drawLive();
  });
}
if ($('looseModeToggle')) {
  $('looseModeToggle').addEventListener('change', async (e) => {
    state.looseMode = e.target.checked;
    const status = $('trainStatus');
    if (!e.target.checked) {
      if (state.looseTracker) state.looseTracker.reset();
      state.looseTrackedObjects = [];
      if (status) status.textContent = 'Loose tracking paused.';
      return;
    }
    if (status) status.textContent = 'Loading local reference index…';
    await ensureOpenCV();
    const instance = await ensureLooseTracker();
    if (status) {
      status.textContent = instance
        ? 'Loose tracking runs locally. Labels are k-NN candidates, not verified facts.'
        : 'Loose tracking could not load its local reference index. See logs.';
    }
  });
}

// ---------------------------------------------------------------------------
// Menu & UI controls
// ---------------------------------------------------------------------------
/** Put a decoded bitmap on the frame, freezing live video like an upload. */
function showBitmapAsFrame(bmp, label = 'Photo loaded') {
  live = false;                    // freeze: the photo is now the frame
  state.mainMarker = null;
  state.assistant.photoLoaded = true;
  state.assistant.aligned = false;
  renderWorkspace();
  drawContain(bmp, bmp.width, bmp.height);
  drawLive();
  liveBtn.disabled = camera.getStatus().state !== 'ready';
  setStatus(label, 'done');
  setAnswer(`${label}. Type a command and press Find it. The marker will be drawn over this photo.`);
}

// ---------------------------------------------------------------------------
// Phone transfer (LAN): one-time code + desktop-served upload page.
// ---------------------------------------------------------------------------
const syncState = { code: null, urls: [], expiresAt: 0, items: [], busy: false };

function renderSyncPanel() {
  const codeEl = $('syncCodeValue');
  const urlEl = $('syncUrlValue');
  const expiryEl = $('syncExpiry');
  const listEl = $('syncItems');
  if (codeEl) codeEl.textContent = syncState.code || '—';
  if (urlEl) {
    urlEl.replaceChildren();
    if (syncState.code && syncState.urls.length) {
      const first = syncState.urls[0];
      const link = document.createElement('a');
      link.href = `${first.url}?code=${syncState.code}`;
      link.textContent = `${first.url}?code=${syncState.code}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'menuLink';
      urlEl.append(link);
      if (syncState.urls.length > 1) {
        const more = document.createElement('span');
        more.textContent = ` · also ${syncState.urls.slice(1).map((u) => u.url).join(', ')}`;
        urlEl.append(more);
      }
    } else {
      urlEl.textContent = 'Create a code to show a phone upload link.';
    }
  }
  if (expiryEl) {
    if (!syncState.expiresAt) {
      expiryEl.textContent = '';
    } else {
      const left = Math.max(0, Math.round((syncState.expiresAt - Date.now()) / 1000));
      expiryEl.textContent = left > 0
        ? `Code expires in ${Math.floor(left / 60)}m ${String(left % 60).padStart(2, '0')}s.`
        : 'Code expired. Create a new one.';
    }
  }
  if (!listEl) return;
  listEl.replaceChildren();
  if (!syncState.items.length) {
    const li = document.createElement('li');
    li.style.color = 'var(--muted)';
    li.textContent = syncState.code ? 'No items received yet.' : 'Nothing received.';
    listEl.append(li);
    return;
  }
  for (const item of syncState.items) {
    const li = document.createElement('li');
    li.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 0;border-bottom:1px solid var(--line);';
    const name = document.createElement('span');
    name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    name.textContent = `${item.name} (${Math.max(1, Math.round(item.bytes / 1024))} KB)`;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'small';
    action.textContent = item.type === 'photo' ? 'Load photo' : 'Show';
    action.addEventListener('click', () => loadSyncItem(item));
    li.append(name, action);
    listEl.append(li);
  }
}

async function createSyncCode() {
  if (syncState.busy) return;
  syncState.busy = true;
  const btn = $('syncCreateBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/sync/code', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    syncState.code = data.code;
    syncState.urls = Array.isArray(data.urls) ? data.urls : [];
    syncState.expiresAt = data.expiresAt;
    syncState.items = [];
    renderSyncPanel();
    if (syncState.timer) clearInterval(syncState.timer);
    syncState.timer = setInterval(() => {
      renderSyncPanel();
      if (!syncState.expiresAt || Date.now() >= syncState.expiresAt) {
        clearInterval(syncState.timer);
        syncState.timer = null;
      }
    }, 1000);
    if (state.menuOpen) renderMenu();
  } catch (err) {
    setAnswer(`Could not create an upload code: ${err.message}`, 'error');
  } finally {
    syncState.busy = false;
    if (btn) btn.disabled = false;
  }
}

async function refreshSyncItems() {
  if (!syncState.code) return;
  try {
    const res = await fetch(`/api/sync/items?code=${encodeURIComponent(syncState.code)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    syncState.items = Array.isArray(data.items) ? data.items : [];
    syncState.expiresAt = data.expiresAt || syncState.expiresAt;
    renderSyncPanel();
  } catch (err) {
    const listEl = $('syncItems');
    if (listEl) {
      listEl.replaceChildren();
      const li = document.createElement('li');
      li.style.color = 'var(--warn)';
      li.textContent = err.message;
      listEl.append(li);
    }
  }
}

async function loadSyncItem(item) {
  try {
    const res = await fetch(`/api/sync/items/${encodeURIComponent(syncState.code)}/${encodeURIComponent(item.id)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    if (data.type === 'note') {
      setAnswer(`Phone note: ${String(data.payload || '').slice(0, 600)}`, 'ready');
      return;
    }
    const blob = await (await fetch(data.payload)).blob();
    const bmp = await createImageBitmap(blob);
    showBitmapAsFrame(bmp, 'Phone photo loaded');
    if (state.menuOpen) closeMenu();
  } catch (err) {
    setAnswer(`Could not load that phone item: ${err.message}`, 'error');
  }
}

function initMenuAndControls() {
  // Hamburger menu open/close
  if ($('menu')) $('menu').addEventListener('click', openMenu);
  if ($('menuClose')) $('menuClose').addEventListener('click', closeMenu);
  if ($('menuBackdrop')) $('menuBackdrop').addEventListener('click', closeMenu);

  // Setup popup launcher from hamburger menu
  if ($('openSetupBtn')) {
    $('openSetupBtn').addEventListener('click', () => {
      closeMenu();
      showSetupPopup(true);
    });
  }

  // Phone transfer controls
  if ($('syncCreateBtn')) $('syncCreateBtn').addEventListener('click', createSyncCode);
  if ($('syncRefreshBtn')) $('syncRefreshBtn').addEventListener('click', refreshSyncItems);

  // Accordion headings
  document.querySelectorAll('.menuHeading').forEach((heading) => {
    heading.addEventListener('click', () => {
      const section = heading.dataset.section;
      const body = $(`menuBody-${section}`);
      if (body) {
        const isVisible = body.style.display === 'block';
        body.style.display = isVisible ? 'none' : 'block';
        const chevron = heading.querySelector('.menuChevron');
        if (chevron) chevron.textContent = isVisible ? '▶' : '▼';
      }
    });
  });

  // Tracking section controls
  if ($('trackPause')) {
    $('trackPause').addEventListener('click', () => {
      if (tracker.state === 'TRACKING') {
        tracker.state = 'INACTIVE';
        $('trackPause').textContent = 'Resume';
      } else if (tracker.target) {
        tracker.state = 'TRACKING';
        $('trackPause').textContent = 'Pause';
      }
      renderMenu();
    });
  }
  if ($('trackReacquire')) {
    $('trackReacquire').addEventListener('click', () => {
      if (tracker.target) tracker.state = 'REACQUIRING';
      renderMenu();
    });
  }
  if ($('trackReset')) {
    $('trackReset').addEventListener('click', () => {
      tracker.reset();
      if (trackedPill) trackedPill.hidden = true;
      hideHandOutline();
      renderMenu();
    });
  }

  // Logs modal controls
  if ($('logsOpen')) $('logsOpen').addEventListener('click', () => showLogs(true));
  if ($('logsClose')) $('logsClose').addEventListener('click', () => showLogs(false));
  if ($('logsBackdrop')) $('logsBackdrop').addEventListener('click', () => showLogs(false));

  document.querySelectorAll('.logsTab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.logsTab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentLogFilter = tab.dataset.filter || 'all';
      renderLogsList();
    });
  });

  if ($('logsRefresh')) {
    $('logsRefresh').addEventListener('click', async () => {
      await syncServerLogs();
      renderLogsList();
    });
  }

  if ($('logsCopy')) {
    $('logsCopy').addEventListener('click', async () => {
      const text = state.logs
        .map((l) => `[${l.when}] [${l.stage || 'SYS'}] [${(l.kind || 'info').toUpperCase()}] ${l.provider ? `(${l.provider}) ` : ''}${l.text}${l.detail ? `\n  Detail: ${l.detail}` : ''}`)
        .join('\n');
      try {
        await navigator.clipboard.writeText(text);
        $('logsCopy').textContent = 'Copied!';
        setTimeout(() => { if ($('logsCopy')) $('logsCopy').textContent = 'Copy Logs'; }, 1500);
      } catch (err) {
        console.warn('Clipboard write failed:', err);
      }
    });
  }

  if ($('logsClear')) {
    $('logsClear').addEventListener('click', async () => {
      state.logs = [];
      updateLogBadge();
      renderLogsList();
      try {
        await fetch('/api/logs', { method: 'DELETE' });
      } catch (err) {
        console.debug('Failed to clear server logs:', err);
      }
    });
  }

  // PCB Registration controls
  if ($('pcbCaptureRef')) {
    $('pcbCaptureRef').addEventListener('click', () => {
      try {
        const c = document.getElementById('frame');
        const tmp = document.createElement('canvas');
        tmp.width = c.width; tmp.height = c.height;
        tmp.getContext('2d').drawImage(c, 0, 0);
        state.pcbReferenceImage = tmp;
        state.pcbBoard = state.pcbBoard || { id: `board_${Date.now()}`, components: [] };
        if (window.cv) {
          try { state.pcbRegistrar = new BoardRegistrar(); } catch (e) { state.pcbRegistrar = null; }
        }
        $('pcbStatus').textContent = 'Reference frame captured. Add components, then Save.';
        renderPcbCompList();
      } catch (e) { $('pcbStatus').textContent = `Capture failed: ${e.message}`; }
    });
  }
  if ($('pcbAddComp')) {
    $('pcbAddComp').addEventListener('click', () => {
      const id = prompt('Component ID (e.g. C1):');
      if (!id) return;
      const type = prompt('Component type (e.g. capacitor):') || 'unknown';
      const x = parseFloat(prompt('Box x (0..1):', '0.5'));
      const y = parseFloat(prompt('Box y (0..1):', '0.5'));
      const w = parseFloat(prompt('Box width (0..1):', '0.05'));
      const h = parseFloat(prompt('Box height (0..1):', '0.05'));
      state.pcbBoard = state.pcbBoard || { id: `board_${Date.now()}`, components: [] };
      state.pcbBoard.components.push({ id, type, x, y, width: w, height: h, provenance: 'user_registered' });
      renderPcbCompList();
    });
  }
  if ($('pcbSaveBoard')) {
    $('pcbSaveBoard').addEventListener('click', () => {
      if (!state.pcbBoard || !state.pcbBoard.components.length) { $('pcbStatus').textContent = 'No components to save.'; return; }
      try {
        const ref = state.pcbReferenceImage;
        const refData = ref ? ref.getContext('2d').getImageData(0,0,ref.width,ref.height) : null;
        if (refData && window.cv) {
          // Register with BoardRegistrar
          const BoardRegistrar = window.BoardRegistrarCtor;
          if (BoardRegistrar) {
            const reg = new BoardRegistrar();
            const compsPx = state.pcbBoard.components.map((c) => ({ id: c.id, type: c.type, x: c.x*ref.width, y: c.y*ref.height, width: c.width*ref.width, height: c.height*ref.height }));
            const r = reg.register(refData, compsPx);
            state.pcbRegistrar = reg;
            state.pcbBoard.regResult = r;
            state.pcbVerifier = new ComponentPresenceVerifierCtor();
            // Store reference regions for each component.
            state.pcbVerifier.referenceRegions = {};
            if (refData) {
              for (const c of state.pcbBoard.components) {
                const refBox = { x: c.x, y: c.y, width: c.width, height: c.height };
                state.pcbVerifier.referenceRegions[c.id] = state.pcbVerifier.extractRegion(refData, refBox);
              }
            }
          }
        }
        const data = JSON.stringify(state.pcbBoard);
        localStorage.setItem('intentlens_pcb_board', data);
        if (ref) localStorage.setItem('intentlens_pcb_ref', ref.toDataURL('image/jpeg', 0.8));
        $('pcbStatus').textContent = `Saved board with ${state.pcbBoard.components.length} components.`;
      } catch (e) { $('pcbStatus').textContent = `Save failed: ${e.message}`; }
    });
  }
  if ($('pcbLoadBoard')) {
    $('pcbLoadBoard').addEventListener('click', () => {
      try {
        const data = localStorage.getItem('intentlens_pcb_board');
        if (!data) { $('pcbStatus').textContent = 'No saved board.'; return; }
        state.pcbBoard = JSON.parse(data);
        renderPcbCompList();
        $('pcbStatus').textContent = `Loaded board: ${state.pcbBoard.components.length} components.`;
      } catch (e) { $('pcbStatus').textContent = `Load failed: ${e.message}`; }
    });
  }

  function renderPcbCompList() {
    const el = $('pcbCompList');
    if (!el) return;
    el.innerHTML = '';
    const comps = state.pcbBoard?.components || [];
    for (const c of comps) {
      const row = document.createElement('div');
      row.className = 'menuRow';
      row.style.fontSize = '.72rem';
      row.textContent = `${c.id} — ${c.type} @ (${c.x.toFixed(2)},${c.y.toFixed(2)})`;
      el.appendChild(row);
    }
  }

  // Identity Transfer controls
  if ($('transferScan')) {
    $('transferScan').addEventListener('click', () => {
      const container = $('transferCandidates');
      if (container) container.innerHTML = '';
      if (!state.crossModeTransfer) {
        $('transferStatus').textContent = 'Transfer module not loaded.';
        return;
      }
      // Use a default PCB component id from registered board.
      const pcbId = state.pcbBoard?.components?.[0]?.id;
      if (!pcbId) { $('transferStatus').textContent = 'No registered PCB component.'; return; }
      const looseTracks = state.looseTracker?.getTracks() || [];
      const img = trackCtx.getImageData(0,0,W,H);
      const cands = state.crossModeTransfer.findCandidates(pcbId, looseTracks, img);
      if (!cands.length) { $('transferStatus').textContent = 'No candidates found.'; return; }
      $('transferStatus').textContent = `${cands.length} candidate(s).`;
      for (const c of cands) {
        const row = document.createElement('div');
        row.className = 'menuRow';
        row.style.fontSize = '.72rem';
        row.textContent = `${c.trackId} — sim ${c.similarity.toFixed(2)}${c.ambiguous ? ' (ambiguous)' : ''}${c.typeMatch ? ' [type match]' : ''}`;
        const btn = document.createElement('button');
        btn.className = 'small';
        btn.textContent = 'Confirm transfer';
        btn.addEventListener('click', () => {
          const res = state.crossModeTransfer.transfer(pcbId, c.trackId, true);
          $('transferStatus').textContent = res.ok ? `Transferred ${pcbId} → ${c.trackId}` : `Failed: ${res.reason}`;
        });
        row.appendChild(btn);
        container.appendChild(row);
      }
    });
  }

  // Perception profile controls
  if ($('profileSelect')) {
    $('profileSelect').addEventListener('change', (e) => {
      if (state.perceptionProfile) state.perceptionProfile.setProfile(e.target.value);
    });
  }
  if ($('diagOverlayToggle')) {
    $('diagOverlayToggle').addEventListener('change', (e) => { state.diagOverlayEnabled = e.target.checked; });
  }
  if ($('hingeModeToggle')) {
    const HINGE_KEY = 'intentlens.hingeMode';
    const saved = localStorage.getItem(HINGE_KEY) === '1';
    state.hingeModeEnabled = saved;
    $('hingeModeToggle').checked = saved;
    $('hingeModeToggle').addEventListener('change', (e) => {
      state.hingeModeEnabled = e.target.checked;
      localStorage.setItem(HINGE_KEY, e.target.checked ? '1' : '0');
      // A mode switch invalidates the tracked angle: start clean rather than
      // blending a stale observation into the first new frame.
      state.hingeTracker?.reset();
      state.hingeReport = null;
    });
  }

  // k-NN Training controls
  if ($('trainCapture')) {
    $('trainCapture').addEventListener('click', () => {
      const label = ($('trainLabel')?.value || '').trim();
      if (!label) { $('trainStatus').textContent = 'Enter a label first.'; return; }
      if (!state.looseTracker) { $('trainStatus').textContent = 'Loose tracker not initialized.'; return; }
      // Use current tracked target box or center region
      const box = state.lastTargetBox || { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
      const canvas = document.getElementById('frame');
      const ctx = canvas.getContext('2d');
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      state.looseTracker.addTrainingExample(img, box, label);
      $('trainStatus').textContent = `Captured example for "${label}".`;
      updateTrainCount();
    });
  }
  if ($('trainClear')) {
    $('trainClear').addEventListener('click', () => {
      if (state.looseTracker) {
        state.looseTracker.classifier.examples = [];
        state.looseTracker.featureCache.clear();
        state.looseTracker.saveTrainingData();
      }
      updateTrainCount();
      $('trainStatus').textContent = 'Your captured examples were cleared. Built-in references remain.';
    });
  }
  updateTrainCount();

  // Session controls
  if ($('endSession')) {
    $('endSession').addEventListener('click', async () => {
      try {
        await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/end-session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ summary: `Session completed at ${new Date().toLocaleTimeString()}` }),
        });
        setAnswer('Session ended and summary saved.', 'done');
        closeMenu();
      } catch (err) {
        setAnswer(`Failed to end session: ${err.message}`, 'error');
      }
    });
  }
  if ($('deleteProject')) {
    $('deleteProject').addEventListener('click', async () => {
      if (!confirm('Are you sure you want to delete all saved data for this project?')) return;
      try {
        await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/data`, { method: 'DELETE' });
        clearBtn.click();
        setAnswer('Project data deleted.', 'done');
        closeMenu();
      } catch (err) {
        setAnswer(`Failed to delete project: ${err.message}`, 'error');
      }
    });
  }
}

// ---------------------------------------------------------------------------
// First-run setup popup listeners
// ---------------------------------------------------------------------------
let setupFormInitialized = false;
let setupBusy = false;

function setSetupMsg(text, tone = '') {
  const el = $('setupMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'setupMsg' + (tone ? ` ${tone}` : '');
}

function selectedSetupProvider() {
  return $('setupProv')?.value || 'openrouter';
}

const SETUP_TIER_RANK = { free: 0, preview: 1, paid: 2, enterprise: 2 };

function selectedSetupTier() {
  return $('setupAccessTier')?.value || localModelStatus?.accessTier || 'paid';
}

/** Build the provider list from the shared catalogue, not hardcoded options. */
function renderSetupProviderOptions() {
  const select = $('setupProv');
  if (!select) return;
  const ids = localModelStatus?.priority || Object.keys(localModelStatus?.catalog || {});
  if (!ids.length) return;
  const current = select.value;
  const options = ids.map((id) => {
    const row = localModelStatus?.providers?.find((p) => p.id === id);
    const models = localModelStatus?.catalog?.[id]?.models || {};
    const vision = Object.values(models).filter((m) => m.modality === 'vision').length;
    const label = row?.label || PROVIDER_NAMES[id] || id;
    return {
      id,
      text: `${label}${vision ? ` — ${vision} vision model${vision === 1 ? '' : 's'}` : ' — no vision model'}`,
    };
  });
  const signature = options.map((o) => `${o.id}:${o.text}`).join('|');
  if (select.dataset.signature === signature) return;
  select.replaceChildren();
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.id;
    el.textContent = option.text;
    select.append(el);
  }
  select.dataset.signature = signature;
  if (ids.includes(current)) select.value = current;
}

function setupVisionModels(provider) {
  const models = localModelStatus?.catalog?.[provider]?.models || {};
  const limit = SETUP_TIER_RANK[selectedSetupTier()] ?? 0;
  return Object.entries(models)
    .filter(([, model]) => model.modality === 'vision')
    .filter(([, model]) => (SETUP_TIER_RANK[model.tier || 'free'] ?? 0) <= limit)
    .map(([id, model]) => ({
      id,
      name: model.name,
      verified: model.verified === true,
      tier: model.tier || 'free',
      note: model.note || '',
    }));
}

/** Fill provider-dependent fields without touching what the user already typed. */
function updateSetupForm({ keepModel = false, preferredProvider = null, preferredModel = null } = {}) {
  renderSetupProviderOptions();
  const provider = preferredProvider || selectedSetupProvider();
  const select = $('setupProv');
  if (select && preferredProvider) select.value = preferredProvider;

  const currentModel = keepModel ? ($('setupModel')?.value || null) : preferredModel;
  const models = setupVisionModels(provider);
  const modelSelect = $('setupModel');
  if (modelSelect) {
    modelSelect.replaceChildren();
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = `${model.name}${model.verified ? ' — verified with an image' : ' — not verified yet'}`;
      modelSelect.append(option);
    }
    const saved = localModelStatus?.providers?.find((p) => p.id === provider)?.modelId;
    const chosen = [currentModel, saved, models.find((m) => m.verified)?.id]
      .find((id) => id && models.some((m) => m.id === id));
    if (chosen) modelSelect.value = chosen;
  }

  const accountRow = $('setupAccountRow');
  const baseUrlRow = $('setupBaseUrlRow');
  const baseUrlInput = $('setupBaseUrl');
  const baseUrlLabel = $('setupBaseUrlLabel');
  const baseUrlHint = $('setupBaseUrlHint');
  const keyLabel = $('setupKeyLabel');
  const keyInput = $('setupKey');
  if (accountRow) accountRow.hidden = provider !== 'cloudflare-workers-ai';
  if (baseUrlRow) baseUrlRow.hidden = !['nvidia-nim', 'custom', 'ollama'].includes(provider);
  // Reset the URL only when the provider changes, so editing a custom relay
  // endpoint is not wiped by a model-selection change.
  if (baseUrlInput && baseUrlInput.dataset.provider !== provider) {
    baseUrlInput.value = provider === 'nvidia-nim'
      ? 'https://integrate.api.nvidia.com'
      : (provider === 'ollama' ? 'http://localhost:11434' : '');
    baseUrlInput.dataset.provider = provider;
  }

  const KEY_META = {
    'nvidia-nim': { label: 'NVIDIA API key (nvapi-…)', placeholder: 'nvapi-...' },
    'cloudflare-workers-ai': { label: 'Cloudflare API token', placeholder: 'Paste your Workers AI token' },
    openrouter: { label: 'OpenRouter API key (sk-or-v1-…)', placeholder: 'sk-or-v1-...' },
    groq: { label: 'Groq API key (gsk_…)', placeholder: 'gsk_...' },
    'google-ai-studio': { label: 'Google AI Studio API key', placeholder: 'AIza...' },
    mistral: { label: 'Mistral API key', placeholder: 'Paste your Mistral key' },
    cerebras: { label: 'Cerebras API key', placeholder: 'csk-...' },
    together: { label: 'Together AI API key', placeholder: 'Paste your Together key' },
    huggingface: { label: 'Hugging Face access token', placeholder: 'hf_...' },
    deepinfra: { label: 'DeepInfra API key', placeholder: 'Paste your DeepInfra key' },
    openai: { label: 'OpenAI API key (sk-…)', placeholder: 'sk-...' },
    anthropic: { label: 'Anthropic API key (sk-ant-…)', placeholder: 'sk-ant-...' },
    ollama: { label: 'Local Ollama needs no key', placeholder: 'Leave blank' },
    custom: { label: 'Relay API key (optional)', placeholder: 'Leave blank if the relay needs none' },
  };
  const keyMeta = KEY_META[provider] || { label: 'API key', placeholder: 'Paste your key' };
  if (keyLabel) keyLabel.textContent = keyMeta.label;
  if (keyInput) keyInput.placeholder = keyMeta.placeholder;

  if (provider === 'nvidia-nim') {
    if (baseUrlLabel) baseUrlLabel.textContent = 'Inference base URL (leave unchanged)';
    if (baseUrlHint) baseUrlHint.textContent = "Pre-filled with NVIDIA's inference host. build.nvidia.com is a dashboard page, not an endpoint.";
    if (baseUrlInput) baseUrlInput.placeholder = 'https://integrate.api.nvidia.com';
  } else if (provider === 'custom') {
    if (baseUrlLabel) baseUrlLabel.textContent = 'HTTPS relay base URL';
    if (baseUrlHint) baseUrlHint.textContent = 'An OpenAI-compatible relay you control. HTTPS is required; plain HTTP is allowed only for localhost.';
    if (baseUrlInput) baseUrlInput.placeholder = 'https://your-relay.example.workers.dev';
  } else if (provider === 'ollama') {
    if (baseUrlLabel) baseUrlLabel.textContent = 'Local Ollama base URL';
    if (baseUrlHint) baseUrlHint.textContent = 'Loopback only. The server contacts this address directly; no key or cloud request is involved.';
    if (baseUrlInput) baseUrlInput.placeholder = 'http://localhost:11434';
  } else {
    if (baseUrlLabel) baseUrlLabel.textContent = 'Base URL';
    if (baseUrlHint) baseUrlHint.textContent = '';
  }

  const note = $('setupModelNote');
  if (note) {
    const chosen = models.find((m) => m.id === (modelSelect?.value || ''));
    const parts = [];
    if (!models.length) {
      const tier = selectedSetupTier();
      parts.push(tier === 'free'
        ? 'No free vision model is available on this provider. Enable paid access only if you already have that account.'
        : 'This provider has no vision-capable model at this access level.');
      parts.push('Text-only and classifier models are never sent images.');
    } else {
      if (chosen?.verified) parts.push('Verified with a real image on this account.');
      else if (chosen) parts.push('Not verified with a real image yet — use Test connection.');
      if (chosen?.note) parts.push(chosen.note);
      parts.push(`Only the ${models.length} vision model${models.length === 1 ? '' : 's'} listed here are used; text-only models are never sent images.`);
    }
    note.textContent = parts.join(' ');
  }

  const netRow = $('setupNetworkRow');
  if (netRow) netRow.hidden = localModelStatus?.allowOutboundNetwork !== false;

  const accessNote = $('setupAccessNote');
  if (accessNote) {
    const tier = selectedSetupTier();
    accessNote.textContent = tier === 'paid'
      ? 'Paid models are visible and may bill your provider account. Select one only if you have billing set up.'
      : tier === 'preview'
        ? 'Free and limited-preview models are visible. Preview models may need account approval and are not verified.'
        : 'Free models only. Paid model names stay hidden until you enable paid access.';
  }
}

function setupProviderNeedsKey(provider) {
  return provider !== 'ollama' && provider !== 'custom';
}

function setupPayload({ includeKey = true } = {}) {
  const provider = selectedSetupProvider();
  const payload = { provider, accessTier: selectedSetupTier() };
  const key = $('setupKey')?.value?.trim() || '';
  if (includeKey && key) payload.apiKey = key;
  // Reuse the saved key for a model/tier/base-URL edit instead of clearing it.
  payload.keepKey = !key;
  const modelId = $('setupModel')?.value || '';
  if (modelId) payload.modelId = modelId;
  if (provider === 'cloudflare-workers-ai') {
    const accountId = $('setupAccount')?.value?.trim();
    if (accountId) payload.accountId = accountId;
  }
  if (provider === 'nvidia-nim' || provider === 'custom' || provider === 'ollama') {
    const baseUrl = $('setupBaseUrl')?.value?.trim();
    if (baseUrl) payload.baseUrl = baseUrl;
  }
  return payload;
}

function setSetupBusy(busy) {
  setupBusy = busy;
  for (const id of ['setupSave', 'setupTest', 'setupRemove']) {
    const btn = $(id);
    if (btn) btn.disabled = busy;
  }
}

async function testSetupProvider() {
  if (setupBusy) return null;
  const provider = selectedSetupProvider();
  const payload = setupPayload();
  if (!payload.apiKey && setupProviderNeedsKey(provider)) {
    // Fall back to the saved key: the server never sends it back to the page.
    const saved = localModelStatus?.providers?.find((p) => p.id === provider);
    if (!saved?.hasKey) {
      setSetupMsg('Enter the key first (or save it once), then test.', 'error');
      return null;
    }
  }
  setSetupBusy(true);
  setSetupMsg(`Testing ${providerLabel(provider)}…`, 'busy');
  try {
    const res = await fetch('/api/providers/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    setSetupMsg(describeTestResult(data), data.ok ? 'ok' : 'error');
    log({ stage: 'model', kind: data.ok ? 'ok' : 'warn', text: `${providerLabel(provider)} test: ${describeTestResult(data)}` });
    await loadLocalModelStatus();
    updateSetupForm({ keepModel: true });
    return data;
  } catch (err) {
    setSetupMsg(`Test failed: ${err.message}`, 'error');
    return null;
  } finally {
    setSetupBusy(false);
  }
}

async function saveSetupProvider() {
  if (setupBusy) return;
  const provider = selectedSetupProvider();
  const payload = setupPayload();
  if (!payload.apiKey && setupProviderNeedsKey(provider)) {
    const saved = localModelStatus?.providers?.find((p) => p.id === provider);
    if (!saved?.hasKey) {
      // No new key and none saved: still let the user change the access level,
      // without pretending a key was saved or tested.
      setSetupBusy(true);
      try {
        const res = await fetch('/api/providers', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accessTier: payload.accessTier }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setSetupMsg(data.error?.message || `Access level could not be saved (HTTP ${res.status}).`, 'error');
          return;
        }
        await loadLocalModelStatus();
        updateSetupForm({ keepModel: false });
        setSetupMsg(`Access level set to ${payload.accessTier}. Enter a key to save and test a provider.`, 'ok');
      } catch (err) {
        setSetupMsg(`Access level could not be saved: ${err.message}`, 'error');
      } finally {
        setSetupBusy(false);
      }
      return;
    }
  }
  setSetupBusy(true);
  setSetupMsg('Saving encrypted credentials and testing…', 'busy');
  try {
    const res = await fetch('/api/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      const code = data.error?.code;
      const message = code === 'SECURE_STORAGE_FAILED'
        ? 'This machine refused to store the key securely (DPAPI/safeStorage unavailable), so it was not saved. The key was not written in plaintext.'
        : (data.error?.message || `Save failed (HTTP ${res.status}).`);
      setSetupMsg(message, 'error');
      return;
    }
    log({ stage: 'api', kind: 'ok', text: `${providerLabel(provider)} key saved securely` });
    await loadLocalModelStatus();
    updateSetupForm({ keepModel: true });
    const test = await testSetupProvider();
    if (test?.ok) {
      setSetupMsg(`${providerLabel(provider)} saved and verified. Closing…`, 'ok');
      setTimeout(() => {
        showSetupPopup(false);
        checkHealth();
      }, 1100);
    } else {
      setSetupMsg(`Saved, but the test did not pass. ${test ? describeTestResult(test) : 'Check the key and model.'}`, 'error');
    }
  } catch (err) {
    setSetupMsg(`Save failed: ${err.message}`, 'error');
    log({ stage: 'api', kind: 'error', text: `Failed to save ${provider} key`, detail: err.message });
  } finally {
    setSetupBusy(false);
  }
}

async function removeSetupProvider() {
  if (setupBusy) return;
  const provider = selectedSetupProvider();
  if (!confirm(`Remove the saved ${providerLabel(provider)} key from this computer?`)) return;
  setSetupBusy(true);
  setSetupMsg('Removing saved key…', 'busy');
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(provider)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
      setSetupMsg(data.error?.message || `Remove failed (HTTP ${res.status}).`, 'error');
      return;
    }
    const key = $('setupKey');
    if (key) key.value = '';
    setSetupMsg('Saved key removed. Local camera and tracking still work.', 'ok');
    await loadLocalModelStatus();
    updateSetupForm({ keepModel: true });
    checkHealth();
  } catch (err) {
    setSetupMsg(`Remove failed: ${err.message}`, 'error');
  } finally {
    setSetupBusy(false);
  }
}

async function primeSetupForm() {
  if (!localModelStatus) await loadLocalModelStatus();
  const active = activeProvider();
  if (!setupFormInitialized) {
    setupFormInitialized = true;
    updateSetupForm({ preferredProvider: active || 'openrouter', keepModel: false });
  } else {
    updateSetupForm({ keepModel: true });
  }
}

function setupBudgetField(id) {
  const el = $(id);
  if (!el) return null;
  const value = Number(el.value);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/** Save the hard budget caps. A blank field keeps its current value. */
async function saveSetupBudget() {
  const budget = {};
  const daily = setupBudgetField('setupBudgetDaily');
  const monthly = setupBudgetField('setupBudgetMonthly');
  const perRequest = setupBudgetField('setupBudgetRequest');
  if (daily != null) budget.dailyUsd = daily;
  if (monthly != null) budget.monthlyUsd = monthly;
  if (perRequest != null) budget.maxRequestUsd = perRequest;
  if (!Object.keys(budget).length) {
    setSetupMsg('Enter at least one budget value (0 is allowed and blocks requests).', 'error');
    return;
  }
  const btn = $('setupBudgetSave');
  if (btn) btn.disabled = true;
  setSetupMsg('Saving budget…', 'busy');
  try {
    const res = await fetch('/api/budget', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      setSetupMsg(data.error?.message || `Budget could not be saved (HTTP ${res.status}).`, 'error');
      return;
    }
    await loadLocalModelStatus();
    renderBudgetUi({ force: true });
    setSetupMsg('Budget saved. Requests that would exceed it are refused before they are sent.', 'ok');
  } catch (err) {
    setSetupMsg(`Budget could not be saved: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Clear recorded usage without changing the caps. */
async function resetSetupBudget() {
  if (!confirm('Clear the recorded token/cost ledger? The budget caps are kept. This does not refund anything with the provider.')) return;
  const btn = $('setupBudgetReset');
  if (btn) btn.disabled = true;
  setSetupMsg('Clearing ledger…', 'busy');
  try {
    const res = await fetch('/api/budget/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reset: true, entriesOnly: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      setSetupMsg(data.error?.message || `Ledger could not be cleared (HTTP ${res.status}).`, 'error');
      return;
    }
    await loadLocalModelStatus();
    renderBudgetUi({ force: true });
    setSetupMsg('Recorded usage cleared. Future requests start from zero for the day and month.', 'ok');
  } catch (err) {
    setSetupMsg(`Ledger could not be cleared: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function initSetupPopupListeners() {
  if ($('setupClose')) $('setupClose').addEventListener('click', () => showSetupPopup(false));
  if ($('setupBackdrop')) $('setupBackdrop').addEventListener('click', () => showSetupPopup(false));
  if ($('setupDontAsk')) {
    $('setupDontAsk').addEventListener('change', (e) => {
      if (e.target.checked) localStorage.setItem('intentlens.dontAskSetup', '1');
      else localStorage.removeItem('intentlens.dontAskSetup');
    });
  }
  if ($('setupProv')) {
    $('setupProv').addEventListener('change', () => updateSetupForm({ keepModel: false }));
  }
  if ($('setupAccessTier')) {
    $('setupAccessTier').addEventListener('change', () => updateSetupForm({ keepModel: false }));
  }
  if ($('setupModel')) {
    $('setupModel').addEventListener('change', () => updateSetupForm({ keepModel: true }));
  }
  if ($('setupBudgetSave')) $('setupBudgetSave').addEventListener('click', saveSetupBudget);
  if ($('setupBudgetReset')) $('setupBudgetReset').addEventListener('click', resetSetupBudget);

  const helpToggle = $('helpGuideToggle');
  const helpContent = $('helpGuideContent');
  const helpChevron = $('helpGuideChevron');
  if (helpToggle && helpContent) {
    helpToggle.addEventListener('click', () => {
      const isHidden = helpContent.style.display === 'none';
      helpContent.style.display = isHidden ? 'block' : 'none';
      if (helpChevron) helpChevron.textContent = isHidden ? '▼' : '▶';
    });
  }

  if ($('setupSave')) $('setupSave').addEventListener('click', saveSetupProvider);
  if ($('setupTest')) $('setupTest').addEventListener('click', testSetupProvider);
  if ($('setupRemove')) $('setupRemove').addEventListener('click', removeSetupProvider);
  if ($('setupAllowOutbound')) {
    $('setupAllowOutbound').addEventListener('click', async () => {
      if (!confirm('Allow IntentLens to send captured images and project context to your chosen AI provider for this session?')) return;
      setSetupMsg('Enabling cloud requests for this session…', 'busy');
      try {
        const res = await fetch('/api/providers/network', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ allow: true, confirm: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setSetupMsg(data.error?.message || `Could not enable cloud requests (HTTP ${res.status}).`, 'error');
          return;
        }
        await loadLocalModelStatus();
        updateSetupForm({ keepModel: true });
        setSetupMsg('Cloud requests enabled for this session. Enter your key and press Save & test.', 'ok');
      } catch (err) {
        setSetupMsg(`Could not enable cloud requests: ${err.message}`, 'error');
      }
    });
  }
}

/**
 * Escape dismisses the topmost overlay. Closing is non-destructive: setup form
 * fields, provider/model selections and the remember-choice checkbox are kept.
 */
function initGlobalDismiss() {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const isOpen = (id) => {
      const el = $(id);
      return el && !el.hidden;
    };
    if (isOpen('installPopup')) {
      $('installPopup').hidden = true;
      if ($('installBackdrop')) $('installBackdrop').hidden = true;
      localStorage.setItem('intentlens.dismissInstall', '1');
    } else if (isOpen('setupPopup')) {
      showSetupPopup(false);
    } else if (isOpen('logsPopup')) {
      showLogs(false);
    } else if (isOpen('menuPanel')) {
      closeMenu();
    }
  });
}

// ---------------------------------------------------------------------------
// First-run provider setup popup (§6)
// ---------------------------------------------------------------------------
async function checkFirstRun() {
  if (localStorage.getItem('intentlens.dontAskSetup') === '1') return;
  // /api/providers reports which providers actually have a usable key. A 404 or
  // network failure returns null, in which case setup is shown so the user can
  // configure once the backend is reachable.
  const data = localModelStatus || (await loadLocalModelStatus());
  const hasProvider = Boolean(data?.configured?.length);
  if (!hasProvider) {
    // Do not interrupt a resumed project with a provider dialog. The workspace
    // banner and the project dialog's "AI provider" button keep it reachable.
    if (localStorage.getItem('intentlens.project.v1')) return;
    // The project dialog is the primary entry point. If it is already open,
    // do not replace it with provider setup.
    const projectDialog = $('projectPopup');
    if (projectDialog && projectDialog.hidden === false) return;
    showSetupPopup(true);
  }
}

function showSetupPopup(show) {
  const popup = $('setupPopup'), backdrop = $('setupBackdrop');
  if (!popup || !backdrop) return;
  if (show) {
    // Only one modal at a time: the project popup is the primary entry point,
    // so opening provider setup closes it instead of stacking two dialogs.
    if (typeof projectPopup !== 'undefined' && projectPopup) {
      projectPopup.hidden = true;
      projectBackdrop.hidden = true;
    }
    popup.hidden = false;
    backdrop.hidden = false;
    // Populate provider/model lists without clearing anything already typed.
    primeSetupForm().catch((err) => console.warn('Setup form prime failed:', err));
    renderBudgetUi();
  } else {
    // Closing never clears the form: typed keys, account IDs and model choices
    // stay available if the user reopens the popup.
    popup.hidden = true;
    backdrop.hidden = true;
  }
}

async function checkHealth() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    markStartup('firstHealth', { status: res.status, modelMode: data.model?.mode || null });
    const outboundAllowed = data.network?.allowOutboundNetwork !== false;
    state.modelMode = outboundAllowed ? data.model.mode : 'offline';
    if (data.model.configured && !outboundAllowed) {
      modeEl.textContent = 'NETWORK DISABLED';
      modeEl.dataset.mode = 'offline';
      modeEl.title = 'A vision provider is configured, but ALLOW_OUTBOUND_NETWORK=false. Local camera, tracking and k-NN still work.';
      setStatus('Cloud off', 'warn');
      setAnswer('A provider is configured, but outbound network is disabled. Set ALLOW_OUTBOUND_NETWORK=true in .env and restart to use cloud analysis. Local camera, tap-to-track and the k-NN index still work.', 'warn');
    } else if (data.model.configured) {
      modeEl.textContent = data.model.id || 'Cloud vision model';
      modeEl.dataset.mode = 'ready';
      modeEl.title = `Model connected: ${data.model.id} (${data.model.mode})`;
      setStatus('Ready', 'ready');
    } else {
      modeEl.textContent = 'NO CLOUD AI KEY';
      modeEl.dataset.mode = 'offline';
      modeEl.title = 'Local camera, tracking and k-NN work without a key. Cloud image analysis needs a configured vision provider.';
      setAnswer('Cloud AI is not configured. Local camera, tap-to-track and the k-NN index still work. Open ☰ → Vision Provider & Model → Configure provider to add any free or paid vision provider with your own key.', 'warn');
    }
    if (state.menuOpen) renderMenu();
  } catch {
    state.modelMode = 'offline';
    modeEl.textContent = 'backend offline';
    modeEl.dataset.mode = 'offline';
    setStatus('Backend offline', 'error');
    setAnswer('The app could not reach /api/health. Start the server with start.cmd or "node server/index.js" and reload.', 'error');
    if (state.menuOpen) renderMenu();
  }
}

// ---------------------------------------------------------------------------
// PWA install prompt
// ---------------------------------------------------------------------------
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const dismissed = localStorage.getItem('intentlens.dismissInstall') === '1';
  if (!dismissed) {
    setTimeout(() => {
      const popup = $('installPopup'), backdrop = $('installBackdrop');
      if (popup) { popup.hidden = false; backdrop.hidden = false; }
    }, 2000);
  }
});

$('installClose').addEventListener('click', () => {
  $('installPopup').hidden = true; $('installBackdrop').hidden = true;
  localStorage.setItem('intentlens.dismissInstall', '1');
});
$('installBackdrop').addEventListener('click', () => {
  $('installPopup').hidden = true; $('installBackdrop').hidden = true;
});
$('installSkip').addEventListener('click', () => {
  $('installPopup').hidden = true; $('installBackdrop').hidden = true;
  localStorage.setItem('intentlens.dismissInstall', '1');
});

$('installApp').addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      $('installPopup').hidden = true; $('installBackdrop').hidden = true;
    }
    deferredInstallPrompt = null;
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
markStartup('boot');
loadSession();
drawMockScene();
drawLive();
checkHealth();
checkFirstRun();
loadLocalModelStatus();
initMenuAndControls();
initSetupPopupListeners();
initGlobalDismiss();
wireAssistant();

window.addEventListener('beforeunload', () => { try { if (state.prevGrayMat) state.prevGrayMat.delete(); } catch {} try { state.looseFlowTracker?.reset(); } catch {} });
