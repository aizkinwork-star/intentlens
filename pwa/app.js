// pwa/app.js — standalone browser controller.
//
// This is deliberately separate from the desktop app.js: the desktop talks to
// a local Node server that owns SQLite and the provider keys. A GitHub Pages
// PWA has no server, so this file owns the browser-side equivalent:
//   camera -> capture -> IndexedDB -> prompt -> direct Meta provider -> validate -> draw
//
// It reuses the same pure modules as the desktop app (grid, componentResult,
// TTS), so coordinate and validation behavior cannot drift.

import { DEFAULT_GRID_SIZE } from './lib/grid.js';
import { toComponentResult } from './lib/componentResult.js';
import { IntentLensTTS } from './lib/intentlens_tts.js';
import { buildComponentPrompt, buildChatPrompt, buildExplainPrompt } from './prompt.js';
import * as db from './store.js';
import {
  PROVIDERS,
  PROVIDER_ORDER,
  OPENROUTER_MODELS,
  callModel,
  callChatModel,
  testProvider,
  modelFor,
} from './provider.js';
import { cameraErrorMessage, computeCaptureSize, tryLockLandscape, unlockOrientation } from './camera.js';
import { escapeHtml } from './safe.js';
import { polygonPointsAttribute, edgeMidpoints } from './geometry.js';

const $ = (id) => document.getElementById(id);

const els = {
  netDot: $('netDot'),
  installBtnWrap: $('installBtnWrap'),
  installBtn: $('installBtn'),
  projectSelect: $('projectSelect'),
  newProjectBtn: $('newProjectBtn'),
  settingsBtn: $('settingsBtn'),
  stage: $('stage'),
  video: $('video'),
  still: $('still'),
  overlay: $('overlay'),
  stageEmpty: $('stageEmpty'),
  rotateHint: $('rotateHint'),
  status: $('status'),
  gridLabel: $('gridLabel'),
  cameraBtn: $('cameraBtn'),
  captureBtn: $('captureBtn'),
  micBtn: $('micBtn'),
  chatBtn: $('chatBtn'),
  chatCard: $('chatCard'),
  chatLog: $('chatLog'),
  chatModeTag: $('chatModeTag'),
  command: $('command'),
  sendBtn: $('sendBtn'),
  answer: $('answer'),
  compName: $('compName'),
  cellTag: $('cellTag'),
  instruction: $('instruction'),
  meta: $('meta'),
  evidence: $('evidence'),
  repeatBtn: $('repeatBtn'),
  explainBtn: $('explainBtn'),
  speakBtn: $('speakBtn'),
  cloudState: $('cloudState'),
  cloudDetail: $('cloudDetail'),
  allowCloudBtn: $('allowCloudBtn'),
  cloudCard: document.querySelector('.cloudCard'),
  settingsDialog: $('settingsDialog'),
  providerSelect: $('providerSelect'),
  providerNote: $('providerNote'),
  modelInput: $('modelInput'),
  modelList: $('modelList'),
  modelNote: $('modelNote'),
  keyInput: $('keyInput'),
  blockrunWarning: $('blockrunWarning'),
  blockrunPolicy: $('blockrunPolicy'),
  blockrunConsent: $('blockrunConsent'),
  baseUrlInput: $('baseUrlInput'),
  gridSelect: $('gridSelect'),
  ttsToggle: $('ttsToggle'),
  testProviderBtn: $('testProviderBtn'),
  clearKeyBtn: $('clearKeyBtn'),
  saveSettingsBtn: $('saveSettingsBtn'),
  closeSettingsBtn: $('closeSettingsBtn'),
  projectDialog: $('projectDialog'),
  projectList: $('projectList'),
  newProjectName: $('newProjectName'),
  createProjectBtn: $('createProjectBtn'),
  closeProjectBtn: $('closeProjectBtn'),
};

const state = {
  projects: [],
  project: null,
  messages: [],
  stream: null,
  captured: null,      // { id, dataUrl, blob, width, height }
  result: null,
  lastLatency: null,
  gridSize: DEFAULT_GRID_SIZE,
  providerId: 'groq',
  model: '',
  baseUrl: '',
  apiKey: '',
  blockrunConsent: false,
  tts: true,
  allowCloud: false,
  mode: 'vision',       // 'vision' sends one still; 'chat' sends text only
  busy: false,
  listening: false,
  recognition: null,
  installPrompt: null,
  lastModel: null,
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
}

