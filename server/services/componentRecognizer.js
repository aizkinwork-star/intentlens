// server/services/componentRecognizer.js — server-side component recognition.
//
// Loads the measured ElectroCom61 classifier exported by
// scripts/export_classifier_onnx.py and runs a single forward pass per crop.
// The model is a ResNet-18 backbone with a linear head folded into one ONNX
// graph; see docs/COMPONENT_RECOGNITION.md for the measured numbers.
//
// The ONNX runtime is an optional dependency. If it or the model file is
// missing, every call returns an honest `available: false` reason instead of
// silently falling back to a weaker classifier.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePngRgba, isPng } from '../lib/png.js';
import { createOnnxClassifier } from '../../perception/learning/OnnxComponentClassifier.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_MODEL_DIR = join(ROOT, 'datasets', 'processed', 'cnn_resnet18_v1');
const MAX_PIXELS = 4096 * 4096;

let state = null; // { status, classifier, meta, error }

function modelDir() {
  return resolve(process.env.COMPONENT_MODEL_DIR || DEFAULT_MODEL_DIR);
}

export function recognizerStatus() {
  const dir = modelDir();
  const metaPath = join(dir, 'classifier.json');
  const modelPath = join(dir, 'component_classifier.onnx');
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null;
  return {
    available: Boolean(meta && existsSync(modelPath)),
    loaded: Boolean(state?.classifier),
    modelDir: dir,
    modelFile: existsSync(modelPath),
    metaFile: Boolean(meta),
    error: state?.error || null,
    model: meta
      ? {
        backbone: meta.backbone,
        classes: meta.classCount,
        classNames: meta.classes,
        featureVersion: meta.featureVersion,
        measured: meta.measured,
      }
      : null,
    note: 'The local recogniser proposes candidates. The AI analysis and user confirmation decide identity.',
  };
}

export async function loadRecognizer() {
  if (state?.classifier) return state;
  if (state?.error) throw new Error(state.error);
  const dir = modelDir();
  const metaPath = join(dir, 'classifier.json');
  const modelPath = join(dir, 'component_classifier.onnx');
  if (!existsSync(metaPath) || !existsSync(modelPath)) {
    state = { error: `Recogniser model not found in ${dir}. Run the training/export scripts first.` };
    throw new Error(state.error);
  }
  try {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.wasmPaths = pathToFileURL(join(ROOT, 'node_modules', 'onnxruntime-web', 'dist') + '/').href;
    ort.env.wasm.numThreads = 1;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const session = await ort.InferenceSession.create(readFileSync(modelPath), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    const classifier = createOnnxClassifier({ session, meta, ort });
    state = { classifier, meta };
    return state;
  } catch (err) {
    state = { error: `Recogniser failed to load: ${err.message || err}` };
    throw new Error(state.error);
  }
}

/** Recognise one already-cropped PNG. Returns top-k candidates. */
export async function recognizePng(buffer, { topK = 5 } = {}) {
  if (!isPng(buffer)) {
    return { available: false, reason: 'not_a_png', candidates: [] };
  }
  const decoded = decodePngRgba(buffer);
  if (!decoded || decoded.decoded !== true) {
    return { available: false, reason: decoded?.reason || 'image_decode_failed', candidates: [] };
  }
  if (decoded.width * decoded.height > MAX_PIXELS) {
    return { available: false, reason: 'image_too_large', candidates: [] };
  }
  const { classifier, meta } = await loadRecognizer();
  const result = await classifier.classify(
    { data: decoded.data, width: decoded.width, height: decoded.height },
    { x: 0, y: 0, width: 1, height: 1 },
    { topK },
  );
  return {
    available: true,
    label: result.label,
    confidence: result.confidence,
    candidates: result.candidates.map((candidate) => ({
      name: candidate.label,
      confidence: candidate.probability,
    })),
    model: {
      featureVersion: meta.featureVersion,
      classes: meta.classCount,
      measuredTestAccuracy: meta.measured?.testAccuracy ?? null,
    },
  };
}

/** Test hook: forget the loaded session (used only by tests). */
export function resetRecognizerForTests() {
  state = null;
}
