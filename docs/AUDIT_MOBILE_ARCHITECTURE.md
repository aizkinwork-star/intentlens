# IntentLens — Mobile PWA Architecture Audit (Phase 0)

Status: **read-only audit of the existing app, plus the provider/mic/TTS fixes made in
this pass.** No PWA refactor has started. This document does not claim Android
support, offline inference, or GitHub Pages deployment.

Audit date: 2026-11-03
Repository: `C:\Users\hp\Desktop\IntentLens` (not a git repository at audit time)

---

## 1. What exists today (verified by reading the code, not by names)

### 1.1 Frontend

| Item | Reality |
| --- | --- |
| Framework | None. Vanilla HTML/CSS + native ES modules. No React/Vue/Svelte, no bundler. |
| Entry point | `index.html` (single page, one `<main>`), imports `app.js` as a module. |
| Build system | None for the browser. The Node server serves repo files as-is (`server/lib/static.js`). Electron packaging is the only "build". |
| Routing | No client router. One screen with popups (setup, project, logs, install). `?project=` style deep links do not exist. |
| State | Module-level `state` object in `app.js`; project id mirrored in `localStorage`. Server-side projects in SQLite. |
| PWA shell | `manifest.json` and `sw.js` exist. `sw.js` is registered from an inline script at the bottom of `index.html` (`./sw.js`). |
| Install UI | `#installPopup` / `#installApp` in `index.html`, wired in `app.js`. |
| Mobile helpers | `mobileSupport.js` reports secure-origin / camera / APK facts; `platform/` has browser/Electron adapter stubs. |

`app.js` is ~4,000 lines and mixes UI, camera, tracking, provider setup, speech,
TTS, and the beginner project workflow. It is the main monolith to split before a
PWA build.

### 1.2 Electron

| Item | Reality |
| --- | --- |
| Main process | `electron/main.js` starts the Node backend as a child process, injects `DATA_DIR`, `PORT`, and `ALLOW_OUTBOUND_NETWORK`. |
| Preload | `electron/preload.js` exposes a minimal IPC bridge for safeStorage. |
| Secrets | `server/lib/credentialStore.js` uses Electron `safeStorage` over IPC, falling back to Windows DPAPI. It refuses plaintext. |
| Packaging | `electron/package.json` + electron-builder; installer rebuilt in this pass: `electron/release/IntentLens Setup 0.4.0.exe`, 131,019,170 bytes, 2026-11-04 00:03. |

### 1.3 Backend

| Item | Reality |
| --- | --- |
| Server | Node's built-in `http`, no Express. `server/index.js` routes by pathname. |
| Auth | Local session token (`server/lib/auth.js`), injected into `index.html` as `<meta name="intentlens-token">`; every `/api/*` call must send it (except `/api/health` and `/api/pair`). |
| Persistence | `node:sqlite` `DatabaseSync` in `server/store.js`. Tables: `projects`, `project_docs`, `captures`, `images`, `objects`, `object_evidence`, `tasks`, `task_citations`, `sources`. Data dir `./intentlens-data` (or Electron userData), including image files. |
| Routes used by the beginner workflow | `POST /api/projects`, `GET/PATCH /api/projects/:id`, `POST /api/captures`, `GET /api/captures/:id`, `POST /api/component/analyze`, `POST /api/explain`, `GET/POST /api/providers`, `POST /api/providers/test`, `POST /api/providers/network`. |
| Provider adapters | `server/services/nimProvider.js`, `cloudflareProvider.js`, `groqProvider.js`, routed by `server/services/provider.js`. |
| Static serving | `server/lib/static.js` serves the repo root, blocks `.sqlite`, `.env`, logs, credential files. |
| STT | `POST /api/transcribe` proxies to a **loopback-only** whisper endpoint (`STT_URL`); unset by default. |

### 1.4 Tests

- `node scripts/run-source-tests.mjs` — 25 files, 201 tests, all passing after this pass.
- `node --test` runs the same files (some need ports 8201–8203).
- `scripts/smoke-mvp.mjs` exercises the packaged resource server (14 checks).
- No browser/IndexedDB/CORS/Android tests exist yet.