function setBusy(value) {
  state.busy = value;
  els.sendBtn.disabled = value;
  els.captureBtn.disabled = value || !state.stream;
  els.repeatBtn.disabled = value;
  els.explainBtn.disabled = value;
  els.settingsBtn.disabled = value;
  els.sendBtn.textContent = value ? 'Working…' : 'Send';
}

function updateNetDot() {
  const online = navigator.onLine !== false;
  els.netDot.classList.toggle('off', !online);
  els.netDot.title = online ? 'Online' : 'Offline';
}

function clearOverlay() {
  while (els.overlay.firstChild) els.overlay.removeChild(els.overlay.firstChild);
}

function drawGrid() {
  clearOverlay();
  if (!state.stream && !state.captured) return;
  const size = state.gridSize;
  for (let i = 0; i <= size; i += 1) {
    const p = (i * 1000) / size;
    for (const [x1, y1, x2, y2] of [[p, 0, p, 1000], [0, p, 1000, p]]) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(y1));
      line.setAttribute('x2', String(x2));
      line.setAttribute('y2', String(y2));
      line.setAttribute('stroke', 'rgba(110, 220, 255, 0.20)');
      line.setAttribute('stroke-width', '1');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      els.overlay.appendChild(line);
    }
  }
}

function drawResult(result) {
  if (!result?.location) return;
  const { corners } = result.location;
  const points = polygonPointsAttribute(corners);
  if (!points) return;

  const polygon = document.createElementNS(SVG_NS, 'polygon');
  polygon.setAttribute('points', points);
  polygon.setAttribute('fill', 'none');
  polygon.setAttribute('stroke', '#ff4d5e');
  polygon.setAttribute('stroke-width', '2');
  polygon.setAttribute('stroke-dasharray', '6 5');
  polygon.setAttribute('vector-effect', 'non-scaling-stroke');
  els.overlay.appendChild(polygon);

  // Four edge-midpoint targets: model-estimated location, never a local detector.
  for (const point of edgeMidpoints(corners)) {
    const marker = document.createElementNS(SVG_NS, 'circle');
    marker.setAttribute('cx', String(point.x * 1000));
    marker.setAttribute('cy', String(point.y * 1000));
    marker.setAttribute('r', '9');
    marker.setAttribute('fill', '#ff4d5e');
    marker.setAttribute('stroke', '#0b1118');
    marker.setAttribute('stroke-width', '3');
    marker.setAttribute('vector-effect', 'non-scaling-stroke');
    els.overlay.appendChild(marker);
  }
}

function showStill(dataUrl, width, height) {
  els.still.src = dataUrl;
  els.still.hidden = false;
  els.video.hidden = true;
  els.stageEmpty.hidden = true;
  if (width && height) els.stage.style.aspectRatio = `${width} / ${height}`;
  updateRotateHint();
  drawGrid();
}

function showLive() {
  els.still.hidden = true;
  els.still.removeAttribute('src');
  els.video.hidden = false;
  els.stageEmpty.hidden = Boolean(state.stream);
  if (els.video.videoWidth && els.video.videoHeight) {
    els.stage.style.aspectRatio = `${els.video.videoWidth} / ${els.video.videoHeight}`;
  } else {
    els.stage.style.aspectRatio = '4 / 3';
  }
  updateRotateHint();
  drawGrid();
}

function showEmpty() {
  els.still.hidden = true;
  els.still.removeAttribute('src');
  els.video.hidden = true;
  els.stageEmpty.hidden = false;
  updateRotateHint();
  clearOverlay();
}

function updateRotateHint() {
  const portrait = window.matchMedia?.('(orientation: portrait)')?.matches ?? true;
  const show = Boolean(state.stream) && portrait;
  els.rotateHint.hidden = !show;
  document.body.classList.toggle('cameraOn', Boolean(state.stream));
}

function updateCloudUi() {
  const provider = PROVIDERS[state.providerId];
  const model = state.model || provider.defaultModel;
  if (state.allowCloud) {
    els.cloudState.textContent = `Cloud is ON · ${provider.label}`;
    els.cloudDetail.textContent = `${model} · only the still image you capture and this prompt leave the device when you press Send. Project history stays local.`;
    els.allowCloudBtn.textContent = 'Cloud is ON for this session';
    els.allowCloudBtn.disabled = true;
    els.cloudCard.classList.add('on');
  } else {
    els.cloudState.textContent = 'Cloud is off';
    els.cloudDetail.textContent = 'No image leaves this phone until you allow it for this session.';
    els.allowCloudBtn.textContent = 'Allow cloud for this session';
    els.allowCloudBtn.disabled = false;
    els.cloudCard.classList.remove('on');
  }
}

