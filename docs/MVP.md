# IntentLens 0.4.0 — Screenshot-Guided Beginner Electronics Assistant

This is the deliverable note for the 10-hour MVP refocus.

**Status in one line:** the full local workflow (project → align → still capture → local reference lookup → AI analysis request → validated box → evidence panel → written step) is implemented and verified on Windows with a configured-but-offline provider gate. Live Meta vision reasoning was **not** exercised, because outbound network access to a provider was not approved in this environment.

---

## 1. What this release is

IntentLens is now a beginner electronics assistant rather than a real-time tracking demo.

A beginner describes what they want to build. IntentLens turns that sentence into a small structured project (goal, parts, safety notes, ordered steps). When the beginner is unsure about a part or a connection, they align the board, take **one still capture**, and the app asks a vision model to identify the part **in the context of that project**. The answer comes back as a boxed region on that specific capture, an evidence panel showing the same still with the region outlined, a written instruction, and a next step.

Nothing is tracked between frames. There is no continuous hand, person, or object tracking in this workflow.

## 2. Scope decisions

Kept and extended:

- Camera adapter, 64×64 product grid, provider router, SQLite store, desktop shell and installer.

Frozen for this release (code present, UI hidden, runtime disabled):

- Admin/person silhouette detection.
- Hand detection and hand-outline tracking.
- Component/chip contour detector.
- Loose-object tracking (`looseMode`).
- Training, PCB registration, cross-mode transfer panels.

Why: raw contours drawn from skin/brightness segmentation looked like component detections even when they were not. In this release the only boxes drawn on the main canvas are **validated model results** and the **evidence panel** for the current capture. The legacy toggles are force-disabled in `wireAssistant()`, so a stale saved setting cannot turn them back on.

Preserved unchanged (frozen artifacts):

- `knn_reference_db_compact.bin` / `.json` / `.meta.json`
- `datasets/processed/feature_scaler.json`
- medoid selection/evaluation outputs and reports
- `API(SECRETS).txt`, `.env` credentials, provider secrets

## 3. Architecture

### 3.1 End-to-end flow

```
beginner sentence
      │
      ▼
projectPlanner.createProjectFromIntent()        (client, pure JS)
      │  goal · parts expected/available/confirmed · 6 starter steps · safety notes
      ▼
POST /api/projects  ──────────►  project_docs (SQLite, JSON document)
      │
      ▼
workspace card: current step, parts, safety, progress
      │  "I'm aligned" after camera/photo shows the board
      ▼
still capture (canvas → JPEG)  ──►  POST /api/captures
      │                               original + transparent grid overlay
      │                               written once with flag "wx" (immutable)
      ▼
local k-NN whole-frame lookup (client, FeatureExtractor + KNNClassifier)
      │  labelled "unverified candidate"; raw distance is never a probability
      ▼
POST /api/component/analyze { projectId, captureId, question }
      │
      │  providerGate: outbound allowed? provider configured?
      │      no  → 200 { status: "unavailable" }   (no network attempt)
      │      yes → exactly one router call with schema + 2 images
      ▼
componentResult validation
      │  0–1000 model integers → 0–1 normalized
      │  4 ordered corners (TL,TR,BR,BL), non-self-intersecting
      │  center inside the outlined region
      │  grid cell derived from center
      │  invalid → rejected, nothing drawn, no clamping
      ▼
project doc updated: object record + capturedImages + lastAnalysis + lastAnswer
      │
      ▼
evidence panel (original + overlay + validated corners + honest status)
      │
      ▼
text instruction ──► step instruction ──► "Next step"
```

### 3.2 Client modules (new)

