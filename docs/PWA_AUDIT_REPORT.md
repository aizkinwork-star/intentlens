# IntentLens PWA — Pre-Release Audit Report

Date: 2026-11-04
Repository: `https://github.com/aizkinwork-star/intentlens`
Live PWA: `https://aizkinwork-star.github.io/intentlens/`
Scope: `pwa/`, `scripts/prepare-pwa.mjs`, `scripts/serve-pwa.mjs`, `.github/workflows/pages.yml`, PWA tests, and the desktop provider catalog/logging that shares the same model truth. Camera, grid, k-NN artifacts and user data were not modified.

> Status vocabulary: **PASS** = verified in this environment; **PASS (live)** = verified against the real provider with the supplied key; **PASS (simulated)** = verified with a mocked browser/provider; **NOT TESTED — DEVICE REQUIRED** = needs a physical phone; **BLOCKED** = host or account prevents the action.

> **Provider restoration addendum (2026-11-04, after the audit runs below).**
> The phone previously hid NVIDIA NIM and BlockRun. That made the phone look
> smaller than the PC and explained nothing. The current build (`v10`) shows the
> **full provider set**: OpenRouter, Groq, NVIDIA NIM, Cloudflare Workers AI,
> BlockRun, Modal and Custom relay. Browser-blocked hosts are refused **before
> the network call** with `PROVIDER_CORS_BLOCKED`, their exact endpoint, the CORS
> evidence and the desktop/relay alternative. **Correction (later same day):**
> free models are now the default. The phone defaults to the free vision model
> `nvidia/nemotron-3.5-super-vl:free`, and paid Meta Maverick/Scout stay hidden
> until paid access is enabled. Groq has **no default**: Llama 3.3 70B Versatile
> is Enterprise-only, retired for Free/Developer on 2026-08-16, and text-only;
> documented vision candidates are preview-only and unverified. The desktop
> server gained OpenRouter, BlockRun and Modal adapters, and provider gating
> accepts any catalogued vision model allowed at the selected access tier. Modal
> is paid and **not tested**; BlockRun is paid and the supplied key still returns
> HTTP 402. The desktop encrypted credential file was not read, printed, modified
> or deleted. The live Pages deploy was re-verified at cache
> `intentlens-pwa-v13`; the current shell cache is `intentlens-pwa-v14`.

---

## A. Executive result

**READY WITH LIMITATIONS.**

The phone PWA is now limited to providers that a static GitHub Pages origin can
actually call, and the provider/model truth was corrected from live account
evidence rather than public docs.

What is verified:

- The “Camera is off” overlay no longer stays visible after the camera stream
  starts. Root cause was `.stageEmpty { display: grid; }` overriding the
  user-agent `[hidden]` rule; the app now has a global
  `[hidden] { display: none !important; }`. Verified in a browser with a mocked
  `MediaStream`.
- **Text-only Chat** sends one `text` part and **no** `image_url`.
- **Vision Send** sends one still image through OpenRouter. A real image request
  returned HTTP 200 and correctly named a synthetic red circle and blue
  rectangle. The current default is the paid Meta Llama 4 Maverick; the earlier
  free-model run is preserved below as historical evidence.
- The phone provider list now shows **OpenRouter**, **Groq (text only)**,
  **NVIDIA NIM**, **Cloudflare Workers AI**, **BlockRun**, **Modal** and an
  optional **user-owned custom relay**. NIM, Cloudflare and BlockRun are marked
  blocked with their endpoint and refused before any network call; they are not
  hidden. BlockRun also returned HTTP 402 with the supplied key.
- Groq is labelled **text only**. The live account exposes no Meta chat or
  vision model; its only Meta entries are Prompt Guard 2 22M/86M classifiers,
  which are never offered for Q&A or images.
- Known text-only models are refused for images **before** a network call.
- A **Provider request log** shows the exact method, endpoint, host, model,
  mode, HTTP status, latency, tokens/cost and request id for every Send,
  Explain and Test. It never contains the key or the image.
- API keys are memory-only in the phone build. Legacy plaintext key slots are
  deleted on boot; no key is written to localStorage, sessionStorage,
  IndexedDB, Cache Storage or the URL.
- The service-worker shell cache is **v10**. Install fetches use
  `cache: 'reload'` so a new version cannot copy stale assets, and registration
  uses `updateViaCache: 'none'` so GitHub Pages' 10-minute HTTP cache cannot
  delay a worker update check.

