# Compact k-NN evaluation (305 references)

Measured on 2026-11-02 against the existing held-out feature splits. The test split
was evaluated once with the configuration frozen on validation; it was not used to
tune anything.

## Data

| Split | Samples | Role |
|---|---:|---|
| Train annotations | 8,877 | Source of the large reference DB; compact refs are drawn from train |
| Validation | 2,507 | Threshold / k selection only |
| Test | 1,283 | Single final evaluation |

- 61 classes.
- Compact runtime DB: **305 references**, exactly **5 per class**.
- Large reference DB used for comparison: **8,877 references**, 105–221 per class
  (mean 145.5).
- Feature schema: **2,027 dimensions**, feature version 4.0.
- No feature-identical overlap was found between the compact references and the
  validation or test vectors, so there is no direct sample leakage.
- The repository does not contain the script that selected the 305 compact references.
  Their provenance is the train split, but the exact selection recipe is not
  reproducible from source.

## Shipped configuration: k=3, maxDist=50.6, separation=1.5

| Split | Overall accuracy | Accepted predictions | Accepted accuracy | Unknown rate |
|---|---:|---:|---:|---:|
| Validation | 0.56% (14/2,507) | 36 | 38.89% | **98.56%** |
| Test | 0.86% (11/1,283) | 29 | 37.93% | **97.74%** |

Under the shipped threshold the classifier almost never answers, and when it does
answer it is wrong about 62% of the time. On the test split, **51 of 61 classes never
receive an accepted prediction**.

The 50.6 threshold was calibrated against the dense 8,877-reference DB. It does not
transfer to five references per class: the median nearest-neighbour distance is
**56.05** on test, above the rejection threshold.

## Validation-only calibration

The calibration sweep tried k = 1/3/5/7, maxDist = 30–100, and separation = 1.0–2.0 on
validation only. The coverage-aware winner was:

- **k = 1**
- **maxDist = 80.0**
- **separation = 1.0**
- Validation: 12.80% accuracy, 99.96% accepted, macro F1 0.1322.

Frozen and evaluated once on test:

| Metric | Test value |
|---|---:|
| Overall accuracy | **13.72%** (176/1,283) |
| Accepted predictions | 1,283 (100%) |
| Accepted accuracy | 13.72% |
| Unknown rate | 0% |
| Macro precision | 22.80% |
| Macro recall | 13.31% |
| Macro F1 | **13.55%** |
| Median per-class recall | 11.11% |

Eleven classes have **zero recall** on test: Fuse-Base, Taper-Potentiometer,
Arduino-Nano, DC-Motor, 9-Volt-Battery, Servo-Motor, FT-232-USB-Serial-Module, Fuse,
Trimmer-Potentiometer, IGBT, and Tact-Switch.

There is no useful high-precision operating point either. On validation, k=1 with
maxDist=45 accepted only 0.8% of samples, and accepted accuracy was 52.6%. That is
better than chance but too little coverage to drive a tracking workflow.

## Comparison with the large reference DB

Same features, same Euclidean/weighted-vote classifier, same splits:

| Reference DB | Config | Test overall accuracy | Test accepted accuracy | Test unknown rate |
|---|---|---:|---:|---:|
| 8,877 refs | k=3, always answer | **52.69%** | 52.81% | 0.23% |
| 8,877 refs | k=1, always answer | **53.78%** | 53.78% | 0% |
| 8,877 refs | k=3, maxDist=50.6 | 29.77% | 72.90% | 59.16% |
| 305 refs | k=1, always answer | **13.72%** | 13.72% | 0% |
| 305 refs | k=3, maxDist=50.6 | **0.86%** | 37.93% | 97.74% |

The large DB reproduces the project's earlier ~51–52% top-1 accuracy claim. The
compact DB loses roughly **39 percentage points** of top-1 accuracy. This is not a
threshold artefact; it persists when both systems are allowed to answer every frame.

## Interpretation

Five references per class are not enough to represent the intra-class variation in
ElectroCom61 (lighting, scale, rotation, background, crop boxes, and visually similar
parts). The current compact DB should be treated as a readiness/indexing demo, not as
a reliable component recognizer.

Do **not** build higher-level reasoning or electrical guidance on top of these labels.
Keep the existing "candidate, not verified fact" UI semantics.

## Recommended next step

Before any feature work:

1. Rebuild the reference set from train with a recorded, reproducible selection
   strategy (for example, class-stratified medoids or k-means centroids rather than
   arbitrary first/random samples).
2. Calibrate k / maxDist / separation on validation only, freeze it, then run test once.
3. Target a defensible operating point such as accepted accuracy ≥ 80% at ≥ 50%
   coverage, or document honestly that local recognition is not ready.
4. Until that passes, keep local classification advisory and require user confirmation.

## Reproduce

```bash
python scripts/eval_compact_knn.py     # compact DB, validation calibration + test
python scripts/eval_full_reference.py  # 8,877-ref comparison, single test evaluation
```

Outputs:

- `datasets/processed/compact_eval.json`
- `datasets/processed/full_db_eval.json`
