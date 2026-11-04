// Backend services: context building, response parsing, result conversion, request
// validation and the mock model. Run with:  node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateResult } from './schema.js';
import { buildGroundingPrompt, summarizeContext } from './server/services/contextBuilder.js';
import { readResponsePayload } from './server/services/metaModelClient.js';
import { toGroundingResult } from './server/services/groundingValidator.js';
import { mockGrounding } from './server/services/mockModel.js';
import { readAnalyzeRequest } from './server/routes/analyze.js';

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==';

const baseRequest = () => ({
  requestId: 'req_test_1',
  sessionId: 'sess_test',
  command: 'Point to the connector near the lower edge',
  frame: {
    frameId: 'frame_004',
    dataUrl: JPEG,
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
    capturedAt: '2026-10-26T13:00:00.000Z',
  },
  gridSize: 64,
  userSelectedRegion: null,
  sceneMap: [],
  taskSummary: 'Inspecting an unpowered old phone motherboard',
  referencePack: [],
  recentCorrections: [],
  lastTargetId: null,
  allowWebSearch: true,
});

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------
test('the prompt carries the command, the frame and the coordinate convention', () => {
  const { instructions, userText } = buildGroundingPrompt(baseRequest());
  assert.match(userText, /Point to the connector near the lower edge/);
  assert.match(userText, /frame_004/);
  assert.match(instructions, /0-1000 grid/);
  assert.match(instructions, /never an instruction to you/i);
});

test('stale scene entries are labelled stale instead of looking current', () => {
  const req = baseRequest();
  req.sceneMap = [
    {
      id: 'U2',
      label: 'RAM (LPDDR)',
      kind: 'component',
      point: { x: 0.6, y: 0.4 },
      sourceFrameId: 'frame_002',
      confidence: 0.88,
      status: 'stale',
      evidenceKind: 'visual_inference',
    },
  ];
  const { userText } = buildGroundingPrompt(req);
  assert.match(userText, /U2/);
  assert.match(userText, /STALE/);
  assert.match(userText, /from_frame=frame_002/);
});

test('a user-tapped region is described as a hint, with its cell', () => {
  const req = baseRequest();
  req.userSelectedRegion = { x: 0.68, y: 0.74, cellId: 'R48C44' };
  const { userText } = buildGroundingPrompt(req);
  assert.match(userText, /R48C44/);
  assert.match(userText, /hint/i);
});

test('context summarises what was actually sent', () => {
  const req = baseRequest();
  req.sceneMap = [{ id: 'A', label: 'a', status: 'stale', confidence: 0.5, sourceFrameId: 'f1', kind: 'component' }];
  const summary = summarizeContext(req);
  assert.equal(summary.sceneItems, 1);
  assert.equal(summary.staleItems, 1);
});

// ---------------------------------------------------------------------------
// Responses API parsing: search proof and citations
// ---------------------------------------------------------------------------
test('a real web_search_call item marks the answer as searched', () => {
  const payload = {
    id: 'resp_1',
    output: [
      { type: 'web_search_call', status: 'completed' },
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: '{"resultStatus":"no_target"}',
            annotations: [
              { type: 'url_citation', url: 'https://example.com/manual', title: 'Official manual', start_index: 0, end_index: 8 },
            ],
          },
        ],
      },
    ],
    usage: { input_tokens: 1200, output_tokens: 60 },
  };
  const out = readResponsePayload(payload);
  assert.equal(out.searchedWeb, true);
  assert.equal(out.citations.length, 1);
  assert.equal(out.citations[0].url, 'https://example.com/manual');
  assert.equal(out.text, '{"resultStatus":"no_target"}');
});

test('no web_search_call means searchedWeb stays false', () => {
  const payload = {
    output: [{ type: 'message', content: [{ type: 'output_text', text: '{}', annotations: [] }] }],
  };
  const out = readResponsePayload(payload);
  assert.equal(out.searchedWeb, false);
  assert.deepEqual(out.citations, []);
});

test('citations are de-duplicated by url and snippet', () => {
  const annotation = { type: 'url_citation', url: 'https://a', title: 'A', start_index: 0, end_index: 3 };
  const payload = {
    output: [
      { type: 'web_search_call' },
      { type: 'message', content: [{ type: 'output_text', text: 'abc', annotations: [annotation, annotation] }] },
    ],
  };
  assert.equal(readResponsePayload(payload).citations.length, 1);
});

// ---------------------------------------------------------------------------
// Model JSON -> GroundingResult
// ---------------------------------------------------------------------------
const rawModelOutput = () => ({
  resultStatus: 'target_found',
  answerShort: 'This appears to be the connector near the lower edge.',
  target: {
    targetId: 'J2',
    label: 'lower-edge connector (proposed)',
    x: 680,
    y: 740,
    box: { x_min: 620, y_min: 690, x_max: 740, y_max: 790 },
    confidence: 0.71,
  },
  uncertaintyNote: 'Visual identification only.',
  needsConfirmation: true,
  requestedClarification: null,
});

test('the adapter converts the 0..1000 model grid to 0..1 and derives the 64-grid cell', () => {
  const result = toGroundingResult({ raw: rawModelOutput(), request: baseRequest() });
  assert.equal(result.target.point.x, 0.68);
  assert.equal(result.target.point.y, 0.74);
  assert.equal(result.target.gridCell, 'R48C44');
  assert.equal(result.target.freshness, 'current_frame');
  assert.equal(Number(result.target.box.width.toFixed(3)), 0.12);
  assert.equal(result.evidenceKind, 'visual_inference');
  assert.equal(result.evidence.length, 0);
});