---

## 2. Actual data flow (traced)

### 2.1 Beginner project workflow (the one that matters for mobile)

```
User text
  -> app.js submitProjectIntent()
  -> POST /api/projects { intent }
  -> server projectPlanner.js builds { projectId, title, userGoal, plan, steps, parts }
  -> SQLite projects/project_docs
  -> response rendered by renderWorkspace()

Project UI
  -> startCamera() (user taps "Start camera")
  -> BrowserCameraAdapter.start() -> navigator.mediaDevices.getUserMedia({ facingMode: {ideal:'environment'} })
  -> video frame drawn to canvas; Capture creates a Blob + PNG/JPEG data
  -> POST /api/captures (original image + metadata) -> SQLite captures + image files
  -> capture id returned; original kept immutable

Analyze
  -> POST /api/component/analyze { projectId, captureId, question, gridSize }
  -> server builds project context + prompt (componentSchema.js)
  -> provider router -> NVIDIA NIM / Cloudflare / Groq (Meta vision only)
  -> JSON parsed and validated by componentResult.js (toComponentResult)
  -> response { analysis, project }
  -> app.js draws the evidence card + corners + instruction, saves object state
  -> Repeat: replays stored answer (0 AI requests)
  -> Explain: POST /api/explain (exactly 1 AI request)
```

Verified in this pass: the same prompt + a real PNG sent to
`meta/muse-glimmer-30b` returned structured JSON (`component`, `location: null`,
`next_action: "ask_question"`, `instruction`) and passed `toComponentResult`.

### 2.2 Legacy tracker workflow (not the mobile target)

Camera frames -> local grid/tracker -> `/api/analyze` (single-target grounding).
It is functional but separate from the project/evidence workflow. It must not be
used as the basis for the PWA rewrite.

---

## 3. Reusable modules (browser-safe today)

These files have no Node imports and can be used by a static PWA:

| Module | Purpose | Notes |
| --- | --- | --- |
| `projectPlanner.js` | Intent -> structured project/plan/parts | Pure logic; already tested. |
| `componentResult.js` | Model JSON -> validated normalized result | Rejects invented boxes/coordinates. |
| `grid.js` / `schema.js` | Grid math and result schema | Pure; tested. |
| `evidencePanel.js` | Evidence card data + drawing contract | Pure helpers; tested. |
| `captureOverlay.js` | Four-corner overlay drawing | Pure; tested. |
| `assistantActions.js` | Repeat/Explain/speech gating | Pure; tested. |
| `observerContext.js` / `observationContext.js` | Context summaries | Pure. |
| `localReferenceLookup.js` | k-NN candidates (advisory only) | Needs the frozen index; must stay advisory. |
| `intentlens_tts.js` | Browser SpeechSynthesis adapter | Fixed in this pass (Android voices). |
| `mobileSupport.js` | Secure-origin/camera capability report | Pure. |
| `cameraAdapter.js` / `platform/browser/cameraAdapter.js` | Rear-camera getUserMedia + capture | Reusable with permission-flow work. |
| `handTracker.js` / `componentDetector.js` | Optional local perception | Heavy (OpenCV.js); not required for the PWA. |

## 4. Desktop-only modules (must not be imported by the PWA build)

| Module | Why |
| --- | --- |
| `server/**` (all of it) | Node `http`, `node:sqlite`, filesystem, DPAPI, `.env`, loopback STT. |
| `electron/**` | Electron main/preload, safeStorage IPC, installer. |
| `server/lib/credentialStore.js` | DPAPI/safeStorage; the PWA cannot reuse it. |
| `server/services/*Provider.js` | They read keys from the server process and add schema hints server-side; the PWA needs browser adapters with the same interface but direct `fetch`. |
| `server/lib/static.js` / `server/index.js` | Static hosting/auth token injection disappears on GitHub Pages. |
| `scripts/*.py` / `datasets/**` / `knn_reference_db_compact.*` | Local evaluation and frozen artifacts; use read-only, never re-train in the PWA. |