function renderProjectSelect() {
  els.projectSelect.innerHTML = state.projects
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
    .join('');
  if (state.project) els.projectSelect.value = state.project.id;
}

async function refreshProjects() {
  state.projects = await db.listProjects();
  if (!state.projects.length) {
    const first = await db.createProject('First project');
    state.projects = [first];
  }
  if (!state.project || !state.projects.some((p) => p.id === state.project.id)) {
    state.project = state.projects[0];
  }
  renderProjectSelect();
  await loadProject(state.project.id);
}

async function loadProject(projectId) {
  const project = state.projects.find((p) => p.id === projectId) || state.projects[0];
  if (!project) return;
  state.project = project;
  els.projectSelect.value = project.id;
  state.messages = await db.listMessages(project.id);

  const [image] = await db.listImages(project.id, 1);
  if (image) {
    state.captured = {
      id: image.id,
      dataUrl: image.dataUrl,
      blob: image.blob,
      width: image.width,
      height: image.height,
    };
    showStill(image.dataUrl, image.width, image.height);
  } else {
    state.captured = null;
    if (state.stream) showLive();
    else showEmpty();
  }

  const lastAssistant = [...state.messages].reverse().find((m) => m.role === 'assistant' && m.result);
  if (lastAssistant?.result) {
    state.result = lastAssistant.result;
    renderResult(state.result, null);
  } else {
    state.result = null;
    els.answer.classList.add('hidden');
    drawGrid();
  }
  renderChatLog();
  updateCloudUi();
}