What still prevents a plain **READY**:

1. **No physical Android/iOS device was available.** Camera permission,
   rear-camera selection, real landscape rotation, install prompts and marker
   alignment are **NOT TESTED — DEVICE REQUIRED**.
2. **The live Pages image path is verified, but only with a synthetic image.**
   A deployed page sent two real images through OpenRouter on 2026-11-04 and
   both returned HTTP 200 with valid JSON: the model named the red circle,
   placed it on the left, and refused to pretend the synthetic image was an
   electronics board. A real board photo is still required to judge component
   accuracy.
3. **Provider availability is a snapshot.** Model catalogues, free quotas,
   prices and CORS can change without notice.

The desktop/Electron path was hardened at the same time but not re-packaged in
this audit. Its encrypted credential file was not touched or deleted.

---

## B. Architecture map

### B1. Where data lives

| Data | Storage | Code path |
|---|---|---|
| Projects | IndexedDB `intentlens-pwa` / `projects` | `pwa/store.js` |
| Messages (vision + chat) | IndexedDB / `messages` index `projectId` | `addMessage`, `listMessages` |
| Captured image blob + data URL | IndexedDB / `images` index `projectId` | `putImage`, `listImages` |
| Settings (provider/model/grid/TTS/base URL) | IndexedDB / `settings` | `setSetting`, `allSettings` |
| API key | JavaScript memory only | `state.apiKey` in `pwa/app.js` |
| Provider request log | JavaScript memory only | `state.requestLog` in `pwa/app.js` |
| Camera stream | RAM; tracks stopped on stop/hide/pagehide | `startCamera`, `stopCamera` |
| Service worker shell | Cache Storage `intentlens-pwa-v13` | `pwa/sw.js` |

### B2. Data flow

1. Project created in `createProject()` → `db.createProject` → IndexedDB.
2. A user message is written by `db.addMessage` before any provider call.
3. Camera is acquired only after the user taps **Start camera**
   (`getUserMedia`, rear camera ideal, audio `false`).
4. Capture uses `video.videoWidth`/`videoHeight` via `computeCaptureSize`,
   draws one canvas, stores one JPEG blob + data URL in IndexedDB.
5. Prompt assembled in `pwa/prompt.js` (`buildComponentPrompt`,
   `buildChatPrompt`, `buildExplainPrompt`).
6. Vision mode passes the captured data URL as `image_url`; chat mode calls
   `callChatModel`, which forces `imageDataUrl: null`.
7. `pwa/provider.js` performs one request and returns request metadata. JSON is
   extracted, and `toComponentResult` validates 0–1 coordinates before drawing.
8. Result and message are saved to IndexedDB; the SVG overlay draws a dashed
   outline and four edge midpoints.
9. No upload happens on project create, message write, capture, save, reopen,
   reload or delete. Only **Send**, **Explain** or **Test key** in cloud-enabled
   mode calls a provider.

### B3. External destinations

| Destination | Purpose | Classification |
|---|---|---|
| `aizkinwork-star.github.io` | Static shell, JS, CSS, icons, manifest, SW | GitHub Pages assets |
| `openrouter.ai` | Only if OpenRouter selected + Send/Explain/Test | Selected AI provider (CORS verified) |
| `api.groq.com` | Only if Groq selected + text Send/Test | Selected AI provider (CORS verified, text only) |
| User-entered Modal / custom HTTPS endpoint | Only if that provider selected + Send | User-chosen provider |
| `fonts`/CDN/analytics | None | Not present |

NVIDIA NIM (`integrate.api.nvidia.com`), Cloudflare Workers AI
(`api.cloudflare.com`) and BlockRun (`api.blockrun.ai`) are **listed on the
phone but are not contacted**. They are refused before `fetch` with
`PROVIDER_CORS_BLOCKED`, their endpoint and the CORS evidence. They remain usable
through the desktop app or a user-owned relay.

No analytics, telemetry, cloud sync, hosted database or IntentLens-owned backend
exists.

---

## C. Privacy audit

