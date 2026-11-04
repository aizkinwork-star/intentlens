// pwa/app.js — standalone browser controller.
//
// This is deliberately separate from the desktop app.js: the desktop talks to
// a local Node server that owns SQLite and the provider keys. A GitHub Pages
// PWA has no server, so this file owns the browser-side equivalent:
//   camera -> capture -> IndexedDB -> prompt -> direct Meta provider -> validate -> draw
//
// It reuses the same pure modules as the desktop app (grid, componentResult,
// text-only interactions, so coordinate and validation behavior cannot drift.

import { DEFAULT_GRID_SIZE } from './lib/grid.js';
import { toComponentResult } from './lib/componentResult.js';
import { buildComponentPrompt, buildChatPrompt, buildExplainPrompt } from './prompt.js';
import * as db from './store.js';
import {
  PROVIDERS,
  PROVIDER_ORDER,
  PROVIDER_MODELS,
  callModel,
  callChatModel,
  testProvider,
  modelFor,
  modelInfo,
  modelsFor,
  defaultModelFor,
  modelAllowedAtTier,
  modelAcceptsImages,
  providerSupportsImages,
  isMetaModelId,
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
  uploadBtn: $('uploadBtn'),
  uploadInput: $('uploadInput'),
  cameraSelect: $('cameraSelect'),
  exportBtn: $('exportBtn'),
  importBtn: $('importBtn'),
  importInput: $('importInput'),
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
  cloudState: $('cloudState'),
  cloudDetail: $('cloudDetail'),
  allowCloudBtn: $('allowCloudBtn'),
  cloudCard: document.querySelector('.cloudCard'),
  settingsDialog: $('settingsDialog'),
  providerSelect: $('providerSelect'),
  providerNote: $('providerNote'),
  accessTier: $('accessTier'),
  accessNote: $('accessNote'),
  modelInput: $('modelInput'),
  modelList: $('modelList'),
  modelNote: $('modelNote'),
  keyInput: $('keyInput'),
  baseUrlInput: $('baseUrlInput'),
  gridSelect: $('gridSelect'),
  testProviderBtn: $('testProviderBtn'),
  clearKeyBtn: $('clearKeyBtn'),
  saveSettingsBtn: $('saveSettingsBtn'),
  closeSettingsBtn: $('closeSettingsBtn'),
  requestLog: $('requestLog'),
  requestLogCount: $('requestLogCount'),
  clearLogBtn: $('clearLogBtn'),
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
  providerId: 'openrouter',
  model: '',
  accessTier: 'paid',
  baseUrl: '',
  apiKey: '',
  allowCloud: false,
  mode: 'vision',       // 'vision' sends one still; 'chat' sends text only
  busy: false,
  installPrompt: null,
  lastModel: null,
  requestLog: [],       // in-memory only; never persisted
};

const MAX_REQUEST_LOG = 40;

const SVG_NS = 'http://www.w3.org/2000/svg';

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
}

function setBusy(value) {
  state.busy = value;
  els.sendBtn.disabled = value;
  els.captureBtn.disabled = value || !state.stream;
  els.uploadBtn.disabled = value;
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

function logSafeText(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|nvapi|gsk|brk)[-_][A-Za-z0-9._-]+/gi, '[redacted]')
    .slice(0, 300);
}

function usageSummary(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const bits = [];
  const total = Number(usage.total_tokens);
  if (Number.isFinite(total)) bits.push(`${total} tokens`);
  const cost = Number(usage.cost);
  if (Number.isFinite(cost) && cost > 0) bits.push(`$${cost.toFixed(7).replace(/0+$/, '').replace(/\.$/, '')}`);
  else if (Number.isFinite(cost) && cost === 0) bits.push('$0');
  return bits.join(' · ');
}

