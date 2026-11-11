# Perception and accuracy

This document explains the local perception modules, the numbers they produce,
and how to measure accuracy without inventing a figure. It matches the code in
`perception/`; every threshold quoted here is a named constant in the module it
belongs to.

Two rules run through all of it:

1. **A heuristic is not a measurement.** A score that comes from an unlabelled
   frame is a hint. It is labelled as one.
2. **No accuracy number without labelled samples.** `accuracyReport` returns
   `null` for an empty sample and `trustworthy: false` below
   `MEASUREMENT_MIN_SAMPLES` (30). It is not possible to read "85%" out of an
   unlabelled run, by construction.

---

## 1. Lighting — `perception/lighting/adaptivePreprocess.js`

Camera frames from a phone or a cheap laptop webcam are often dim, backlit,
clipped, or brighter on one side than the other. A vision model sees the raw
still, so those faults become wrong answers. This module measures the frame and
repairs only what it can prove is wrong.

It is pure: it takes an `ImageData`-like object
(`{ data: Uint8ClampedArray, width, height }`), never mutates it, and has no DOM
or OpenCV dependency. That makes it testable in Node and cheap on a low-power
PC.

### `analyzeLighting(imageData, options)`

Samples evenly (default `maxSamples: 24000`) so cost does not grow with
megapixels, then returns:

| Field | Meaning |
| --- | --- |
| `mean`, `median`, `stdDev` | luma statistics |
| `p05`, `p95`, `dynamicRange` | tonal spread (`p95 - p05`) |
| `clippingHigh`, `clippingLow` | fraction of pixels pinned at the top/bottom |
| `shadowRatio`, `highlightRatio` | fraction below `shadowCut` (45) / above `highlightCut` (220) |
| `uniformity` | `1 - stdev(8x8 tile means) / mean`, clamped to `0..1` |
| `state` | one of the five classes below |
| `score` | compact `0..1` quality score |
| `recommendation.steps` | which repairs the measurement suggests |

### States and the thresholds that produce them

Evaluated in this order (first match wins):

| State | Condition |
| --- | --- |
| `blown_out` | `mean >= 236` **or** `clippingHigh > 0.22` |
| `dim` | `mean < 58` **or** `shadowRatio > 0.62` **or** `clippingLow > 0.35` |
| `low_contrast` | `dynamicRange < minDynamicRange` (42) |
| `uneven` | `uniformity < minUniformity` (0.55) |
| `good` | none of the above |

The `score` is `0.35 * exposure + 0.30 * range + 0.20 * uniformity + 0.15 *
clip`, so it can be compared across frames and shown as a single number.

### `adaptivePreprocess(imageData, options)`

Returns `{ image, before, after, steps, changed, improved }`.

- `mode: 'off'` returns a copy with `changed: false`.
- A `blown_out` frame is returned unchanged. A clipped highlight has no detail
  to recover; brightening or sharpening it would only make the frame *look*
  better while keeping it wrong.
- A `good` frame is also returned unchanged unless `force: true`.

Otherwise it applies, in order, and only when the matching measurement is bad:

1. **Exposure** — gamma lift when `mean < 105` and `clippingHigh < 0.1`.
2. **Contrast** — bounded percentile stretch when `dynamicRange < 120` and
   `clippingHigh < 0.1`.
3. **Illumination** — local flattening when `uniformity < 0.72`.
4. **Sharpen** — mild unsharp mask when the post-lift `stdDev` is in `3..80`.

Every applied step is recorded in `steps`, and `improved` is true only when the
measured `score` actually rose. The capture path stores the report in
`state.lastPreprocess`, so the UI can say the still was adjusted rather than
silently pretending it was not.

### What it cannot do

- It cannot recover a genuinely blurry photo. Sharpening is clamped
  (`amount` default 0.35, capped at 0.8) and honesty wins over a crisp-looking
  lie.
- It cannot restore lost highlight detail.
- It does not change geometry. Perspective, rotation and board curvature are
  handled (or not) elsewhere.

