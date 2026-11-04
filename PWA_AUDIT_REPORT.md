# IntentLens PWA — Pre-Release Audit Report

Date: 2026-11-04
Repository: `https://github.com/aizkinwork-star/intentlens`
Live PWA: `https://aizkinwork-star.github.io/intentlens/`
Scope: `pwa/`, `scripts/prepare-pwa.mjs`, `scripts/serve-pwa.mjs`, `.github/workflows/pages.yml`, PWA tests. The Electron app, desktop server, SQLite data, and frozen k-NN/scaler artifacts were not modified.

> Status vocabulary: **PASS** = verified in this environment; **PASS (simulated)** = verified with a mocked browser/provider; **NOT TESTED** = requires a physical Android device or a real provider key; **BLOCKED** = provider/host prevents the action.

---

## A. Executive result

**READY WITH LIMITATIONS.**

What is genuinely fixed and verified:

- The “Camera is off” overlay no longer stays visible after the camera stream starts. Root cause was `.stageEmpty { display: grid; }` overriding the user-agent `[hidden]` rule; the app now has a global `[hidden] { display: none !important; }`. Verified in a browser by starting a mocked `MediaStream`: computed `display` became `none`.
- A **Chat** mode now exists in the same project tab. It sends **text only**; the request body contains one `text` part and **no** `image_url`. Verified with a mocked provider call.
- Providers: Groq default changed from the reported-unavailable Scout to `meta-llama/llama-4-maverick-17b-128e-instruct`; OpenRouter and BlockRun presets added. No silent model/provider fallback.
- API keys are memory-only. The old “Remember key” path is removed, legacy `apiKey`/`rememberKey` IndexedDB entries are deleted on boot, and a **Clear key** control exists. Verified: no key in localStorage/sessionStorage/IndexedDB/URL, and reload clears it.
- BlockRun has a blocking consent checkbox and a prominent retention/unverified-vision warning. Its direct browser CORS was observed blocked.
- Landscape-responsive CSS, orientation-lock attempt with fallback, resize/orientation recalculation, four edge-midpoint markers, and a rotate hint were added.

What prevents a plain **READY**:

1. **No physical Android device was available.** Camera permission, rear-camera selection, landscape rotation, saved orientation, and marker alignment on a real phone are **NOT TESTED**.
2. **No real provider key was available.** No live Groq/OpenRouter vision request was made. The vision path is code-reviewed and unit-tested with a mocked response, not certified against a live model.
3. **Groq’s public model table on 2026-11-04 did not list a Llama 4 vision model.** The API schema still names Maverick/Scout. Whether Maverick is enabled on the user’s Groq account is **unverified**.
4. **BlockRun direct browser calls are CORS-blocked** in the observed preflight, and its own SDK README disputes vision reliability. It is integrated behind consent, not recommended for private data.

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
| Camera stream | RAM; tracks stopped on stop/hide/pagehide | `startCamera`, `stopCamera` |
| Service worker shell | Cache Storage `intentlens-pwa-v6` | `pwa/sw.js` |

### B2. Data flow

1. Project created in `createProject()` → `db.createProject` → IndexedDB.
2. A user message is written by `db.addMessage` before any provider call.
3. Camera acquired only after the user taps **Start camera** (`getUserMedia`, rear camera ideal, audio `false`).
4. Capture uses `video.videoWidth`/`videoHeight` via `computeCaptureSize`, draws one canvas, stores one JPEG blob + data URL in IndexedDB.
5. Prompt assembled in `pwa/prompt.js` (`buildComponentPrompt`, `buildChatPrompt`, `buildExplainPrompt`).
6. Vision mode passes the captured data URL as `image_url`; chat mode calls `callChatModel`, which forces `imageDataUrl: null`.
7. Response read in `pwa/provider.js`; JSON extracted; `toComponentResult` validates 0–1 coordinates before drawing.
8. Result and message saved to IndexedDB; SVG overlay draws a dashed outline and four edge midpoints.
9. No upload happens on project create, message write, capture, save, reopen, reload, or delete. Only **Send** in cloud-enabled mode calls a provider.

### B3. External destinations

| Destination | Purpose | Classification |
|---|---|---|
| `aizkinwork-star.github.io` | Static shell, JS, CSS, icons, manifest, SW | GitHub Pages assets |
| `api.groq.com` | Only if Groq selected + Send | Selected AI provider |
| `openrouter.ai` | Only if OpenRouter selected + Send | Selected AI provider |
| `blockrun.ai` | Only if BlockRun selected + consent + Send | Selected AI provider (CORS blocked in test) |
| `integrate.api.nvidia.com` | Only if NIM selected + Send | Selected AI provider (CORS blocked) |
| User-entered custom HTTPS relay | Only if Custom selected + Send | User-chosen provider |
| `fonts`/CDN/analytics | None | Not present |

