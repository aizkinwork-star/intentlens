# IntentLens — Phase 6.1: Classification Accuracy Improvement Research

## 1. Root causes of current classification errors

### Primary causes (ranked by impact)

1. **Visually similar small passive components.** Resistors, diodes, capacitors, and inductors share similar shapes (rectangular/cylindrical) and differ mainly by color bands or markings that are often illegible at typical camera distances. The worst 5 classes are all small passives.

2. **Feature dimensionality without spatial localization.** HOG uses 64x64 resize, destroying fine details (color bands on resistors). The 1,791-dim vector is dominated by HOG (1,764 dims), making color/shape features (27 dims) relatively weak.

3. **No color standardization.** HSV histogram uses raw HSV values. Different lighting conditions shift hue/saturation significantly.

4. **Class imbalance.** Class counts range from 153 to 312 (2x variation). Rare classes have fewer training examples, reducing k-NN coverage.

5. **Near-duplicate clusters.** 23 clusters within training may cause k-NN to over-rely on memorized examples.

6. **No distance normalization.** Raw Euclidean distance on high-dimensional features is dominated by HOG magnitude.

### Error distribution
- Best classes (accuracy >= 0.80): 5 (Heat-Sink, OLED-Display, Soil-Moisture-Sensor, Rocker-Switch, Keypad)
- Worst classes (accuracy < 0.30): 12 (TCRT5000, Taper-Potentiometer, DC-Motor, IC-Base-14-Pin, Fuse-Base, 1-5-Volt-Battery, ESP32-CAM, Bridge-Rectifier, Inductor, Servo-Motor, Capacitor-10mf, Zener-Diode)
- Overall: 51.57% accuracy, 0.5490 macro F1, 5.69% rejection rate

### Component family grouping
| Family | Classes | Avg accuracy |
|---|---|---|
| Large modules (Arduino, ESP, GSM) | ~8 | ~0.55 |
| Displays (LCD, OLED, 7-Segment) | ~4 | ~0.75 |
| Passive components (R, C, L, D) | ~15 | ~0.30 |
| Sensors | ~10 | ~0.60 |
| Switches/Connectors | ~8 | ~0.75 |
| Motors/Actuators | ~6 | ~0.35 |

Passive components are the primary source of errors.

---

## 2. Recommended feature improvements

### A. Local Binary Patterns (LBP)
- **Benefit:** Captures local texture patterns (surface finish, markings) that HOG misses. Good for distinguishing component types by surface texture.
- **Cost:** Low. 256-dim histogram, O(n) computation.
- **JS compatibility:** Easy. Standard LBP is a simple per-pixel comparison.
- **Expected improvement:** +5-10% on passive components.

### B. Multi-scale HOG
- **Benefit:** Current HOG uses 64x64 resize, losing fine details. Multi-scale (32x32, 64x64, 128x128) captures both coarse and fine structure.
- **Cost:** Medium. 3x HOG computation.
- **JS compatibility:** Moderate. Need to resize and compute HOG at multiple scales.
- **Expected improvement:** +3-5%.

### C. Improved color descriptors
- **Benefit:** Current HSV histogram is coarse (16 bins). Better: color moments (mean, std, skewness) per channel, or dominant color extraction.
- **Cost:** Low.
- **JS compatibility:** Easy.
- **Expected improvement:** +2-4% (color is important for component identification).

### D. Edge density
- **Benefit:** Ratio of edge pixels to total pixels. Distinguishes dense (IC) from sparse (resistor) components.
- **Cost:** Low (Canny edge count).
- **JS compatibility:** Easy with OpenCV.js.
- **Expected improvement:** +1-2%.

### E. Improved contour descriptors
- **Benefit:** Current shape descriptors are basic (solidity, extent). Better: Fourier descriptors, Zernike moments, or contour chain code histograms.
- **Cost:** Medium.
- **JS compatibility:** Moderate (need contour extraction).
- **Expected improvement:** +3-5%.

### F. OCR / component markings
- **Benefit:** Component values (e.g., "10K", "100nF") are printed on many components. OCR would provide definitive identification.
- **Cost:** High. Requires Tesseract.js or similar (~5MB library).
- **JS compatibility:** Possible but heavy.
- **Expected improvement:** +10-20% on marked components. Not all components have markings.

### Recommended priority order
1. Improved color descriptors (low cost, easy)
2. LBP (low cost, easy)
3. Edge density (low cost, easy)
4. Multi-scale HOG (medium cost)
5. Improved contour descriptors (medium cost)
6. OCR (high cost, deferred)

---

## 3. Proposed hierarchical classifier architecture

### Stage 1: Family classification
Broad families: Passive, IC, Sensor, Display, Module, Switch, Motor, Connector

### Stage 2: Within-family classification
- Passive: Resistor, Capacitor, Diode, Inductor, LED, etc.
- IC: IC-Chip, IC-Base-14-Pin, IC-Base-28-Pin
- etc.