---

## 2. Tracking — `tracker.js`, `looseObjectTracker.js`, `perception/tracking/HingeTracker.js`

### Object tracker

The colour-histogram + patch tracker exists already and is independent of any
model call. It exposes five states:

`INACTIVE → TRACKING → LOW_CONFIDENCE → LOST`, with `REACQUIRING` while it
searches after a loss. It is a localisation aid; it does not classify what it is
tracking.

### Hinge tracker

`HingeTracker` answers a narrow question: is a clamshell (laptop lid, fold,
hinged case) opening or closing, and by roughly how much? It is local and
model-free, so it runs at camera speed and costs no tokens.

**Inputs.** Coordinates are normalized `0..1`. An edge is `{ near, far }`,
where `near` sits at the hinge and `far` points along the board. A plain `{ a,
b }` edge is accepted too, with `a` treated as the hinge end.

- **Two board edges per frame** (`{ upper, lower, confidence, timestamp }`):
  the lid angle is the angle between the two `near -> far` vectors. This is
  exact geometry and is what the unit tests cover. Closed = 0°, flat = 180°.
- **A raw frame** (`{ image, timestamp }`): `estimateHingeFromFrame` runs
  `dominantOrientations`, which bins Sobel gradient directions (`bins: 36`) and
  takes the angle between the two strongest peaks. The result carries
  `method: 'orientation'` and a low confidence. It is a **coarse hint**, never
  a calibrated measurement: perspective and lighting move it.

**Bands** (`HINGE_BANDS`): `closedMaxDeg: 20`, `openMinDeg: 150`. `classifyHinge`
returns `closed`, `ajar` or `open`.

**Filtering.** `DEFAULT_HINGE_OPTIONS`:

| Option | Default | Effect |
| --- | --- | --- |
| `smoothing` | 0.35 | exponential smoothing factor per update |
| `minConfidence` | 0.55 | below this the frame is a miss |
| `lostAfterMs` | 900 | time without a good frame before `LOST` |
| `minEdgeLength` | 0.03 | normalized minimum edge length |
| `maxJumpDeg` | 65 | a larger single-frame jump is rejected as a mis-detection |
| `maxVelocityDegPerSec` | 400 | velocity is clamped |

**States.** `INACTIVE`, `TRACKING`, `LOW_CONFIDENCE`, `LOST`. It also exposes
`angleDeg` (smoothed), `rawAngleDeg`, `confidence`, `velocityDegPerSec` and a
`snapshot()`. Out-of-order frames are ignored rather than moving the angle
backwards.

**Limits.** A single camera cannot resolve true 3D hinge angle without
calibration; the two-edge path is exact only when the edges are real and
correctly labelled. The orientation path is explicitly a hint.

---

## 3. PCB and grid confidence — `perception/pcb/gridConfidence.js`

This module does two separate jobs: score a geometry hypothesis, and measure
detection quality against ground truth. All boxes and points are normalized
`0..1`. Pure functions only.

### Box metrics

- `iou(a, b)` — intersection over union of two valid boxes.
- `matchBoxes(predictions, groundTruth, { iouThreshold = 0.5 })` — greedy
  one-to-one matching by descending IoU. One prediction can match one truth
  box only, so duplicates count as false positives instead of inflating recall.
- `evaluateDetections(predictions, groundTruth, { iouThreshold = 0.5 })`
  returns:
  - `precision = matched / predictions`
  - `recall = matched / truth`
  - `f1 = 2PR / (P + R)`
  - `accuracy = 2 * matched / (predictions + truth)` — a symmetric match rate;
    duplicates and misses both lower it
  - `meanIou` over matched pairs
  - `falsePositives`, `falseNegatives`, `matches`, `unmatched*`

  With nothing to evaluate, the ratios are `null`, never a flattering `1`.

### Grid use

- `gridCellResidual(point, gridSize)` — distance from a point to the nearest
  cell centre, in cell units.
