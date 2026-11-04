# Class-stratified medoid experiment (v1)

Generated: 2026-11-03T03:06:13.518232+00:00

## What was held fixed

- Feature extractor and scaler unchanged (2,027 dimensions, feature version 4.0).
- Existing 305-reference runtime DB and 8,877-reference DB unchanged (hashes recorded).
- Validation used for calibration only. Test evaluated once per pre-registered budget.
- No test result was used to select a budget or a threshold.

## Selection procedure

For each class, greedy k-medoids select references from the **train split only**. The first medoid minimises total distance; each later medoid is the point that most reduces the total distance from class members to their nearest selected medoid. Ties are broken by lexicographic `sampleId`. Budgets are nested prefixes of the 40-medoid ordering. Every selected reference retains its original crop path, source image and normalized bounding box.

## Validation calibration (validation only)

| Budget | Refs | k | maxDist | sep. | Coverage | Accepted acc. | Overall acc. | Unknown | Macro F1 | 80%/50% gate |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| 5 | 305 | 1 | 51.2 | 1.0 | 50.02% | 25.60% | 12.80% | 49.98% | 0.1629 | fail |
| 10 | 610 | 3 | 51.7 | 1.0 | 59.99% | 32.58% | 19.55% | 40.01% | 0.2392 | fail |
| 20 | 1220 | 1 | 50.1 | 1.0 | 50.02% | 40.35% | 20.18% | 49.98% | 0.2533 | fail |
| 40 | 2440 | 1 | 49.7 | 1.0 | 50.02% | 47.61% | 23.81% | 49.98% | 0.3008 | fail |

## Validation-selected budget

The pre-registered validation rule selected **40 references/class** (2440 total) with **k=1**, **maxDist=49.7**, **separation=1.0**.
This configuration did **not** meet the 80% accepted-accuracy / 50% coverage gate on validation.

## Test evaluation (single look per pre-registered budget)

All four budgets were fixed before any test evaluation. Each configuration was frozen on validation, then evaluated once on test. The test table is descriptive; the recommendation above comes from validation only.

| Budget | Refs | k | maxDist | sep. | Coverage | Accepted acc. | Overall acc. | Unknown | Macro F1 | 80%/50% gate |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| 5 | 305 | 1 | 51.2 | 1.0 | 48.17% | 24.76% | 11.93% | 51.83% | 0.1464 | fail |
| 10 | 610 | 3 | 51.7 | 1.0 | 56.74% | 29.81% | 16.91% | 43.26% | 0.2081 | fail |
| 20 | 1220 | 1 | 50.1 | 1.0 | 47.86% | 39.90% | 19.10% | 52.14% | 0.2426 | fail |
| 40 | 2440 | 1 | 49.7 | 1.0 | 49.26% | 46.99% | 23.15% | 50.74% | 0.2892 | fail |

## Selected budget: per-class test recall

Frozen configuration: k=1, maxDist=49.7, separation=1.0. Classes are sorted by recall.