function recordRequest(result) {
  if (!result) return;
  const entry = {
    when: new Date().toISOString(),
    ok: result.ok === true,
    providerId: result.providerId || state.providerId,
    providerLabel: result.providerLabel || PROVIDERS[result.providerId]?.label || result.providerId || 'provider',
    method: result.method || 'POST',
    endpoint: result.endpoint || '',
    host: result.host || '',
    model: result.model || result.requestedModel || '',
    returnedModel: result.returnedModel || '',
    mode: result.mode || 'chat',
    requestId: result.requestId || '',
    status: Number.isFinite(result.httpStatus) ? result.httpStatus : (Number.isFinite(result.status) ? result.status : null),
    code: result.code || '',
    latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : null,
    usage: result.usage || null,
    imageAttached: result.imageAttached === true,
    message: result.ok ? '' : logSafeText(result.message || ''),
  };
  state.requestLog.unshift(entry);
  if (state.requestLog.length > MAX_REQUEST_LOG) state.requestLog.length = MAX_REQUEST_LOG;
  renderRequestLog();
}

function renderRequestLog() {
  if (!els.requestLog) return;
  els.requestLog.replaceChildren();
  const count = state.requestLog.length;
  if (els.requestLogCount) {
    els.requestLogCount.textContent = `${count} request${count === 1 ? '' : 's'}`;
  }
  if (!count) {
    const empty = document.createElement('p');
    empty.className = 'meta';
    empty.textContent = 'No provider requests yet. Each Send, Explain or Test is logged here with the exact endpoint and model.';
    els.requestLog.appendChild(empty);
    return;
  }
  for (const entry of state.requestLog) {
    const row = document.createElement('article');
    row.className = `logRow ${entry.ok ? 'ok' : 'fail'}`;

    const head = document.createElement('div');
    head.className = 'logHead';
    const status = document.createElement('span');
    status.className = `logStatus ${entry.ok ? 'ok' : 'fail'}`;
    status.textContent = entry.status
      ? `${entry.status} ${entry.ok ? 'OK' : 'ERROR'}`
      : (entry.ok ? 'OK' : (entry.code || 'FAILED'));
    const time = document.createElement('time');
    time.dateTime = entry.when;
    time.textContent = new Date(entry.when).toLocaleTimeString();
    head.append(status, time);

    const target = document.createElement('code');
    target.className = 'logTarget';
    target.textContent = `${entry.method} ${entry.endpoint || '(no endpoint)'}`;

    const meta = document.createElement('div');
    meta.className = 'logMetaLine';
    meta.textContent = [
      entry.providerLabel,
      entry.host || 'no host',
      entry.mode,
      entry.imageAttached ? 'image attached' : 'text only',
    ].join(' · ');

    const modelLine = document.createElement('div');
    modelLine.className = 'logMetaLine';
    const returned = entry.returnedModel && entry.returnedModel !== entry.model
      ? ` → ${entry.returnedModel}`
      : '';
    modelLine.textContent = `model ${entry.model || '(default)'}${returned}`;

    row.append(head, target, meta, modelLine);

    const extras = [];
    if (entry.latencyMs != null) extras.push(`${(entry.latencyMs / 1000).toFixed(2)} s`);
    const usage = usageSummary(entry.usage);
    if (usage) extras.push(usage);
    if (entry.requestId) extras.push(entry.requestId);
    if (extras.length) {
      const extra = document.createElement('div');
      extra.className = 'logMetaLine';
      extra.textContent = extras.join(' · ');
      row.appendChild(extra);
    }
    if (entry.message) {
      const error = document.createElement('div');
      error.className = 'logError';
      error.textContent = entry.message;
      row.appendChild(error);
    }
    els.requestLog.appendChild(row);
  }
}