- `gridSnapScore(points, { gridSize })` — how well points land on cell centres.
- `gridLineAlignmentScore(points, { gridSize })` — how well lines follow the
  grid. Together these answer "did the model actually use the grid it was
  asked to use?"

### Board quad sanity — `boardQuadQuality(corners)`

Rejects a projected board before it is drawn:

- Requires exactly four valid points (`need-four-points`).
- Detects self-intersection / concavity (a bow-tie) via consistent cross-product
  signs and cuts the score to `0.15`.
- `score = 0.65 * areaScore + 0.35 * aspectScore`, where a sliver (high bbox
  aspect) loses points.
- `ok` also requires `area > 0.005` and a non-zero aspect.

### Component confidence — `componentConfidence(...)`

Combines independent evidence with declared weights so the number can be
explained:

| Part | Weight | Input |
| --- | --- | --- |
| similarity | 0.45 | mapped from `[-1, 1]` to `[0, 1]` |
| focus | 0.20 | `sharpness / 180`, clamped |
| presence | 0.35 | verifier output |
| position | 0.10 | from `iou`, else `1 - positionError / 0.25` (only when supplied) |

`score = Σ(weight * value) / Σ(weight)`, then `label` is `high` (`>= 0.75`),
`medium` (`>= 0.5`) or `low`. `parts` exposes each component value, so a
confidence can be audited rather than trusted.

`aggregateConfidence(scores)` returns `count/mean/median/min/max` for a set.

### Calibration — `calibrationReport(records, { bins = 10 })`

Each record is `{ confidence: 0..1, correct: 0|1 }`. Invalid records are
counted, not silently dropped.

- **Brier score** — mean of `(confidence - correct)^2`. Lower is better; a
  confident wrong answer costs more than an unsure wrong answer.
- **ECE** (expected calibration error) — bucket-weighted mean of
  `|avg confidence - accuracy|`.
- `bins` returns each bucket's `count`, `avgConfidence` and `accuracy`.

### Accuracy — `accuracyReport(records, { confidenceThreshold = 0.5, minSamples = 30 })`

- `selected` — records at or above the threshold.
- `coverage = selected / count`.
- `accuracy = correct selected / selected` (`null` when nothing is selected).
- `overallAccuracy = correct / count`.
- `brier`, `ece` from the calibration report.
- `trustworthy = count >= minSamples`.
- Empty input returns `accuracy: null`, `overallAccuracy: null`,
  `reason: 'no labelled samples'`.
- A small sample returns a number **with** `trustworthy: false` and a reason
  stating how many samples are still needed.

This is the only sanctioned way to quote an accuracy figure in this project.

### Reproducible reference selection and calibration

The shipped 305-reference compact index used an undocumented selection recipe and measured **13.72% test top-1** (`docs/KNN_EVALUATION.md`). The replacement pipeline is explicit:

- `perception/learning/ReferenceSelector.js` groups by class and selects real training samples with deterministic k-medoids. Classes at or below the budget are kept unchanged. Gross outliers are removed from the medoid candidate pool by a dense-sample rule, so a bad crop cannot become its own singleton reference.
- `perception/learning/KnnLab.js` provides class-balanced voting, optional local distance scaling, a margin rejection rule, and a distance-matrix cache so a large calibration sweep does not recompute 2,027-dimensional distances for every candidate configuration.
- Calibration always runs on **validation only**. The winning configuration is frozen, then `evaluateFrozen` / `evaluateSplit` evaluates **test once**. `scripts/eval-accuracy.mjs` enforces this split discipline and refuses to run without train, validation and test data.
- Every metric uses the shared `MEASUREMENT_MIN_SAMPLES` trust flag. A number below 30 labelled samples is reported with `trustworthy: false` and is not a field-accuracy claim.
- Class-balanced voting and local scaling remain **off by default at runtime** until measured data shows they improve a frozen test result. They are laboratory options, not silent behaviour changes.

