import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from './server/store.js';
import { createProjectFromIntent, advanceProjectStep } from './projectPlanner.js';
import {
  readComponentRequest,
  runComponentAnalysis,
  persistAnalysisOutcome,
} from './server/routes/componentAnalyze.js';
import { readExplainRequest, runExplain } from './server/routes/explain.js';
import { readCaptureRequest } from './server/routes/captures.js';
import { COMPONENT_SCHEMA, buildComponentPrompt } from './server/services/componentSchema.js';

const tiny = (text) => Buffer.from(text).toString('base64');

function fakeRouter(raw, provider = 'fake-provider') {
  const inputs = [];
  const router = {
    async analyze(input) {
      inputs.push(input);
      return {
        result: { text: JSON.stringify(raw), citations: [], searchedWeb: false },
        providerUsed: provider,
        providerName: 'Fake Meta provider',
        modelId: 'meta/fake-vision',
        fallbackOccurred: false,
        attempts: [{ id: provider, ok: true }],
      };
    },
  };
  return { router, inputs };
}

const validModelResult = {
  component: {
    name: 'LED',
    identity_status: 'ai_candidate',
    evidence: ['clear dome with two leads'],
    uncertainty: 'medium',
  },
  location: {
    center: { x: 500, y: 500 },
    corners: [
      { x: 400, y: 400 },
      { x: 600, y: 400 },
      { x: 600, y: 600 },
      { x: 400, y: 600 },
    ],
  },
  next_action: 'instruction',
  instruction: 'Check the longer lead before connecting power.',
};

