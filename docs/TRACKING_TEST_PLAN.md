# Tracking Test Plan

## Hand detection (MediaPipe Hand Landmarker)
- Verify `initHandTracker()` returns mode `mediapipe` on a device with WebGL.
- Verify `detectHands(video, ts)` returns 21 landmarks per hand and a bounding box.
- Test with: single hand, two hands, hand partially out of frame, different lighting, gloves.
- Confirm no camera frames leave the device (network tab shows no frame uploads).

## Component detection (ONNX / heuristic)
- Without model URL: mode `heuristic`, returns knownComponents as candidates (labelled heuristic).
- With a valid ONNX model URL: mode `onnx`, returns boxes with confidence >= 0.35.
- Test re-identification: move camera, verify component boxes track across frames.

## MultiTargetTracker
- Add two targets, update with moving frames, verify both tracked independently.
- Remove one target mid-sequence, verify the other continues.
- Lost target transitions to LOST state, not stale-locked.

## Consecutive-frame tracking
- Run 300 frames with a stationary target: state should remain TRACKING, confidence > 0.6.
- Move target 50px between frames: tracker should follow within 3 frames.
- Occlude target for 5 frames: state should become LOST, then REACQUIRING on reappearance.
- Measure update latency: target < 16ms per frame on mid-range laptop.

## Measured synthetic benchmark

`node scripts/bench-tracking.mjs` draws seven deterministic 320×240 scenes (no
camera, no browser) and runs `TargetTracker` on each: clean light, lights
dropping to 60%/40%, steady 50% light, an occlusion, a similar distractor and a
target that shrinks to 82%.

Per scenario it records the tracked rate (IoU > 0.35), mean IoU against the
ground-truth box, the fraction of occluded frames falsely reported as TRACKING,
and how many visible frames recovery took. The gate is mean tracked ≥ 90%, mean
IoU ≥ 55%, and ≤ 5% false tracking on every scenario. Results are written to
`datasets/processed/tracking_benchmark.json` (gitignored).

`trackingBenchmark.test.js` runs a shorter subset of the same scenes in
`npm test`, including the honesty check that an occluded target is never
reported as TRACKING. The full script is the number to quote.