No analytics, telemetry, cloud sync, hosted database, or IntentLens-owned backend exists.

---

## C. Privacy audit

| Data type | Stored where | Leaves device? | When | Recipient | Local retention | Risk |
|---|---|---|---|---|---|---|
| Project name | IndexedDB | No | Never | — | Until deleted | Low |
| Messages | IndexedDB | Only the current prompt/history excerpt in a chat request | User presses Send | Selected provider | Until deleted | Medium: chat history excerpt (last 12 messages, 1200 chars each) is sent |
| Captured image | IndexedDB (blob + data URL) | Only in vision mode | User presses Send | Selected provider | Until project deleted | Medium: image leaves only on explicit action |
| Component result | IndexedDB | No | Never | — | Until deleted | Low |
| API key | RAM only | Only in `Authorization` header | Provider request | Selected provider | Until reload/tab close/Clear | Medium: browser-origin JS and device owner can read it while open |
| Settings | IndexedDB | No | Never | — | Until cleared | Low |
| Camera stream | RAM | No live stream is sent | Never | — | Stopped on stop/hide/pagehide | Low |
| Service worker cache | Cache Storage | No | Never | — | Static shell only | Low |

**Exact cloud boundary:** one still image (vision only), the current question, and a trimmed project/chat context. No other project, no full database, no settings, no key in URL, no live stream. Chat mode sends no image.

**UI disclosure:** the cloud card names the provider and model and states that the still image and prompt leave the device on Send; it states project history stays local. BlockRun adds a separate consent gate and retention warning.

---

## D. API key security findings

| # | Finding | Severity | Evidence / file |
|---|---|---|---|
| D1 | Old build persisted the key in IndexedDB when “Remember” was checked | **High** (fixed) | Legacy code removed; `deleteSetting('apiKey')` and `deleteSetting('rememberKey')` run on boot (`pwa/app.js`) |
| D2 | Key is now memory-only; masked input; cleared on reload and by Clear key | PASS | Browser test after reload: key field empty, no `apiKey` setting |
| D3 | Key never appears in URL/query; only `Authorization: Bearer` | PASS | Mocked request: URL did not contain sentinel; header did |
| D4 | No key in localStorage/sessionStorage/Cache/IndexedDB | PASS | Browser test returned `[]`, `[]`, and settings keys without `apiKey` |
| D5 | Error/log output does not echo the key | PASS (test) | Sentinel network-failure test asserts the result JSON does not contain the key |
| D6 | Browser-side protection is not a secret vault | Documented | UI warning in Settings; XSS/device owner can read the key while the tab is open |
| D7 | XSS-safe rendering | PASS (code review + unit test) | Untrusted values use `textContent`; project options use `escapeHtml`; `safeHref` rejects `javascript:`/`data:` |
| D8 | CSP present but header unverified | Limitation | Meta CSP in `pwa/index.html`; GitHub Pages cannot set response headers, so `frame-ancestors` is not claimed |
| D9 | SQL injection | **NOT APPLICABLE** | PWA uses IndexedDB, not SQL. Desktop SQLite untouched |

No real key was requested, displayed, logged, committed, or screenshotted during this audit. Automated tests use synthetic sentinels.

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
| Landscape CSS and controls | PASS (code) | `@media (orientation: landscape) and (max-height: 620px)` two-column grid |
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
| Vision request includes one `image_url` data URL | PASS (mocked test) |
| Blob URL is never sent as a remote image URL | PASS (code): only `canvas.toDataURL(...)` is passed |
| Chat request contains no image part | PASS (mocked test + browser test) |
| Text-only success is not reported as vision success | PASS (UI text says “no image was sent” for chat) |
| Real Groq vision on the user’s account | **NOT TESTED — KEY REQUIRED** |
| Real OpenRouter vision | **NOT TESTED — KEY REQUIRED** |
| BlockRun vision | **BLOCKED/UNVERIFIED** — CORS preflight returned no `Access-Control-Allow-Origin`; its own SDK README reports incorrect answers at HTTP 200 |
| Invalid key/model/rate-limit/network/malformed responses | PASS (unit/error mapping); live not tested |