| File | Role |
| --- | --- |
| `projectPlanner.js` | Intent parsing, skill level, expected vs available vs confirmed parts, starter plan, safety notes, project/object/capture helpers, serialization. |
| `componentResult.js` | Strict 0–1000 → 0–1 conversion, four-corner consistency, center-in-polygon, derived grid cell, client-side validation. No clamping. |
| `captureOverlay.js` | Pure `buildGridOverlaySvg()` plus browser `drawGridOnCanvas()`; 1-based row/column labels, origin top-left. |
| `evidencePanel.js` | Builds the evidence-card model: capture, object, `analysisState`, corners, meta. |
| `assistantActions.js` | Repeat (reuse stored answer, zero requests), Explain (exactly one request); both are text-only. |
| `localReferenceLookup.js` | Turns k-NN output into explicitly unverified candidates; never a probability. |
| `mobileSupport.js` | Detects secure context / camera capability and explains the LAN-HTTP limitation without weakening auth. |

### 3.3 Server modules (new / rewritten)

| File | Role |
| --- | --- |
| `server/services/componentSchema.js` | Component analysis and explanation JSON schemas and prompts (project-aware, anti-invention rules). |
| `server/services/providerGate.js` | Single gate: `ALLOW_OUTBOUND_NETWORK` **and** a configured provider, or the route reports unavailability. |
| `server/routes/componentAnalyze.js` | Request parsing, one router call, validation, object persistence, `lastAnalysis` persistence, honest error mapping. |
| `server/routes/explain.js` | Explanation route with exactly one provider request. |
| `server/routes/projects.js` | Project create/list/get/update over the JSON document store. |
| `server/routes/captures.js` | Capture create/get/file handlers, duplicate-ID rejection, overlay fallback. |

### 3.4 HTTP API added

