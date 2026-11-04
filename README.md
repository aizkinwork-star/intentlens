# IntentLens

IntentLens is a local-first visual grounding prototype for electronics work.
Point a camera at a board, ask a question by text or voice, and get a short answer
plus a target position on a normalized overlay grid. The default grid is **64×64**;
16×16, 24×24, 32×32, 64×64 and 128×128 are available in Settings.

There are **two builds**:

| Build | Platform | Runtime | AI request path |
|---|---|---|---|
| **Desktop / Electron** | Windows PC | Electron + local Node server | Renderer → `localhost:8000` → provider API. Keys never enter the page. |
| **Phone PWA** | Android / iOS browser | Static GitHub Pages site | Browser → provider API directly. Keys stay in page memory. |

Live phone build: <https://aizkinwork-star.github.io/intentlens/>

> **Honest status.** This is a prototype, not a production tool. Local component
> tracking accuracy is low, physical Android/iOS camera behaviour was not tested,
> and Meta glasses integration was not built. Details are in
> [Limitations](#limitations) and [docs/](docs/).

---

## Contents

- [What works](#what-works)
- [Architecture](#architecture)
- [User flow](#user-flow)
- [Install on a PC](#install-on-a-pc-windows)
- [Install on a phone](#install-on-a-phone-github-pages-pwa)
- [Credentials and providers](#credentials-and-providers)
- [Which cloud hosts and models were used](#which-cloud-hosts-and-models-were-used)
- [Request logging](#request-logging)
- [Privacy](#privacy)
- [Training and data](#training-and-data)
- [Accuracy and limitations](#accuracy-and-limitations)
- [Troubleshooting](#troubleshooting)
- [Repository layout](#repository-layout)
- [Docs](#docs)
- [Safety](#safety)

---

## What works

- Camera preview, still capture, grid overlay and tap/drag tracking.
- Local k-NN component classifier (unverified candidates, not facts).
- Structured project memory: projects, messages, images, tasks and results.
- Text-only chat that never attaches an image.
- Optional cloud image analysis with strict result validation (no invented box).
- Repeat = 0 AI requests; Explain = exactly 1.
- Provider request log showing the exact API host, endpoint, model, mode, HTTP
  status, latency and request id.
- Desktop: encrypted credential storage and sequential provider failover.
- Phone: installable PWA with IndexedDB storage and an offline shell.

**Not present:** no local LLM, no local Llama model, no IntentLens backend, no
analytics, no account system, no APK, no Meta glasses integration.

---

## Architecture

### Desktop / Electron

```text
┌──────────────────────────── Windows PC ────────────────────────────┐
│                                                                    │
│  Electron renderer (index.html, app.js)                            │
│    camera · grid · tracking · k-NN classifier · UI                 │
│                         │                                          │
│                         │ local HTTP + session token               │
│                         ▼                                          │
│  Node server on 127.0.0.1:8000                                     │
│    /api/analyze   validation · context · provider router           │
│    /api/providers credentials (never returned to the page)          │
│    /api/transcribe local whisper.cpp only (loopback)               │
│                         │                                          │
│        ┌────────────────┼─────────────────┐                        │
│        ▼                ▼                 ▼                        │
│   NVIDIA NIM     Cloudflare Workers AI   (Groq skipped: no Meta    │
│   Meta Muse      Meta Llama 3.2 11B       vision on this account)  │
│        │                │                                          │
│        └──────── HTTPS ─┴──────────────► provider APIs             │
│                                                                    │
│  Local data: SQLite + images in intentlens-data/ or %APPDATA%      │
│  Credentials: Electron safeStorage / Windows DPAPI                 │
└────────────────────────────────────────────────────────────────────┘
```

The desktop renderer never sees provider keys. The server enforces an HTTPS
host allowlist, a Meta-only model catalogue, a network gate and sequential
failover with cooldowns.

### Phone / GitHub Pages PWA

```text
┌──────────────────────────── Phone browser ─────────────────────────┐
│                                                                    │
│  Static PWA from GitHub Pages (pwa/)                               │
│    camera · capture · grid · IndexedDB · service worker            │
│    provider.js builds one request and calls the provider directly  │
│                         │                                          │
│         ┌───────────────┴────────────────┐                         │
│         ▼                                ▼                         │
│   OpenRouter API                   Groq API (text only)            │
│   free vision / paid Meta          HTTP + CORS verified            │
│         │                                                          │
│         └──────── HTTPS + CORS ─────────► upstream model           │
│                                                                    │
│  Local data: IndexedDB (projects, messages, images, settings)      │
│  Key: JavaScript memory only; cleared on reload                    │
└────────────────────────────────────────────────────────────────────┘
```

A static GitHub Pages site has no server to hide a key or proxy a request.
Only providers that return browser CORS headers are offered. When a provider
blocks CORS (NVIDIA NIM, Cloudflare Workers AI), the user can deploy their own
HTTPS relay and select **Custom relay**; IntentLens does not operate that relay.

### Shared logic

`grid.js`, `componentResult.js`, prompt builders and validators are shared
between desktop and phone so coordinate conversion and validation cannot drift.
`pwa/lib/` is generated from the root sources by `scripts/prepare-pwa.mjs`.

---

## User flow

1. **Open** the desktop app or the Pages URL.
2. **Start camera** (permission is requested only then) or upload a photo.
3. **Frame** the board; rotate the phone to landscape for a wider view.
4. **Capture** one still. The live stream is never sent to a model.
5. **Ask** a question by typing or voice, e.g. “where is the battery connector?”.
6. **Allow cloud** for the session (off by default).
7. **Send**. One still image, the prompt and a trimmed project context leave the
   device. Repeat and Explain are explicit: Repeat reuses the stored answer with
   zero requests; Explain makes exactly one.
8. **Inspect** the answer, evidence and request log. If the model cannot
   honestly locate the part, no box is drawn.

---

## Install on a PC (Windows)

### Requirements

- Windows 10/11
- Node.js **22.5 or newer** (the test runner uses `node:sqlite`)
- Chrome or Edge for the browser-UI path
- Optional: a provider key (NVIDIA NIM or Cloudflare Workers AI)

### A. Installer (recommended for normal use)

1. Build or obtain `electron/release/IntentLens Setup 0.4.0.exe`.
2. Run the installer. It creates Start Menu and desktop shortcuts.
3. Launch **IntentLens**.
4. Open the top-left menu → **Vision Provider & Model** → **Configure provider**.
5. Enter a provider key and press **Save & test**.
6. Cloud access is off by default. Start with `start.cmd --online` to allow
   provider hosts for that session, or use the in-app network gate.

Data lives in `%APPDATA%\IntentLens\`. The encrypted credential file is
`%APPDATA%\IntentLens\credentials.safe`. Do not delete it unless you intend to
re-enter every key.

### B. Run from source

```cmd
git clone https://github.com/aizkinwork-star/intentlens.git
cd intentlens
npm install
start.cmd                 :: Electron desktop app
start.cmd --online        :: desktop app with cloud providers enabled
```

Browser UI instead of Electron:

```cmd
start-browser.cmd
:: or
node server/index.js
```

Then open <http://localhost:8000>. Do not run the browser server and Electron app
at the same time: both use port 8000.

### C. Build the installer

```cmd
cd electron
npm install
npm run build
```

Output: `electron/release/IntentLens Setup 0.4.0.exe`.

### D. Tests

```cmd
npm test
:: 27 source test files, 221 tests, 0 failures at the 2026-11-04 checkpoint
```

`npm test` excludes `node_modules`, `datasets`, `intentlens-data` and build
output. `npm run test:all` also discovers stale copies under `electron/release`
and is therefore not the source-of-truth count.

---

## Install on a phone (GitHub Pages PWA)

### Requirements

- A phone with a modern browser (Chrome on Android, Safari on iOS)
- HTTPS. GitHub Pages provides it; a plain LAN IP does not.
- An OpenRouter key for image analysis (or a custom relay)

### Steps

1. Open <https://aizkinwork-star.github.io/intentlens/>.
2. Install to the home screen:
   - Android Chrome: menu → **Add to Home screen**
   - iOS Safari: Share → **Add to Home Screen**
3. Open the installed icon.
4. Tap **Settings** → **OpenRouter**.
5. Paste the key. It is kept in memory for this tab only.
6. Tap **Save**. Tap **Allow cloud for this session**.
7. Tap **Start camera**, frame a board, **Capture**, type a question, **Send**.
8. Open **Provider request log** to confirm the exact endpoint and model.

### Deploy your own copy

1. Fork or push the repository to GitHub.
2. Repository → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main`. `.github/workflows/pages.yml` runs the source tests, prepares
   `pwa/lib` and deploys `pwa/`.
4. Open `https://<user>.github.io/<repo>/`.

The service worker updates automatically. A tab running an older shell reloads
once when a new worker takes control.

### Phone status

- **Verified end to end on the deployed page:** a synthetic red circle and blue
  rectangle sent from the live Pages origin returned HTTP 200 with valid JSON;
  the request log showed the endpoint, model, status, latency and `$0` cost, and
  the key was absent from the URL, storage and IndexedDB.
- **Verified in the deployed browser:** shell, manifest, service worker, text
  chat, request log, and no key in URL/storage/IndexedDB.
- **Details and the exact request shape:** [docs/PWA_AUDIT_REPORT.md](docs/PWA_AUDIT_REPORT.md).
- **NOT TESTED — DEVICE REQUIRED:** physical Android/iOS camera, permission
  prompts, landscape rotation, install prompts and touch tracking. Desktop
  emulation is not proof of device behaviour.

---

## Credentials and providers

### Key preservation

| Build | Where the key lives | Preserved after restart? |
|---|---|---|
| Desktop / Electron | `credentials.safe`, encrypted with Electron `safeStorage` / Windows DPAPI | **Yes**, by design |
| Desktop / headless server | `.env` or environment; gitignored | **Yes**, if you keep `.env` |
| Phone PWA | JavaScript memory for the open tab only | **No**, deliberately |

The phone key is **not** written to localStorage, sessionStorage, IndexedDB,
Cache Storage or the URL. Reloading the page or pressing **Clear key** removes
it. This is a privacy choice: a static site cannot protect a persistent secret
from scripts, extensions or anyone holding the unlocked device. Re-enter the key
when needed. The desktop app is the place to preserve keys.

Never commit `.env`, `API Keys*.txt`, `credentials.safe` or
`intentlens-config.json`. They are gitignored.

### Provider matrix

| Provider | Desktop | Phone PWA | Vision | Notes |
|---|---|---|---|---|
| **NVIDIA NIM** | Yes | **No** | Meta Muse Glimmer 30B verified | No browser CORS; restricted/third-party host. Desktop only. |
| **Cloudflare Workers AI** | Yes | **No** | Meta Llama 3.2 11B verified | No browser CORS. Desktop only, or a user-owned relay. |
| **OpenRouter** | Not wired | **Yes** | Free NVIDIA Nemotron 3.5 Super VL verified; paid Meta Maverick verified | CORS `*`. Phone default and paid Meta option. |
| **Groq** | Skipped | **Yes, text only** | **None** | Account has only Prompt Guard 2 22M/86M classifiers among Meta models. Text chat uses GPT-OSS/Qwen (not Meta). |
| **BlockRun** | No | **No** | Unusable | HTTP 402 payment failure and no CORS with the supplied key. |
| **Custom relay** | No | **Yes** | User decides | Your HTTPS relay must allow this Pages origin. |

### Desktop provider setup

1. Menu → **Vision Provider & Model** → **Configure provider**.
2. Choose NVIDIA NIM or Cloudflare Workers AI.
3. Enter the key (and Cloudflare Account ID for Workers AI).
4. Choose a **verified** vision model:
   - NIM: `meta/muse-glimmer-30b`
   - Cloudflare: `@cf/meta/llama-3.2-11b-vision-instruct`
5. Press **Save & test**.

Only verified vision models make a provider eligible. Catalogued-but-unverified
models remain visible with their failure note, but they are never selected
automatically and do not mark the provider as configured.

Groq is skipped for vision because the live account has no Meta vision model.
Prompt Guard is a prompt-injection classifier and is never used for chat or
vision.

### Phone provider setup

1. Settings → Provider.
2. **OpenRouter** is the default. The free default is
   `nvidia/nemotron-3.5-super-vl:free`.
3. Paste a key; it stays in memory.
4. Optional: type any model id. Known text-only models are refused for images;
   unknown ids are sent as typed and the provider decides.
5. Paid Meta models show their price in the model note/datalist. Select one only
   if you accept the charge.

### Environment variables (headless desktop)

Copy `.env.example` to `.env` and set only the provider you use:

```text
NIM_ENABLED=true
NIM_API_KEY=...
NIM_BASE_URL=https://integrate.api.nvidia.com
NIM_MODEL_ID=meta/muse-glimmer-30b
PROVIDER_PRIORITY=nvidia-nim,cloudflare-workers-ai,groq
ALLOW_OUTBOUND_NETWORK=true
```

`ALLOW_OUTBOUND_NETWORK=false` blocks cloud analysis and provider tests without
affecting camera, grid, tracking or the local classifier.

---

## Which cloud hosts and models were used

Live audit date: **2026-11-04**. Keys were used only for testing and were not
logged, committed or shown. Test images were synthetic (a red circle and a blue
rectangle), never private photos.

| Host | What was checked | Result |
|---|---|---|
| `openrouter.ai` | CORS preflight; free vision; paid Meta vision | CORS `*`. `nvidia/nemotron-3.5-super-vl:free` and two free alternatives returned 200 and correctly named the shapes. `meta-llama/llama-4-maverick` returned 200; canary cost $0.0000219. |
| `api.groq.com` | CORS; model list; text; vision | CORS `*`. 11 models; Meta entries only Prompt Guard 2 22M/86M classifiers; no vision model. GPT-OSS 120B and Qwen 3.8 27B text calls returned 200. |
| `integrate.api.nvidia.com` | CORS; Muse image | No CORS. `meta/muse-glimmer-30b` returned 200 and correctly named the shapes. 11B returned 404; 90B timed out. |
| `api.cloudflare.com` | CORS; Workers AI image | No CORS (OPTIONS 405). `@cf/meta/llama-3.2-11b-vision-instruct` returned 200 after licence acceptance and correctly named the shapes. |
| `api.blockrun.ai` | Text and image | 115 models listed, but both calls returned 402 `Payment verification failed`; no CORS. Unusable. |

Cloud hosts used by the shipped software:

- **Desktop:** NVIDIA NIM (`integrate.api.nvidia.com`) and Cloudflare Workers AI
  (`api.cloudflare.com`).
- **Phone:** OpenRouter (`openrouter.ai`) and Groq (`api.groq.com`, text only).
- **No IntentLens-owned cloud.** No Supabase, Firebase, Vercel function, AWS
  service or application backend is used.

### Development models versus shipped calls

The development agents that helped build this repository were **not Meta
models**, because Meta model API access was not available to them. That does not
describe the shipped inference path:

- Desktop vision calls use **Meta-published models** hosted by NVIDIA NIM or
  Cloudflare Workers AI.
- Phone calls use **OpenRouter**. The free default is an NVIDIA model because no
  free Meta vision route was available; paid Meta Maverick/Scout are explicit
  options with prices. Groq text chat uses non-Meta models because the account
  has no Meta chat model, and the UI labels that truthfully.
- Classifiers (Prompt Guard, Llama Guard) are never presented as chat or vision
  models.

### Why NVIDIA NIM was removed from the phone layout

NIM is a restricted, third-party host that does not return
`Access-Control-Allow-Origin`. A static GitHub Pages page cannot read its
responses, and NIM is not free. Muse was reachable server-side in the audit but
is not usable from the phone build. The desktop app keeps NIM because its local
Node server makes the request. A user-owned relay is the only phone workaround.

---

## Request logging

Both builds log the exact request, not just “request failed”.

### Phone

The **Provider request log** card records, for every Send, Explain and Test:

- method and full endpoint (`POST https://openrouter.ai/api/v1/chat/completions`)
- host (`openrouter.ai`)
- provider label
- mode (`vision`, `chat`, `explain`, `test`)
- model id sent and model id returned
- whether an image was attached
- HTTP status or error code
- latency, token usage and cost when the provider reports it
- request id

The log is memory-only. It never includes the API key or the image.

### Desktop

Server logs (`server/lib/http.js`, visible in the in-app **Logs** panel) now
include:

```text
POST https://integrate.api.nvidia.com/v1/chat/completions
provider=nvidia-nim host=integrate.api.nvidia.com
model=meta/muse-glimmer-30b returned=meta/muse-glimmer-30b
mode=vision http=200 status=ok latency=...ms request=...
```

Failures include each attempt’s provider, host, endpoint, model, error code and
latency. Cloudflare account ids are redacted in logged endpoints. Keys are never
logged.

---

## Privacy

- **Local-first.** Camera preview, grid, tracking, k-NN classification and
  project history run on the device. There is no analytics or telemetry.
- **One still per request.** The live video stream is never uploaded. Only the
  captured still, the prompt and a trimmed project context are sent when you
  press Send.
- **Cloud is off by default.** Nothing leaves the device until you allow cloud
  for the session.
- **Phone key is memory-only.** It is not persisted. See
  [Key preservation](#key-preservation).
- **Desktop key is encrypted at rest.** It is never returned to the page and
  never written to logs.
- **Provider policy applies.** OpenRouter, Groq, NVIDIA and Cloudflare receive
  what you send. Free does not automatically mean private or no-training. Check
  the selected model page before sending sensitive images.
- **No application backend.** IntentLens cannot see or retain your requests; the
  provider can. A user-owned relay is controlled by you, not by IntentLens.
- **Synthetic test images only.** The live audit used a generated shape image,
  never personal or private photos.
- **CSP caveat.** GitHub Pages cannot set response headers, so the PWA CSP is a
  `<meta>` tag only. `connect-src` allows HTTPS because the optional custom relay
  can live on any domain; the fixed providers are OpenRouter and Groq.

---

## Training and data

- **No LLM training or fine-tuning is performed by IntentLens.** There is no
  local generative model and no training job in this repository.
- The local classifier is a **k-NN reference index**, not a neural network. It
  uses a 2,027-dimensional frozen/LBP feature schema over the ElectroCom61
  dataset. The shipped runtime index has 305 references across 61 classes; the
  larger 8,877-reference index is an evaluation artifact, not the shipped DB.
- **User images and prompts are not used by IntentLens for training.** Providers
  may use data under their own terms; choose the model/provider accordingly.
- Development agents were non-Meta models due to lack of Meta model API access.
  This is disclosed because it is part of how the code was produced, not because
  the shipped app calls those agents.
- Dataset attribution: ElectroCom61, CC BY 4.0. See
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## Accuracy and limitations

- **Low local tracking accuracy.** The shipped 305-reference classifier rejects
  97.7% of test frames at the shipped threshold and reaches only 13.7% top-1 test
  accuracy after validation-only calibration. Even the 8,877-reference DB reaches
  about 52.7% under an always-answer protocol. Local labels are unverified
  candidates, not electrical facts. See [docs/KNN_EVALUATION.md](docs/KNN_EVALUATION.md).
- **No Meta glasses integration.** Meta Ray-Ban Display / device access toolkit
  access was not available, so the glasses integration was planned but **not
  built**. The phone camera and phone display are the only input/output.
- **Physical phone testing not done.** Camera permission, landscape rotation,
  install prompts and touch tracking are **NOT TESTED — DEVICE REQUIRED**.
- **Model coordinates are proposals.** The app validates and rejects invalid
  coordinates; it does not clamp a bad result into a fake marker. It cannot verify
  circuit connectivity or measure a component.
- **Provider availability changes.** Model catalogues, free quotas, CORS and
  prices can change without notice. The audit is a 2026-11-04 snapshot.
- **Groq has no vision model on this account.** Prompt Guard is a classifier and
  is never used for Q&A or images.
- **BlockRun is unusable with the supplied key.** HTTP 402 and no CORS.
- **Phone keys are not preserved.** This is intentional. Use the desktop app if
  you need encrypted key persistence.
- **Packaged desktop limitations.** The installer and window were previously
  exercised, but full safeStorage round-trips, camera permission, uninstall and
  shutdown/restart flows were not exhaustively tested in this audit.
- **No web search at runtime.** Evidence is limited to the local source vault
  and user-confirmed references.
- **Landscape-oriented.** The UI is designed for a landscape phone; portrait
  shows a rotation hint.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `AI_NOT_CONFIGURED` | No verified desktop vision provider | Configure NIM Muse or Cloudflare 11B. Groq cannot do vision on this account. |
| `NETWORK_DISABLED` | `ALLOW_OUTBOUND_NETWORK=false` | Set it to `true` and restart, or start with `start.cmd --online`. |
| `MODEL_AUTH_FAILED` | Bad/revoked key | Replace the key. |
| `MODEL_QUOTA_EXHAUSTED` | No credit | Add credit or change provider. |
| Phone “Network/CORS failure” | Custom relay missing CORS | Return `Access-Control-Allow-Origin` for the Pages origin; use HTTPS. |
| Phone key disappears after reload | By design | Re-enter it; use desktop for key preservation. |
| Camera permission denied | HTTP origin or browser setting | Use HTTPS (Pages) or localhost; check site permissions. |
| Groq image request refused | Groq has no vision model here | Switch to OpenRouter or use Chat for text. |
| “Model result rejected” | Invalid coordinates/schema | Nothing is drawn. Retry or choose a stronger vision model. |

---

## Repository layout

```text
index.html, app.js, style.css      desktop renderer
grid.js, componentResult.js        shared coordinate/validation logic
server/                            local Node backend
  config.js                        Meta-only catalog + verified model gate
  routes/analyze.js                validation, context, provider orchestration
  routes/providers.js              save/test/status without key disclosure
  services/*Provider.js            NIM, Cloudflare, Groq adapters
  services/provider.js             failover, cooldowns, error classification
electron/                          Electron shell + safeStorage bridge
pwa/                               static phone PWA (GitHub Pages)
pwa/provider.js                    browser provider catalog and calls
pwa/app.js                         phone UI, IndexedDB, request log
.github/workflows/pages.yml        test + prepare + deploy PWA
scripts/run-source-tests.mjs       source-only test runner
docs/                              architecture, audits, install, evaluation
```

---

## Docs

- [docs/INSTALL.md](docs/INSTALL.md) — desktop install and provider details
- [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md) — shorter setup walkthrough
- [docs/PWA_AUDIT_REPORT.md](docs/PWA_AUDIT_REPORT.md) — PWA audit and live provider evidence
- [docs/architecture.md](docs/architecture.md) — full MVP architecture specification
- [docs/KNN_EVALUATION.md](docs/KNN_EVALUATION.md) — classifier accuracy and reproduction
- [docs/DEVICE_TEST_CHECKLIST.md](docs/DEVICE_TEST_CHECKLIST.md) — physical phone checks
- [docs/AUDIT_MOBILE_ARCHITECTURE.md](docs/AUDIT_MOBILE_ARCHITECTURE.md) — mobile architecture audit
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — dataset attribution

---

## Safety

Use an unpowered, disconnected board for demos. A visual inference is not a
measurement. IntentLens does not verify circuit connectivity and does not
generate wiring or soldering instructions. Verify physical connections against a
real schematic.

No license file is present in this repository. Treat it as a private prototype
unless the owner adds an explicit license.
