# Component recognition

IntentLens identifies Electronic components on a captured still with a **local,
measured classifier** trained on the ElectroCom61 dataset. Recognition is a
candidate source, not a verdict: the identity shown to the user is still an AI
candidate that the user can confirm or correct.

This page records what was measured, how to reproduce it, and what the numbers
do **not** prove.

---

## Measured results

The current model is a ResNet-18 whose last block (`layer4`) and classifier were
fine-tuned on ElectroCom61 with the lighting and rotation augmentation the device
sees. Accuracy is reported per lighting stage, because "works in a dim room" was
the original failure. Each stage dims every pixel toward black by the listed
opacity factor (`clean` 1.0, `slight` 0.75, `medium` 0.50, `low` 0.30); rotation
is part of training only, so these stage numbers isolate lighting.

Held-out test split, 1,283 labelled crops (offline, PyTorch preprocessing):

| Stage | Opacity | Accuracy | Classes below 90% | Worst class recall |
| --- | --- | --- | --- | --- |
| clean | 1.00 | **97.51%** | 6 of 61 | 83.3% (`Resistor`) |
| slight | 0.75 | **97.82%** | 3 of 61 | 86.4% (`IC-Base-14-Pin`) |
| medium | 0.50 | **97.43%** | 5 of 61 | 86.4% |
| low | 0.30 | **97.04%** | 7 of 61 | 86.4% |

Shipped runtime path (JavaScript preprocessing + `onnxruntime-web`, 300 held-out
crops exported for the app):

| Stage | Opacity | Accuracy | ms/crop |
| --- | --- | --- | --- |
| clean | 1.00 | **97.33%** (292/300) | ~490 |
| slight | 0.75 | **97.67%** (293/300) | |
| medium | 0.50 | **97.33%** (292/300) | |
| low | 0.30 | **97.33%** (292/300) | |

The runtime number is the one to quote for "how often does the app get the
component right", because it runs the exact image pipeline that ships.

**What this does and does not prove.** Overall accuracy clears 90% at every
lighting stage, and by a wide margin. Per-class accuracy (≥90% for *every one of
the 61 classes*) is **not** fully met: 3–7 classes sit at 83–89% on the 1,283-crop
test split, and 6–7 classes on the 300-crop runtime set. Those shortfalls are
mostly one or two errors with tiny support (some classes have only 9 test crops,
so a single error puts them at 88.9%). The shortfall list is recorded in
`report.json` (`classesBelow90`) and in `runtime_accuracy.json`
(`stages.<stage>.classesBelowList`) rather than hidden behind the average. The
strongest remaining confusions are `Resistor → Diode`/`Zener-Diode` and
`IC-Base-14-Pin → IC-Chip`; both are visually plausible at this crop resolution.

Validation (capped at 8 crops/class during training, 488 crops/stage) reached
**96.52%** clean and **96.72%** medium; the full validation split measured
97.61% / 97.73%. The epoch was chosen on validation only; the test split was
evaluated once.

The dataset audit found 2,071 images, 12,667 annotations and 61 classes with no
missing labels, no empty labels, no duplicate images and no degenerate boxes
(`datasets/processed/audit.md`). A separate check found no duplicate images and no
shared base stems across the train/valid/test splits, so the held-out numbers are
not inflated by leakage.

## What the classifier is

- **Backbone:** ImageNet-pretrained ResNet-18.
- **Fine-tuning:** `layer4` + classifier head only; earlier blocks stay frozen and
  BatchNorm statistics stay at their ImageNet values.
- **Training augmentation:** brightness/opacity sampled uniformly in `[0.30, 1.0]`
  (blend toward black, matching dim lighting), rotation uniformly in `±3°`,
  label smoothing `0.05`. AdamW, 6 epochs, early stopping on a clean+medium
  validation mix.
- **Input:** 224×224 RGB, per-channel mean `[0.485, 0.456, 0.406]` and std
  `[0.229, 0.224, 0.225]`.
- **Export:** backbone + head in one ONNX graph (`image` → `logits`),
  `[1,3,224,224]` → `[1,61]`, opset 17.
- **Classes:** the 61 ElectroCom61 component names from the dataset, stored in
  `classifier.json` so the prompt vocabulary cannot drift from the model.

The recogniser is exposed in two places:

