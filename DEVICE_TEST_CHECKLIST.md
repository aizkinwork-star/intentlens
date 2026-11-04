# Device & Platform Test Checklist

## Android Chrome
- [ ] Camera access granted and stream starts
- [ ] Permission denial shows recovery UI
- [ ] Orientation change preserves tracking
- [ ] OpenCV/WASM assets load offline
- [ ] IndexedDB persists board registration across reload
- [ ] Long-running tracking (10+ min) no memory leak
- [ ] Background/foreground recovery

## iOS Safari
- [ ] Camera access (playsinline required)
- [ ] WASM initialization completes
- [ ] Memory pressure handling
- [ ] Background suspension recovery
- [ ] Persistent local storage

## Electron Windows
- [ ] Production build (npm run build)
- [ ] Packaged asset resolution (opencv.js, models)
- [ ] Camera permissions
- [ ] OpenCV initialization
- [ ] IndexedDB persistence
- [ ] CSP and renderer security
- [ ] Restart and recovery

STATUS: NOT TESTED — no actual devices or packaged builds available in this environment.