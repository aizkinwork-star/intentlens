// server/services/contextBudget.js — context window budget tracker.
//
// Estimates token usage of the context packet sent to the model (rough
// characters ÷ 4, a standard heuristic for LLMs). Tracks usage across
// requests and recommends aggressive archiving when approaching the
// provider's context window so the system never silently loses history.
//
// The project summary is the compression mechanism: when recent tasks
// exceed the cap, their key facts are archived into the summary before
// removal (§9 of the architecture). This module decides WHEN to trigger
// that archiving based on estimated token budget.

// Rough token estimate: ~4 chars per token for English text.
// Providers vary; this is a conservative planning figure.
const CHARS_PER_TOKEN = 4;

// Default context window budget (tokens). Override per provider in config.
export const DEFAULT_CONTEXT_WINDOW = 32_000;

// When estimated usage exceeds this fraction of the window, start
// aggressively archiving older tasks into the project summary.
export const ARCHIVE_THRESHOLD = 0.70;

// How hard to compress: reduce scene items, corrections, reference items.
export const COMPRESS_LEVELS = {
  mild:   { sceneItems: 8,  corrections: 2, referenceItems: 4 },
  moderate: { sceneItems: 5,  corrections: 1, referenceItems: 2 },
  severe: { sceneItems: 2,  corrections: 0, referenceItems: 1 },
};

export class ContextBudget {
  constructor({ contextWindow = DEFAULT_CONTEXT_WINDOW } = {}) {
    this.contextWindow = contextWindow;
    this.estimatedTokens = 0;
    this.peakTokens = 0;
    this.requestCount = 0;
    this.compressionLevel = 'none'; // none | mild | moderate | severe
  }

  // Rough token estimate of a string.
  estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / CHARS_PER_TOKEN);
  }

  // Estimate tokens for the full context packet that will be sent to the model.
  estimateContextTokens(request) {
    let tokens = 0;

    // System instructions (fixed overhead).
    tokens += this.estimateTokens(INSTRUCTIONS_OVERHEAD);

    // Command, task summary, frame metadata.
    tokens += this.estimateTokens(request.command);
    tokens += this.estimateTokens(request.taskSummary);
    tokens += this.estimateTokens(
      `frameId=${request.frame.frameId}, ${request.frame.width}x${request.frame.height}px`
    );

    // User selected region.
    if (request.userSelectedRegion) {
      tokens += this.estimateTokens(
        `point=(${request.userSelectedRegion.x}, ${request.userSelectedRegion.y})`
      );
    }

    // Scene map items.
    const scene = Array.isArray(request.sceneMap) ? request.sceneMap : [];
    for (const item of scene) {
      tokens += this.estimateTokens(item.id || '');
      tokens += this.estimateTokens(item.label || '');
      tokens += this.estimateTokens(item.kind || '');
      tokens += this.estimateTokens(item.sourceFrameId || '');
      tokens += 40; // overhead for coordinates, confidence, status fields
    }

    // Reference pack.
    const refs = Array.isArray(request.referencePack) ? request.referencePack : [];
    for (const ref of refs) {
      tokens += this.estimateTokens(ref.title || '');
      tokens += this.estimateTokens(ref.summary || '');
      tokens += 30;
    }

    // Corrections.
    const corrections = Array.isArray(request.recentCorrections) ? request.recentCorrections : [];
    for (const c of corrections) {
      tokens += this.estimateTokens(c.targetId || '');
      tokens += this.estimateTokens(c.correction || '');
      tokens += 20;
    }

    // Output schema instructions (fixed).
    tokens += this.estimateTokens(OUTPUT_SCHEMA_OVERHEAD);

    this.estimatedTokens = tokens;
    if (tokens > this.peakTokens) this.peakTokens = tokens;
    this.requestCount += 1;

    this._updateCompressionLevel();
    return tokens;
  }

  _updateCompressionLevel() {
    const usage = this.estimatedTokens / this.contextWindow;
    if (usage >= 0.90) this.compressionLevel = 'severe';
    else if (usage >= 0.80) this.compressionLevel = 'moderate';
    else if (usage >= ARCHIVE_THRESHOLD) this.compressionLevel = 'mild';
    else this.compressionLevel = 'none';
  }

  getUsagePercent() {
    return Math.round((this.estimatedTokens / this.contextWindow) * 100);
  }

  getCompressionLevel() {
    return this.compressionLevel;
  }

  shouldArchive() {
    return this.compressionLevel !== 'none';
  }

  getCompressedLimits() {
    return COMPRESS_LEVELS[this.compressionLevel] || {
      sceneItems: 12, corrections: 3, referenceItems: 6,
    };
  }

  getStats() {
    return {
      estimatedTokens: this.estimatedTokens,
      peakTokens: this.peakTokens,
      contextWindow: this.contextWindow,
      usagePercent: this.getUsagePercent(),
      compressionLevel: this.compressionLevel,
      requestCount: this.requestCount,
    };
  }
}

// Fixed overhead text that's always sent to the model.
const INSTRUCTIONS_OVERHEAD = `You are the visual grounding component of IntentLens.
Coordinates: 0-1000 integer grid. Grounding rules apply. Answer in JSON schema.`;

const OUTPUT_SCHEMA_OVERHEAD = `Return JSON: resultStatus, answerShort, target {targetId, label, x, y, box, confidence}, uncertaintyNote, needsConfirmation, requestedClarification.`;