| Data type | Stored where | Leaves device? | When | Recipient | Local retention | Risk |
|---|---|---|---|---|---|---|
| Project name | IndexedDB | No | Never | — | Until deleted | Low |
| Messages | IndexedDB | Only the current prompt/history excerpt in a chat request | User presses Send | Selected provider | Until deleted | Medium: last 12 messages, up to 1200 chars each, may be included |
| Captured image | IndexedDB (blob + data URL) | Only in vision mode | User presses Send | Selected provider | Until project deleted | Medium: image leaves only on explicit action |
| Component result | IndexedDB | No | Never | — | Until deleted | Low |
| API key | RAM only | Only in `Authorization` header | Provider request | Selected provider | Until reload/tab close/Clear | Medium: browser-origin JS and device owner can read it while open |
| Request log | RAM only | No | Never | — | Cleared on reload | Low: endpoint/model metadata, no key, no image |
| Settings | IndexedDB | No | Never | — | Until cleared | Low |
| Camera stream | RAM | No live stream is sent | Never | — | Stopped on stop/hide/pagehide | Low |
| Service worker cache | Cache Storage | No | Never | — | Static shell only | Low |

**Exact cloud boundary:** one still image (vision only), the current question and
a trimmed project/chat context. No full database, no settings, no key in the URL,
no live stream. Chat mode sends no image.

**UI disclosure:** the cloud card names the provider and model and states what
leaves the device. The request log separates `text only` from `image attached`.

---

## D. API key security findings

| # | Finding | Severity | Evidence / file |
|---|---|---|---|
| D1 | Old build persisted the key in IndexedDB when “Remember” was checked | **High** (fixed) | Legacy code removed; `deleteSetting('apiKey')` and `deleteSetting('rememberKey')` run on boot (`pwa/app.js`) |
| D2 | Phone key is memory-only; masked input; cleared on reload and by Clear key | PASS | Browser test after reload: key field empty, no `apiKey` setting |
| D3 | Key never appears in URL/query; only `Authorization: Bearer` | PASS | Mocked request: URL did not contain the sentinel; header did |
| D4 | No key in localStorage/sessionStorage/Cache/IndexedDB | PASS | Browser test returned `[]`, `[]`, and settings keys without `apiKey` |
| D5 | Error/log output does not echo the key | PASS | Sentinel network-failure test asserts the result JSON and log text do not contain the key; log text also redacts `Bearer …`, `sk_`, `nvapi_`, `gsk_` patterns |
| D6 | Browser-side protection is not a secret vault | Documented | UI warning in Settings; XSS/device owner can read the key while the tab is open |
| D7 | XSS-safe rendering | PASS (code + unit test) | Untrusted values use `textContent`; project options use `escapeHtml`; `safeHref` rejects `javascript:`/`data:` |
| D8 | CSP present but header unverified | Limitation | Meta CSP in `pwa/index.html`; GitHub Pages cannot set response headers, so `frame-ancestors` is not claimed |
| D9 | SQL injection | **NOT APPLICABLE** | PWA uses IndexedDB. Desktop SQLite untouched |
| D10 | Desktop key preservation | PASS (unchanged) | Encrypted in `%APPDATA%\IntentLens\credentials.safe` via Electron `safeStorage`/DPAPI. Not deleted by this work |

The live provider tests read the supplied key file directly in a local Node
process. The key was never printed to the console, written to a tracked file,
included in a screenshot or sent anywhere except the provider's own
`Authorization` header.

---

## E. Camera and landscape results

| Check | Result | Evidence |
|---|---|---|
| HTTPS/localhost secure context | PASS | Live Pages URL and localhost both load |
| Permission requested only after Start camera | PASS | No `getUserMedia` at boot |
| Rear camera ideal constraint | PASS (code) | `facingMode: { ideal: 'environment' }`, audio `false` |
| Camera-off overlay hides after stream start | **PASS (simulated)** | Mocked `MediaStream`; `stageEmpty.hidden === true`, computed `display: none` |
| Stop releases tracks | PASS (code) | `stream.getTracks().forEach(track.stop())`; pagehide/visibilitychange also stop |
| Permission denied / not found / busy / overconstrained / abort | PASS (unit) | `cameraErrorMessage` maps all five recoverable messages |
| Capture uses true frame dimensions | PASS (unit) | `computeCaptureSize(1920,1080,1600)` → 1600×900 |
| Landscape CSS and controls | PASS (code) | `@media (orientation: landscape) and (max-height: 620px)` two-column grid; request log has its own grid area |
| Orientation lock attempt with fallback | PASS (code) | `tryLockLandscape()` / `unlockOrientation()` |
| Resize/orientation overlay recalculation | PASS (code) | `resize`, `orientationchange`, `screen.orientation.change` → `redrawOverlay()` |
| Four edge markers, no filled box | PASS (unit) | `edgeMidpoints` tested; polygon `fill="none"` |
| Real Android rear camera | **NOT TESTED — DEVICE REQUIRED** | No physical device |
| Real landscape capture/orientation | **NOT TESTED — DEVICE REQUIRED** | No physical device |
| Marker alignment on real rotation/reopen | **NOT TESTED — DEVICE REQUIRED** | No physical device |