### Challenges
- Family boundaries are fuzzy (e.g., is a "Push-Switch" a switch or a connector?).
- Some families have only 1-2 classes (no benefit from hierarchy).
- Hierarchical errors compound: if Stage 1 misclassifies, Stage 2 can't recover.

### Expected benefit
- Reduces the number of classes per decision (61 → ~8 families, then ~8 within family).
- May improve accuracy by 5-10% if family classification is reliable.
- Risk: family misclassification cascades.

### Classes that cannot be reliably separated visually
- Resistor vs. Capacitor (similar cylindrical shape, different color bands)
- Diode vs. Zener-Diode (identical except markings)
- Inductor vs. Capacitor (similar shape, different function)
- Various capacitor subtypes (10mf, 470mf, ceramic, film, MLC, low-voltage, high-voltage)

---

## 4. Dataset improvements

### Current issues
- **Class imbalance:** 153-312 samples per class (2x variation).
- **Near-duplicates:** 23 clusters within training split.
- **Visual diversity:** Unknown (need to check orientations, lighting, backgrounds).
- **Isolated vs. PCB-mounted:** Dataset appears to be isolated component photos on various backgrounds. Live inference will see components on PCBs, which looks different.

### Recommendations
1. **Collect 50+ examples per weak class** (especially passives).
2. **Capture multiple orientations** (0°, 45°, 90°, 135°).
3. **Vary lighting** (warm, cool, bright, dim).
4. **Include PCB-mounted examples** (components soldered on boards).
5. **Capture at different distances** (close-up, mid-range).
6. **Remove or flag near-duplicates** before training.

### Targeted collection for weak classes
| Weak class | Current count | Target | Priority |
|---|---|---|---|
| TCRT5000 | ~153 | 300+ | High |
| Taper-Potentiometer | ~153 | 300+ | High |
| Fuse-Base | ~153 | 300+ | High |
| 1-5-Volt-Battery | ~153 | 300+ | Medium |
| ESP32-CAM | ~153 | 300+ | Medium |
| Bridge-Rectifier | ~153 | 300+ | Medium |

---

## 5. Experimental cost and complexity

| Experiment | Effort | Risk | Expected gain |
|---|---|---|---|
| Improved color descriptors | 1-2 days | Low | +2-4% |
| LBP | 1-2 days | Low | +5-10% |
| Edge density | 0.5 days | Low | +1-2% |
| Multi-scale HOG | 2-3 days | Medium | +3-5% |
| Improved contours | 2-3 days | Medium | +3-5% |
| Hierarchical classification | 3-5 days | Medium | +5-10% |
| OCR | 5-7 days | High | +10-20% |

### Minimal experiment to determine if improvement is possible
1. Implement improved color descriptors + LBP + edge density (3 features, ~3 days).
2. Re-run k-NN evaluation on validation set.
3. If accuracy improves by >5%, proceed with more features.
4. If not, investigate dataset quality issues.

---

## 6. Expected benefits (not measured)

| Change | Expected improvement | Confidence |
|---|---|---|
| LBP | +5-10% | Medium |
| Improved color | +2-4% | High |
| Edge density | +1-2% | High |
| Multi-scale HOG | +3-5% | Medium |
| Hierarchical | +5-10% | Medium |
| OCR | +10-20% | Low (not all components have markings) |
| Better dataset | +5-15% | High |
| **Combined (optimistic)** | **+20-40%** | **Low** |
| **Realistic target** | **+10-20%** | **Medium** |

80% accuracy is unlikely without OCR and a significantly larger, more diverse dataset.

---

## 7. Recommended implementation order

1. **Improved color descriptors** (1 day) — Low risk, easy win.
2. **LBP** (1-2 days) — Low risk, good texture capture.
3. **Edge density** (0.5 days) — Trivial.
4. **Re-evaluate** on validation set. If improvement >5%, continue.
5. **Multi-scale HOG** (2-3 days) — Medium risk.
6. **Improved contours** (2-3 days) — Medium risk.
7. **Re-evaluate** on validation set.
8. **Hierarchical classification** (3-5 days) — Only if family classification is reliable.
9. **OCR** (5-7 days) — Only if markings are present on target components.
10. **Dataset expansion** (ongoing) — Collect more diverse examples.

---

## 8. Minimal experiment

**Objective:** Determine if feature improvements can meaningfully improve accuracy.

**Steps:**
1. Implement LBP (256-dim), improved color descriptors (9-dim: mean/std/skew per RGB channel), edge density (1-dim).
2. Append to existing 1,791-dim feature vector → ~2,057-dim.
3. Fit scaler on training set.
4. Evaluate k=3 weighted on validation set.
5. Compare to baseline (51.42% validation accuracy).

**Success criterion:** >5% improvement on validation set.

**If successful:** Proceed with multi-scale HOG and improved contours.
**If not:** Investigate dataset quality (lighting, backgrounds, near-duplicates).

**Estimated effort:** 2-3 days.
**No production changes required.** All experiments run in isolation on the validation set.