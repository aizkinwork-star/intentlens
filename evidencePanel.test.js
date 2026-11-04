import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceCard, toggleExpanded } from './evidencePanel.js';

const capture = {
  captureId: 'cap_1',
  originalUrl: '/api/captures/cap_1/original',
  overlayUrl: '/api/captures/cap_1/overlay',
  width: 1280,
  height: 720,
  gridSize: 64,
};

const analysis = {
  component: { name: 'LED', identity_status: 'ai_candidate', evidence: ['clear dome'], uncertainty: 'medium' },
  location: {
    grid_cell: 'R33C33',
    center: { x: 0.5, y: 0.5 },
    corners: [
      { x: 0.4, y: 0.4 },
      { x: 0.6, y: 0.4 },
      { x: 0.6, y: 0.6 },
      { x: 0.4, y: 0.6 },
    ],
  },
  next_action: 'instruction',
  instruction: 'Check the longer lead.',
};

test('evidence card keeps the original URL and draws only validated corners', () => {
  const card = buildEvidenceCard({ capture, analysis, candidates: [{ name: 'LED', status: 'unverified_candidate' }] });
  assert.equal(card.originalUrl, capture.originalUrl);
  assert.equal(card.overlayUrl, capture.overlayUrl);
  assert.equal(card.gridCell, 'R33C33');
  assert.equal(card.drawOutline, true);
  assert.equal(card.statusLabel, 'AI candidate — confirm or correct');
  assert.equal(card.candidates[0].status, 'unverified_candidate');
});

test('no outline is drawn for invalid corners', () => {
  const card = buildEvidenceCard({
    capture,
    analysis: {
      ...analysis,
      location: { ...analysis.location, corners: [{ x: 2, y: 0 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 }] },
    },
  });
  assert.equal(card.corners, null);
  assert.equal(card.drawOutline, false);
});

test('expand toggles the preview and requires an original image', () => {
  const card = buildEvidenceCard({ capture, analysis });
  const expanded = toggleExpanded(card);
  assert.equal(expanded.expanded, true);
  assert.equal(toggleExpanded(expanded).expanded, false);
  assert.equal(toggleExpanded(buildEvidenceCard({ analysis })).canExpand, false);
});

test('an unavailable, rejected or invalid analysis is labelled honestly', () => {
  assert.equal(
    buildEvidenceCard({ capture, analysisState: 'unavailable' }).statusLabel,
    'Captured — AI unavailable, saved locally',
  );
  assert.equal(
    buildEvidenceCard({ capture, analysisState: 'rejected' }).statusLabel,
    'Captured — AI result rejected, no box drawn',
  );
  assert.equal(
    buildEvidenceCard({ capture, analysisState: 'invalid' }).statusLabel,
    'Captured — coordinates failed validation',
  );
  // A capture with no analysis state is genuinely still waiting.
  assert.equal(buildEvidenceCard({ capture }).statusLabel, 'Captured — waiting for analysis');
});