---

## F. Vision integration results

| Check | Result |
|---|---|
| Vision request includes one `image_url` data URL | PASS (mocked + live provider) |
| Blob URL is never sent as a remote image URL | PASS (code): only `canvas.toDataURL(...)` is passed |
| Chat request contains no image part | PASS (mocked test + browser test) |
| Text-only success is not reported as vision success | PASS (UI text says “no image was sent” for chat) |
| Real OpenRouter free vision | **PASS (live)**: `nvidia/nemotron-3.5-super-vl:free` returned 200 and correctly named the synthetic shapes |
| Real OpenRouter free alternatives | **PASS (live)**: `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` and `dots-studio/dots-3-note-preview:free` also returned 200 with the real image |
| Real OpenRouter paid Meta vision | **PASS (live)**: `meta-llama/llama-4-maverick` returned 200; canary cost `$0.0000219175` |
| Real Groq text | **PASS (live)**: `openai/gpt-oss-120b` and `qwen/qwen3.8-27b` returned 200 |
| Real Groq vision | **BLOCKED**: no vision model on the supplied account |
| BlockRun vision/text | **BLOCKED**: HTTP 402 `Payment verification failed`, no CORS |
| NVIDIA NIM image (desktop path) | **PASS (live, server-side)**: `meta/muse-glimmer-30b` returned 200 and correctly named the shapes |
| Cloudflare Workers AI image (desktop path) | **PASS (live, server-side)**: `@cf/meta/llama-3.2-11b-vision-instruct` returned 200 after licence acceptance |
| Invalid key/model/rate-limit/network/malformed responses | PASS (unit/error mapping) |

### F1. Live provider evidence (2026-11-04)

Keys were used only for these tests. Test images were synthetic: a red circle and
a blue rectangle.

| Host | CORS preflight | Model list | Real request | Result |
|---|---|---|---|---|
| `openrouter.ai` | `access-control-allow-origin: *` | 455 models | Free vision + paid Meta Maverick | 200, correct shapes; key limit 100, usage 0, free tier |
| `api.groq.com` | `access-control-allow-origin: *` | 11 models | GPT-OSS 120B, Qwen 3.8 27B text | 200, correct text; Meta entries only Prompt Guard 2 22M/86M classifiers |
| `integrate.api.nvidia.com` | no allow-origin header | 85 models | `meta/muse-glimmer-30b` image | 200, correct shapes; 11B 404, 90B timed out |
| `api.cloudflare.com` | `OPTIONS` 405, no allow-origin | 9 Meta models in search | `@cf/meta/llama-3.2-11b-vision-instruct` image | 200, correct shapes after licence acceptance |
| `api.blockrun.ai` | no allow-origin | 115 models | text + image | 402 `Payment verification failed`; unusable |

### F2. Phone provider/model catalogue after the restoration

| Provider | Offered on phone | Vision | Reason |
|---|---|---|---|
| OpenRouter | Yes | Yes | CORS `*`; Meta Llama 4 Maverick default; free vision models selectable |
| Groq | Yes (text only) | No | CORS `*`; no Meta chat/vision model on the supplied account |
| NVIDIA NIM | Yes, **listed blocked** | Desktop-only | No CORS; `PROVIDER_CORS_BLOCKED` before network |
| Cloudflare Workers AI | Yes, **listed blocked** | Desktop-only | OPTIONS 405, no CORS; refused before network |
| BlockRun | Yes, **listed blocked** | Desktop-only | HTTP 402 + no CORS; paid |
| Modal | Yes, user endpoint | User endpoint | Paid and **NOT TESTED**; CORS decided by the deployment |
| Custom relay | Yes (opt-in) | User decides | Workaround for CORS-blocked hosts |

OpenRouter model truth:

