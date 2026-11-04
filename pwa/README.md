# IntentLens PWA — phone build

Standalone installable phone app. Separate from the Windows Electron app and
does not need the local Node server.

## What works without a server

- Installable PWA (manifest + service worker + PNG icons)
- Rear-camera preview with explicit permission
- Still capture using the true video frame size
- IndexedDB projects, messages, captures and settings
- **Text-only project chat** (no image is captured or sent)
- Voice transcription through the browser speech API, with text fallback
- Repeat = 0 AI requests; Explain = exactly 1
- Same coordinate conversion and result validation as the desktop app
- Offline shell caching (history opens; AI calls clearly fail offline)

## Providers and CORS (checked 2026-11-04)

| Provider | Model preset | Browser CORS | Notes |
|---|---|---|---|
| Groq | `meta-llama/llama-4-maverick-17b-128e-instruct` | allowed (`*`) | Scout was reported unavailable. Groq's public model table did not list a Llama 4 vision model; verify your account. |
| OpenRouter | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` (free, vision) | allowed (`*`) | Paid Meta Maverick/Scout are selectable in the model list. |
| BlockRun | `nvidia/llama-3.2-11b-vision` | **blocked** (no allow-origin) | Consent required. Retention policy conflicts with marketing; SDK README disputes vision quality. |
| NVIDIA NIM | `meta/muse-glimmer-30b` | blocked | Desktop-only or via a CORS relay. |
| Custom relay | user-defined | unknown | Must be HTTPS and allow this origin. |

There is no silent fallback. A provider error is shown; the app does not switch
models or hosts on its own.

## Privacy boundary

- Projects, messages, images, settings and component results stay in IndexedDB.
- The API key stays in **JavaScript memory only** for the open tab. It is not in
  localStorage, sessionStorage, IndexedDB, Cache Storage or the URL. Reload or
  **Clear key** removes it.
- Cloud is off by default. Only the **Send** action, after allowing cloud for the
  session, sends data.
- Vision Send sends one still image + the current prompt + a trimmed project/chat
  context. Chat Send sends text only. No live camera stream is sent.
- BlockRun adds a separate consent checkbox; do not send private documents,
  personal data or sensitive project history through it.

## Local preview

```cmd
cd C:\Users\hp\Desktop\IntentLens
node scripts\prepare-pwa.mjs
node scripts\serve-pwa.mjs
```

Open `http://localhost:8020`. Camera/mic need a secure context: HTTPS or
localhost. A plain `http://192.168.x.x` address will not get camera permission
on Android Chrome.

## GitHub Pages

1. Repository → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main`. The workflow runs tests, prepares `pwa/lib`, and deploys `pwa/`.
3. Open `https://<user>.github.io/<repo>/` on the phone.
4. Chrome menu → **Add to Home screen**.

## Phone test checklist

Before claiming the PWA works on a phone, verify:

- [ ] Page loads from the Pages URL and installs to the home screen.
- [ ] Permission is requested only after tapping **Start camera**.
- [ ] Rear camera is used; stopping releases the tracks.
- [ ] Capture freezes the frame and stores it across a reload.
- [ ] Rotate to landscape; preview and controls remain usable.
- [ ] Capture in landscape; image is not sideways/stretched.
- [ ] Rotate after opening evidence; four markers stay on the same part.
- [ ] Mic produces an editable transcript; typing works when it does not.
- [ ] **Cloud is off** by default; no image leaves until allowed.
- [ ] **Chat** sends a text-only request (Network panel: no `image_url`).
- [ ] A real image request returns a real model answer naming something visible.
- [ ] A null location draws no box; an out-of-range result is rejected.
- [ ] Repeat makes no request; Explain makes exactly one.
- [ ] Reload clears the key; project and image persist.
- [ ] Airplane mode still opens the shell.
- [ ] Deleting a project removes its messages/images after confirmation.

Mark physical checks NOT TESTED if no real phone was used. Desktop emulation is
not proof of Android camera behaviour.

## Security limits

This is a static site. Any script running on the page, a browser extension, or
the device owner can read the key while the tab is open. Session-only storage
reduces persistence; it is not a secret vault. GitHub Pages cannot set response
headers, so the CSP is delivered by a `<meta>` tag only and `frame-ancestors`
is not claimed.

## What is intentionally not here

- No hosted backend, database, account system or paid dependency.
- No analytics, telemetry, cloud sync or automatic upload.
- No APK; this is a PWA.
- No continuous video streaming and no invented coordinates.
