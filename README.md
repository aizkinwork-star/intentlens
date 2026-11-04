# IntentLens

IntentLens is a local-first visual grounding prototype for electronics work. Point a
camera at a board, type or say a command, and get a short answer plus a target position
on a normalized overlay grid. The default grid is **64x64**; 16x16, 24x24, 32x32,
64x64 and 128x128 are available from the menu.

Camera preview, grid interaction, tap/drag tracking and the k-NN component classifier
run on this machine. Cloud generative analysis is **optional** and uses Meta-published
vision models only. There is **no local LLM** and no local Llama model.

## Quick start

```bash
start.cmd          # Electron desktop app
start.cmd --online # desktop app with cloud providers enabled for this run
```

Or run the browser UI directly:

```bash
npm start          # http://localhost:8000
npm test           # source tests only, excludes stale build output
```

Node.js 20+ is required for the server and tests. The desktop app is built with
Electron from `electron/`; the installer is
`electron/release/IntentLens Setup 0.4.0.exe`. Use `start-browser.cmd` for the
browser path, and do not run it at the same time as the desktop app (both use
port 8000).

Open `http://localhost:8000`, then use the top-left menu:

- **Vision Provider & Model** to connect a cloud provider.
- **Grid** to change grid resolution.
- **Logs** for local diagnostics.

Camera access needs `localhost` or HTTPS. Over plain HTTP on a phone, use
**Upload photo** instead.

## Cloud providers (Meta only)

The provider router is strict. It only sends images to vision-capable models in the
Meta-only catalog. Text-only Meta models are never used for image analysis, and
non-Meta models are rejected before saving.

| Priority | Provider | Example vision model |
|---|---|---|
| 1 | NVIDIA NIM | `meta/llama-3.2-11b-vision-instruct` |
| 2 | Cloudflare Workers AI | `@cf/meta/llama-4-scout-17b-16e-instruct` |
| 3 | Groq, only with an explicit Meta vision model | `meta-llama/llama-4-scout-17b-16e-instruct` |

Only providers that are configured with a usable key and a vision-capable Meta model
are eligible. Failed providers enter a short cooldown and the router falls through to
the next eligible provider. Authentication, quota, rate-limit, timeout and upstream
failures are reported without exposing key material.

`PROVIDER_PRIORITY` changes the order. The default is:

```text
nvidia-nim,cloudflare-workers-ai,groq
```

### Credentials

Provider keys are saved through the **Connect Vision AI Provider** popup. They are
encrypted at rest with Electron `safeStorage` when running under Electron, or Windows
DPAPI for a standalone server. Keys are never returned to the browser or written to
logs. Placeholder values such as `your_nim_api_key` are rejected and are never treated
as configured.

Environment variables still work for headless/server deployments. Real environment
values take precedence over `.env`. See `.env.example` for the full list.

### Network gate

`ALLOW_OUTBOUND_NETWORK=false` disables cloud analysis and provider tests. It does not
disable local camera, grid, tap-to-track, or k-NN classification. When a provider is
configured but the gate is off, `/api/analyze` returns `NETWORK_DISABLED` and the UI
explains how to enable cloud calls.

## Local perception

The local classifier uses a compact Float32 reference index generated from the
ElectronCom61 feature set:

- LBP/frozen feature schema: **2,027 dimensions**.
- Compact reference index: **305 references, 61 classes**.
- Runtime file: `knn_reference_db_compact.bin` plus metadata JSON.

The runtime does not parse the 338 MB training JSONL. Predictions from local
classification are unverified candidates, not electrical facts. Identity must be
confirmed by the user before it is treated as durable evidence.

> **Accuracy warning:** the shipped 305-reference DB has been evaluated on the
> held-out splits. It is not a reliable recognizer yet: at the shipped threshold it
> rejects 97.7% of test frames, and even after validation-only threshold calibration
> it reaches only 13.7% top-1 test accuracy. The 8,877-reference DB reaches ~52.7%
> under the same always-answer protocol. See [KNN_EVALUATION.md](KNN_EVALUATION.md)
> for the full table, per-class results and reproduction commands. Do not use local
> labels for electrical decisions.

A controlled follow-up experiment replaced the arbitrary 305 samples with
class-stratified greedy medoids at 5, 10, 20 and 40 references per class. No budget
met the 80% accepted-accuracy / 50% coverage gate. The validation-selected
40/class configuration reached 49.3% test coverage and 47.0% accepted accuracy
(23.2% overall, macro F1 0.289). See
[MEDOID_EXPERIMENT.md](MEDOID_EXPERIMENT.md) for the protocol, per-class recall and
reproduction scripts. The runtime DB was not changed.