`platform/index.js` imports `./electron/cameraAdapter.js` and
`./capacitor/cameraAdapter.js` that do not exist; those dynamic imports fall
through to browser today. A PWA build must not rely on that fallback.

---

## 5. Missing for the Android PWA

1. **Static build + base path.** No GitHub Pages workflow, no `base` handling for
   `/<repo>/`. `manifest.json` uses `start_url: "."` and `scope: "."` (relative,
   so it can work), but every fetch in `app.js` is absolute (`/api/...`) and will
   hit the Pages domain root, not the backend. The PWA needs a runtime
   `API_BASE` or, preferably, direct provider calls.
2. **Direct provider calls + CORS proof.** Today the key lives in the Node backend.
   The PWA must call the provider from the browser, keep the key in memory, and
   prove `OPTIONS` + `POST` from the deployed origin. This is unverified. Do not
   assume Node success implies browser success.
3. **Storage.** `platform/browser/storageAdapter.js` is a key/value IndexedDB
   wrapper with one shared store. It is **not** the Project/Conversation/Message/
   Object/Image/Settings repository model; its `set()` also spreads non-object
   values. Phase 1 needs real repositories, Blob storage, migrations, quota
   handling, export/import.
4. **Project isolation.** The UI currently restores the last project id from
   `localStorage` and lists projects from the server. There is no multi-project
   tab bar with independent conversations; the summary is per project but the
   screen is single-project.
5. **Camera permission UX.** `BrowserCameraAdapter` handles denied/not-found, but
   there is no status list (not requested / granted / denied / busy / blocked),
   no settings guidance, no explicit "save before analyze" transaction. Camera is
   already started only on tap — keep that.
6. **PWA icons.** `manifest.json` uses `data:image/svg+xml` icons. Android Chrome
   generally will not install a manifest whose icons are data URLs. Real 192/512
   PNG files are required.
7. **Service worker.** `sw.js` is network-first (good for updates) but caches only
   a subset of modules and has no version handshake in the UI. It must never cache
   provider responses, keys, captures or project data — currently it skips
   `/api/*` and non-GET, but project data would move to IndexedDB, not HTTP.
8. **Export ZIP.** Not implemented. Must be local-only, user-selected, and never
   upload.
9. **Android tests.** Impossible in this environment. No phone, no deployed URL.

---

## 6. Security findings (this pass)

| Finding | Status |
| --- | --- |
| `API(SECRETS).txt` in repo + Desktop copy | **Deleted** after testing. `.gitignore` now ignores `API(SECRETS).txt`, `*SECRETS*.txt`, `*.pem`, `*.key`, `.env.*` (except `.env.example`). |
| Plaintext keys in `.env` | NIM/Cloudflare values cleared. `.env` is ignored and never bundled. |
| Keys in logs / screenshots / build | Scanned repo + `%APPDATA%\IntentLens` + `app.asar`: no `nvapi-`/`gsk_`/Bearer hits. The only `nvapi-` match is a 42-char fake fixture in `looseObjectTracker.compact.test.js`, not a real key. |
| Server binds `0.0.0.0` | Any LAN device with the session token can call the API. Token is injected into HTML and printed nowhere. Keep the server on localhost for normal use; do not expose the port. |
| API keys in browser | PWA must keep keys in memory by default. Never in query strings, URLs, logs, IndexedDB without an explicit "remember" warning, or the build. |
| Model output rendering | Current UI uses `textContent` for answers; keep it. No `innerHTML` from model output. |
| Provider CORS | Unknown. Must be tested from the deployed origin. `no-cors` is not a workaround. |

Note: `.env` now enables outbound network for this local workspace. The packaged
Electron app still defaults `ALLOW_OUTBOUND_NETWORK=false`. The setup popup now
offers a **session-only, confirm-gated** button (`POST /api/providers/network`)
so a packaged install can opt in without editing files; a restart returns to the
packaged default. To make it permanent for a packaged install, set the Windows
user environment variable `ALLOW_OUTBOUND_NETWORK=true` and relaunch — the app
never enables cloud requests silently.