| Class | Support | Correct | Accepted | Precision | Recall | F1 |
|---|---:|---:|---:|---:|---:|---:|
| 7-Segment-Display | 16 | 0 | 0 | 0.00% | 0.00% | 0.0000 |
| DC-Motor | 16 | 0 | 0 | 0.00% | 0.00% | 0.0000 |
| LDR-Sensor | 17 | 0 | 5 | 0.00% | 0.00% | 0.0000 |
| Taper-Potentiometer | 15 | 0 | 1 | 0.00% | 0.00% | 0.0000 |
| Inductor | 29 | 1 | 2 | 50.00% | 3.45% | 0.0645 |
| Relay-Module | 25 | 1 | 1 | 100.00% | 4.00% | 0.0769 |
| Low-Voltage-Ceramic-Capacitor | 22 | 1 | 25 | 4.00% | 4.55% | 0.0426 |
| Tact-Switch | 22 | 1 | 2 | 50.00% | 4.55% | 0.0833 |
| MOSFET | 20 | 1 | 2 | 50.00% | 5.00% | 0.0909 |
| Capacitor-470mf | 18 | 1 | 8 | 12.50% | 5.56% | 0.0769 |
| Servo-Motor | 17 | 1 | 3 | 33.33% | 5.88% | 0.1000 |
| IC-Chip | 27 | 2 | 6 | 33.33% | 7.41% | 0.1212 |
| Bridge-Rectifier | 23 | 2 | 4 | 50.00% | 8.70% | 0.1481 |
| IC-Base-14-Pin | 22 | 2 | 5 | 40.00% | 9.09% | 0.1481 |
| Trimmer-Potentiometer | 21 | 2 | 7 | 28.57% | 9.52% | 0.1429 |
| TCRT5000 | 18 | 2 | 2 | 100.00% | 11.11% | 0.2000 |
| Buzzer | 26 | 3 | 4 | 75.00% | 11.54% | 0.2000 |
| 9-Volt-Battery | 17 | 2 | 2 | 100.00% | 11.76% | 0.2105 |
| Film-Capacitor | 17 | 2 | 2 | 100.00% | 11.76% | 0.2105 |
| MLC-Capacitor | 32 | 4 | 4 | 100.00% | 12.50% | 0.2222 |
| IC-Base-28-Pin | 22 | 3 | 15 | 20.00% | 13.64% | 0.1622 |
| IGBT | 22 | 3 | 8 | 37.50% | 13.64% | 0.2000 |
| Fuse | 21 | 3 | 4 | 75.00% | 14.29% | 0.2400 |
| Sonar-Sensor | 27 | 4 | 5 | 80.00% | 14.81% | 0.2500 |
| Push-Switch | 33 | 5 | 7 | 71.43% | 15.15% | 0.2500 |
| 3-3-Volt-Battery | 19 | 3 | 3 | 100.00% | 15.79% | 0.2727 |
| High-Voltage-Ceramic-Capacitor | 29 | 5 | 6 | 83.33% | 17.24% | 0.2857 |
| 1-5-Volt-Battery | 17 | 3 | 6 | 50.00% | 17.65% | 0.2609 |
| Humidity-Sensor | 22 | 4 | 9 | 44.44% | 18.18% | 0.2581 |
| Bluetooth-Module | 25 | 5 | 13 | 38.46% | 20.00% | 0.2632 |
| Diode | 25 | 5 | 16 | 31.25% | 20.00% | 0.2439 |
| Zener-Diode | 25 | 5 | 30 | 16.67% | 20.00% | 0.1818 |
| GSM-Module | 24 | 5 | 7 | 71.43% | 20.83% | 0.3226 |
| BJT-Transistor | 19 | 4 | 10 | 40.00% | 21.05% | 0.2759 |
| Motor-Driver | 19 | 4 | 7 | 57.14% | 21.05% | 0.3077 |
| Breadboard | 18 | 4 | 8 | 50.00% | 22.22% | 0.3077 |
| ESP32-CAM | 18 | 4 | 7 | 57.14% | 22.22% | 0.3200 |
| Fuse-Base | 9 | 2 | 2 | 100.00% | 22.22% | 0.3636 |
| Rocker-Switch | 17 | 4 | 5 | 80.00% | 23.53% | 0.3636 |
| Pin-Header | 25 | 6 | 13 | 46.15% | 24.00% | 0.3158 |
| Motion-Sensor | 20 | 5 | 5 | 100.00% | 25.00% | 0.4000 |
| NTC-Thermistor | 20 | 5 | 17 | 29.41% | 25.00% | 0.2703 |
| IR-Sensor | 18 | 5 | 17 | 29.41% | 27.78% | 0.2857 |
| Buck-Converter | 16 | 5 | 5 | 100.00% | 31.25% | 0.4762 |
| LCD-Display | 16 | 5 | 6 | 83.33% | 31.25% | 0.4545 |
| FT-232-USB-Serial-Module | 19 | 6 | 17 | 35.29% | 31.58% | 0.3333 |
| Water-Sensor | 21 | 7 | 7 | 100.00% | 33.33% | 0.5000 |
| Gas-Sensor | 23 | 8 | 15 | 53.33% | 34.78% | 0.4211 |
| Capacitor-10mf | 19 | 7 | 17 | 41.18% | 36.84% | 0.3889 |
| Arduino-Nano | 16 | 6 | 27 | 22.22% | 37.50% | 0.2791 |
| Raindrops-Module | 18 | 7 | 7 | 100.00% | 38.89% | 0.5600 |
| Arduino-Mega | 17 | 7 | 17 | 41.18% | 41.18% | 0.4118 |
| LED-Light | 38 | 19 | 31 | 61.29% | 50.00% | 0.5507 |
| Resistor | 18 | 9 | 44 | 20.45% | 50.00% | 0.2903 |
| ESP32 | 21 | 11 | 21 | 52.38% | 52.38% | 0.5238 |
| Arduino-Uno | 28 | 15 | 19 | 78.95% | 53.57% | 0.6383 |
| Soil-Moisture-Sensor | 18 | 10 | 24 | 41.67% | 55.56% | 0.4762 |
| Heat-Sink | 16 | 9 | 11 | 81.82% | 56.25% | 0.6667 |
| RFID-Scanner | 16 | 9 | 9 | 100.00% | 56.25% | 0.7200 |
| OLED-Display | 32 | 21 | 37 | 56.76% | 65.62% | 0.6087 |
| Keypad | 17 | 12 | 13 | 92.31% | 70.59% | 0.8000 |