function clearRequestLog() {
  state.requestLog = [];
  renderRequestLog();
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
  const model = state.model || defaultModelFor(state.providerId, state.accessTier) || 'no model selected';
  const images = modelAcceptsImages(state.providerId, state.model);
  const blocked = Boolean(provider.unavailableInBrowser);
  if (state.allowCloud) {
    els.cloudState.textContent = blocked
      ? `Cloud is ON · ${provider.label} (blocked on phone)`
      : `Cloud is ON · ${provider.label}`;
    els.cloudDetail.textContent = blocked
      ? provider.blockedMessage
      : images
        ? `${model} · only the still you capture and this prompt leave the device.`
        : `${model} · not a vision model. Use Chat; project history stays local.`;
    els.allowCloudBtn.textContent = 'Cloud is ON for this session';
    els.allowCloudBtn.disabled = true;
    els.cloudCard.classList.add('on');
  } else {
    els.cloudState.textContent = 'Cloud is off';
    els.cloudDetail.textContent = images
      ? 'No image leaves this phone until you allow it for this session.'
      : 'No text leaves this phone until you allow it for this session. This provider is text-only.';
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

const CAMERA_KEY = 'intentlens.cameraId';
function savedCameraId() {
  try { return localStorage.getItem(CAMERA_KEY) || ''; } catch { return ''; }
}
function saveCameraId(id) {
  try { if (id) localStorage.setItem(CAMERA_KEY, id); else localStorage.removeItem(CAMERA_KEY); } catch { /* optional */ }
}

async function refreshCameraList() {
  if (!navigator.mediaDevices?.enumerateDevices || !els.cameraSelect) return;
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch { return; }
  const current = els.cameraSelect.value || savedCameraId();
  els.cameraSelect.replaceChildren(new Option('Default camera', ''));
  devices.forEach((d, i) => els.cameraSelect.appendChild(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  els.cameraSelect.value = devices.some((d) => d.deviceId === current) ? current : '';
  els.cameraSelect.hidden = devices.length < 2;
}

async function openCameraStream() {
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  const wanted = els.cameraSelect?.value || savedCameraId();
  if (wanted) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: { ...size, deviceId: { exact: wanted } }, audio: false });
    } catch (error) {
      if (!['OverconstrainedError', 'NotFoundError'].includes(error?.name)) throw error;
      saveCameraId(''); // the chosen camera was unplugged: fall back to the default
    }
  }
  return navigator.mediaDevices.getUserMedia({ video: { ...size, facingMode: { ideal: 'environment' } }, audio: false });
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera needs HTTPS (GitHub Pages is fine) and a browser with getUserMedia.');
  }
  stopCamera();
  setStatus('Requesting camera permission…', 'busy');
  try {
    const stream = await openCameraStream();
    state.stream = stream;
    els.video.srcObject = stream;
    await els.video.play();
    showLive();
    els.cameraBtn.textContent = 'Stop camera';
    els.captureBtn.disabled = false;
    updateRotateHint();
    await refreshCameraList(); // labels are only available after permission
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
  await storeCaptured(canvas, 'Frame captured');
}

async function storeCaptured(canvas, label) {
  const { width, height } = canvas;
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
  setStatus(`${label} (${width}×${height}). Ask a question, then Send.`, 'ok');
}