- `perception/learning/OnnxComponentClassifier.js` — runtime inference.
- `server/services/componentRecognizer.js` — server-side lazy loader used by
  `GET /api/recognizer/status` and `POST /api/recognizer/classify`.
- `server/routes/recognizer.js` — no provider key, no network, no image leaves
  the machine.

When the model files are missing the API returns `available: false` with a
reason. It never falls back to a weaker guess.

## Reproduce

The dataset, crops and model artifacts are gitignored (they are large and are
not source). To rebuild them locally:

```powershell
# 1. Dataset audit (fast, CPU only)
python scripts/audit_dataset.py

# 2. Fine-tune layer4 + head with the lighting/rotation augmentation
python scripts/train_finetune_classifier.py `
  --root "datasets/ElectroCom61 A Multiclass Dataset for Detection of Electronic Components/ElectroCom61" `
  --out datasets/processed/cnn_resnet18_finetuned_v1 --epochs 6 --threads 2

# 3. Export the fine-tuned state dict to one ONNX graph + classifier.json
python scripts/export_finetuned_onnx.py `
  --report datasets/processed/cnn_resnet18_finetuned_v1/report.json `
  --state datasets/processed/cnn_resnet18_finetuned_v1/finetuned_state.pt `
  --out datasets/processed/cnn_resnet18_finetuned_v1

# 4. Export the held-out test crops the runtime will be judged on
python scripts/export_test_crops.py

# 5. End-to-end runtime accuracy per lighting stage (JS preprocessing + onnxruntime-web)
node scripts/eval-runtime-accuracy.mjs --min 0.90 --min-stage 0.90 --min-class 0.90
```

Step 5 is also wired as a gate:

```powershell
npm run test:accuracy   # fails below 90% overall or at any lighting stage
```

The cheaper frozen-embedding + logistic-regression baseline remains available
(`scripts/train_robust_classifier.py` → `scripts/export_classifier_onnx.py`) and
is used automatically when the fine-tuned artifacts are absent:
`server/services/componentRecognizer.js` and the evaluation scripts prefer
`cnn_resnet18_finetuned_v1`, then `cnn_resnet18_robust_v1`, then
`cnn_resnet18_v1`. All three share the same ONNX contract.

`node scripts/run-source-tests.mjs` includes `accuracyGate.test.js`, which checks
that any recorded measurement has at least 30 labeled samples, that overall and
per-stage accuracy clear 90%, and that the per-class shortfall list matches the
stage summary. When the artifacts are absent the test skips with a reason rather
than claiming a number it did not measure.

## How the result is used

1. The client crops the region to classify (centre crop in the camera workflow,
   or the selected region in the screenshot workflow).
2. The crop is sent as PNG to `/api/recognizer/classify`.
3. The top-k names and probabilities are passed to the prompt as
   **unverified candidates**, alongside a confidence-aware vocabulary of the
   dataset's classes.
4. The vision provider reasons from the image and the candidates. It must not
   treat a local candidate as a fact, and the UI labels it as an AI candidate
   until the user confirms.

A confidence margin of `0.10` is stored in `classifier.json`; low-margin results
are reported as uncertain rather than promoted to a label.

## Limitations

- **Per-class accuracy is not yet universal.** Overall and per-stage accuracy
  clear 90%, but 3–7 of 61 classes remain below 90% on held-out crops (worst
  ~83%). Those classes are named in the generated reports; treat a prediction for
  one of them as more uncertain.
- **Classification only.** The classifier answers "which component is in this
  crop". It does not produce masks, pin numbers, polarity, ratings or board
  regions. Guidance that depends on those still needs the vision provider and,
  ideally, a labelled set the project does not have yet.
- **Domain shift.** ElectroCom61 is a curated dataset. Blur, glare, extreme
  close-ups and unusual packages can still be misclassified; the runtime accuracy
  above is measured on held-out dataset crops, not on arbitrary user photos.
- **61 classes.** A part outside the dataset vocabulary must be reported as
  unknown, not forced into the nearest class.
- **No hosted SAM dependency.** The hosted segmentation path (Replicate
  `meta/sam-2`) is optional and separate. SAM produces masks, not identities; it
  has not been live-tested here because no Replicate token is configured.

## Dataset licence

ElectroCom61 v5 (Roboflow), CC BY 4.0. The dataset URL and per-class counts are
recorded in `datasets/processed/audit.json`.