---

## 7. Provider reality (verified in this pass)

| Provider / model | Result |
| --- | --- |
| NIM `meta/muse-glimmer-30b` | **HTTP 200, verified with a real image.** Returns valid structured JSON. Slow: 6–15s for short text, ~80–105s for the full component prompt. Reasoning output can land in `reasoning_content`; the adapter now reads both. |
| NIM `meta/llama-3.2-11b-vision-instruct` | HTTP 404 `Function ... is not found` for this account. Marked `verified: false`. |
| NIM `meta/llama-3.2-90b-vision-instruct` | Timeout >90s. Marked `verified: false`. |
| NIM `meta/llama-4-maverick-17b-128e-instruct` | HTTP 410, EOL 2026-07-27. Removed from the NIM catalog. |
| Cloudflare Workers AI, supplied Account ID + token | `401 Authentication error` / `Invalid API Token`. **The supplied token is not valid** (checked at `/ai/run/*` and `/user/tokens/verify`). No live Cloudflare inference was possible. Models listed in the catalog as unverified. |
| Groq | The supplied file's "Groq" slot duplicates the Cloudflare token; no `gsk_` key exists. Playground on this account exposed only Prompt Guard models. Groq vision remains **unverified**. |

What the user must do for Cloudflare: create a **new** API token in the dashboard
(`My Profile → API Tokens → Create Token → Custom token`), permission
`Account → Workers AI → Read` (or `Read all resources`), scoped to the account,
then paste the token + the 32-char Account ID in setup.

---

## 8. Changes made in this pass (files + why)

| File | Change |
| --- | --- |
| `server/config.js` | NIM default -> `meta/muse-glimmer-30b`; removed EOL Maverick; added `verified`/`note` metadata; added the Cloudflare Meta models the user listed; added Groq Prompt Guard entries. |
| `server/lib/credentialStore.js` | NIM default model -> Muse Glimmer. |
| `server/routes/providers.js` | Same default; model list now exposes `verified`/`note`/`modelVerified`; new confirm-gated `handleSetOutboundNetwork`. |
| `server/services/nimProvider.js` | Reads `reasoning_content`/`reasoning` when `content` is null; extracts JSON from mixed text; 180s timeout; 3072 max tokens; 30s health check. |
| `server/index.js` | Route `POST /api/providers/network`. |
| `app.js` | Mic auto-start (default on, persistent `Mic on start` toggle, one attempt per launch, graceful gesture-failure hint); TTS init fixed (async, status callback, Android voices); `Test voice` button; provider test messages now explain network/auth/model errors; secure-storage message; model dropdown shows verified/not verified; session-only outbound button. |
| `index.html` | `Mic on start` toggle; `Test voice`; Cloudflare/NVIDIA/Groq help rewritten to match reality; outbound opt-in row. |
| `style.css` | Styling for the mic toggle. |
| `intentlens_tts.js` | Do not filter to `localService` voices (Android Chrome); accept all voices; treat SpeechSynthesis as available while voices load; `init(options)` now wires `onStatus`. |
| `providerCatalog.test.js` | Updated for the corrected catalog. |
| `.gitignore` | Secret filenames and key extensions. |
| `API(SECRETS).txt` (repo + Desktop) | Deleted after testing. |

### Verification run in this pass

- `node scripts/run-source-tests.mjs` -> **201 passed, 0 failed**.
- Live NIM route test (server on 127.0.0.1:8011):
  - `GET /api/local-model` -> NIM configured, model `meta/muse-glimmer-30b`, `modelVerified: true`.
  - `POST /api/providers/test` (Muse) -> `ok: true`, 6.4s.
  - `POST /api/providers/test` (11B) -> `category: model_unavailable`, HTTP 404 (honest, no fake success).
  - Cloudflare test with an invalid token -> `category: auth`, HTTP 401.
  - `POST /api/providers/network {allow:true}` -> 400 `CONFIRMATION_REQUIRED`; with `confirm:true` -> 200, session enabled.
