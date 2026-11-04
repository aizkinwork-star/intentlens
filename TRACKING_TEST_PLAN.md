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