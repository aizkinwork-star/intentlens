// server/services/contextBudget.test.js — context budget tests.
// Run with: node --test contextBudget.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextBudget, DEFAULT_CONTEXT_WINDOW, ARCHIVE_THRESHOLD, COMPRESS_LEVELS } from './server/services/contextBudget.js';

test('ContextBudget starts with no compression', () => {
  const cb = new ContextBudget({ contextWindow: 1000 });
  assert.equal(cb.compressionLevel, 'none');
  assert.equal(cb.getUsagePercent(), 0);
});

test('ContextBudget estimates tokens for a request', () => {
  const cb = new ContextBudget({ contextWindow: 10000 });
  const request = {
    command: 'where is the battery connector',
    taskSummary: 'Inspecting phone motherboard',
    frame: { frameId: 'frame_1', width: 1280, height: 720 },
    sceneMap: [
      { id: 'J1', label: 'Battery connector', kind: 'conn', sourceFrameId: 'frame_1' },
    ],
    referencePack: [],
    recentCorrections: [],
  };
  const tokens = cb.estimateContextTokens(request);
  assert.ok(tokens > 0);
  assert.ok(cb.getUsagePercent() > 0);
});

test('ContextBudget compression levels escalate with usage', () => {
  const cb = new ContextBudget({ contextWindow: 1000 });
  // Simulate high usage by estimating many tokens
  cb.estimatedTokens = 950; // 95% usage
  cb._updateCompressionLevel();
  assert.equal(cb.compressionLevel, 'severe');

  cb.estimatedTokens = 800; // 80% usage
  cb._updateCompressionLevel();
  assert.equal(cb.compressionLevel, 'moderate');

  cb.estimatedTokens = 700; // 70% usage
  cb._updateCompressionLevel();
  assert.equal(cb.compressionLevel, 'mild');

  cb.estimatedTokens = 500; // 50% usage
  cb._updateCompressionLevel();
  assert.equal(cb.compressionLevel, 'none');
});

test('shouldArchive returns true when compression needed', () => {
  const cb = new ContextBudget({ contextWindow: 1000 });
  cb.estimatedTokens = 950;
  cb._updateCompressionLevel();
  assert.ok(cb.shouldArchive());
});

test('shouldArchive returns false when usage low', () => {
  const cb = new ContextBudget({ contextWindow: 1000 });
  cb.estimatedTokens = 500;
  cb._updateCompressionLevel();
  assert.ok(!cb.shouldArchive());
});

test('getCompressedLimits returns level-specific limits', () => {
  const cb = new ContextBudget({ contextWindow: 1000 });
  cb.compressionLevel = 'mild';
  const limits = cb.getCompressedLimits();
  assert.equal(limits.sceneItems, 8);
  assert.equal(limits.corrections, 2);

  cb.compressionLevel = 'severe';
  const limits2 = cb.getCompressedLimits();
  assert.equal(limits2.sceneItems, 2);
  assert.equal(limits2.corrections, 0);
});

test('ARCHIVE_THRESHOLD is 0.70', () => {
  assert.equal(ARCHIVE_THRESHOLD, 0.70);
});

test('DEFAULT_CONTEXT_WINDOW is 32000', () => {
  assert.equal(DEFAULT_CONTEXT_WINDOW, 32000);
});