## Voice input (optional, local)

The browser's built-in `SpeechRecognition` works in Chrome/Edge, but Electron has no
Google speech backend, so it fails with `network`. IntentLens therefore falls back to
recording a short clip and posting it to `/api/transcribe`, which forwards it to a
speech-to-text process running **on this machine**:

```text
# whisper.cpp server
whisper-server -m ggml-base.en.bin --host 127.0.0.1 --port 8080
STT_URL=http://127.0.0.1:8080/inference
```

`STT_URL` is loopback-only (`localhost`, `127.0.0.1`, `[::1]`); any other host is
rejected, so audio cannot be sent to a remote service. Without `STT_URL` the mic
button explains what to configure and typing continues to work. The packaged app
reads `.env` from `%APPDATA%\IntentLens\.env`; source runs also read the project
`.env`. See [.env.example](.env.example) for the OpenAI-compatible variant.

## Request flow

1. The browser captures one frame from the camera or an uploaded photo.
2. It sends `/api/analyze` with the command, frame, selected cell, scene memory and
   recent corrections.
3. The server validates the request, enforces the Meta-only catalog and network gate,
   and calls the first eligible provider.
4. The model response is validated before anything is drawn. Invalid points, boxes or
   confidence values are rejected rather than clamped into a fake marker.
5. The UI marks low-confidence results as needing confirmation.

API routes other than `/api/health` and `/api/pair` require the local session token.
The token is persisted in the data directory and injected into the served HTML. If a
page survives a backend restart, it re-reads the token after a 401 and retries once.

## Layout

```text
index.html                 screen and menu
style.css                  layout and responsive UI
app.js                     UI state, camera, tracking, provider setup, token refresh
grid.js                    coordinate math shared by browser and server
tracker.js                 local single-target tracking
looseObjectTracker.js      local component detection + k-NN tracking
sw.js                      network-first service worker shell
server/
  index.js                 HTTP server, static files, route dispatch
  config.js                Meta-only catalog, priority, feature flags
  lib/auth.js              persisted local session token
  lib/credentialStore.js   secure credential persistence
  routes/providers.js      save/test/delete/status without key disclosure
  routes/analyze.js        request validation, network gate, orchestration
  services/provider.js     sequential failover, cooldowns, error classification
  services/router.js       eligible provider construction
  services/nimProvider.js  NVIDIA NIM adapter
  services/cloudflareProvider.js
  services/groqProvider.js
electron/
  main.js                  desktop shell + safeStorage IPC
  preload.js               minimal non-secret bridge
```

## Tests

```bash
npm test            # 15 source files, 146 tests
npm run test:all    # raw node --test discovery, includes stale build output
```

`npm test` runs `scripts/run-source-tests.mjs`, which excludes `node_modules`,
`datasets`, `intentlens-data` and `electron/release`. The suite covers coordinate
math, validation, per-request grid sizing, tracking state transitions, provider
routing and failover, credential-placeholder handling, auth, persistence, compact k-NN
readiness, and the local inference paths.

Current source result: **146 passing tests, 0 failures**. Raw `node --test` also finds
stale copies under `electron/release/`, which is why that command reports a larger,
misleading count.

## Current limitations

- No real provider credentials were available during the audit. Live NVIDIA,
  Cloudflare and Groq calls and live Meta-model accessibility remain unverified.
- No physical camera or phone was available. Camera permission and hardware tracking
  were not verified end to end.
- The packaged Electron build was launched on Windows: the window, bundled backend,
  health endpoint and packaged asset copies were verified. Full safeStorage
  round-trips, camera permission, installer/uninstaller and shutdown/restart flows
  were not exercised.
- The packaged app ships no `.env`; it forces `ALLOW_OUTBOUND_NETWORK=false` unless
  the environment explicitly sets `ALLOW_OUTBOUND_NETWORK=true`.
- The compact reference index contains **305** references, not the 8,877 annotation
  total sometimes quoted from the dataset inventory.
- The 305-reference recognizer is not accuracy-validated for production use: 13.7%
  top-1 test accuracy after validation-only calibration, and 97.7% rejection at the
  shipped threshold. See [KNN_EVALUATION.md](KNN_EVALUATION.md).
- Web search is not used at runtime. External evidence is limited to the local source
  vault and user-confirmed references.
- The app is landscape-oriented.

## Safety

Use an unpowered, disconnected board for demos. A visual inference is not a
measurement. IntentLens does not verify circuit connectivity and does not generate
wiring or soldering instructions. Verify physical connections against a real schematic.