**Groq availability evidence (2026-11-04):** `https://console.groq.com/docs/models` listed `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, Whisper, Prompt Guard, `meta-models/muse-spark-open`, and Qwen — no Llama 4 vision model in the table. The API schema still names `meta-llama/llama-4-maverick-17b-128e-instruct` and `meta-llama/llama-4-scout-17b-16e-instruct`. The app therefore uses Maverick as the Groq default but labels vision as unverified.

**OpenRouter live catalogue (GET `https://openrouter.ai/api/v1/models`, 2026-11-04):**
- `meta-llama/llama-4-maverick` — text+image, paid: $0.1875/M input, $0.6525/M output.
- `meta-llama/llama-4-scout` — text+image, paid: $0.10/M input, $0.30/M output.
- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` — text+image+video+audio, **free** — used as the OpenRouter preset default.
- No free Meta Llama model was observed. `meta/muse-glimmer-30b` exists but is paid and not image-capable in this listing.

**CORS evidence (real browser preflight from the Pages origin):**
- Groq: `access-control-allow-origin: *` → readable 401 with a synthetic key.
- OpenRouter: `Access-Control-Allow-Origin: *` → allowed.
- NVIDIA NIM: no allow-origin header → `Failed to fetch`.
- BlockRun: `OPTIONS` 204/200 without `Access-Control-Allow-Origin` → browser call blocked.
- Cloudflare Workers AI: `OPTIONS` 405.

---

## G. Automated test results

Commands run:

```cmd
node --test pwa\chat.test.js
node scripts\run-source-tests.mjs
node scripts\prepare-pwa.mjs
node --check pwa\app.js
```

Final result: **217 tests, 217 passed, 0 failed, 0 skipped, 0 cancelled** (201 existing + 16 PWA tests). New PWA tests cover:

- Text chat prompt has no image markers.
- Chat request body has only a `text` part; no `image_url`.
- Vision request does include one `image_url` when an image is supplied.
- Provider defaults/consent/vision metadata; Groq no longer defaults to Scout.
- Sentinel key never appears in a network error.
- Camera error mapping and true-frame capture dimensions.
- Four edge midpoints and polygon points.
- HTML escaping and `javascript:`/`data:` rejection.
- Static scans: no `setSetting('apiKey')`; legacy key/remember slots deleted.
- Service worker rejects non-GET, cross-origin, and Authorization-bearing requests.
- A deployed worker change triggers one controlled reload, and a new shell cache bypasses the HTTP cache rather than copying stale assets.

Browser smoke test (localhost, simulated camera/provider):

- No console warnings/errors.
- Mocked stream start → camera-off overlay `display: none`.
- Chat send → one OpenRouter request, content types `['text']`, `hasImagePart: false`.
- Key only in `Authorization` header, not URL.
- Reload → key field empty; chat history kept; cloud off.
- BlockRun consent unchecked → save blocked; checked → save allowed.
- IndexedDB settings: no `apiKey`, no `rememberKey`.

### G1. CI and live deployment verification

The first Pages run after these changes (`41778799620`) failed before deploy because the workflow used Node 20 and the desktop store tests import `node:sqlite`, which exists only from Node 22.5. The gate now uses Node 24 and `package.json`/lock declare `>=22.5`. Subsequent runs completed successfully and deployed `pwa/`.

Live origin `https://aizkinwork-star.github.io/intentlens/` was checked after the final deploy (`b69df5b`):

| Check | Result |
|---|---|
| Pages workflow conclusion | **PASS** (deploy job completed) |
| `manifest.webmanifest` | **PASS**: `orientation: "any"` |
| Service worker | **PASS**: `intentlens-pwa-v6`, 16 shell entries including `app.js`, `index.html`, `sw.js` |
| Current `app.js` served | **PASS**: chat code and worker-update handler present |
| Camera-off overlay after mocked stream start | **PASS (simulated)**: `hidden: true`, computed `display: none` |
| Chat request | **PASS (simulated)**: one request to `openrouter.ai`, content types `['text']`, no `image_url` |
| Chat default model | **PASS**: `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`; no silent switch |
| Key handling | **PASS**: key only in `Authorization`; absent from URL/localStorage/sessionStorage/IndexedDB |
| Reload | **PASS**: key field empty, chat history kept, cloud off |
| BlockRun consent gate | **PASS**: save blocked until the checkbox is ticked; warning visible |
| Browser console | **PASS**: no warnings or errors |
| Physical Android camera / real vision | **NOT TESTED — DEVICE/KEY REQUIRED** |

GitHub Pages serves static files with `Cache-Control: max-age=600`. A returning client can therefore run the previous cached shell once after a deploy; the new worker now reloads the page once when it takes control, and install fetches with `cache: 'reload'` so a new versioned cache cannot be poisoned by an unexpired HTTP cache. This behavior was verified in the live browser after clearing the old worker and cache.

> These are simulated browser tests on the live origin. They do not prove a physical phone camera or a real provider vision response.

---

## H. Manual Android test results

All items below are **NOT TESTED — DEVICE REQUIRED** unless marked otherwise. No physical Android device was connected.

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
15. Enter user’s own Groq key — NOT TESTED (no key requested).
16. Select the vision model — NOT TESTED.
17. Enable cloud for session — PASS (simulated); phone NOT TESTED.
18. Send the captured image — NOT TESTED with a real provider.
19. Verify visual identification — NOT TESTED.
20. Verify location description — NOT TESTED.
21. Verify marker — PASS (unit geometry); phone NOT TESTED.
22. Close the installed PWA — NOT TESTED.
23. Reopen — NOT TESTED.
24. Project/image persistence — PASS (simulated reload); phone NOT TESTED.
25. Key not restored — PASS (simulated reload); phone NOT TESTED.

