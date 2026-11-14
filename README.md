# IntentLens

Point a camera at a board or device, type a question, and get a grounded answer with a marker on the exact part — plus a next step you can actually follow.

IntentLens runs in two places:

| Surface | Where | What it does |
| --- | --- | --- |
| **Desktop / Electron** | Windows PC | Local Node server, encrypted credentials, SQLite project store, camera or uploaded photo, local perception, provider failover, cost ledger |
| **Phone PWA** | Android / iOS browser | Static GitHub Pages app, camera or gallery photo, IndexedDB history, direct provider calls in the browser |

Both surfaces share the same pure modules for coordinates, result validation and model metadata, so a marker cannot mean different things on the phone and the PC.

> **Honest status.** This is an MVP. Component identification is a research problem, not a solved one. The only accuracy figures quoted here are measured on the held-out ElectroCom61 test split; the measurement code returns `null` until it has at least 30 labelled samples, and those samples do not ship in this repository. Low-light capture, hinge/articulation tracking and PCB registration are included as local heuristics with explicit confidence, not as validated industrial metrology. Physical phone, laptop-hinge and PCB accuracy still need hardware validation. Meta Ray-Ban glasses integration was not built.

---

## Contents

- [What works](#what-works)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Models and providers](#models-and-providers)
- [Hard cost budgets](#hard-cost-budgets)
- [Perception pipeline](#perception-pipeline)
- [Phone ↔ desktop transfer](#phone--desktop-transfer)
- [CLI](#cli)
- [Training and evaluation flow](#training-and-evaluation-flow)
- [Tests](#tests)
- [Privacy and security](#privacy-and-security)
- [Troubleshooting](#troubleshooting)
- [Repository layout](#repository-layout)
- [Docs](#docs)

---

## What works

- **Camera and upload** — live preview, frozen stills, phone gallery upload and desktop file upload.
- **Local component recognition** — a measured ElectroCom61 classifier (ResNet-18, last block fine-tuned, exported to ONNX). **97.51%** held-out test accuracy (clean), **97.33%** through the shipped JS + onnxruntime path, and still **97.04%** at 30% brightness. Per-class accuracy is tracked honestly: 3–7 of 61 classes remain just below 90%. It proposes candidates; the AI and the user decide identity. See [docs/COMPONENT_RECOGNITION.md](docs/COMPONENT_RECOGNITION.md).
- **Coordinate grounding** — the model returns `0..1000` coordinates; the app validates them and converts them to normalized points/boxes. There is no visual grid overlay.
- **Read aloud** — the written answer can be spoken with the browser's built-in voice. Text-to-speech only; the app never opens the microphone.
- **Local tracking** — colour-histogram + patch similarity tracking, reacquisition and a visible state machine. No per-frame AI calls.
- **Lighting repair** — measures a still and only repairs genuinely dim, low-contrast or uneven frames. Blown highlights are never pushed brighter.
- **Hinge / articulation tracking** — local, model-free angle estimate from two board edges, or a coarse frame-only orientation hint. Explicitly labelled as a hint when it comes from a raw frame.
- **PCB registration and confidence** — board homography, per-component presence verification, explainable component confidence, board-quad sanity checks, IoU precision/recall and calibration metrics.
- **Any vision provider** — OpenRouter, Groq, Google AI Studio, NVIDIA NIM, Cloudflare Workers AI, Mistral, Together, Hugging Face, DeepInfra, OpenAI, Anthropic, local Ollama, or a custom HTTPS relay. Free, preview and paid tiers are selectable.
- **Key-first selection** — a provider is only used when its own key is present; free tier auto-selects free models, paid tier uses paid models.
- **10-second answer deadline** — a slow attempt is aborted and the next provider is tried instead of waiting minutes.
- **Failover** — auth, quota, rate-limit, timeout and outage errors move to the next configured provider.
- **Hard budgets** — a pessimistic preflight reserves the worst-case cost against daily, monthly and per-request caps before any request is sent.
- **Optional hosted masks** — SAM 2 via Replicate, with a server-side key, same-origin mask cache, timeouts, mask/byte caps and a flat per-run budget guard. Off by default. It proposes masks; it does not identify components.
- **Phone transfer** — a one-time code plus a desktop-served upload page for gallery photos over the LAN; project JSON export/import for offline transfer.
- **CLI** — health, provider list, model list, budget get/set/reset, analysis and sync-code creation.

Not built: live desktop↔phone video sync, an APK, glasses integration, a PWA overlay for hosted masks, and pin/polarity/board-region labels for step-level guidance. The server API and mask cache are ready; the phone UI is not wired yet.

---

## Quick start

### Requirements

- Windows 10/11 for the desktop app, or any OS with Node 22.5+ for the server and tests.
- A modern Chromium/Edge browser for camera capture (camera needs `https://` or `http://localhost`).
- A provider key only if you want cloud vision. Everything local works without one.

### A. Run the source

```bat
git clone https://github.com/aizkinwork-star/intentlens.git
cd intentlens
start.cmd
```

`start.cmd` runs the Node server and opens `http://localhost:8000`. For a headless server run:

```bat
node server/index.js
```

### B. Tests

```bat
node scripts/prepare-pwa.mjs
node scripts/run-source-tests.mjs
```

The PWA prepare step copies shared modules into `pwa/lib/`; those copies are generated and gitignored.

### C. PWA

```bat
node scripts/prepare-pwa.mjs
node scripts/serve-pwa.mjs
```

Serve `pwa/` over HTTPS or localhost. For GitHub Pages, `.github/workflows/pages.yml` runs the prepare step and publishes `pwa/`.

### D. Electron installer (optional)

```bat
npm.cmd --prefix electron install
npm.cmd --prefix electron run build
```

The installer is written under `electron/release/` and is not committed.

---

## Architecture

```text
Browser / Electron renderer
  app.js (desktop) or pwa/app.js (phone)
    capture → lighting check → prompt → provider call → validate → draw
    local perception: tracker.js, componentDetector.js, OpenCV loader
    local recognition: /api/recognizer/classify (desktop) or optional PWA endpoint
                 │
                 │ /api/* (desktop only, session token)
                 ▼
Node server (server/index.js)
  routes/analyze.js          validate frame + context
  services/provider.js       budget preflight → attempt → failover → usage record
  services/router.js         provider order + health
  services/*Provider.js      OpenAI-compatible, Cloudflare, Anthropic adapters
  services/costManager.js    persistent cost ledger
  routes/providers.js        credentials, model catalogue, budget status
  routes/sync.js             one-time LAN upload codes
  store.js                   SQLite + image files (gitignored)
```

### Shared pure modules

| File | Responsibility |
| --- | --- |
| `modelRegistry.js` | One catalogue of providers, models, modalities, tiers, prices, context windows and endpoints. Used by the server, desktop UI and PWA. |
| `costCore.js` | Pure budget normalisation, window sums, pessimistic preflight, usage entries and pruning. No I/O, so it is directly testable. |
| `grid.js` | Point/box/letterbox coordinate math. The visual overlay grid was removed. |
| `componentResult.js` | The only boundary that converts `0..1000` model coordinates to normalized boxes and rejects invalid markers. |
| `componentVocabulary.js` | The 61 ElectroCom61 labels the local recogniser can emit, shared by desktop and PWA prompts. |
| `speech.js` | Read-aloud via the browser Web Speech API. Synthesis only; no microphone. |
| `schema.js` | Result validation shared by both clients. |

### Why one catalogue

Before, provider names and model ids lived in several files. That is how a model can be “allowed” in one place and rejected in another. Now `modelRegistry.js` is the single source of truth; `server/config.js`, the desktop settings UI and `pwa/provider.js` derive everything from it. `scripts/prepare-pwa.mjs` copies it (plus `costCore.js`, `grid.js`, `componentResult.js`, `componentVocabulary.js`, `speech.js`) into `pwa/lib/` so the browser build uses the same rules.

---

## Models and providers

Only **vision-capable** models receive an image. Text-only and classifier models are refused before a request is sent. Provider entries marked *verified* have answered a real image request on a test machine; everything else needs **Test connection**.

| Provider | Desktop | Phone PWA | Notes |
| --- | --- | --- | --- |
| **OpenRouter** | Yes | Yes (CORS) | Free and paid models; the widest vision catalogue |
| **Groq** | Yes | Yes (CORS) | Vision availability depends on the account; press Test |
| **Google AI Studio** | Yes | Yes (CORS) | Gemini models; free tier available |
| **NVIDIA NIM** | Yes | No (CORS) | Inference host is `integrate.api.nvidia.com`; the dashboard is not an endpoint |
| **Cloudflare Workers AI** | Yes | No (CORS) | Needs an Account ID plus a Workers AI token |
| **Mistral** | Yes | Yes | Pixtral and Mistral Small |
| **Cerebras** | Yes | Yes | Text catalogue only in this build; no vision model is listed |
| **Together AI** | Yes | Yes | Open-weight vision models |
| **Hugging Face** | Yes | Yes | Router-style OpenAI-compatible endpoint |
| **DeepInfra** | Yes | Yes | Paid open-weight models |
| **OpenAI** | Yes | No (CORS) | GPT-4.1 / GPT-4o family |
| **Anthropic** | Yes | No (CORS) | Claude family via the Messages API |
| **Ollama** | Yes | No | Local loopback; no key, no cloud request |
| **Custom relay** | Yes | Yes | An OpenAI-compatible HTTPS endpoint you control |

### Desktop setup

1. Menu → **Vision Provider & Model** → **Configure provider**.
2. Choose **Model access**: free, preview or paid. Paid models are visible and may bill your provider account.
3. Choose a provider, choose a vision model, paste its key.
   - Cloudflare also needs the 32-character Account ID.
   - NVIDIA NIM pre-fills the inference base URL; leave it unchanged.
   - Ollama needs no key and uses `http://localhost:11434`.
   - Custom relay requires HTTPS; plain HTTP is allowed only for loopback.
4. Press **Save & test**. The key is encrypted at rest and never returned to the page.

### Phone setup

Settings → Provider, then the same model-access choice. The phone calls the provider directly, so keys stay in memory only and are lost when the tab closes. Providers without browser CORS are listed but blocked, with the reason shown. The desktop app or an HTTPS relay is the alternative.

### Typed model ids

A typed id is sent exactly as typed. It is never silently replaced by a default. If the id is not in that provider's catalogue, it is rejected; if the model is text-only, the image is never sent.

---

## Hard cost budgets

Prices in `modelRegistry.js` are planning figures, not invoices.

`costCore.js` implements one rule: **refuse before spending**.

1. Estimate input tokens from the command and context.
2. Estimate image tokens from width and height.
3. Reserve the maximum output tokens, not a hoped-for short answer.
4. Price the worst case with the selected model.
5. If the request would exceed the per-request cap, or the remaining daily/monthly budget, return a `REQUEST_COST_LIMIT` / `BUDGET_EXCEEDED` error **without contacting the provider**.
6. After a successful call, record the reported usage in `intentlens-data/cost-ledger.json`.

The ledger contains token counts, model ids and estimated cost only — never prompts, images or keys. Budget caps and the ledger are editable in the desktop setup dialog and the PWA settings, and from the CLI.

Caveat: a provider can report usage late or differently from its public price list. The ledger is a guardrail and an estimate; the provider invoice is authoritative.

### Optional hosted segmentation (SAM 2)

Hosted segmentation is a separate, opt-in path. It is **not** the component classifier and it is off unless `SAM2_ENABLED=true` and a Replicate token are present.

- `POST /api/segmentation` accepts an inline image or HTTPS image URL plus optional normalized boxes/points. `GET /api/segmentation` returns key-free status.
- The adapter targets Replicate `meta/sam-2` (SAM 2 large, image-only automatic mask generation). Native box/point prompts are not exposed by that endpoint, so the server ranks automatic proposals against the prompt and labels the strategy `filter`. `SAM2_INPUT_STYLE=promptable` is for deployments that really accept boxes/points.
- The token stays in the server/encrypted store. Mask PNGs are downloaded, bounds-checked, cached under `intentlens-data/segmentation/` and served same-origin so the overlay avoids CORS and expiring URLs.
- Every run is bounded by `SAM2_MAX_MASKS`, `SAM2_MAX_MASK_BYTES`, `SAM2_MAX_WAIT_MS`, and a flat `SAM2_COST_PER_RUN_USD` preflight against `MAX_REQUEST_USD` and the remaining budget.
- A mask is evidence, not an identification. The response carries `promptStrategy`, candidate count, prediction id and cost source so the UI cannot present a filtered proposal as a model-recognized part.

Setup, API shape, limits and evaluation rules: `docs/HOSTED_SAM.md`.

---

## Perception pipeline

### 1. Lighting (`perception/lighting/adaptivePreprocess.js`)

Pure functions, no DOM and no OpenCV:

- `analyzeLighting` samples evenly, builds a 256-bin luma histogram and an 8×8 tile map, then classifies `good`, `dim`, `blown_out`, `low_contrast` or `uneven`.
- `adaptivePreprocess` runs only the repairs the measurement justifies: gamma lift, bounded contrast stretch, local illumination flattening and a mild unsharp mask.
- A `good` or `blown_out` frame is returned unchanged. Sharpening cannot recover a blurry photo, and a blown highlight has no detail to recover, so the report says so instead of pretending.
- The capture path stores a before/after report in `state.lastPreprocess`; the preview loop measures at ~1 Hz on a 320×180 copy so a low-power laptop is not taxed.

### 2. Tracking (`tracker.js`, `perception/tracking/HingeTracker.js`)

- The existing tracker combines colour histograms and patch similarity and exposes `INACTIVE`, `TRACKING`, `LOW_CONFIDENCE`, `LOST` and `REACQUIRING`.
- `HingeTracker` answers a narrower question: is a clamshell opening or closing, and by roughly how much?
  - With two board edges (`near → far`), the interior angle is exact geometry.
  - With a raw frame, `dominantOrientations` bins Sobel gradients and returns the angle between the two strongest peaks. The result is `method: 'orientation'` and is a coarse hint, never a calibrated measurement.
  - Smoothing, velocity, jump clamping, loss and reacquisition are covered by synthetic tests.

### 3. PCB geometry confidence (`perception/pcb/gridConfidence.js`)

- Board-quad sanity checks, component presence/confidence and IoU precision/recall.
- Grid-line alignment scores remain as a geometry heuristic over detected board features; there is no visual grid overlay in the product.
- `iou`, one-to-one greedy matching, precision, recall, F1 and a symmetric accuracy.
- `iou`, one-to-one greedy matching, precision, recall, F1 and a symmetric accuracy.
- Grid snap and grid-line alignment scores remain as geometry signals over detected board features (not a user-facing grid).
- `boardQuadQuality` rejects bow-ties, slivers and self-intersecting projected boards before they are drawn.
- `componentConfidence` combines declared evidence (similarity, focus, presence, position) with published weights, so a confidence number can be explained.
- `calibrationReport` computes Brier score and expected calibration error.
- `accuracyReport` returns `null` when there are no labelled samples, and sets `trustworthy: false` below 30 samples. It cannot emit “85%” from an unlabelled run by construction.

### 4. Honest accuracy

If you want an accuracy figure, collect labelled boxes or labelled component outcomes first, then call `evaluateDetections` or `accuracyReport`. The UI shows confidence and coverage; it does not promote a heuristic score into an accuracy claim.

The offline learning pipeline is reproducible and validation-only:

```bat
node scripts/eval-accuracy.mjs --train train.jsonl --valid valid.jsonl --test test.jsonl --out datasets/processed/accuracy.json
```

It selects deterministic k-medoids references from the **train** split, sweeps k / distance threshold / separation / class-balanced voting / local scaling on **validation**, freezes the winner, and evaluates **test once**. It exits instead of inventing a number when a split is missing, and every report carries the shared `trustworthy` flag (below 30 labelled samples is not a usable accuracy claim). See `docs/PERCEPTION_AND_ACCURACY.md` for the rules and `docs/KNN_EVALUATION.md` for the measured compact-index failure.

---

## Phone ↔ desktop transfer

There is no shared cloud account and no live socket between the phone and the PC.

### LAN gallery upload (works over plain HTTP)

1. On the PC: menu → **Phone Transfer (LAN)** → **Create upload code**.
2. Open the shown URL on a phone on the same Wi-Fi (for example `http://192.168.1.10:8000/sync.html?code=123456`).
3. Choose a gallery photo and send it. The PC lists it; press **Load photo** to analyse it.

Why gallery upload and not live sync: a plain-HTTP LAN page is not a secure context, so it cannot use `getUserMedia`, and an HTTPS page cannot POST to a plain-HTTP LAN server. GitHub Pages itself is HTTPS, so the PWA camera **does** work there; only live sync between that page and the desktop's HTTP server is restricted. A file input has neither limitation. Codes are 6 digits from a cryptographic RNG, expire after 10 minutes, exist only in the server process, and only accept bounded PNG/JPEG/WebP payloads or short notes. Failed attempts are rate-limited. The server binds `0.0.0.0` for LAN use — do not expose it to the public internet.

### Offline project transfer

The PWA can export a project as `*.intentlens.json` (messages + images) and import it again. This is a deliberate manual transfer for when the phone is on HTTPS and the desktop is on a different origin.

---

## CLI

The CLI talks to a running local server. It never reads provider keys.

```bat
node cli/intentlens.mjs health
node cli/intentlens.mjs providers
node cli/intentlens.mjs models --provider openrouter
node cli/intentlens.mjs budget get
node cli/intentlens.mjs budget set --daily 1 --monthly 10 --request 0.25
node cli/intentlens.mjs budget reset
node cli/intentlens.mjs analyze --image board.jpg --command "where is the battery connector?"
node cli/intentlens.mjs sync
```

- `--server` defaults to `http://127.0.0.1:8000`.
- `--token` (or `INTENTLENS_TOKEN`) is the local session capability. If omitted, the CLI reads `intentlens-data/.session-token` written by the server.
- `--json` prints the raw API response.
- `analyze` reads PNG, JPEG or GIF dimensions from the file header; WebP needs `--width` and `--height`.

---

## Training and evaluation flow

IntentLens does not train a neural network in this repository. “Training” means local reference examples and calibration:

1. **Reference index** — `looseObjectTracker.js` and `KNNClassifier` store labelled feature vectors. `knn_reference_db_compact.bin` is the shipped compact index (generated; see `docs/KNN_EVALUATION.md`).
2. **Capture examples** — menu → **k-NN Training** → select a region, type a label, **Capture example**. Labels are candidates, not verified facts.
3. **Evaluate** — `node scripts/eval-accuracy.mjs --train … --valid … --test …` runs reproducible medoid selection, validation-only calibration and a single frozen test evaluation. You can also feed labelled boxes to `evaluateDetections` and record precision, recall, F1, mean IoU and calibration.
4. **Calibrate** — use `calibrationReport` to compare confidence with outcomes. A model that says 0.9 and is right 60% of the time should not be trusted at 0.9.
5. **Report honestly** — quote the sample count, the threshold, the split and the date. Do not quote a number from unlabelled data.

The perception thresholds live in `perception/PerceptionProfile.js` (`performance`, `balanced`, `accuracy`) so speed/accuracy trade-offs are explicit.

---

## Tests

```bat
node scripts/prepare-pwa.mjs
node scripts/run-source-tests.mjs
```

Current suite: **325 tests across 36 source test files, 0 failures**. It includes:

- coordinate and result-validation tests,
- provider catalogue, adapter, failover and budget tests,
- PWA provider/CORS/budget behavior,
- PWA camera constraint-ladder, torch and zoom capability tests (mocked),
- deterministic medoid selection and validation-only k-NN calibration tests,
- desktop UI text guards (no microphone/speech paths),
- server auth, store and integration tests,
- synthetic lighting, hinge and PCB-confidence suites,
- sync store and CLI image-header tests.

Tests run on Node's built-in test runner with no third-party dependency. `node --test` with no arguments also discovers stale copies under build output, so use the runner.

---

## Privacy and security

- **Keys never reach the browser.** The desktop server stores credentials encrypted (Electron `safeStorage` / Windows DPAPI) and applies them only inside the server process.
- **Outbound network is opt-in.** `ALLOW_OUTBOUND_NETWORK=false` by default. Local camera, tracking, lighting and the local recogniser still work.
- **Answer read-aloud is local.** It uses the browser's built-in speech synthesis. There is no microphone capture, speech recognition or recording anywhere in the app.
- **The recogniser never calls the network.** `/api/recognizer/status` and `/api/recognizer/classify` run the ONNX model in-process. The PWA only sends a crop to an endpoint you explicitly configure, and only over https, same-origin or loopback.
- **Hosted segmentation is separately opt-in.** `SAM2_ENABLED=true` plus a server-side Replicate token. When enabled, the captured still is sent to Replicate for masks; when disabled, no frame leaves the machine for segmentation. Masks are cached locally for a bounded TTL and served same-origin.
- **Host allowlist.** Known provider hosts plus explicit HTTPS relays. A custom relay must be HTTPS; private LAN IP literals are refused. Ollama is the loopback exception. Replicate is allowlisted only for the optional segmentation path.
- **Only captured frames are sent.** No continuous video stream. Images leave the device only when you press Find it.
- **No analytics, accounts or telemetry.** Project data stays in `intentlens-data/` (gitignored).
- **Provider terms still apply.** Your chosen provider processes the frame and prompt under its own policy. A local Ollama model keeps inference on your machine.

Never commit `.env`, `intentlens-data/`, `intentlens-config.json`, generated `pwa/lib/`, or provider keys. `.gitignore` excludes all of them. The test suite does not require a key.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `NO CLOUD AI KEY` | No usable provider credential | Menu → **Configure provider**, save and test |
| `NETWORK DISABLED` | `ALLOW_OUTBOUND_NETWORK=false` | Set it to `true` and restart, or use the session-only switch in setup |
| `MODEL_AUTH_FAILED` | Key rejected | Re-copy the key; check provider/account permissions |
| `MODEL_QUOTA_EXHAUSTED` | No credit or free quota used up | Add credit or choose another provider/model |
| `MODEL_TIMEOUT` | Slow or reasoning model | Retry, use a smaller image, or choose another model |
| Budget error | Preflight would exceed a cap | Raise the cap in Budget settings or choose a cheaper model |
| Phone cannot open camera | A plain-`http://192.168.x.x` LAN page is not a secure context | Open the PWA over HTTPS (GitHub Pages is HTTPS and works) or `localhost`; gallery upload works over plain HTTP |
| Phone cannot reach the desktop | Different network or firewall | Same Wi-Fi, allow the port, use the LAN URL shown on the PC |
| `This page is out of date after a server restart` | Session token rotated | Reload the page |

---

## Repository layout

```text
app.js / index.html              desktop renderer
style.css / sw.js                UI and service worker
grid.js / componentResult.js     shared coordinate + validation modules
componentVocabulary.js           shared ElectroCom61 label set
speech.js                        read-aloud (browser speech synthesis only)
modelRegistry.js                 shared provider/model catalogue
costCore.js                      shared budget rules
tracker.js / looseObjectTracker.js
perception/
  lighting/adaptivePreprocess.js
  tracking/HingeTracker.js
  pcb/gridConfidence.js
  pcb/BoardRegistrar.js
  pcb/ComponentPresenceVerifier.js
server/
  index.js                       routes + startup
  config.js                      runtime provider state
  store.js                       SQLite + image files
  routes/                        analyze, providers, sync, captures, segmentation, ...
  services/                      adapters, failover, cost ledger, sync store, SAM adapter
pwa/                             phone PWA (static)
cli/intentlens.mjs               headless control
scripts/                         PWA prepare, test runner
sync.html                        phone gallery upload page
docs/                            architecture, audits, evaluation notes
```

---

## Docs

- `docs/architecture.md` — original architecture; sections written before the multi-provider change are historical. Use `docs/MULTI_PROVIDER_ARCHITECTURE.md` for current provider/budget design.
- `docs/PERCEPTION_AND_ACCURACY.md` - lighting, hinge, PCB confidence and how to measure accuracy honestly.
- `docs/COMPONENT_RECOGNITION.md` - ElectroCom61 classifier: measured per-stage accuracy (97.5% clean → 97.0% in low light), the per-class shortfall, and reproduction commands.
- `docs/HOSTED_SAM.md` - optional SAM 2 via Replicate: setup, API, limits, privacy and evaluation rules.
- `docs/INSTALL.md`, `docs/SETUP_GUIDE.md` — installation and provider setup.
- `docs/KNN_EVALUATION.md`, `docs/PHASE6_*` — local reference experiments.
- `docs/DEVICE_TEST_CHECKLIST.md` — what still needs physical hardware.
- `THIRD_PARTY_NOTICES.md` — third-party components.
