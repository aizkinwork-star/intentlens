# Component recognition

IntentLens identifies Electronic components on a captured still with a **local,
measured classifier** trained on the ElectroCom61 dataset. Recognition is a
candidate source, not a verdict: the identity shown to the user is still an AI
candidate that the user can confirm or correct.

This page records what was measured, how to reproduce it, and what the numbers
do **not** prove.

---

## Measured results

| Path | Accuracy | Labeled samples | Notes |
| --- | --- | --- | --- |
| Offline evaluation (scikit-learn, frozen head) | **94.15%** | 1,283 test crops | Held-out dataset split, never seen in training |
| Shipped runtime (JS preprocessing + `onnxruntime-web`) | **93.00%** (279/300) | 300 held-out crops | Same crops and preprocessing the app uses |
| Validation split (scikit-learn) | 94.30% | — | Cross-check that the split is not lucky |

Both numbers are above the 90% project target. The runtime number is the one to
quote for "how often does the app get the component right", because it runs the
exact image pipeline that ships.

The dataset audit found 2,071 images, 12,667 annotations and 61 classes with no
missing labels, no empty labels, no duplicate images and no degenerate boxes
(`datasets/processed/audit.md`).

## What the classifier is

- **Backbone:** ImageNet-pretrained ResNet-18, frozen.
- **Head:** multinomial logistic regression on the 512-d embedding.
- **Input:** 224×224 RGB, per-channel mean `[0.485, 0.456, 0.406]` and std
  `[0.229, 0.224, 0.225]`.
- **Export:** backbone + head folded into one ONNX graph (`image` →
  `logits`), `[1,3,224,224]` → `[1,61]`.
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

# 2. Train the classifier (ResNet-18 embeddings + logistic regression)
python scripts/train_cnn_classifier.py

# 3. Fold backbone + head into one ONNX graph
python scripts/export_classifier_onnx.py

# 4. Export the held-out test crops the runtime will be judged on
python scripts/export_test_crops.py

# 5. End-to-end runtime accuracy (JS preprocessing + onnxruntime-web)
node scripts/eval-runtime-accuracy.mjs --limit 300 --min 0.85
```

Step 5 is also wired as a gate:

```powershell
npm run test:accuracy   # fails below 85%
```

`node scripts/run-source-tests.mjs` includes `accuracyGate.test.js`, which checks
that any recorded measurement has at least 30 labeled samples and clears the
gates. When the artifacts are absent the test skips with a reason rather than
claiming a number it did not measure.

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
