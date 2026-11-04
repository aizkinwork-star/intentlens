# IntentLens PWA — phone build

This folder is the standalone phone app. It is **separate** from the Windows
Electron app and does not need the local Node server.

## What works without a server

- Installable PWA (manifest + service worker + real PNG icons)
- Rear-camera preview with explicit permission
- Still-frame capture; the original blob and data URL are saved in IndexedDB
- IndexedDB projects, messages, captures and settings
- Voice transcription through the browser speech API, with text fallback
- Repeat = 0 AI requests; Explain = exactly 1 request
- The same coordinate conversion and result validation as the desktop app
- Offline shell caching (the app opens without a network)

Cloud analysis is the part that depends on the provider.

## CORS reality (verified with real preflight requests)

| Provider | Browser CORS | Can GitHub Pages call it? |
|---|---|---|
| Groq (Meta Llama vision) | `access-control-allow-origin: *` | **Yes** |
| NVIDIA NIM (Meta Muse) | no allow-origin header | **No** |
| Cloudflare Workers AI | `OPTIONS` → 405 | **No** |

The PWA therefore defaults to **Groq**, and shows a clear error instead of
pretending a blocked call worked. NIM can only be used through a custom
OpenAI-compatible relay that allows the Pages origin. There is no non-Meta
fallback anywhere in this app.

## Local preview

```cmd
cd C:\Users\hp\Desktop\IntentLens
node scripts\prepare-pwa.mjs
npx.cmd serve pwa
```

Open the HTTPS/localhost URL on the phone. Camera and microphone require a
secure context: GitHub Pages, `localhost`, or a tunnel with HTTPS. A plain
`http://192.168.x.x` address will not get camera permission on Android Chrome.

## GitHub Pages setup (fastest path)

1. Push this repository to GitHub (public repo on the free plan).
2. Repository → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main`. The workflow `.github/workflows/pages.yml` runs
   `scripts/prepare-pwa.mjs` and publishes `pwa/`.
4. Open `https://<user>.github.io/<repo>/` on the phone.
5. Chrome menu → **Add to Home screen**.

The workflow copies `grid.js`, `componentResult.js` and `intentlens_tts.js`
into `pwa/lib/` at build time, so those files stay single-sourced in the repo
root and `pwa/lib/` is gitignored.

## Phone test checklist

Before claiming the PWA works, verify all of these on the real phone:

- [ ] Page loads from the Pages URL and installs to the home screen.
- [ ] Camera permission is requested only after tapping **Start camera**.
- [ ] Rear camera is used; stopping releases the tracks.
- [ ] Capture freezes the frame and stores it across a reload.
- [ ] Mic produces an editable transcript; typing works when it does not.
- [ ] **Cloud is off** by default; no image leaves the phone until allowed.
- [ ] A real image request returns a real model answer.
- [ ] A null location draws no box.
- [ ] An out-of-range result is rejected, not clamped.
- [ ] Repeat makes no request; Explain makes exactly one.
- [ ] Airplane mode still opens the app shell.
- [ ] Deleting a project requires confirmation and removes its messages/images.

## Key handling

The key is entered on the phone and used directly from the browser. If
“Remember” is ticked it is stored in IndexedDB in plaintext; that is honest but
not encrypted. Leave it off on a shared device. Never commit a key, and never
put one in this repository.

## What is intentionally not here

- No hosted backend, database, account system or paid service.
- No Cloudflare Worker is required. A relay is optional and only for NIM.
- No claim of APK support. This is a PWA.
- No continuous video streaming and no invented coordinates.