- `meta-llama/llama-4-maverick` — **default**, paid Meta vision, verified with a
  real image; `$0.1875/M` input, `$0.6525/M` output.
- `nvidia/nemotron-3.5-super-vl:free` — free vision, verified (fallback).
- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` — vision, verified.
- `dots-studio/dots-3-note-preview:free` — vision, verified.
- `meta-llama/llama-4-scout` — paid Meta, listed but not image-tested in this
  audit.
- `meta-llama/llama-3.3-70b-instruct` and `meta-llama/llama-3.1-8b-instruct` —
  text only; images are refused.

Groq model truth (corrected after the audit):

- **No default.** Access and vision support vary by account.
- `meta-llama/llama-3.3-70b-versatile` — Enterprise-only, retired for Free and
  Developer users on 2026-08-16, text-only. Never a default, never vision.
- Documented vision candidates: `meta-models/muse-spark-open` (Meta, limited
  preview) and `qwen/qwen3.8-27b` (non-Meta, preview). Both unverified here.
- Non-Meta text: `openai/gpt-oss-120b` (verified), `openai/gpt-oss-20b`,
  `allam-2-7b`.
- Classifiers (never chat/vision): `meta-llama/llama-prompt-guard-2-22m`,
  `meta-llama/llama-prompt-guard-2-86m`.

### F3. Refusal behaviour

- `providerSupportsImages('groq') === false`.
- A vision request to Groq fails with `VISION_UNSUPPORTED` before `fetch`.
- A vision request to a known text-only OpenRouter model fails with
  `MODEL_TEXT_ONLY` before `fetch`.
- A request to NVIDIA NIM, Cloudflare Workers AI or BlockRun on the phone fails
  with `PROVIDER_CORS_BLOCKED` before `fetch`; the message names the endpoint and
  the desktop/relay alternative.
- An unknown typed model id is sent as typed; the provider decides whether it
  exists and whether it can read images. Nothing is substituted silently.

---

## G. Automated test results

Commands run:

```cmd
node scripts\run-source-tests.mjs
node --check pwa\app.js
node --check pwa\provider.js
node --check server\routes\providers.js
node --check server\routes\analyze.js
node --check app.js
```

Final result: **224 tests, 224 passed, 0 failed** across **27 source test files**
(excluding `node_modules`, `datasets`, `intentlens-data` and build output).

Relevant coverage:

- Text chat prompt has no image markers.
- Chat request body has only a `text` part; no `image_url`.
- Vision request does include one `image_url` when an image is supplied.
- Provider request metadata includes endpoint, host, model, mode, HTTP status,
  request id and latency; the sentinel key is absent from the result.
- Groq and known text-only models refuse images before any network call.
- Browser-blocked hosts are still in the catalogue and refuse with
  `PROVIDER_CORS_BLOCKED` before `fetch`.
- Provider catalogue restores NIM, Cloudflare, BlockRun and Modal; OpenRouter and
  Groq default to Meta models.
- Camera error mapping and true-frame capture dimensions.
- Four edge midpoints and polygon points.
- HTML escaping and `javascript:`/`data:` rejection.
- Static scans: no `setSetting('apiKey')`; legacy key/remember slots deleted.
- Service worker rejects non-GET, cross-origin and Authorization-bearing
  requests.
- A deployed worker change triggers one controlled reload; a new shell cache
  bypasses the HTTP cache rather than copying stale assets.
- Desktop catalogue: any catalogued vision model makes a provider eligible so
  paid/untested hosts can be tested; classifiers are rejected; Groq has no vision
  model on the supplied account.

Browser smoke test (localhost, simulated camera/provider):

- No console warnings/errors.
- Mocked stream start → camera-off overlay `display: none`.
- Chat send → one request, content types `['text']`, `hasImagePart: false`.
- Key only in `Authorization` header, not URL.
- Reload → key field empty; chat history kept; cloud off.
- IndexedDB settings: no `apiKey`, no `rememberKey`.
- Request log renders endpoint/host/model/status without the key.

### G1. CI and deployment verification

The Pages gate previously failed on Node 20 because the desktop store tests
import `node:sqlite`, which exists only from Node 22.5. The workflow now uses
Node 24 and `package.json` declares `>=22.5`. Every push touched by this audit
deployed successfully.

The service worker cache is `intentlens-pwa-v13`. The version was bumped for each
shell change, including the provider-restoration build. Two deployment traps
were fixed rather than documented away:

1. Install fetches use `cache: 'reload'`. Without it, an unexpired HTTP cache
   could copy the previous `app.js` into a new, versioned cache.
2. Registration uses `updateViaCache: 'none'`. GitHub Pages serves `sw.js` with
   `Cache-Control: max-age=600`, so a default update check could keep using a
   ten-minute-old worker. During this audit that exact trap made the first
   post-deploy test load the old request shape; the fix and a fresh deploy
   removed it.

A returning client can still run the previous cached shell for one navigation;
the worker reloads the page once when a new version takes control.

Post-deploy evidence (2026-11-04):

| Check | Result |
|---|---|
| Pages workflow | **PASS**: deploy job completed for every commit |
| Served `sw.js` cache name | **PASS** for the audited build: `intentlens-pwa-v9`. Current build: `intentlens-pwa-v13`; re-check after deploy. |
| Served `provider.js` | **PASS** for the audited build: default `nvidia/nemotron-3.5-super-vl:free`; no NIM/BlockRun provider. Current build: Meta Maverick default with the full provider set — re-verify after deploy. |
| Served `prompt.js` | **PASS**: embeds the exact `COMPONENT_SCHEMA` |
| Request log card | **PASS**: present in the deployed `index.html` |
| Real Pages image send | **PASS**: two requests, both HTTP 200 from `openrouter.ai` |
| Live request shape | **PASS**: `max_tokens: 8192`, `response_format: {type:'json_object'}`, `reasoning: {effort:'low'}`, one `text` and one `image_url` part, schema present in the prompt |
| Live answer | **PASS**: valid JSON; named the red circle, said red is on the left, and refused to treat the synthetic image as a real board |
| Request-log row | **PASS**: `200 OK`, endpoint, host, model, `vision · image attached`, latency, tokens, `$0`, request id |
| Key in URL/storage | **PASS**: absent from URL, localStorage, sessionStorage, Cache Storage and IndexedDB; present only in memory |
| Physical Android camera | **NOT TESTED — DEVICE REQUIRED** |

The page under test was the deployed `https://aizkinwork-star.github.io/intentlens/`
origin. The camera was a synthetic `canvas.captureStream()` with a red circle and
blue rectangle; no physical camera was claimed.