Synthetic fixtures prove the maths and the failure modes. They do not prove component accuracy on photographs, and the ≥85% target remains unclaimed.

### PWA camera constraints and torch

`pwa/camera.js` is pure and testable without a phone:

- `buildCameraConstraintLadder` tries the selected device at full resolution, then 720p, then any resolution, then the rear camera at two sizes, then any camera. A stale saved `deviceId` is cleared when a generic step succeeds.
- `openCameraWithFallback` retries only constraint / missing-device / `TypeError` failures. A denied permission or busy camera aborts immediately; retrying cannot fix those.
- `cameraCapabilities` reports torch, a usable zoom range and continuous-focus support from `getCapabilities`/`getSettings`. `setTorch` and `setZoom` return `{ applied: false }` instead of throwing at the UI; zoom is clamped and snapped to the hardware step.
- GitHub Pages is HTTPS and therefore a secure context, so the installed PWA camera works. The restriction is only for a plain `http://192.168.x.x` LAN page.
- These are mocked tests. They do not prove that a specific Android or iOS camera exposes torch/zoom or produces a usable frame; that needs hardware.

---

## 4. How to measure accuracy honestly

Do this on hardware you actually have, with labels you trust:

1. **Define the unit.** One row = one component: its ground-truth box, the
   prediction, and whether the predicted identity is correct. Decide the IoU
   threshold up front (0.5 is the default here).
2. **Capture across conditions.** Bright, dim, backlit and uneven light; a few
   camera distances; board held flat and slightly angled. Record the condition
   so a bad result can be attributed.
3. **Label blind.** Do not look at the prediction while drawing the truth box.
4. **Run the metric, not the eye.**
   - Boxes: `evaluateDetections(predictions, truth)`.
   - Identity + confidence: build `{ confidence, correct }` records and call
     `accuracyReport` and `calibrationReport`.
5. **Report the sample count, threshold, split, date and conditions.** A number
   without those is not a result.
6. **Refuse to quote under 30 samples.** The code will still compute it; it
   will also tell you not to trust it. Believe the flag.

### Component-accuracy target

The project's target is **≥ 85% overall component accuracy**, measured as in
step 4. That figure is **not claimed** here or in the README, because the
labelled sample set does not exist in this repository and no physical hardware
run has been performed. Synthetic fixtures prove the maths and the failure
modes; they do not prove field accuracy.

---

## 5. Current status

| Area | Implemented | Proven where |
| --- | --- | --- |
| Lighting measurement and bounded repair | Yes | `adaptivePreprocess.test.js` (synthetic frames) |
| Hinge geometry, smoothing, loss/reacquisition | Yes | `HingeTracker.test.js` (synthetic edges) |
| Hinge from a raw frame | Yes, as a coarse hint | `HingeTracker.test.js` (synthetic gradients) |
| IoU, matching, precision/recall/F1/accuracy | Yes | `gridConfidence.test.js` |
| Grid snap / line alignment | Yes | `gridConfidence.test.js` |
| Board quad rejection | Yes | `gridConfidence.test.js` |
| Component confidence + aggregation | Yes | `gridConfidence.test.js` |
| Brier / ECE / accuracy honesty rule | Yes | `gridConfidence.test.js` |
| Deterministic medoid reference selection | Yes | `referenceSelector.test.js` (synthetic) |
| Validation-only calibration + frozen test evaluation | Yes | `knnLab.test.js`, `scripts/eval-accuracy.mjs` |
| Camera fallback ladder + torch/zoom capabilities | Yes | `pwa/camera.test.js` (mocked) |
| Physical phone / laptop hinge / PCB accuracy | **No** | Needs hardware |

What still needs hardware validation:

- phone camera capture and gallery upload on real devices,
- the hinge tracker on a real laptop and a real hinged case,
- PCB component identification against labelled boards,
- the ≥ 85% target itself.

`docs/DEVICE_TEST_CHECKLIST.md` lists the manual checks.
