// perception/learning/OnnxComponentClassifier.js — measured component classifier.
//
// The dataset classifier is a pretrained ResNet-18 backbone with a linear head
// folded into a single ONNX graph (see scripts/export_classifier_onnx.py). This
// module is the only runtime path that should be described as "the trained
// recogniser": it performs the same crop / resize / ImageNet normalisation as
// training, then runs the ONNX session.
//
// The ONNX runtime is injected so the module stays testable and so the browser
// and Node can use different builds of onnxruntime-web.

export const INPUT_SIZE = 224;
export const DEFAULT_CONTEXT_MARGIN = 0.10;
export const IMAGENET_MEAN = [0.485, 0.456, 0.406];
export const IMAGENET_STD = [0.229, 0.224, 0.225];

function triangle(value) {
  const abs = Math.abs(value);
  return abs < 1 ? 1 - abs : 0;
}

/** PIL-compatible coefficient table for one axis of a bilinear resize. */
export function bilinearCoefficients(inSize, outSize) {
  const scale = inSize / Math.max(1, outSize);
  const filterscale = Math.max(1, scale);
  const support = filterscale;
  const rows = [];
  for (let out = 0; out < outSize; out += 1) {
    const center = (out + 0.5) * scale;
    let xmin = Math.floor(center - support + 0.5);
    let xmax = Math.floor(center + support + 0.5);
    if (xmin < 0) xmin = 0;
    if (xmax > inSize) xmax = inSize;
    const weights = [];
    let total = 0;
    for (let x = xmin; x < xmax; x += 1) {
      const weight = triangle((x - center + 0.5) / filterscale);
      weights.push(weight);
      total += weight;
    }
    if (total !== 0) {
      for (let i = 0; i < weights.length; i += 1) weights[i] /= total;
    }
    rows.push({ xmin, weights });
  }
  return rows;
}

/**
 * Resize an RGBA region to `outW x outH` using separable bilinear filtering.
 * `region` is { data, width, height } with 4 bytes per pixel.
 */
export function resizeRgba(region, outW, outH) {
  const { data, width, height } = region;
  const horizontal = new Float32Array(outW * height * 4);
  const xCoefficients = bilinearCoefficients(width, outW);
  for (let y = 0; y < height; y += 1) {
    const srcRow = y * width;
    for (let x = 0; x < outW; x += 1) {
      const { xmin, weights } = xCoefficients[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < weights.length; k += 1) {
        const weight = weights[k];
        const offset = (srcRow + xmin + k) * 4;
        r += data[offset] * weight;
        g += data[offset + 1] * weight;
        b += data[offset + 2] * weight;
        a += data[offset + 3] * weight;
      }
      const dst = (y * outW + x) * 4;
      horizontal[dst] = r;
      horizontal[dst + 1] = g;
      horizontal[dst + 2] = b;
      horizontal[dst + 3] = a;
    }
  }

  const output = new Uint8ClampedArray(outW * outH * 4);
  const yCoefficients = bilinearCoefficients(height, outH);
  for (let y = 0; y < outH; y += 1) {
    const { xmin, weights } = yCoefficients[y];
    for (let x = 0; x < outW; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < weights.length; k += 1) {
        const offset = ((xmin + k) * outW + x) * 4;
        const weight = weights[k];
        r += horizontal[offset] * weight;
        g += horizontal[offset + 1] * weight;
        b += horizontal[offset + 2] * weight;
        a += horizontal[offset + 3] * weight;
      }
      const dst = (y * outW + x) * 4;
      output[dst] = r;
      output[dst + 1] = g;
      output[dst + 2] = b;
      output[dst + 3] = a;
    }
  }
  return { data: output, width: outW, height: outH };
}