function renderChatLog() {
  const chatMessages = state.messages.filter((message) => message.mode === 'chat');
  els.chatLog.replaceChildren();
  if (!chatMessages.length) {
    const empty = document.createElement('p');
    empty.className = 'meta';
    empty.textContent = 'No text-only chat yet. Tap Chat, type a question and Send. No photo is attached.';
    els.chatLog.appendChild(empty);
  }
  for (const message of chatMessages) {
    const row = document.createElement('div');
    row.className = `chatMsg ${message.role === 'assistant' ? 'assistant' : 'user'}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = message.role === 'assistant' ? 'IntentLens' : 'You';
    const body = document.createElement('span');
    body.textContent = String(message.text || '');
    row.append(who, body);
    els.chatLog.appendChild(row);
  }
  if (state.mode === 'chat' || chatMessages.length) els.chatCard.classList.remove('hidden');
  else if (state.mode !== 'chat') els.chatCard.classList.add('hidden');
  updateChatModeUi();
}

function updateChatModeUi() {
  const chat = state.mode === 'chat';
  els.chatBtn.setAttribute('aria-pressed', chat ? 'true' : 'false');
  els.chatBtn.textContent = chat ? 'Chat on' : 'Chat';
  els.captureBtn.disabled = state.busy || !state.stream;
  els.command.placeholder = chat
    ? 'Ask a text question (no image is sent)'
    : 'Ask: what is this part?';
  els.chatModeTag.textContent = chat ? 'text only · no image' : 'text only · no image';
  if (chat) els.chatCard.classList.remove('hidden');
}

function redrawOverlay() {
  drawGrid();
  if (state.result) drawResult(state.result);
}

function renderResult(result, latencyMs) {
  if (!result) return;
  state.result = result;
  const component = result.component || {};
  els.compName.textContent = component.name || 'Unknown component';
  els.cellTag.textContent = result.location?.grid_cell || 'no location';
  els.instruction.textContent = result.instruction || '';
  const bits = [
    String(component.identity_status || 'unknown').replaceAll('_', ' '),
    `uncertainty ${component.uncertainty || 'unknown'}`,
  ];
  if (result.next_action && result.next_action !== 'instruction') {
    bits.push(result.next_action.replaceAll('_', ' '));
  }
  if (Number.isFinite(latencyMs)) bits.push(`${(latencyMs / 1000).toFixed(1)} s`);
  if (!result.location) bits.push('no box drawn');
  els.meta.textContent = bits.join(' · ');

  els.evidence.innerHTML = '';
  for (const item of component.evidence || []) {
    const li = document.createElement('li');
    li.textContent = item;
    els.evidence.appendChild(li);
  }

  drawGrid();
  drawResult(result);
  els.answer.classList.remove('hidden');
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera needs HTTPS (GitHub Pages is fine) and a browser with getUserMedia.');
  }
  stopCamera();
  setStatus('Requesting camera permission…', 'busy');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    state.stream = stream;
    els.video.srcObject = stream;
    await els.video.play();
    showLive();
    els.cameraBtn.textContent = 'Stop camera';
    els.captureBtn.disabled = false;
    updateRotateHint();
    setStatus('Camera live. Frame a part, then Capture.', 'ok');
    const lock = await tryLockLandscape();
    if (lock.locked) setStatus('Camera live in landscape. Frame a part, then Capture.', 'ok');
  } catch (error) {
    stopCamera();
    throw new Error(cameraErrorMessage(error));
  }
}

function stopCamera() {
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  els.video.srcObject = null;
  els.cameraBtn.textContent = 'Start camera';
  els.captureBtn.disabled = true;
  unlockOrientation();
  if (state.captured) showStill(state.captured.dataUrl, state.captured.width, state.captured.height);
  else showEmpty();
  updateChatModeUi();
}

async function captureFrame() {
  if (!state.stream || !els.video.videoWidth) {
    throw new Error('Start the camera first, then capture.');
  }
  const size = computeCaptureSize(els.video.videoWidth, els.video.videoHeight, 1600);
  if (!size) throw new Error('The camera frame has no usable dimensions yet.');
  const { width, height } = size;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot capture a frame.');
  context.drawImage(els.video, 0, 0, width, height);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('Capture failed.'))), 'image/jpeg', 0.9);
  });
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const row = await db.putImage({
    projectId: state.project.id,
    blob,
    dataUrl,
    width,
    height,
    gridSize: state.gridSize,
  });
  state.captured = { id: row.id, dataUrl, blob, width, height };
  showStill(dataUrl, width, height);
  await db.touchProject(state.project.id);
  setStatus(`Frame captured (${width}×${height}). Ask a question, then Send.`, 'ok');
}

function projectContext() {
  return {
    project: state.project?.name || 'Untitled',
    summary: state.project?.summary || '',
    recent: state.messages.slice(-3).map((m) => ({
      role: m.role,
      text: String(m.text || '').slice(0, 300),
    })),
  };
}

function requireCloudReady() {
  if (!state.allowCloud) {
    setStatus('Cloud is off. Tap “Allow cloud for this session” first.', 'error');
    return false;
  }
  if (!state.apiKey) {
    openSettings();
    setStatus('Add a provider key in Settings. It is kept in memory only.', 'error');
    return false;
  }
  if (PROVIDERS[state.providerId]?.consent && !state.blockrunConsent) {
    openSettings();
    setStatus('BlockRun needs explicit consent. Read the warning and tick the consent box in Settings.', 'error');
    return false;
  }
  if (navigator.onLine === false) {
    setStatus('Offline. Local history is available, but cloud analysis needs a connection.', 'error');
    return false;
  }
  return true;
}

async function sendChat(command) {
  setBusy(true);
  try {
    await db.addMessage({
      projectId: state.project.id,
      role: 'user',
      text: command,
      mode: 'chat',
    });
    state.messages = await db.listMessages(state.project.id);
    renderChatLog();
    els.command.value = '';

    setStatus(`Asking ${PROVIDERS[state.providerId].label} for a text-only answer…`, 'busy');
    const { instructions, userText } = buildChatPrompt({
      projectContext: projectContext(),
      history: state.messages.filter((message) => message.mode === 'chat'),
      question: command,
    });
    const response = await callChatModel({
      providerId: state.providerId,
      apiKey: state.apiKey,
      model: modelFor(state.providerId, state.model),
      baseUrl: state.baseUrl,
      prompt: `${instructions}\n\n${userText}`,
    });

    if (!response.ok) {
      setStatus(response.message, 'error');
      await db.addMessage({
        projectId: state.project.id,
        role: 'assistant',
        text: `Chat failed: ${response.message}`,
        mode: 'chat',
      });
      state.messages = await db.listMessages(state.project.id);
      renderChatLog();
      return;
    }

    const answer = String(response.text || '').trim().slice(0, 8000);
    state.lastModel = response.returnedModel || null;
    await db.addMessage({
      projectId: state.project.id,
      role: 'assistant',
      text: answer,
      mode: 'chat',
      model: response.returnedModel || null,
    });
    await db.touchProject(state.project.id);
    state.messages = await db.listMessages(state.project.id);
    renderChatLog();
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
    setStatus(
      `Text answer received in ${(response.latencyMs / 1000).toFixed(1)} s · no image was sent.`,
      'ok',
    );
  } catch (error) {
    setStatus(String(error?.message || error), 'error');
  } finally {
    setBusy(false);
  }
}

async function send() {
  if (state.busy) return;
  const command = els.command.value.trim();
  if (!command) {
    setStatus('Type or say what you want to know first.', 'error');
    return;
  }
  if (state.mode === 'chat') {
    if (!requireCloudReady()) return;
    return sendChat(command);
  }
  if (!state.captured) {
    try {
      await captureFrame();
    } catch (error) {
      setStatus(error.message, 'error');
      return;
    }
  }
  if (!requireCloudReady()) return;

  setBusy(true);
  try {
    setStatus('Building context…', 'busy');
    const { instructions, userText } = buildComponentPrompt({
      projectContext: projectContext(),
      capture: {
        width: state.captured.width,
        height: state.captured.height,
        gridSize: state.gridSize,
      },
      question: command,
    });
    const prompt = `${instructions}\n\n${userText}`;

    await db.addMessage({
      projectId: state.project.id,
      role: 'user',
      text: command,
      imageId: state.captured.id,
      mode: 'vision',
    });

    const provider = PROVIDERS[state.providerId];
    setStatus(`Analyzing image with ${provider.label}… (can take 10–120 s)`, 'busy');

    const response = await callModel({
      providerId: state.providerId,
      apiKey: state.apiKey,
      model: modelFor(state.providerId, state.model),
      baseUrl: state.baseUrl,
      prompt,
      imageDataUrl: state.captured.dataUrl,
    });

    if (!response.ok) {
      setStatus(response.message, 'error');
      await db.addMessage({
        projectId: state.project.id,
        role: 'assistant',
        text: `Analysis failed: ${response.message}`,
        imageId: state.captured.id,
        mode: 'vision',
      });
      state.messages = await db.listMessages(state.project.id);
      return;
    }

    const normalized = toComponentResult(response.json, { gridSize: state.gridSize });
    if (!normalized.ok) {
      setStatus(`Model result rejected: ${normalized.errors.join(' ')}`, 'error');
      await db.addMessage({
        projectId: state.project.id,
        role: 'assistant',
        text: `Result rejected: ${normalized.errors.join(' ')}`,
        imageId: state.captured.id,
        mode: 'vision',
      });
      state.messages = await db.listMessages(state.project.id);
      return;
    }

    state.lastLatency = response.latencyMs;
    state.lastModel = response.returnedModel || null;
    state.result = normalized.result;
    await db.addMessage({
      projectId: state.project.id,
      role: 'assistant',
      text: normalized.result.instruction,
      result: normalized.result,
      imageId: state.captured.id,
      mode: 'vision',
      model: response.returnedModel || null,
    });
    await db.touchProject(state.project.id);
    state.messages = await db.listMessages(state.project.id);
    renderResult(state.result, response.latencyMs);
    setStatus('Done. The box, if any, passed coordinate validation.', 'ok');
    await speak(normalized.result.instruction);
  } catch (error) {
    setStatus(String(error?.message || error), 'error');
  } finally {
    setBusy(false);
  }
}

async function explain() {
  if (state.busy || !state.result) return;
  if (!requireCloudReady()) return;

  setBusy(true);
  try {
    setStatus('Asking for one clearer explanation…', 'busy');
    const { instructions, userText } = buildExplainPrompt({
      projectContext: projectContext(),
      previousAnswer: state.result.instruction,
      question: els.command.value.trim() || 'Explain the previous answer.',
    });
    const response = await callModel({
      providerId: state.providerId,
      apiKey: state.apiKey,
      model: modelFor(state.providerId, state.model),
      baseUrl: state.baseUrl,
      prompt: `${instructions}\n\n${userText}`,
    });

    if (!response.ok) {
      setStatus(`Explain failed (no retry): ${response.message}`, 'error');
      return;
    }
    const answer = String(response.json?.answer || '').trim();
    if (!answer) {
      setStatus('Explain returned no answer. The previous answer is unchanged.', 'error');
      return;
    }
    state.result = { ...state.result, instruction: answer };
    await db.addMessage({
      projectId: state.project.id,
      role: 'assistant',
      text: answer,
      result: state.result,
      imageId: state.captured?.id || null,
      mode: 'vision',
      model: response.returnedModel || null,
    });
    state.messages = await db.listMessages(state.project.id);
    renderResult(state.result, response.latencyMs);
    setStatus('Explained in one request.', 'ok');
    await speak(answer);
  } catch (error) {
    setStatus(String(error?.message || error), 'error');
  } finally {
    setBusy(false);
  }
}

async function repeat() {
  if (!state.result) return;
  renderResult(state.result, state.lastLatency);
  setStatus('Repeated the stored answer. 0 AI requests.', 'ok');
  await speak(state.result.instruction);
}

async function speak(text) {
  if (!state.tts || !text) return;
  try {
    await IntentLensTTS.speak(text);
  } catch {
    setStatus('Text shown; speech is unavailable on this device.', 'error');
  }
}

function setupSpeech() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    els.micBtn.disabled = true;
    els.micBtn.title = 'Speech recognition is not available in this browser';
    return;
  }
  const recognition = new Recognition();
  recognition.lang = navigator.language || 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.onstart = () => {
    state.listening = true;
    els.micBtn.textContent = 'Stop';
    setStatus('Listening…', 'busy');
  };
  recognition.onend = () => {
    state.listening = false;
    els.micBtn.textContent = 'Mic';
  };
  recognition.onerror = (event) => {
    state.listening = false;
    els.micBtn.textContent = 'Mic';
    setStatus(`Voice error: ${event.error}. Type the command instead.`, 'error');
  };
  recognition.onresult = (event) => {
    let finalText = '';
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    if (interim) setStatus(`Listening… ${interim}`, 'busy');
    if (finalText.trim()) {
      els.command.value = finalText.trim();
      setStatus('Transcript ready. Edit it or Send.', 'ok');
    }
  };
  state.recognition = recognition;
  els.micBtn.disabled = false;
}

function toggleMic() {
  if (!state.recognition) return;
  try {
    if (state.listening) state.recognition.stop();
    else state.recognition.start();
  } catch {
    setStatus('Microphone could not start. Check site permission.', 'error');
  }
}

function syncProviderDetail(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) return;
  els.providerNote.textContent = `${provider.note} Browser CORS: ${provider.browserCors}. Retention: ${provider.retention}`;
  els.modelInput.placeholder = provider.defaultModel;
  els.baseUrlInput.disabled = providerId !== 'custom';
  els.blockrunWarning.hidden = providerId !== 'blockrun';
  if (providerId === 'blockrun') {
    els.blockrunPolicy.textContent = provider.retention;
  }
  const models = providerId === 'openrouter'
    ? Object.entries(OPENROUTER_MODELS).map(([id, info]) => ({ id, ...info }))
    : [{ id: provider.defaultModel, label: `${provider.label} default`, pricing: '', modalities: [] }];
  els.modelList.replaceChildren();
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.label = `${model.label}${model.pricing ? ` — ${model.pricing}` : ''}`;
    els.modelList.appendChild(option);
  }
  els.modelNote.textContent = providerId === 'openrouter'
    ? 'Free vision candidate: nvidia/nemotron-3-nano-omni-30b-a3b-reasoning (checked live 2026-11-04). Meta Maverick/Scout are paid per token. No model is switched silently.'
    : providerId === 'groq'
      ? 'Default changed to Meta Llama 4 Maverick because Scout was reported unavailable. Verify your account has access before the demo.'
      : '';
}

function updateProviderUi() {
  els.providerSelect.innerHTML = PROVIDER_ORDER
    .map((id) => `<option value="${id}">${escapeHtml(PROVIDERS[id].label)}</option>`)
    .join('');
  els.providerSelect.value = state.providerId;
  els.modelInput.value = state.model;
  els.blockrunConsent.checked = state.blockrunConsent;
  syncProviderDetail(state.providerId);
}

function openSettings() {
  els.providerSelect.value = state.providerId;
  els.modelInput.value = state.model;
  els.keyInput.value = state.apiKey;
  els.baseUrlInput.value = state.baseUrl;
  els.gridSelect.value = String(state.gridSize);
  els.ttsToggle.checked = state.tts;
  updateProviderUi();
  if (!els.settingsDialog.open) els.settingsDialog.showModal();
}

function readSettingsForm() {
  return {
    providerId: els.providerSelect.value,
    model: els.modelInput.value.trim(),
    apiKey: els.keyInput.value.trim(),
    blockrunConsent: els.blockrunConsent.checked,
    baseUrl: els.baseUrlInput.value.trim(),
    gridSize: Number(els.gridSelect.value) || DEFAULT_GRID_SIZE,
    tts: els.ttsToggle.checked,
  };
}

async function saveSettings() {
  const values = readSettingsForm();
  if (PROVIDERS[values.providerId]?.consent && !values.blockrunConsent) {
    setStatus('BlockRun requires the consent checkbox before it can be saved.', 'error');
    return;
  }
  state.providerId = values.providerId;
  state.model = values.model;
  state.apiKey = values.apiKey;          // memory only, never persisted
  state.blockrunConsent = values.blockrunConsent;
  state.baseUrl = values.baseUrl;
  state.gridSize = values.gridSize;
  state.tts = values.tts;

  // Settings are not sensitive, so they may persist. The key never is.
  await db.setSetting('providerId', state.providerId);
  await db.setSetting('model', state.model);
  await db.setSetting('baseUrl', state.baseUrl);
  await db.setSetting('gridSize', state.gridSize);
  await db.setSetting('tts', state.tts);
  await db.deleteSetting('rememberKey');
  await db.deleteSetting('apiKey');

  els.gridLabel.textContent = `Grid ${state.gridSize}×${state.gridSize}`;
  updateCloudUi();
  drawGrid();
  els.settingsDialog.close();
  setStatus('Settings saved. The key stays in memory for this tab only.', 'ok');
}

function clearKey() {
  state.apiKey = '';
  els.keyInput.value = '';
  db.deleteSetting('apiKey').catch(() => {});
  setStatus('Key cleared from memory and any legacy saved slot.', 'ok');
}

async function runProviderTest() {
  const values = readSettingsForm();
  if (!values.apiKey) {
    setStatus('Add a key before testing.', 'error');
    return;
  }
  els.testProviderBtn.disabled = true;
  setStatus('Testing the key with one text-only request…', 'busy');
  try {
    const result = await testProvider(values);
    if (result.ok) {
      setStatus(`Key works with ${PROVIDERS[values.providerId].label}.`, 'ok');
    } else {
      setStatus(result.message, 'error');
    }
  } finally {
    els.testProviderBtn.disabled = false;
  }
}

function openProjectDialog() {
  els.projectList.innerHTML = '';
  for (const project of state.projects) {
    const row = document.createElement('div');
    row.className = 'projectItem';
    const label = document.createElement('span');
    label.textContent = project.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      const ok = window.confirm(`Delete “${project.name}” and all of its saved frames and messages? This cannot be undone.`);
      if (!ok) return;
      await db.deleteProject(project.id);
      if (state.project?.id === project.id) state.project = null;
      await refreshProjects();
      openProjectDialog();
      setStatus('Project deleted.', 'ok');
    });
    row.append(label, remove);
    els.projectList.appendChild(row);
  }
  if (!els.projectDialog.open) els.projectDialog.showModal();
}

async function createProject() {
  const name = els.newProjectName.value.trim() || 'Untitled project';
  const project = await db.createProject(name);
  els.newProjectName.value = '';
  state.project = project;
  await refreshProjects();
  els.projectDialog.close();
  setStatus(`Project “${project.name}” created.`, 'ok');
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!secure) return;
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* offline cache is optional; camera and model calls still work */
  });
}

function wireEvents() {
  els.video.addEventListener('loadedmetadata', () => {
    if (els.video.videoWidth && els.video.videoHeight) {
      els.stage.style.aspectRatio = `${els.video.videoWidth} / ${els.video.videoHeight}`;
      updateRotateHint();
      redrawOverlay();
    }
  });

  els.cameraBtn.addEventListener('click', async () => {
    if (state.stream) {
      stopCamera();
      setStatus('Camera stopped. Tracks released.', 'ok');
      return;
    }
    try {
      await startCamera();
    } catch (error) {
      setStatus(String(error?.message || error), 'error');
    }
  });

  els.captureBtn.addEventListener('click', async () => {
    try {
      await captureFrame();
    } catch (error) {
      setStatus(String(error?.message || error), 'error');
    }
  });

  els.micBtn.addEventListener('click', toggleMic);
  els.sendBtn.addEventListener('click', send);
  els.repeatBtn.addEventListener('click', repeat);
  els.explainBtn.addEventListener('click', explain);
  els.speakBtn.addEventListener('click', () => speak(state.result?.instruction || els.instruction.textContent));

  els.allowCloudBtn.addEventListener('click', () => {
    state.allowCloud = true;
    updateCloudUi();
    setStatus('Cloud allowed for this session only. Reload to turn it off.', 'ok');
  });

  els.settingsBtn.addEventListener('click', openSettings);
  els.saveSettingsBtn.addEventListener('click', saveSettings);
  els.closeSettingsBtn.addEventListener('click', () => els.settingsDialog.close());
  els.testProviderBtn.addEventListener('click', runProviderTest);
  els.clearKeyBtn.addEventListener('click', clearKey);

  els.providerSelect.addEventListener('change', () => {
    const next = els.providerSelect.value;
    const previousDefault = PROVIDERS[state.providerId]?.defaultModel || '';
    if (!els.modelInput.value || els.modelInput.value === previousDefault) {
      els.modelInput.value = PROVIDERS[next]?.defaultModel || '';
    }
    syncProviderDetail(next);
  });

  els.chatBtn.addEventListener('click', () => {
    state.mode = state.mode === 'chat' ? 'vision' : 'chat';
    if (state.mode === 'chat') els.chatCard.classList.remove('hidden');
    updateChatModeUi();
    setStatus(
      state.mode === 'chat'
        ? 'Text-only chat is on. Send will not capture or attach an image.'
        : 'Image mode is on. Capture a still, then Send.',
      'ok',
    );
  });

  els.newProjectBtn.addEventListener('click', openProjectDialog);
  els.closeProjectBtn.addEventListener('click', () => els.projectDialog.close());
  els.createProjectBtn.addEventListener('click', createProject);
  els.projectSelect.addEventListener('change', async () => {
    await loadProject(els.projectSelect.value);
    setStatus('Project loaded.', 'ok');
  });

  window.addEventListener('online', updateNetDot);
  window.addEventListener('offline', updateNetDot);
  window.addEventListener('pagehide', stopCamera);

  let relayoutFrame = 0;
  const relayout = () => {
    if (relayoutFrame) cancelAnimationFrame(relayoutFrame);
    relayoutFrame = requestAnimationFrame(() => {
      relayoutFrame = 0;
      if (state.stream && els.video.videoWidth && els.video.videoHeight) {
        els.stage.style.aspectRatio = `${els.video.videoWidth} / ${els.video.videoHeight}`;
      }
      updateRotateHint();
      redrawOverlay();
    });
  };
  window.addEventListener('resize', relayout);
  window.addEventListener('orientationchange', relayout);
  screen.orientation?.addEventListener?.('change', relayout);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.stream) {
      stopCamera();
      setStatus('Camera stopped when the app went to the background. Tap Start camera to resume.', '');
    }
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    els.installBtnWrap.hidden = false;
  });
  els.installBtn.addEventListener('click', async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    els.installBtnWrap.hidden = true;
  });
}

async function boot() {
  updateNetDot();
  wireEvents();
  setupSpeech();
  updateCloudUi();
  registerServiceWorker();

  try {
    await db.open();
  } catch (error) {
    setStatus(`Storage unavailable: ${error.message}`, 'error');
    return;
  }

  const settings = await db.allSettings();
  state.gridSize = Number(settings.gridSize) || DEFAULT_GRID_SIZE;
  state.providerId = PROVIDERS[settings.providerId] ? settings.providerId : 'groq';
  state.model = settings.model || '';
  state.baseUrl = settings.baseUrl || '';
  state.tts = settings.tts === true;
  // Legacy plaintext keys from older builds are deleted, not migrated.
  await db.deleteSetting('apiKey');
  await db.deleteSetting('rememberKey');
  state.apiKey = '';
  state.blockrunConsent = false;

  els.gridSelect.value = String(state.gridSize);
  els.gridLabel.textContent = `Grid ${state.gridSize}×${state.gridSize}`;
  els.ttsToggle.checked = state.tts;
  updateProviderUi();
  updateCloudUi();
  updateChatModeUi();

  try {
    await IntentLensTTS.init({ onStatus: () => {} });
  } catch {
    /* text answers still work */
  }

  await refreshProjects();
  setStatus('Ready. Camera permission is asked only when you tap Start camera.', '');
}

boot().catch((error) => setStatus(String(error?.message || error), 'error'));
