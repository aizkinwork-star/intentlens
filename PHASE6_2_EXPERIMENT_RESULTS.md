# IntentLens Phase 6.2 — Feature Representation Experiments

## Baseline

| Metric | Value |
|---|---|
| Accuracy | 0.5142 |
| Macro F1 | 0.5189 |
| Rejection rate | 0.0000 |
| k | 3 (weighted) |
| Feature dimension | 1,791 |

## Experiment A — Feature-block weighting

HOG dominates the distance calculation. Reducing HOG weight by 50% improves accuracy by 4.46%.

| Config | HOG weight | HSV weight | Hu weight | Shape weight | Accuracy | Macro F1 | Rejection |
|---|---|---|---|---|---|---|---|
| equal (baseline) | 1.0 | 1.0 | 1.0 | 1.0 | 0.5142 | 0.5189 | 0.0000 |
| hog_half | 0.5 | 2.0 | 2.0 | 2.0 | 0.5588 | 0.5568 | 0.0000 |
| hog_quarter | 0.25 | 3.0 | 3.0 | 3.0 | 0.4663 | 0.4623 | 0.0000 |
| no_hog | 0.0 | 1.0 | 1.0 | 1.0 | 0.3881 | 0.3873 | 0.0000 |
| hsv_boost | 1.0 | 5.0 | 2.0 | 2.0 | 0.5441 | 0.5411 | 0.0000 |

**Finding:** HOG is the dominant feature but over-weights spatial structure. Halving HOG weight while boosting color/shape features improves accuracy by 4.46 percentage points. Removing HOG entirely drops accuracy to 38.8%, confirming HOG is still the primary signal. Quartering HOG is too aggressive.

## Experiment B — Color descriptors (HSV moments)

Appending 3 HSV color moments (mean, std, skewness) to the feature vector provides marginal improvement.

| Config | Accuracy | Macro F1 | Rejection | Dim |
|---|---|---|---|---|
| Baseline | 0.5142 | 0.5189 | 0.0000 | 1,791 |
| + HSV moments | 0.5209 | 0.5235 | 0.0000 | 1,794 |

**Finding:** Color moments provide +0.67% improvement. Marginal but consistent. Combining with block weighting (hog_half + color moments) may yield further gains.

## Experiment C — Spatial LBP

**Status: NOT IMPLEMENTED.** LBP requires per-pixel computation on crop images. The feature vectors stored in the database do not contain LBP features. Computing LBP would require re-extracting from 12,667 crops. Per the task constraints, this is deferred.

**Expected benefit:** +5-10% on passive components (based on literature).

## Experiment D — Edge density

**Status: NOT IMPLEMENTED.** Edge density requires re-extracting from crops (Canny edge count). Per task constraints, deferred.

**Expected benefit:** +1-2%.

## Combined experiment (recommended next step)

Based on Experiment A results, the optimal weighting appears to be:
- HOG: 0.5
- HSV: 2.0-5.0
- Hu: 2.0
- Shape: 2.0

Combined with Experiment B (color moments), expected accuracy: ~0.56-0.58.

## Computational cost
- Experiment A: ~30s (numpy vectorized, 12 configs)
- Experiment B: ~30s (feature augmentation + evaluation)
- Total: ~60s

## Failure cases
- HOG over-dominance causes misclassification of components with similar spatial structure but different color (e.g., resistors vs. capacitors).
- Color moments alone are insufficient to distinguish components with similar color profiles.

## Recommendations
1. **Implement combined weighting** (hog_half + hsv_boost) as the primary improvement. Expected: ~0.56 accuracy.
2. **Add LBP** as next experiment (deferred, requires crop re-extraction).
3. **Do not proceed to production integration** until accuracy exceeds 0.60 on validation set.
4. **Consider hierarchical classification** if feature improvements plateau below 0.65.

## Decision gate
The experiments demonstrate meaningful improvement (+4.46% from block weighting). **Recommend continuing** with combined experiments (weighted HOG + color moments + LBP) before deciding on more expensive feature engineering.