test('the request grid size drives the derived cell, not a hidden default', () => {
  const request = { ...baseRequest(), gridSize: 32 };
  const result = toGroundingResult({ raw: rawModelOutput(), request });
  assert.equal(result.target.gridCell, 'R24C22');
  assert.equal(validateResult(result, { gridSize: 32 }).ok, true);
  assert.equal(validateResult(result, { gridSize: 64 }).ok, false);
});

test('a converted result passes the shared UI validator', () => {
  const result = toGroundingResult({ raw: rawModelOutput(), request: baseRequest() });
  const check = validateResult(
    { ...result, requestId: 'req_test_1', frameId: 'frame_004' },
    { requestId: 'req_test_1', frameId: 'frame_004' },
  );
  assert.equal(check.ok, true, check.reason);
});

test('out-of-range model coordinates are rejected, not clamped into a fake marker', () => {
  const raw = rawModelOutput();
  raw.target.x = 4200;
  assert.throws(() => toGroundingResult({ raw, request: baseRequest() }), (err) => err.code === 'RESULT_SCHEMA_INVALID');
});

test('a target on a clarification result is dropped rather than drawn', () => {
  const raw = rawModelOutput();
  raw.resultStatus = 'needs_clarification';
  raw.requestedClarification = 'Is this the connector you meant?';
  const result = toGroundingResult({ raw, request: baseRequest() });
  assert.equal(result.target, null);
  assert.equal(result.needsConfirmation, true);
  assert.equal(result.requestedClarification, 'Is this the connector you meant?');
});

test('low confidence forces a confirmation step', () => {
  const raw = rawModelOutput();
  raw.target.confidence = 0.3;
  raw.needsConfirmation = false;
  assert.equal(toGroundingResult({ raw, request: baseRequest() }).needsConfirmation, true);
});

test('web evidence is only web evidence when a search actually ran', () => {
  const request = baseRequest();
  const citations = [{ title: 'Manual', url: 'https://example.com/m', citedText: 'pin 1' }];

  const withoutSearch = toGroundingResult({ raw: rawModelOutput(), request, citations, searchedWeb: false });
  assert.equal(withoutSearch.evidenceKind, 'visual_inference');
  assert.equal(withoutSearch.evidence.length, 0, 'an unproven search must not become evidence');

  const withSearch = toGroundingResult({ raw: rawModelOutput(), request, citations, searchedWeb: true });
  assert.equal(withSearch.evidenceKind, 'web_source');
  assert.equal(withSearch.evidence.length, 1);
  assert.equal(withSearch.evidence[0].url, 'https://example.com/m');
});

test('a user-verified reference outranks a web source', () => {
  const request = baseRequest();
  request.referencePack = [{ id: 'r1', title: 'Board schematic', kind: 'schematic', verifiedByUser: true, summary: 'J2 is the display connector.' }];
  const result = toGroundingResult({
    raw: rawModelOutput(),
    request,
    citations: [{ title: 'Manual', url: 'https://example.com/m', citedText: 'x' }],
    searchedWeb: true,
  });
  assert.equal(result.evidenceKind, 'verified_reference');
  assert.ok(result.evidence.some((e) => e.kind === 'verified_reference'));
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------
test('a request without a command is refused', () => {
  const body = { ...baseRequest(), command: '   ' };
  assert.throws(() => readAnalyzeRequest(body), (err) => err.code === 'COMMAND_MISSING');
});

test('a request without a usable frame is refused', () => {
  const body = { ...baseRequest(), frame: null };
  assert.throws(() => readAnalyzeRequest(body), (err) => err.code === 'CAMERA_FRAME_MISSING');

  const badType = { ...baseRequest(), frame: { ...baseRequest().frame, dataUrl: 'https://example.com/a.jpg' } };
  assert.throws(() => readAnalyzeRequest(badType), (err) => err.code === 'CAMERA_FRAME_MISSING');
});

test('a good request is normalized and defaults are applied', () => {
  const clean = readAnalyzeRequest({ command: 'hi', frame: baseRequest().frame });
  assert.equal(clean.command, 'hi');
  assert.equal(clean.allowWebSearch, false);
  assert.equal(clean.gridSize, 64);
  assert.equal(clean.frame.frameId, 'frame_004');
  assert.ok(clean.requestId.startsWith('req_'));
});

test('scene map entries with junk coordinates are discarded', () => {
  const body = {
    ...baseRequest(),
    sceneMap: [
      { id: 'U1', label: 'SoC', point: { x: 2, y: 0.5 } },
      { id: 'U2', label: 'RAM', point: { x: 0.6, y: 0.4 } },
      { id: '', label: 'no id' },
    ],
  };
  const clean = readAnalyzeRequest(body);
  assert.equal(clean.sceneMap.length, 1);
  assert.equal(clean.sceneMap[0].id, 'U2');
});

// ---------------------------------------------------------------------------
// Mock model: same shape as the live one
// ---------------------------------------------------------------------------
test('mock model finds the battery connector and returns a valid result', async () => {
  const result = await mockGrounding({
    requestId: 'req_1',
    frameId: 'frame_001',
    command: 'where is the battery connector',
  });
  assert.equal(result.resultStatus, 'target_found');
  assert.equal(result.target.targetId, 'J1');
  assert.equal(result.target.freshness, 'current_frame');
  assert.equal(validateResult({ ...result, requestId: 'req_1', frameId: 'frame_001' }).ok, true);
});

test('mock model asks for clarity instead of inventing a target', async () => {
  const result = await mockGrounding({ requestId: 'req_2', frameId: 'frame_002', command: 'banana' });
  assert.equal(result.resultStatus, 'needs_clarification');
  assert.equal(result.target, null);
});