Classes with zero test recall: **4** (7-Segment-Display, DC-Motor, LDR-Sensor, Taper-Potentiometer).

## Comparison with existing frozen results

| System | Test coverage | Test accepted acc. | Test overall acc. | Test macro F1 | Note |
|---|---:|---:|---:|---:|---|
| 305 refs, shipped k=3/maxDist=50.6 | 2.26% | 37.93% | 0.86% | 0.0140 | existing frozen report |
| 305 refs, validation-frozen k=1/maxDist=80 | 100.00% | 13.72% | 13.72% | 0.1355 | existing frozen report |
| 8,877 refs, always answer (k=1) | 100.00% | 53.78% | 53.78% | n/a | existing frozen report |
| 8,877 refs, always answer (k=3) | 99.77% | 52.81% | 52.69% | n/a | existing frozen report |

## Interpretation

No pre-registered budget met the 80% accepted-accuracy / 50% coverage gate. The validation-selected budget's test result is reported above. Medoid selection over the existing 2,027-dimensional feature space therefore does not, by itself, make local recognition reliable enough for electrical guidance.

The selected thresholds sit at the 50% validation-coverage boundary. On test they landed slightly below 50% (49.26%), which shows that a gate-boundary threshold is fragile under distribution shift. A deployment decision would need a coverage margin or a separately calibrated abstention policy, not a threshold tuned to the exact boundary.

Budget 10 selected k=3, while budgets 20 and 40 selected k=1. More neighbours did not improve the validation score at the coverage gate, which is consistent with class overlap in the current feature space. The medoid 5/class set improved accepted accuracy over the arbitrary 305-reference compact DB, but the overall conclusion is unchanged: reference curation helps, yet the representation remains the limiting factor.

Caveats: greedy k-medoids are not exhaustive PAM; features and scaler are unchanged; the test split is reused across four pre-registered budgets, so the test table is descriptive and not a model-selection signal; the dataset is still the same lab capture domain, not a real PCB camera session.

## Reproduce

```bash
python scripts/select_medoid_references.py
python scripts/eval_medoid_budgets.py
```

Outputs:

- `datasets/processed/medoids/budget_005.json` … `budget_040.json`
- `datasets/processed/medoids/manifest.json`
- `datasets/processed/medoid_experiment_v1.json`
- `datasets/processed/medoids/selected_budget_per_class.csv`