Record phone model, Android version, and Chrome version when this checklist is run.

---

## I. Performance findings

No mid-range Android measurements were possible. Code-level observations:

| Area | Finding | Recommendation |
|---|---|---|
| Initial load | Shell is small; `opencv.js` and k-NN index are **not** loaded by the PWA | Keep them out of the phone path |
| Camera startup | One `getUserMedia` call with ideal 1920×1080; browser may downgrade | Measure on device; avoid overconstraint |
| Capture | One canvas + one JPEG encode (quality 0.9) + one data URL | Store blob; convert to data URL once for the request |
| Duplicate image copies | Blob **and** data URL are stored per capture | Acceptable for this sprint; future: store blob only and generate data URL on demand |
| IndexedDB | Small project lists, indexed by `projectId` | Fine for demo scale; add pagination later |
| Memory | Canvas and data URL are local variables after capture | Revoke object URLs if added later; currently no `createObjectURL` usage |
| Provider latency | Groq/OpenRouter vary; timeout 180 s | Show elapsed time; do not auto-retry to avoid duplicate cost |
| Large assets | `pwa/icons` are small PNGs; no CDN | No change needed |

---

## J. Remediation plan

| # | Severity | Issue | File | Root cause | Reproduction | Minimal fix | Data migration | Regression test | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| J1 | **High** | Camera-off overlay stayed visible | `pwa/styles.css` | `.stageEmpty { display:grid }` beat `[hidden]` | Start camera; overlay remained | Global `[hidden]{display:none!important}` | None | Simulated stream test (done) | Revert CSS block |
| J2 | **High** | Key persisted when Remember checked | `pwa/app.js` | `setSetting('apiKey')` | Tick Remember, save, reload | Memory-only; delete legacy slots | Deletes old plaintext key | Static scan (done) | Revert to previous build; old key already deleted |
| J3 | **High** | BlockRun privacy/vision risk | `pwa/provider.js`, `pwa/index.html` | Marketing/privacy conflict; SDK disputes vision | Select BlockRun | Consent gate + warning + no default | None | Consent gate test (done) | Remove preset |
| J4 | **Medium** | Groq model availability unverified | `pwa/provider.js` | Scout unavailable; docs table lacks Llama 4 | Select Groq + Send | Maverick default + explicit “verify account” note | None | Provider metadata test (done) | Change model ID |
| J5 | **Medium** | Physical camera/landscape unverified | whole PWA | No device | Run Phase 12 checklist | Must be tested on Android | None | Manual checklist | N/A |
| J6 | **Medium** | Real vision unverified | `pwa/provider.js` | No key | Send a real board photo | Use user’s key; confirm image accepted; record returned model | None | Live canary (not run) | Keep text chat usable |
| J7 | **Medium** | BlockRun browser CORS blocked | `pwa/provider.js` | No `Access-Control-Allow-Origin` | Select BlockRun + Send | Use server SDK/relay or another provider | None | CORS probe (done) | Remove preset |
| J8 | **Low** | Duplicate image storage (blob + data URL) | `pwa/store.js` | Simplicity | Capture several images | Store blob only; derive data URL at send | Existing rows remain readable | Storage test | Keep both fields |
| J9 | **Low** | CSP is meta-only | `pwa/index.html` | GitHub Pages header limits | Inspect response headers | Document limitation; use a host that supports headers if needed | None | Header check | Remove meta |

### Remaining work before a public vision demo

1. On a real Android phone, run the Phase 12 checklist and record the device/browser versions.
2. With the user’s own Groq key, send one real board photo and confirm the response names something visible; record the exact returned model ID.
3. If Groq has no vision model, test the OpenRouter free NVIDIA Omni preset or the paid Meta Maverick preset; do not silently switch.
4. Do not use BlockRun for private images until its CORS, vision quality, and retention conflict are resolved.

---

## Appendix — exact commands and environment

```cmd
git status --short
git log --oneline -3
node --test pwa\chat.test.js
node scripts\run-source-tests.mjs
node scripts\prepare-pwa.mjs
node --check pwa\app.js
```

- Current base commit before this work: `c7c0554`.
- Feature commit: `a34aeac`.
- CI fix (Node 24 / `node:sqlite`): `d81dac8`.
- Worker auto-update: `bea7e07`.
- Shell cache v6 / HTTP-cache bypass: `b69df5b` (last live-verified code commit).
- Live URL: `https://aizkinwork-star.github.io/intentlens/`.
- No `.env`, secret, ZIP, or build output is tracked by the repository.
- No real API key was used in any test. All keys in tests are synthetic sentinels.