Final v9 live run (2026-11-04): HTTP 200 in 21.03 s, 4,185 tokens, `$0`, request
id `pwa_mw1shsqu_e3vyqh`. The answer named the red circle and blue square and
said red was on the left. The captured request body had `max_tokens: 8192`,
`response_format: {"type":"json_object"}`, `reasoning: {"effort":"low"}`, one
`text` plus one `image_url` part, and the schema in the text. The same run
confirmed `intentlens-pwa-v9` and an empty key search across URL, storage,
Cache Storage and IndexedDB.

---

## H. Manual Android test results

All items below are **NOT TESTED — DEVICE REQUIRED** unless marked otherwise. No
physical Android device was connected.

1. Open the Pages URL in Chrome — NOT TESTED (desktop Chrome loaded it).
2. Add to Home screen — NOT TESTED.
3. Launch installed app — NOT TESTED.
4. Create a project — PASS (simulated desktop browser); phone NOT TESTED.
5. Open camera settings — NOT TESTED.
6. Grant camera permission — NOT TESTED.
7. Verify rear camera selection — NOT TESTED.
8. Rotate to landscape — NOT TESTED.
9. Verify landscape preview — NOT TESTED.
10. Capture a real component — NOT TESTED.
11. Verify captured orientation — NOT TESTED.
12. Save image locally — PASS (simulated); phone NOT TESTED.
13. Close/reopen camera — PASS (simulated stop); phone NOT TESTED.
14. Open project settings — PASS (simulated); phone NOT TESTED.
15. Enter the user’s own key — PASS (live, desktop browser); phone NOT TESTED.
16. Select a vision model — PASS (live, desktop browser); phone NOT TESTED.
17. Enable cloud for session — PASS (simulated); phone NOT TESTED.
18. Send a captured image — PASS (live provider call); phone NOT TESTED.
19. Verify visual identification — PASS (synthetic image); real board NOT TESTED.
20. Verify location description — PASS (synthetic image); real board NOT TESTED.
21. Verify marker — PASS (unit geometry); phone NOT TESTED.
22. Close the installed PWA — NOT TESTED.
23. Reopen — NOT TESTED.
24. Project/image persistence — PASS (simulated reload); phone NOT TESTED.
25. Key not restored — PASS (simulated reload); phone NOT TESTED.

