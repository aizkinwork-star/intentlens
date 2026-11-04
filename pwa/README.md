# IntentLens PWA — phone build

Standalone installable phone app served from GitHub Pages. It does not need the local Node server, and it does not share data with the desktop app.

Live URL: https://aizkinwork-star.github.io/intentlens/

## What works without a server

- Installable PWA (manifest + service worker + PNG icons)
- Rear-camera preview with explicit permission
- Still capture using the true video frame size
- IndexedDB projects, messages, captures and settings
- Text-only project chat (no image is captured or sent)
- Real image analysis through OpenRouter or the configured Meta provider
- Repeat = 0 AI requests; Explain = exactly 1
- Same coordinate conversion and result validation as the desktop app
- Offline shell caching (history opens; AI calls clearly fail offline)
- In-memory provider request log showing the exact host, endpoint, model, mode, HTTP status, latency and request id

## Full provider set, including hosts a browser cannot call

Every provider is visible in Settings. Browser-blocked hosts are refused before any network request with their exact endpoint and the reason, instead of being hidden. Nothing falls back silently.

## Install on a phone (GitHub Pages)

1. Open https://aizkinwork-star.github.io/intentlens/ in Chrome on Android or Safari on iOS.
2. Android Chrome: menu → Add to Home screen.
3. iOS Safari: Share → Add to Home Screen.
4. Open the installed icon. Camera permission is requested only after tapping Start camera.
5. Tap Settings, choose OpenRouter, paste your key, and press Save.
6. Frame a board in landscape and tap Capture, or tap Upload photo to use an existing picture.
7. Type a question and press Send.
8. Check the Provider request log to see the exact endpoint and model used.

Camera and microphone need a secure context. GitHub Pages is HTTPS, so the installed PWA works. A plain http://192.168.x.x LAN address will not get camera permission on Android Chrome.

## Local preview

```cmd
cd C:\Users\hp\Desktop\IntentLens
node scripts\prepare-pwa.mjs
node scripts\serve-pwa.mjs
```

Open http://localhost:8020.