/** Crop a normalized box (with context margin) out of an RGBA image. */
export function cropRegion(imageData, box = { x: 0, y: 0, width: 1, height: 1 }, margin = DEFAULT_CONTEXT_MARGIN) {
  const { width, height, data } = imageData;
  const bx = Number(box.x) || 0;
  const by = Number(box.y) || 0;
  const bw = Number(box.width) || 1;
  const bh = Number(box.height) || 1;
  const left = Math.max(0, Math.min(width - 1, Math.round((bx - bw * margin) * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round((by - bh * margin) * height)));
  const right = Math.max(left + 1, Math.min(width, Math.round((bx + bw + bw * margin) * width)));
  const bottom = Math.max(top + 1, Math.min(height, Math.round((by + bh + bh * margin) * height)));
  const cropW = right - left;
  const cropH = bottom - top;
  const region = new Uint8ClampedArray(cropW * cropH * 4);
  for (let y = 0; y < cropH; y += 1) {
    const src = ((top + y) * width + left) * 4;
    const dst = y * cropW * 4;
    region.set(data.subarray(src, src + cropW * 4), dst);
  }
  return { data: region, width: cropW, height: cropH };
}

/** Convert a cropped RGBA region into a normalized NCHW Float32 tensor. */
export function toTensor(region, { mean = IMAGENET_MEAN, std = IMAGENET_STD } = {}) {
  const resized = resizeRgba(region, INPUT_SIZE, INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  const tensor = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    const offset = i * 4;
    tensor[i] = (resized.data[offset] / 255 - mean[0]) / std[0];
    tensor[plane + i] = (resized.data[offset + 1] / 255 - mean[1]) / std[1];
    tensor[plane * 2 + i] = (resized.data[offset + 2] / 255 - mean[2]) / std[2];
  }
  return tensor;
}

export function softmax(logits) {
  let max = -Infinity;
  for (const value of logits) if (value > max) max = value;
  const exps = new Float64Array(logits.length);
  let total = 0;
  for (let i = 0; i < logits.length; i += 1) {
    const value = Math.exp(logits[i] - max);
    exps[i] = value;
    total += value;
  }
  if (total === 0) return new Float64Array(logits.length);
  for (let i = 0; i < logits.length; i += 1) exps[i] /= total;
  return exps;
}

export class OnnxComponentClassifier {
  /**
   * @param {object} options
   * @param {object} options.session   An onnxruntime InferenceSession (or compatible).
   * @param {object} options.meta      Parsed classifier.json.
   * @param {string} [options.inputName]
   * @param {string} [options.outputName]
   */
  constructor({ session, meta, inputName = 'image', outputName = 'logits' } = {}) {
    if (!session) throw new Error('OnnxComponentClassifier: an ONNX session is required');
    if (!meta || !Array.isArray(meta.classes) || meta.classes.length === 0) {
      throw new Error('OnnxComponentClassifier: classifier metadata with classes is required');
    }
    this.session = session;
    this.meta = meta;
    this.inputName = inputName;
    this.outputName = outputName;
    this.classes = meta.classes;
    this.mean = meta.mean || IMAGENET_MEAN;
    this.std = meta.std || IMAGENET_STD;
    this.version = meta.featureVersion || 'cnn-5.1';
    this.inputSize = meta.inputSize || INPUT_SIZE;
    this.contextMargin = Number.isFinite(meta.contextMargin) ? meta.contextMargin : DEFAULT_CONTEXT_MARGIN;
  }

  static async load({ ort, modelUrl, metaUrl, wasmPaths, fetchImpl = globalThis.fetch, threads = 1, sessionOptions = {} } = {}) {
    if (!ort) throw new Error('OnnxComponentClassifier.load: pass the onnxruntime module as `ort`');
    if (wasmPaths && ort.env?.wasm) {
      ort.env.wasm.wasmPaths = wasmPaths;
      ort.env.wasm.numThreads = threads;
    }
    const metaResponse = await fetchImpl(metaUrl, { cache: 'no-store' });
    if (!metaResponse.ok) throw new Error(`classifier metadata fetch failed: ${metaResponse.status}`);
    const meta = await metaResponse.json();
    const modelResponse = await fetchImpl(modelUrl, { cache: 'force-cache' });
    if (!modelResponse.ok) throw new Error(`classifier model fetch failed: ${modelResponse.status}`);
    const modelBytes = new Uint8Array(await modelResponse.arrayBuffer());
    const session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      ...sessionOptions,
    });
    return new OnnxComponentClassifier({ session, meta });
  }

  /** Classify a normalized crop. Returns { label, confidence, candidates }. */
  async classify(imageData, box, { topK = 5 } = {}) {
    if (!imageData || !imageData.data) throw new Error('OnnxComponentClassifier.classify: imageData is required');
    const region = cropRegion(imageData, box, this.contextMargin);
    const tensor = toTensor(region, { mean: this.mean, std: this.std });
    // The injected runtime owns the Tensor class; `createOnnxClassifier`
    // attaches it so a bare session cannot silently use the wrong constructor.
    const Tensor = this.TensorClass;
    if (!Tensor) throw new Error('OnnxComponentClassifier: Tensor class is missing;use createOnnxClassifier');
    const output = await this.session.run({ [this.inputName]: new Tensor('float32', tensor, [1, 3, this.inputSize, this.inputSize]) });
    const logits = output[this.outputName] || output[this.session.outputNames?.[0]];
    const values = Array.from(logits.data);
    const probabilities = softmax(values);
    const ranked = Array.from(probabilities)
      .map((probability, index) => ({ label: this.classes[index], probability, index }))
      .sort((a, b) => b.probability - a.probability)
      .slice(0, Math.max(1, topK));
    return {
      label: ranked[0]?.label || 'unknown',
      confidence: ranked[0]?.probability || 0,
      candidates: ranked,
      featureVersion: this.version,
    };
  }
}

/** Convenience factory that wires the runtime Tensor class correctly. */
export function createOnnxClassifier({ session, meta, ort, inputName = 'image', outputName = 'logits' }) {
  const classifier = new OnnxComponentClassifier({ session, meta, inputName, outputName });
  classifier.TensorClass = ort?.Tensor;
  return classifier;
}