test('structured project state persists in SQLite and resumes on the current step', () => {
  const dir = mkdtempSync(join(tmpdir(), 'intentlens-project-'));
  const store = new Store({ dataDir: dir });
  store.open();
  try {
    const project = createProjectFromIntent('Build a blinking LED with an Arduino Uno. I have an Arduino Uno and a breadboard.');
    store.saveProjectDoc(project);
    const loaded = store.getProjectDoc(project.projectId);
    assert.equal(loaded.projectId, project.projectId);
    assert.equal(loaded.currentStep, project.currentStep);

    const advanced = advanceProjectStep(loaded, loaded.currentStep);
    store.saveProjectDoc(advanced);
    assert.equal(store.getProjectDoc(project.projectId).currentStep, advanced.currentStep);
    assert.equal(store.listProjectDocs(5).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture metadata is stored and the original file is immutable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'intentlens-capture-'));
  const store = new Store({ dataDir: dir });
  store.open();
  try {
    const project = createProjectFromIntent('Build an LED circuit.');
    store.saveProjectDoc(project);

    const capture = store.createCapture({
      id: 'cap_test_1',
      projectId: project.projectId,
      originalBuffer: Buffer.from('original-bytes'),
      overlayBuffer: Buffer.from('overlay-bytes'),
      overlaySvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      mimeType: 'image/jpeg',
      width: 1280,
      height: 720,
      gridSize: 64,
      capturedAt: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(capture.captureId, 'cap_test_1');
    assert.equal(capture.width, 1280);
    assert.equal(capture.height, 720);
    assert.equal(capture.gridSize, 64);
    assert.equal(capture.capturedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(capture.hasOverlay, true);
    assert.equal(capture.originalUrl, '/api/captures/cap_test_1/original');
    assert.equal(capture.overlayUrl, '/api/captures/cap_test_1/overlay');

    const original = store.getCaptureFile('cap_test_1', 'original');
    const overlay = store.getCaptureFile('cap_test_1', 'overlay');
    assert.equal(readFileSync(original.path, 'utf8'), 'original-bytes');
    assert.equal(readFileSync(overlay.path, 'utf8'), 'overlay-bytes');
    assert.notEqual(original.path, overlay.path);
    assert.equal(store.listCaptures(project.projectId).length, 1);

    assert.throws(
      () => store.createCapture({
        id: 'cap_test_1',
        projectId: project.projectId,
        originalBuffer: Buffer.from('replacement-bytes'),
        mimeType: 'image/jpeg',
        width: 1280,
        height: 720,
        gridSize: 64,
      }),
      (err) => err.code === 'CAPTURE_EXISTS',
    );
    assert.equal(readFileSync(original.path, 'utf8'), 'original-bytes');

    store.deleteProject(project.projectId);
    assert.equal(existsSync(original.path), false);
    assert.equal(store.getCapture('cap_test_1'), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture request rejects a non-image payload before anything is stored', () => {
  assert.throws(
    () => readCaptureRequest({ projectId: 'proj_1', width: 1280, height: 720, dataUrl: 'not-an-image' }),
    (err) => err.code === 'CAMERA_FRAME_MISSING',
  );
});

test('component analysis makes one request and sends the original plus grid overlay', async () => {
  const request = readComponentRequest({
    projectId: 'proj_test',
    capture: {
      dataUrl: `data:image/jpeg;base64,${tiny('original')}`,
      width: 1280,
      height: 720,
      gridSize: 64,
    },
    overlayDataUrl: `data:image/png;base64,${tiny('overlay')}`,
    question: 'Build a blinking LED',
    localCandidates: [{ name: 'LED', distance: 12.5 }],
  });

  const { router, inputs } = fakeRouter(validModelResult);
  const out = await runComponentAnalysis({ router, request, project: null });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].imageDataUrls.length, 2);
  assert.equal(inputs[0].schema, COMPONENT_SCHEMA);
  assert.match(inputs[0].userText, /unverified local k-NN candidate/i);
  assert.match(inputs[0].userText, /not a probability/i);
  assert.match(inputs[0].userText, /Build a blinking LED/);
  assert.equal(out.converted.ok, true);
  assert.equal(out.converted.result.location.grid_cell, 'R33C33');
});

test('an invalid coordinate result is rejected without a fabricated box', async () => {
  const request = readComponentRequest({
    projectId: 'proj_test',
    capture: {
      dataUrl: `data:image/jpeg;base64,${tiny('original')}`,
      width: 1280,
      height: 720,
      gridSize: 64,
    },
  });
  const invalid = {
    ...validModelResult,
    location: {
      center: { x: 500, y: 500 },
      corners: [{ x: 400, y: 400 }, { x: 600, y: 400 }, { x: 600, y: 600 }],
    },
  };
  const { router, inputs } = fakeRouter(invalid);
  const out = await runComponentAnalysis({ router, request, project: null });
  assert.equal(inputs.length, 1);
  assert.equal(out.converted.ok, false);
  assert.match(out.converted.errors.join(' '), /exactly four/i);
});

test('model prompt carries project context and resists invented facts', () => {
  const project = createProjectFromIntent('Build a blinking LED. I have an Arduino Uno.');
  const prompt = buildComponentPrompt({
    projectContext: { title: 'blinking LED', skillLevel: 'beginner', availableMaterials: ['Arduino board'] },
    capture: { captureId: 'cap_1', width: 1280, height: 720, gridSize: 64 },
    localCandidates: [{ name: 'LED', distance: 9.2 }],
    question: 'What is this part?',
  });
  assert.match(prompt.instructions, /Never invent a component identity/i);
  assert.match(prompt.instructions, /Visually similar components can have different pinouts/i);
  assert.match(prompt.userText, /"skillLevel": "beginner"/);
  assert.match(prompt.userText, /unverified local k-NN candidate/i);
  assert.match(prompt.instructions, /location to null/i);
  assert.ok(project.userGoal);
});

test('Explain makes exactly one request and returns the expanded answer', async () => {
  const request = readExplainRequest({
    projectId: 'proj_test',
    previousAnswer: 'Check the LED polarity.',
    question: 'Build a blinking LED',
  });
  const { router, inputs } = fakeRouter({ answer: '1. Find the longer leg. 2. Point it toward the resistor.' });
  const out = await runExplain({ router, request, project: null });
  assert.equal(inputs.length, 1);
  assert.match(out.answer, /longer leg/);
  assert.match(inputs[0].userText, /Check the LED polarity/);
});

test('an unavailable analysis outcome is recorded on the project for resume', () => {
  const dir = mkdtempSync(join(tmpdir(), 'intentlens-outcome-'));
  const store = new Store({ dataDir: dir });
  store.open();
  try {
    const project = createProjectFromIntent('Build an LED circuit.');
    store.saveProjectDoc(project);

    persistAnalysisOutcome(store, {
      request: { projectId: project.projectId, captureId: 'cap_outcome_1' },
      status: 'unavailable',
      message: 'No Meta vision provider is configured.',
    });

    const loaded = store.getProjectDoc(project.projectId);
    assert.equal(loaded.lastAnalysis.status, 'unavailable');
    assert.equal(loaded.lastAnalysis.captureId, 'cap_outcome_1');
    assert.match(loaded.lastAnalysis.message, /No Meta vision provider/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