- Real image component test: Muse returned valid JSON, `toComponentResult` -> `ok: true`, `location: null` for a missing LDR with `next_action: ask_question`.
- Rebuilt packaged app (`electron/release/win-unpacked/IntentLens.exe`) launched and served `/api/health`.
  - Saved credentials migrated the old NIM default to `meta/muse-glimmer-30b`.
  - Packaged `POST /api/providers/test` with the saved key: **ok: true**, 1.7s.
  - Packaged outbound toggle: enabled -> true, then restored to false.
  - `app.asar` contains the new UI strings, and contains no `nvapi-`/`gsk_` key patterns.
- **Mic auto-start caveat:** it attempts once per launch. Chrome may refuse a
  gestureless `SpeechRecognition.start()`; the app then shows
  "Mic idle — tap the mic to speak" instead of looping. The toggle is
  `Mic on start`, persisted in `localStorage`, default ON.

---

## 9. Recommended implementation plan

1. **Storage abstraction (Phase 1).** Define repository interfaces and an
   IndexedDB adapter with stores for projects, conversations, messages, objects,
   images (Blob), settings, provider profiles. Add migrations, quota handling,
   `navigator.storage.persist()`, export/import.
2. **Project isolation (Phase 1.3/1.4).** Each project = its own conversation.
   Recent-project tabs restore messages/objects/images. Deletion cascades with
   confirmation. Build a compact context summary; never send full history.
3. **Static PWA build (Phase 2).** Add a GitHub Pages workflow, real PNG icons,
   correct `start_url`/`scope`/base for the repo subpath, and a version/update
   handshake. Keep the Electron base unchanged.
4. **Camera (Phase 3).** Permission state machine, rear camera, track cleanup,
   capture -> original Blob + inference copy, save transaction before reporting
   success, orientation/coordinate mapping, retake.
5. **Provider CORS proof (Phase 4).** Test `OPTIONS` + `POST` with a real image
   from the deployed origin for NIM and Cloudflare. Add browser-native provider
   adapters (same interface, provider-specific image schema). If CORS fails,
   document the limitation; do not fake a proxy or ship a key.
6. **Structured localization (Phase 5).** Reuse `componentSchema.js` and
   `componentResult.js`; validate coordinates; draw only validated corners; store
   one active target per project.
7. **Evidence + guidance (Phase 5.4–5.5).** Original image, expandable card,
   aligned marker after resize/rotation, plain-language + simplified location.
8. **Repeat/Explain + speech (Phase 6).** Keep Repeat at 0 requests, Explain at
   exactly 1. Keep the text answer when TTS fails.
9. **Optional ZIP export (Phase 7).** Local-only, user-selected, manifest,
   explicit consent, no upload.
10. **Android tests (Phase 9.2).** Real phone, Chrome, documented model/version.
11. **Desktop regression (Phase 9.3).** Re-run 201 tests + packaged smoke +
    installer build.
12. **Final audit (Phase 10).** `FINAL_RELEASE_AUDIT.md` with evidence and every
    remaining limitation.

---

## 10. Blockers

- **No Android device / no deployed GitHub Pages URL in this environment.** PWA
  installability and camera behaviour cannot be claimed until tested there.
- **Cloudflare credentials are invalid.** Need a newly created Workers AI token.
- **Groq key missing and vision unverified.**
- **Muse Glimmer latency (80–120s for a full analysis).** Acceptable for a
  single-target flow, but the UI must show progress and allow cancel.
- **NIM 11B/90B are not usable on this account.** Only Muse Glimmer is verified.
- **Browser CORS for NIM/Cloudflare is unproven from a Pages origin.** This is a
  release-critical test in Phase 4.

---

## 11. Bottom line

The existing app already has the valuable, testable parts: validated component
results, one-image capture, project planning, evidence rendering, Repeat/Explain,
and a Meta-only provider layer. What it does **not** have is a browser persistence
layer, a static GitHub Pages build, direct browser provider calls with CORS proof,
or any real phone test. Those are the next phases; none of them is done yet.