async function loadUploadedPhoto(file) {
  if (!file || !/^image\//i.test(file.type)) throw new Error('Choose an image file (JPEG, PNG or WebP).');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('This image could not be read.'));
      el.src = url;
    });
    const size = computeCaptureSize(img.naturalWidth, img.naturalHeight, 1600);
    if (!size) throw new Error('The image has no usable dimensions.');
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot process the image.');
    context.drawImage(img, 0, 0, size.width, size.height);
    await storeCaptured(canvas, 'Photo loaded');
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ------------------------------------------------ project export / import
// There is no server between phone and PC, so projects move as a portable
// JSON file (messages + images). This is a manual transfer, not live sync.
function dataUrlToBlob(dataUrl) {
  const [head, b64] = String(dataUrl).split(',');
  const mime = /^data:(image\/[a-z0-9.+-]+)/i.exec(head || '')?.[1];
  if (!mime) throw new Error('Unsupported image in project file.');
  const bin = atob(b64 || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function exportProject() {
  if (!state.project) return;
  const [messages, images] = await Promise.all([
    db.listMessages(state.project.id),
    db.listImages(state.project.id, 1000),
  ]);
  const bundle = {
    format: 'intentlens-project-v1',
    exportedAt: new Date().toISOString(),
    project: { name: state.project.name, summary: state.project.summary || '' },
    messages,
    images: images.map(({ blob, ...rest }) => rest),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
  const link = document.createElement('a');
  const slug = String(state.project.name || 'project').replace(/[^a-z0-9]+/gi, '-').slice(0, 40) || 'project';
  link.href = url;
  link.download = `${slug}.intentlens.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  setStatus(`Exported ${messages.length} messages and ${images.length} images.`, 'ok');
}

async function importProject(file) {
  const bundle = JSON.parse(await file.text());
  if (bundle?.format !== 'intentlens-project-v1' || !bundle.project) {
    throw new Error('This is not an IntentLens project file.');
  }
  const project = await db.createProject(`${bundle.project.name || 'Imported'} (imported)`);
  const idMap = new Map();
  for (const img of bundle.images || []) {
    const row = await db.putImage({
      projectId: project.id,
      blob: dataUrlToBlob(img.dataUrl),
      dataUrl: img.dataUrl,
      width: img.width,
      height: img.height,
      gridSize: img.gridSize,
      createdAt: img.createdAt,
    });
    idMap.set(img.id, row.id);
  }
  for (const message of bundle.messages || []) {
    await db.addMessage({ ...message, projectId: project.id, imageId: idMap.get(message.imageId) || null });
  }
  state.project = project;
  await refreshProjects();
  setStatus(`Imported "${project.name}".`, 'ok');
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

    setStatus(`POST ${PROVIDERS[state.providerId].host || PROVIDERS[state.providerId].endpoint || 'your endpoint'} for a text-only answer…`, 'busy');
    const { instructions, userText } = buildChatPrompt({
      projectContext: projectContext(),
      history: state.messages.filter((message) => message.mode === 'chat'),
      question: command,
    });
    const response = await callChatModel({
      providerId: state.providerId,
      apiKey: state.apiKey,
      model: modelFor(state.providerId, state.model),
      accessTier: state.accessTier,
      baseUrl: state.baseUrl,
      prompt: `${instructions}\n\n${userText}`,
    });
    recordRequest(response);

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
      `Text answer from ${response.returnedModel || response.model} in ${(response.latencyMs / 1000).toFixed(1)} s · no image was sent.`,
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
  if (PROVIDERS[state.providerId]?.unavailableInBrowser) {
    setStatus(PROVIDERS[state.providerId].blockedMessage, 'error');
    return;
  }
  if (!providerSupportsImages(state.providerId)) {
    setStatus(`${PROVIDERS[state.providerId].label} cannot accept images on this account. Switch to OpenRouter, or tap Chat for a text-only question.`, 'error');
    return;
  }
  const chosen = modelInfo(state.providerId, state.model);
  if (chosen && chosen.vision === false) {
    setStatus(`${state.model} is text-only. Choose a vision model in Settings, or tap Chat.`, 'error');
    return;
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
    setStatus(`POST ${provider.host} · image analysis… (can take 10–120 s)`, 'busy');

    const response = await callModel({
      providerId: state.providerId,
      apiKey: state.apiKey,
      model: modelFor(state.providerId, state.model),
      accessTier: state.accessTier,
      baseUrl: state.baseUrl,
      prompt,
      imageDataUrl: state.captured.dataUrl,
    });
    recordRequest(response);

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
    setStatus(`Done via ${response.returnedModel || response.model}. The box, if any, passed coordinate validation.`, 'ok');
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
      accessTier: state.accessTier,
      baseUrl: state.baseUrl,
      prompt: `${instructions}\n\n${userText}`,
    });
    recordRequest(response);

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
}

function updateModelNote() {
  const providerId = els.providerSelect.value || state.providerId;
  const tier = els.accessTier?.value || state.accessTier || 'paid';
  const model = els.modelInput.value.trim() || defaultModelFor(providerId, tier) || '';
  const info = modelInfo(providerId, model);
  if (!info) {
    els.modelNote.textContent = providerId === 'custom'
      ? 'Any model id your relay accepts can be typed here. It is sent exactly as typed.'
      : 'This model id is not in the verified catalogue. It will be sent as typed; the provider decides whether it exists and whether it can read images.';
    return;
  }
  const bits = [info.label];
  if (info.pricing) bits.push(info.pricing);
  bits.push(info.vision ? 'accepts images' : 'text only — images are refused');
  if (info.verified) bits.push('verified in this audit');
  els.modelNote.textContent = `${bits.join(' · ')}. ${info.note || ''}`.trim();
}

function syncProviderDetail(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) return;
  const tier = els.accessTier?.value || state.accessTier || 'paid';
  const cors = provider.unavailableInBrowser
    ? `Browser CORS: BLOCKED — ${provider.blockedMessage || 'the host does not allow this origin.'}`
    : `Browser CORS: ${provider.browserCors}.`;
  const base = `${provider.note} ${cors}`;
  const endpointBit = provider.endpoint && !base.includes(provider.endpoint)
    ? ` Endpoint: ${provider.endpoint}`
    : '';
  els.providerNote.textContent = `${base}${endpointBit}`;
  const defaultModel = defaultModelFor(providerId, tier);
  els.modelInput.placeholder = defaultModel || 'Type the exact model id';
  if (els.accessNote) {
    els.accessNote.textContent = tier === 'preview'
      ? 'Limited-preview Meta models are visible. They may need account approval and are not verified.'
      : 'Meta models only. They are paid per token and bill your provider account, so set up billing first. Non-Meta models are never offered or sent.';
  }
  const baseUrlRow = $('baseUrlRow');
  if (baseUrlRow) baseUrlRow.hidden = !provider.requiresBaseUrl;
  els.baseUrlInput.disabled = !provider.requiresBaseUrl;
  els.baseUrlInput.placeholder = providerId === 'modal'
    ? 'https://your-workspace--your-app.modal.run'
    : 'https://your-relay.example.workers.dev';
  const catalogue = modelsFor(providerId, tier);
  els.modelList.replaceChildren();
  for (const [id, info] of Object.entries(catalogue)) {
    const option = document.createElement('option');
    option.value = id;
    option.label = `${info.label}${info.pricing ? ` — ${info.pricing}` : ''}`;
    els.modelList.appendChild(option);
  }
  updateModelNote();
}

function updateProviderUi() {
  els.providerSelect.innerHTML = PROVIDER_ORDER
    .map((id) => `<option value="${id}">${escapeHtml(PROVIDERS[id].label)}</option>`)
    .join('');
  els.providerSelect.value = state.providerId;
  if (els.accessTier) els.accessTier.value = state.accessTier;
  const defaultModel = defaultModelFor(state.providerId, state.accessTier);
  if (!state.model || !modelAllowedAtTier(state.providerId, state.model, state.accessTier)) {
    state.model = defaultModel;
  }
  els.modelInput.value = state.model;
  syncProviderDetail(state.providerId);
}

function openSettings() {
  els.providerSelect.value = state.providerId;
  els.accessTier.value = state.accessTier;
  els.modelInput.value = state.model;
  els.keyInput.value = state.apiKey;
  els.baseUrlInput.value = state.baseUrl;
  els.gridSelect.value = String(state.gridSize);
  updateProviderUi();
  if (!els.settingsDialog.open) els.settingsDialog.showModal();
}

function readSettingsForm() {
  const providerId = els.providerSelect.value;
  return {
    providerId,
    model: els.modelInput.value.trim(),
    accessTier: els.accessTier.value,
    apiKey: els.keyInput.value.trim(),
    // Only keep a base URL for providers that actually use one, so a stale
    // relay/deployment URL is never carried into a fixed-host request.
    baseUrl: PROVIDERS[providerId]?.requiresBaseUrl ? els.baseUrlInput.value.trim() : '',
    gridSize: Number(els.gridSelect.value) || DEFAULT_GRID_SIZE,
  };
}

async function saveSettings() {
  const values = readSettingsForm();
  state.providerId = values.providerId;
  state.model = values.model;
  state.accessTier = values.accessTier;
  state.apiKey = values.apiKey;          // memory only, never persisted
  state.baseUrl = values.baseUrl;
  state.gridSize = values.gridSize;

  // Settings are not sensitive, so they may persist. The key never is.
  await db.setSetting('providerId', state.providerId);
  await db.setSetting('model', state.model);
  await db.setSetting('accessTier', state.accessTier);
  await db.setSetting('baseUrl', state.baseUrl);
  await db.setSetting('gridSize', state.gridSize);
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
    recordRequest(result);
    if (result.ok) {
      setStatus(`Key works: POST ${result.host} · ${result.model} · ${result.latencyMs} ms.`, 'ok');
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

  // A returning client may still be running the previous cached shell. When a
  // newly deployed worker takes control, reload once so the camera overlay and
  // chat fixes are actually applied. Guarded by hadController so the very
  // first install (which also fires controllerchange via clients.claim) does
  // not reload a freshly opened tab.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  // updateViaCache: 'none' stops GitHub Pages' 10-minute HTTP cache from
  // serving the previous sw.js during an update check. Without it a client can
  // keep running old shell modules for up to max-age after a deploy.
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((registration) => {
    if (hadController) registration.update().catch(() => {});
  }).catch(() => {
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

  els.uploadBtn.addEventListener('click', () => els.uploadInput.click());
  els.uploadInput.addEventListener('change', async () => {
    const file = els.uploadInput.files?.[0];
    els.uploadInput.value = '';
    if (!file) return;
    try { await loadUploadedPhoto(file); } catch (error) { setStatus(String(error?.message || error), 'error'); }
  });
  els.exportBtn.addEventListener('click', () => exportProject().catch((e) => setStatus(String(e?.message || e), 'error')));
  els.importBtn.addEventListener('click', () => els.importInput.click());
  els.importInput.addEventListener('change', async () => {
    const file = els.importInput.files?.[0];
    els.importInput.value = '';
    if (!file) return;
    try { await importProject(file); } catch (error) { setStatus(`Import failed: ${error?.message || error}`, 'error'); }
  });
  els.cameraSelect.addEventListener('change', async () => {
    saveCameraId(els.cameraSelect.value);
    if (state.stream) {
      try { await startCamera(); } catch (error) { setStatus(String(error?.message || error), 'error'); }
    }
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshCameraList);
  els.sendBtn.addEventListener('click', send);
  els.repeatBtn.addEventListener('click', repeat);
  els.explainBtn.addEventListener('click', explain);

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
    const tier = els.accessTier.value;
    els.modelInput.value = defaultModelFor(next, tier);
    syncProviderDetail(next);
  });
  els.accessTier.addEventListener('change', () => {
    const tier = els.accessTier.value;
    const providerId = els.providerSelect.value;
    if (els.modelInput.value && !modelAllowedAtTier(providerId, els.modelInput.value, tier)) {
      els.modelInput.value = defaultModelFor(providerId, tier);
    }
    syncProviderDetail(providerId);
  });
  els.modelInput.addEventListener('input', updateModelNote);
  els.modelInput.addEventListener('change', updateModelNote);
  els.clearLogBtn?.addEventListener('click', clearRequestLog);

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
  const savedProvider = PROVIDERS[settings.providerId] ? settings.providerId : 'openrouter';
  state.providerId = savedProvider;
  state.accessTier = 'paid'; // older builds saved 'free'/'preview'; paid is the superset
  // Older builds saved retired models. A model the user typed themselves is
  // kept unless it is a known paid model while free access is selected.
  const legacyRetired = new Set([
    'meta-llama/llama-3.3-70b-versatile',
  ]);
  const savedModel = settings.model && isMetaModelId(settings.model) && !legacyRetired.has(settings.model) ? settings.model : '';
  state.model = modelAllowedAtTier(savedProvider, savedModel, state.accessTier) ? savedModel : '';
  state.baseUrl = settings.baseUrl || '';
  await db.deleteSetting('tts'); // remove the legacy voice preference
  // Legacy plaintext keys from older builds are deleted, not migrated.
  await db.deleteSetting('apiKey');
  await db.deleteSetting('rememberKey');
  state.apiKey = '';

  els.gridSelect.value = String(state.gridSize);
  els.gridLabel.textContent = `Grid ${state.gridSize}×${state.gridSize}`;
  updateProviderUi();
  updateCloudUi();
  updateChatModeUi();
  clearRequestLog();

  await refreshProjects();
  setStatus('Ready. Camera permission is asked only when you tap Start camera.', '');
}

boot().catch((error) => setStatus(String(error?.message || error), 'error'));