All `/api/*` routes except `/api/health` require the session token header `x-intentlens-token` (injected by the client's fetch wrapper).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/projects` | Create project from an intent sentence. |
| `GET` | `/api/projects` | List recent projects. |
| `GET` | `/api/projects/:id` | Load one project document. |
| `PUT`/`PATCH` | `/api/projects/:id` | Persist project state (step, parts, objects, last answer). |
| `POST` | `/api/captures` | Store an immutable capture + overlay. |
| `GET` | `/api/captures/:id` | Capture metadata. |
| `GET` | `/api/captures/:id/original` | Original still bytes. |
| `GET` | `/api/captures/:id/overlay` | Raster overlay if uploaded, else server SVG grid. |
| `POST` | `/api/component/analyze` | One vision request for the current capture, or an explicit unavailable result. |
| `POST` | `/api/explain` | One explanation request for the current answer. |

`/api/analyze` and the older object/task routes are untouched.

### 3.5 Storage

- SQLite (`node:sqlite`, WAL) in the data directory.
- New tables: `project_docs` (structured project JSON) and `captures` (metadata + file references, indexed by project).
- Capture files are written once with `flag: 'wx'`. A repeated capture ID returns `409 CAPTURE_EXISTS` instead of overwriting evidence.
- Deleting a project removes its capture rows and files.
- Objects live inside the project document and are keyed by `captureId`; they are never re-projected onto a later frame.

### 3.6 Coordinate contract (enforced, not cosmetic)

1. The model must answer with **integers 0–1000**.
2. The server converts to normalized 0–1 (`value / 1000`), rejecting anything outside 0–1000.
3. Exactly four corners are required, in order TL → TR → BR → BL; self-intersecting ("bow-tie") orders are rejected.
4. The center must lie inside the corner polygon.
5. The grid cell is derived from the center (1-based row/column over the 64×64 active grid).
6. Contradictory results are rejected with **no box drawn**; nothing is silently clamped.
7. The model cannot mark its own output as "confirmed by you" — only an explicit user action sets that.

### 3.7 Honesty rules implemented in code

- No provider configured → `unavailable`, no network request, capture preserved.
- Invalid coordinates → `rejected`/`invalid`, no box, no invented component.
- Local k-NN → "unverified candidate", distance shown as distance, never a percentage.
- Evidence statuses are literal: `Captured — waiting for analysis`, `Captured — AI unavailable, saved locally`, `Captured — AI result rejected, no box drawn`, `Captured — coordinates failed validation`, `AI candidate — confirm or correct`, `Confirmed by you`.

## 4. Files changed

New:

- `componentResult.js`, `projectPlanner.js`, `captureOverlay.js`, `evidencePanel.js`, `assistantActions.js`, `localReferenceLookup.js`, `mobileSupport.js`
- `server/services/componentSchema.js`, `server/services/providerGate.js`
- `server/routes/componentAnalyze.js`, `server/routes/explain.js`, `server/routes/projects.js`, `server/routes/captures.js`
- `componentResult.test.js`, `projectPlanner.test.js`, `captureOverlay.test.js`, `evidencePanel.test.js`, `assistantActions.test.js`, `localReferenceLookup.test.js`, `mobileSupport.test.js`, `componentWorkflow.test.js`
- `scripts/smoke-mvp.mjs`, `scripts/make-test-photo.mjs`
- `MVP.md` (this file)

Modified:

- `app.js` — assistant state, project/capture workflow, evidence rendering, Repeat/Explain, honest `analysisState`, restored-capture canvas redraw, legacy contour/track runtime disabling, resilient "Resume last project".
- `index.html`, `style.css` — project dialog, workspace card, image evidence panel, mobile stacking, legacy menu sections hidden.
- `server/index.js` — new routes wired; `/api/analyze` kept intact.
- `server/store.js` — `project_docs`, `captures`, immutable file writes, project/capture helpers, cleanup on delete.
- `server/services/nimProvider.js`, `cloudflareProvider.js`, `groqProvider.js` — optional `schema` and multi-image `imageDataUrls`, backward compatible with `GROUNDING_SCHEMA` / `imageDataUrl`.
- `server/config.js`, `server/lib/env.js`, `server/routes/providers.js`, `electron/main.js` — runtime provider state, provider credential handling and startup diagnostics in the same release window.
- `electron/package.json` — `extraResources` now includes the new client modules and the frozen `datasets/processed/feature_scaler.json`.
- `server.auth.test.js` — replaced fixed 2 s startup sleeps with health-readiness polling and guaranteed server shutdown (fixes parallel-run flakiness and hangs).

## 5. What works locally (verified)

Verified in the in-app browser against a source server on port 8011 with `ALLOW_OUTBOUND_NETWORK=false`:

1. Project dialog opens on startup; recent projects list loads.
2. Creating a project from "I want to build a night-light that turns on in the dark…" produces the title, 6 steps, parts, and safety notes; the LDR/photoresistor is recognised.
3. "I'm aligned" arms Capture; uploading a 1280×720 PNG shows it on the main canvas.
4. Capture stores original + overlay, runs the local lookup, and shows honest statuses.
5. With no provider, analysis returns `unavailable`; the capture is preserved and the project shows that state after reload.
6. Repeat reuses a stored answer with **zero** AI requests (verified with a stored-answer fixture in the smoke data directory, and in unit tests; a live model answer was not available here).
7. Explain issues **exactly one** `POST /api/explain` (same fixture/unit-test basis).
8. Confirming the name persists `Confirmed by you`; "Next step" persists the advanced step.
9. Reloading the app restores the project, the capture, the redrawn canvas and the confirmed state.
10. No silhouette, hand, chip or loose-track boxes are drawn.

Verified against the packaged resources on port 8012 (`smoke-mvp.mjs`, 14/14 checks):

- token rejection (401), project create/get/list/update, capture create, byte-identical original, raster overlay byte-identical, SVG overlay fallback, duplicate capture rejected (409), analyze/explain `unavailable` without provider, capture survives, invalid project id → 400.

Verified on the packaged app on port 8000: `/api/health` 200, UI loads with no console errors, project dialog + "AI provider" button + Explain button present.

## 6. Provider-dependent behaviour (not verified here)

Not exercised in this environment:

- A live Meta vision request and its real answer (no outbound approval, and the session ran with `ALLOW_OUTBOUND_NETWORK=false`).
- Real model latency, refusal behaviour and malformed-JSON handling against a live endpoint (covered only by mocks/unit tests).
- Explain against a live provider.

Behaviour that is implemented but provider-dependent:

- When a permitted provider is configured, every capture produces exactly one `/api/component/analyze` request and one answer.
- When it is not, the app reports `AI unavailable`, keeps the capture, and does not fabricate a box.

## 7. Tests and evidence

- **Source suite:** 25 test files via `node scripts/run-source-tests.mjs` (excludes build output). Latest run: **201 tests, 0 failures**.
  - Includes coordinate rejection cases (out-of-range, fewer than four corners, center outside outline, bow-tie order, model self-confirmation), overlay determinism, Repeat/Explain request counts, capture immutability, and project-resume persistence.
- **HTTP smoke:** `node scripts/smoke-mvp.mjs` → 14/14, run against both the source tree (8011) and packaged resources (8012).
- **UI smoke:** scripted browser session described in section 5.
- **Packaged launch:** `electron/release/win-unpacked/IntentLens.exe` starts, serves the API, and renders the new UI.

Note: stop all running servers before the suite. The auth tests spawn fixed ports (8201–8203).

## 8. Phone / mobile status

> **Status update, 2026-11-11.** The standalone PWA is published on GitHub Pages, which is HTTPS and therefore a secure context. The camera works there, and so does gallery upload. The limitation below applies to a plain-`http://<lan-ip>:port` page and to live transfer into the desktop's HTTP server, not to the GitHub Pages PWA.

- The camera requires a secure context. `localhost` (desktop) is secure; a phone opening `http://<lan-ip>:port` is not, so `getUserMedia` is unavailable there.
- The app detects this (`mobileSupport.js`) and explains it; it does **not** relax backend auth to make a phone work.
- "Upload photo" remains available over plain HTTP.
- No APK is shipped. The only install path on a phone is the PWA manifest/service worker — and a real phone camera over the LAN still needs HTTPS, which is not set up.
- No phone was tested in this cycle.

## 9. Build deliverable

- Installer: `electron/release/IntentLens Setup 0.4.0.exe` — **≈125 MiB (about 131 MB)**; the exact byte count depends on the bundled documentation and is printed by Windows in the file properties.
- Unpacked: `electron/release/win-unpacked/IntentLens.exe` (port 8000).
- Packaged resources include all new modules, the frozen scaler, the k-NN binary, and the new server routes (verified by file presence and by serving them).
- Build command: `cd electron` then `npm.cmd run build`.

## 10. Known failures, limits and unverified claims

1. Live Meta inference unverified (see section 6).
2. A plain-HTTP LAN page is blocked by the secure-context rule; use the HTTPS GitHub Pages PWA for the camera, or the LAN gallery upload over HTTP. Live phone-to-desktop sync is still not implemented.
3. Real hardware photo/camera capture not tested — UI smoke used an uploaded generated PNG.
4. Installer is unsigned and uses the default Electron icon, so Windows SmartScreen may warn.
5. The local k-NN lookup is a whole-frame, weak reference lookup. It is labelled unverified and is not an identity source.
6. Legacy tracking/training/PCB/transfer code is still bundled (including `opencv.js`, ~10.9 MB) even though it is hidden and disabled. This affects size, not the workflow.
7. First open of the packaged SQLite store can take several seconds on a cold start; the UI waits for health, but startup feels slow.
8. The installer version stays 0.4.0; there is no separate build number beyond the health `version` string (`0.4.0-v8`).
9. Fix applied during final verification: `server.auth.test.js` no longer relies on a fixed 2 s startup sleep (it could fail or hang when the store opened slowly under parallel test load).

## 11. Reproducible demo sequence

Use a fresh data directory so the demo is deterministic.

```cmd
cd C:\Users\hp\Desktop\IntentLens
set PORT=8011
set DATA_DIR=%TEMP%\il-demo
set ALLOW_OUTBOUND_NETWORK=false
node server\index.js
```

Then open `http://localhost:8011`.

### 11.1 Offline demo (no provider configured — works today)

1. The **Project** dialog appears. Type: `I want to build a night-light that turns on in the dark. I have an Arduino Uno, a breadboard, an LDR and a resistor.` Press **Create project**.
   Expected: title `a night-light that turns on in the dark`, 6 steps, the LDR listed as a part, safety notes, step 1 current.
2. Press **Upload photo** and choose a photo of the board (a generated 1280×720 PNG is fine).
   Expected: the still replaces the placeholder demo board.
3. Press **I'm aligned**, then **Capture component**.
   Expected status: `Captured — waiting for analysis`, then `Captured — AI unavailable, saved locally`. The evidence panel shows the original and the grid overlay. If the local lookup returns anything, it appears as an **unverified candidate** with a raw distance.
4. Press **Next step**.
   Expected: the step advances and the workspace progress bar moves; the written instruction matches the new step.
5. Reload the page. Open **Project → Resume last project**.
   Expected: the same project, the real capture redrawn on the canvas, and the advanced step — all restored from SQLite.
6. Press **Repeat** with no stored answer.
   Expected: `There is no previous answer to repeat yet.` — this is correct, not a failure. The offline flow produces no model answer, so there is nothing to repeat or explain.

### 11.2 Provider demo (requires explicit outbound approval and a configured provider)

Same steps 1–3, then:

4. Analysis returns either `AI candidate — confirm or correct` with a validated box, or an explicit rejected/invalid status with no box.
5. Press **Repeat**.
   Expected: the same stored answer is shown; the server log shows **no** new `/api/component/analyze` or `/api/explain` request.
6. Press **Explain**.
   Expected: exactly one `POST /api/explain`; the expanded text appears on screen.
7. Press **Confirm** (or **Correct name**, type `LDR`, **Save**).
   Expected: status becomes `Confirmed by you`; the object is tied to this capture only.
8. Press **Next step**, then reload and resume as in 11.1.

## 12. How to run tests and rebuild

```cmd
cd C:\Users\hp\Desktop\IntentLens
node scripts\run-source-tests.mjs
```

```cmd
cd C:\Users\hp\Desktop\IntentLens\electron
npm.cmd run build
```

HTTP smoke against a running server:

```cmd
set SMOKE_BASE=http://127.0.0.1:8011
set SMOKE_DATA=%TEMP%\il-demo
node scripts\smoke-mvp.mjs
```

---

## 13. Post-MVP fixes (2026-11-03)

- **NVIDIA NIM default model is now `meta/muse-glimmer-30b`.** It is the only
  model verified with a real image on the tested account. `meta/llama-3.2-11b-vision-instruct`
  returns HTTP 404 there, `meta/llama-3.2-90b-vision-instruct` times out, and
  `meta/llama-4-maverick-17b-128e-instruct` is end-of-life (HTTP 410) and has
  been removed from the NIM catalog.
- A saved old default (11B or Maverick) is migrated to Muse Glimmer on startup.
  Any model the user picks from the current list is left alone.
- Muse Glimmer is a reasoning model. The NIM adapter now reads `reasoning_content`
  as well as `content`, extracts JSON from mixed text, uses a 180s timeout and
  3072 max tokens. A full component analysis can take 80-120 seconds.
- Provider setup shows **verified / not verified** per model and explains
  network-disabled, auth, unavailable-model, timeout and rate-limit failures.
- When `ALLOW_OUTBOUND_NETWORK=false`, setup offers a confirm-gated
  **Allow cloud requests for this session** button. It never persists; a restart
  returns to the configured default.
- Desktop and PWA commands and answers are text-only.
- Cloudflare models the user listed are in the catalog (Llama 3.1 8B/FP8,
  3.2 1B/3B/11B/90B vision, 3.3 70B FP8, Llama Guard 3, Llama 4 Scout).
  The supplied Cloudflare token was invalid (HTTP 401), so none is verified yet.
- Groq has no key in the supplied file; only Prompt Guard models were visible in
  the playground, so Groq vision remains unverified.
- `API(SECRETS).txt` was deleted from the repo and the Desktop after testing.
  `.gitignore` now blocks `API(SECRETS).txt`, `*SECRETS*.txt`, `.env.*`
  (except `.env.example`), `*.pem` and `*.key`.
- Installer rebuilt: `electron/release/IntentLens Setup 0.4.0.exe`.