Record phone model, Android version and Chrome version when this checklist is
run. Use [DEVICE_TEST_CHECKLIST.md](DEVICE_TEST_CHECKLIST.md).

---

## I. Performance findings

No mid-range Android measurements were possible. Code-level observations:

| Area | Finding | Recommendation |
|---|---|---|
| Initial load | Shell is small; `opencv.js` and the k-NN index are **not** loaded by the PWA | Keep them out of the phone path |
| Camera startup | One `getUserMedia` call with ideal 1920×1080; browser may downgrade | Measure on device; avoid overconstraint |
| Capture | One canvas + one JPEG encode (quality 0.9) + one data URL | Store blob; convert to data URL once for the request |
| Duplicate image copies | Blob **and** data URL are stored per capture | Acceptable for this sprint; future: store blob only and generate a data URL on demand |
| IndexedDB | Small project lists, indexed by `projectId` | Fine for demo scale; add pagination later |
| Request log | Capped at 40 rows, memory-only | No persistence growth |
| Provider latency | OpenRouter free vision can take 10–120 s; timeout 180 s | Show elapsed time; never auto-retry to avoid duplicate cost |
| Large assets | `pwa/icons` are small PNGs; no CDN | No change needed |

---

## J. Remediation plan and remaining work

| # | Severity | Issue | Status | Fix / evidence |
|---|---|---|---|---|
| J1 | **High** | Camera-off overlay stayed visible | **Fixed** | Global `[hidden]{display:none!important}`; simulated stream test |
| J2 | **High** | Key persisted when Remember checked | **Fixed** | Memory-only; legacy slots deleted; storage test |
| J3 | **High** | BlockRun privacy/vision risk | **Restored, blocked** | 402 + no CORS; visible with endpoint and reason, refused before network | 
| J4 | **High** | NIM unusable from a static page | **Restored, blocked** | No CORS; visible on phone, refused before network; full desktop path |
| J4b | **High** | Cloudflare workers AI absent from phone | **Restored, blocked** | OPTIONS 405 + no CORS; visible with endpoint |
| J4c | **High** | Modal paid/untested not represented | **Restored, labelled** | User `*.modal.run` endpoint; paid and NOT TESTED |
| J5 | **High** | Groq offered as a vision provider | **Fixed** | Groq is text-only; images refused before network |
| J6 | **Medium** | Model truth relied on public docs | **Fixed** | Live account catalogs and real image tests |
| J7 | **Medium** | Logs did not name the API/endpoint/model | **Fixed** | Phone request log; desktop success/failure logs |
| J8 | **Medium** | Physical camera/landscape unverified | **Open** | Run the device checklist on a real phone |
| J9 | **Low** | Duplicate image storage (blob + data URL) | **Open** | Store blob only; derive data URL at send |
| J10 | **Low** | CSP is meta-only | **Documented** | GitHub Pages header limits; custom relay needs `connect-src https:` |

### Remaining work before a public vision demo

1. On a real Android and iOS phone, run [DEVICE_TEST_CHECKLIST.md](DEVICE_TEST_CHECKLIST.md)
   and record the device/browser versions.
2. Send one real board photo from the live Pages URL and confirm the answer
   names something visible. Do not treat a synthetic success as proof of
   electronics accuracy.
3. Keep the phone key memory-only. Use the desktop app when key persistence is
   required.
4. Re-check provider prices, free quotas and CORS before a public demo; they are
   not guaranteed.

---

## Appendix — exact commands and environment

```cmd
git status --short
git log --oneline -3
node scripts\run-source-tests.mjs
node --check pwa\app.js
node --check pwa\provider.js
node --check server\routes\providers.js
node --check server\routes\analyze.js
node --check app.js
```

- Base commit before this session: `5f56532`.
- Live URL: `https://aizkinwork-star.github.io/intentlens/`.
- Local Node used for the audit: `v24.22.1`.
- No `.env`, secret, ZIP or build output is tracked by the repository.
- The supplied key file was used only for live provider tests and is deleted
  after the audit. Test sentinels are synthetic.
- Desktop credentials in `%APPDATA%\IntentLens\credentials.safe` were not read,
  printed, modified or deleted.
