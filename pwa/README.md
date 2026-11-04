# IntentLens PWA — phone build

Standalone installable phone app served from GitHub Pages. It does **not** need
the local Node server, and it does **not** share data with the desktop app.

Live URL: <https://aizkinwork-star.github.io/intentlens/>

> **Meta AI Developer Hackathon.** This project is an MVP made for the **Meta AI
> Developer Hackathon, partnered by Cerebral Valley**. Meta-published models are
> the priority; non-Meta models are explicitly labelled.

## What works without a server

- Installable PWA (manifest + service worker + PNG icons)
- Rear-camera preview with explicit permission
- Still capture using the true video frame size
- IndexedDB projects, messages, captures and settings
- Text-only project chat (no image is captured or sent)
- Real image analysis through OpenRouter (Meta Llama 4 Maverick by default)
- Voice transcription through the browser speech API, with text fallback
- Repeat = 0 AI requests; Explain = exactly 1
- Same coordinate conversion and result validation as the desktop app
- Offline shell caching (history opens; AI calls clearly fail offline)
- In-memory provider request log showing the exact host, endpoint, model, mode,
  HTTP status, latency and request id for every call

## Full provider set, including hosts a browser cannot call (checked 2026-11-04)

Every provider is visible in Settings. Browser-blocked hosts are refused before
any network request with their exact endpoint and the reason, instead of being
hidden. Nothing falls back silently.

| Provider | Status in this PWA | Default / Meta model | Cost | Notes |
|---|---|---|---|---|
| **OpenRouter** | Browser CORS `*`, verified | `meta-llama/llama-4-maverick` (Meta vision) | Paid; price shown | Default and first choice. Maverick verified from GitHub Pages with a real image; Scout and Meta text models are listed. Free NVIDIA/Dots vision models remain selectable. |
| **Groq** | Browser CORS `*`, text only | `meta-llama/llama-3.3-70b-versatile` (Meta text) | Account limits | Meta text is listed first. The supplied account exposed only Prompt Guard classifiers, so it may return 403/404. GPT-OSS/Qwen are labelled non-Meta fallbacks. No vision model: image requests are refused before any network call. |
| **NVIDIA NIM** | **Blocked by CORS** | `meta/muse-glimmer-30b` (Meta vision) | NVIDIA account | Endpoint `https://integrate.api.nvidia.com/v1/chat/completions`. Verified with a real image on the desktop path. No `Access-Control-Allow-Origin`, so the phone refuses with `PROVIDER_CORS_BLOCKED`. Use the PC app or a relay. |
| **Cloudflare Workers AI** | **Blocked by CORS** | `@cf/meta/llama-3.2-11b-vision-instruct` (Meta vision) | Free tier / account | Endpoint template `https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}`. Preflight returns 405 with no CORS. Desktop only. |
| **BlockRun** | **Blocked by CORS + unpaid** | `meta-llama/llama-4-maverick` (Meta vision) | **Paid x402** | Endpoint `https://api.blockrun.ai/v1/chat/completions`. 115 models listed, but the supplied key returned HTTP 402 `Payment verification failed`; no CORS. Restored and visible, not working with that key. |
| **Modal** | User-deployed endpoint | `meta-llama/Llama-4-Maverick-17B-128E-Instruct` | **Paid** / untested | Paste your `*.modal.run` OpenAI-compatible URL. **NOT TESTED** in the audit. CORS is whatever your deployment allows. |
| **Custom relay** | User-owned HTTPS endpoint | Your choice | Your cost | Use only if you deploy a relay that forwards to a blocked host and returns `Access-Control-Allow-Origin` for this origin. IntentLens does not run a relay for you. |

There is no silent fallback. A provider error is shown in the request log; the
app does not switch hosts or models on its own. A blocked provider's message
names the endpoint, the CORS evidence and the desktop/relay alternative.

### Model selection truth

- The model field is editable. You can type any model id the provider accepts.
- Known text-only models are refused for images before a request is made.
- A model not in the catalogue is sent as typed; the provider decides whether
  it exists. The request log records the exact id sent and the model id returned.
- Paid OpenRouter Meta models show their per-token price in the model note and
  in the datalist. Nothing is charged unless you explicitly select one.
- Browser-blocked hosts still record the intended endpoint, model and
  `PROVIDER_CORS_BLOCKED` code in the request log, with no network call made.

## Install on a phone (GitHub Pages)

1. Open <https://aizkinwork-star.github.io/intentlens/> in Chrome on Android or
   Safari on iOS.
2. Android Chrome: menu → **Add to Home screen**.
   iOS Safari: Share → **Add to Home Screen**.
3. Open the installed icon. Camera permission is requested only after tapping
   **Start camera**.
4. Tap **Settings**, choose **OpenRouter**, paste your key, and press **Save**.
   The key is kept in memory for this tab only. Meta Llama 4 Maverick is the
   default; select a free model if you do not want a paid request.
5. Tap **Allow cloud for this session**.
6. Frame a board in landscape, tap **Capture**, type a question, then **Send**.
7. Check the **Provider request log** to see the exact endpoint and model used.

Camera and microphone need a secure context. GitHub Pages is HTTPS, so the
installed PWA works. A plain `http://192.168.x.x` LAN address will not get
camera permission on Android Chrome.

## Local preview

```cmd
cd C:\Users\hp\Desktop\IntentLens
node scripts\prepare-pwa.mjs
node scripts\serve-pwa.mjs
```

Open `http://localhost:8020`.

## GitHub Pages deployment

1. Repository → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main`. The workflow runs source tests, prepares `pwa/lib`, and
   deploys `pwa/`.
3. The deployed service worker auto-updates. A tab running an older shell
   reloads once when a new worker takes control.

## Privacy boundary

- Projects, messages, images, settings and component results stay in IndexedDB
  on the phone.
- The API key stays in **JavaScript memory only** for the open tab. It is not in
  localStorage, sessionStorage, IndexedDB, Cache Storage or the URL. Reload or
  **Clear key** removes it. This is deliberate: the phone key is **not
  preserved**. Re-enter it after a reload.
- Cloud is off by default. Only **Send**, **Explain** or **Test key** after
  allowing cloud for the session sends data.
- Vision Send sends one still image + the current prompt + a trimmed
  project/chat context. Chat Send sends text only. No live camera stream is
  sent.
- The request log is memory-only and contains endpoint/model metadata, never the
  key and never the image.
- There is no analytics, telemetry, account system or IntentLens backend. The
  browser calls the provider directly, so the provider's own retention and
  training policy applies to what you send.

## Phone test checklist

Before claiming the PWA works on a physical phone, verify:

- [ ] Page loads from the Pages URL and installs to the home screen.
- [ ] Permission is requested only after tapping **Start camera**.
- [ ] Rear camera is used; stopping releases the tracks.
- [ ] Capture freezes the frame and stores it across a reload.
- [ ] Rotate to landscape; preview and controls remain usable.
- [ ] Capture in landscape; image is not sideways/stretched.
- [ ] Rotate after opening evidence; four markers stay on the same part.
- [ ] Mic produces an editable transcript; typing works when it does not.
- [ ] Cloud is off by default; no image leaves until allowed.
- [ ] Chat sends a text-only request (Network panel: no `image_url`).
- [ ] A real image request returns a real model answer naming something visible.
- [ ] A null location draws no box; an out-of-range result is rejected.
- [ ] Repeat makes no request; Explain makes exactly one.
- [ ] Reload clears the key; project and image persist.
- [ ] Airplane mode still opens the shell.
- [ ] Deleting a project removes its messages/images after confirmation.
- [ ] The request log names the endpoint, host, model and status for each call.

**Physical-device status:** the camera, landscape, permission and install
checks are **NOT TESTED — DEVICE REQUIRED**. Desktop browser emulation is not
proof of Android/iOS camera behaviour. A deployed page sent a real synthetic
image through OpenRouter and returned valid JSON; the request log, shell service
worker, text chat and absence of keys in URL/storage were verified in the live
browser. Details: [../docs/PWA_AUDIT_REPORT.md](../docs/PWA_AUDIT_REPORT.md).

## Security limits

This is a static site. Any script running on the page, a browser extension, or
the device owner can read the key while the tab is open. Session-only storage
reduces persistence; it is not a secret vault. GitHub Pages cannot set response
headers, so the CSP is delivered by a `<meta>` tag only and `frame-ancestors` is
not claimed. `connect-src` allows HTTPS origins because Modal deployments and
the optional custom relay can live on any domain you deploy; the fixed providers
are OpenRouter, Groq, NVIDIA NIM, Cloudflare Workers AI and BlockRun.

## What is intentionally not here

- No hosted backend, database, account system or paid dependency.
- No analytics, telemetry, cloud sync or automatic upload.
- No APK; this is a PWA.
- No continuous video streaming and no invented coordinates.
- No Meta glasses integration. The device access toolkit was not available, so
  that integration was not built or claimed.
