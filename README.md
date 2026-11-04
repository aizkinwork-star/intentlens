# IntentLens

IntentLens is a local-first visual grounding prototype for electronics work.
Point a camera at a board, type a question, and get a short answer
plus a target position on a normalized overlay grid. The default grid is **64×64**;
16×16, 24×24, 32×32, 64×64 and 128×128 are available in Settings.

There are **two builds**:

| Build | Platform | Runtime | AI request path |
|---|---|---|---|
| **Desktop / Electron** | Windows PC | Electron + local Node server | Renderer → `localhost:8000` → provider API. Keys never enter the page. |
| **Phone PWA** | Android / iOS browser | Static GitHub Pages site | Browser → provider API directly. Keys stay in page memory. |

Live phone build: <https://aizkinwork-star.github.io/intentlens/>

> **Meta AI Developer Hackathon.** This project is an MVP made for the **Meta AI
> Developer Hackathon, partnered by Cerebral Valley**. Meta-published models are
> the priority across every provider; non-Meta models are explicitly labelled.

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
│    /api/providers credentials (never returned to the page)         │
│                         │                                          │
│        ┌────────────────┼─────────────────┬────────────────┐       │
│        ▼                ▼                 ▼                ▼       │
│   OpenRouter      NVIDIA NIM     Cloudflare Workers AI   BlockRun  │
│   Meta Llama 4    Meta Muse      Meta Llama 3.2 11B      Meta 4    │
│        │                │                 │                │       │
│        └────────────────┴──────── HTTPS ──┴────────────────┘       │
│                         │                                          │
│                  Modal (your deployment) + Groq (skipped: no Meta  │
│                  vision on this account)                           │
│                                                                    │
│  Local data: SQLite + images in intentlens-data/ or %APPDATA%      │
│  Credentials: Electron safeStorage / Windows DPAPI                 │
└────────────────────────────────────────────────────────────────────┘
```

The desktop renderer never sees provider keys. The server enforces an HTTPS
host allowlist, a Meta-only model catalogue, a network gate and sequential
failover with cooldowns. Providers with a catalogued vision model are
configurable even before they are verified, so an untested host can be tested
without pretending it already works.

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
│   OpenRouter API                   Groq API (text only)      │
│   Meta Llama 4 Maverick (paid)     no image input                  │
│         │                                                          │
│         └──────── HTTPS + CORS ─────────► upstream model           │
│                                                                    │
│  Also listed, with endpoint + CORS reason:                         │
│    NVIDIA NIM · Cloudflare Workers AI · BlockRun                   │
│    Modal (user endpoint) · Custom relay                            │
│  Those are refused before the network call on the phone and point  │
│  to the desktop app or a user relay instead of silently failing.   │
│                                                                    │
│  Local data: IndexedDB (projects, messages, images, settings)      │
│  Key: JavaScript memory only; cleared on reload                    │
└────────────────────────────────────────────────────────────────────┘
```

A static GitHub Pages site has no server to hide a key or proxy a request. Every
provider stays visible, including the ones a browser cannot call. A blocked host
is refused **before** any network request with its exact endpoint and the reason
(`PROVIDER_CORS_BLOCKED`), plus the desktop/relay alternative. Nothing is hidden
and nothing is silently swapped. The user can deploy their own HTTPS relay and
select **Custom relay**; IntentLens does not operate that relay.

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
5. **Ask** a question by typing, e.g. “where is the battery connector?”.
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
- Node.js **22.5 or newer** from <https://nodejs.org/>
- Internet on the first run (Electron is installed once)
- A provider key for cloud AI (OpenRouter recommended; Cloudflare Workers AI,
  NVIDIA NIM, BlockRun or Modal also work on the PC; Groq is text-only)

### A. Download the ZIP and run it (recommended)

1. Open <https://github.com/aizkinwork-star/intentlens> and click
   **Code → Download ZIP**, or use the direct link:
   <https://github.com/aizkinwork-star/intentlens/archive/refs/heads/main.zip>
2. Right-click the ZIP → **Extract All…** and pick a folder, for example
   `C:\IntentLens`. Do not run it from inside the ZIP.
3. Open the extracted `intentlens-main` folder and double-click **`start.cmd`**.
   The first run installs Electron (one time, a few minutes), then the app opens.
4. In the app, open the top-left menu → **Vision Provider & Model** →
   **Configure provider**, enter a provider key and press **Save & test**.
5. Cloud access is off by default. Start with **`start.cmd --online`** (run it
   from a Command Prompt in that folder) to allow provider hosts for that session.

`start.cmd` always runs the code in the folder it sits in, so it is the version
you downloaded. To update, download the ZIP again and extract it to a new folder.
Close any older installed `IntentLens.exe` first; it would block the new window.

Data lives in `%APPDATA%\IntentLens\`. The encrypted credential file is
`%APPDATA%\IntentLens\credentials.safe`. Do not delete it unless you intend to
re-enter every key.

### B. Clone with git (easier updates)

```cmd
git clone https://github.com/aizkinwork-star/intentlens.git
cd intentlens
start.cmd                 :: desktop app, run from this folder's source
start.cmd --online        :: same, with cloud providers enabled
start.cmd --packaged      :: use an installed/built IntentLens.exe (old snapshot)
```

Update later with `git pull`. Do not run another server on port 8000 at the same
time as the app.

### C. Build the installer (optional)

Only needed if you want a standalone `.exe` installer to hand to someone. It is
a frozen snapshot, so rebuild it after every update.

```cmd
cd electron
npm install
npm run build
```

Output: `electron/release/IntentLens Setup 0.4.0.exe`.

### D. Tests

```cmd
npm test
:: 27 source test files, 224 tests, 0 failures at the 2026-11-04 checkpoint
```

`npm test` excludes `node_modules`, `datasets`, `intentlens-data` and build
output. `npm run test:all` also discovers stale copies under `electron/release`
and is therefore not the source-of-truth count.

---

## Install on a phone (GitHub Pages PWA)

**No download needed.** The phone app is served straight from this repository by
GitHub Pages: just open <https://aizkinwork-star.github.io/intentlens/> on the
phone. It updates itself whenever the repository's `main` branch changes.

### Requirements

- A phone with a modern browser (Chrome on Android, Safari on iOS)
- HTTPS. GitHub Pages provides it; a plain LAN IP does not.
- An OpenRouter key for image analysis (or a custom relay)
- NVIDIA NIM, Cloudflare Workers AI and BlockRun are listed on the phone but
  cannot be called from a browser without CORS; use the PC app or a relay.

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

**Only Meta-published models are ever called, on every provider.** Every model
id is checked against a Meta-only allowlist before a key check or network call;
anything else, including ids typed by hand, is refused with `NON_META_MODEL`.
Access is **paid** by default: no free Meta vision model was usable, so the app
assumes you have billing on the host you choose. "Desktop only" means the host
works through the Electron server but cannot be read by a browser because of CORS.

| Provider | Desktop | Phone PWA | Default / model | Cost | Notes |
|---|---|---|---|---|---|
| **OpenRouter** | **Yes** | **Yes** | `meta-llama/llama-4-maverick` (Meta vision) | **Paid per token** | CORS `*`, so it is the only image-capable host the phone can call directly. $0.1875/M input, $0.6525/M output. |
| **Cloudflare Workers AI** | **Yes** | **Listed, blocked** | `@cf/meta/llama-3.2-11b-vision-instruct` (Meta vision) | Cloudflare account pricing | Verified with a real image after licence acceptance. Preflight OPTIONS returns 405 and no CORS; needs Account ID + token. |
| **NVIDIA NIM** | **Yes** | **Listed, blocked** | `meta/muse-glimmer-30b` (Meta vision) | NVIDIA account | Hosts Meta models only here. No `Access-Control-Allow-Origin`, so the phone refuses before network. |
| **BlockRun** | **Yes (paid)** | **Listed, blocked** | `meta-llama/llama-4-maverick` (Meta vision) | **Paid x402** | The supplied key returned HTTP 402 `Payment verification failed` and the host sends no CORS. |
| **Modal** | **Yes (paid)** | **Listed, user endpoint** | `meta-llama/Llama-4-Maverick-17B-128E-Instruct` | **Paid** | Paste your deployed `*.modal.run` OpenAI-compatible URL. **NOT tested** in the audit. |
| **Groq** | **Text only** | **Text only** | None | Groq account | **No image input, ever.** Text chat only; image requests are refused before any network call. Llama 3.3 70B Versatile is Enterprise-only on Groq, so a free account may expose no Meta chat model. |
| **Custom relay** | Not wired | **Yes** | Your choice (Meta ids only) | Your cost | Your HTTPS relay must allow this Pages origin. Non-Meta model ids are still refused. |

**Limitations of the paid-only setup.** On the phone, every provider call goes
straight from the browser, so only OpenRouter (and text-only Groq) can work
without a relay; Cloudflare, NVIDIA-hosted Meta models and BlockRun need the PC
app or your own relay. Phone camera and photo upload have **not been tested on a
physical phone**. Free tiers on the listed hosts may exist but are not relied on.

### Desktop provider setup

1. Menu → **Vision Provider & Model** → **Configure provider**.
2. **Model access** is **All Meta models (paid per token)**. Only Meta models
   are ever offered or sent.
3. Choose OpenRouter, Cloudflare Workers AI, NVIDIA NIM, BlockRun, Modal or Groq
   (Groq is text-only).
4. Enter the key. Cloudflare also needs the Account ID; Modal also needs the
   HTTPS URL of your deployed endpoint.
5. Choose a vision model from that provider's Meta catalogue.
6. Press **Save & test**.

A provider with a catalogued **vision** model is eligible even when the model is
not verified yet, so BlockRun and Modal can be configured and tested. The UI keeps the "not verified yet"
warning and the test result tells you whether it actually works. Text-only and
classifier models are never eligible for images. Groq never receives an image.

Modal is **paid and was not tested**. BlockRun is **paid** and the supplied key
returned HTTP 402. Neither is presented as working.

### Phone provider setup

1. Settings → Provider.
2. **Model access** is **All Meta models (paid per token)**. The default model is
   `meta-llama/llama-4-maverick` on OpenRouter, which bills your OpenRouter
   account per token.
3. Paste a key; it stays in memory for this tab. The key is sent directly from
   the browser and is never stored.
4. Optional: type a Meta model id. The exact id is sent in the request body and
   is shown in the request log. Non-Meta ids and text-only models are refused
   for images before any network call.
5. Cloudflare Workers AI, NVIDIA-hosted Meta models and BlockRun are listed with their endpoint
   and a **blocked** reason. They are refused before any network call on the
   phone. Use the PC app or your own relay.
6. Modal and Custom relay accept a user-supplied HTTPS base URL. Modal is paid
   and untested here; CORS depends on the deployment.

### Environment variables (headless desktop)

Copy `.env.example` to `.env` and set only the providers you use:

```text
# Paid by default (all usable Meta vision models are paid or account-gated).
MODEL_ACCESS_TIER=paid

OPENROUTER_API_KEY=...
OPENROUTER_MODEL_ID=meta-llama/llama-4-maverick

NIM_ENABLED=true
NIM_API_KEY=...
NIM_BASE_URL=https://integrate.api.nvidia.com
NIM_MODEL_ID=meta/muse-glimmer-30b

CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_MODEL_ID=@cf/meta/llama-3.2-11b-vision-instruct

BLOCKRUN_API_KEY=...
BLOCKRUN_MODEL_ID=meta-llama/llama-4-maverick

MODAL_API_KEY=...
MODAL_BASE_URL=https://your-workspace--your-app.modal.run
MODAL_MODEL_ID=meta-llama/Llama-4-Maverick-17B-128E-Instruct

# No default. Set a model you have confirmed with Test connection.
GROQ_API_KEY=...

PROVIDER_PRIORITY=openrouter,cloudflare-workers-ai,nvidia-nim,blockrun,modal,groq
ALLOW_OUTBOUND_NETWORK=true
```

`MODEL_ACCESS_TIER` is always treated as paid unless you explicitly set `preview`.
Set it to `paid` only when you actually have billing on that provider.

`ALLOW_OUTBOUND_NETWORK=false` blocks cloud analysis and provider tests without
affecting camera, grid, tracking or the local classifier.

---

## Which cloud hosts and models were used

Live audit date: **2026-11-04**. Keys were used only for testing and were not
logged, committed or shown. Test images were synthetic (a red circle and a blue
rectangle), never private photos.

| Host | What was checked | Result |
|---|---|---|
| `openrouter.ai` | CORS preflight; paid Meta vision | CORS `*`. `meta-llama/llama-4-maverick` returned 200 and correctly named the shapes; a small canary cost about $0.00002. |
| `api.groq.com` | CORS; model list; text | CORS `*`. Meta entries on the tested account were only Prompt Guard 2 22M/86M classifiers; no Meta chat or vision model. Groq is therefore text-only in IntentLens. |
| `integrate.api.nvidia.com` | CORS; Muse image | No CORS. `meta/muse-glimmer-30b` returned 200 and correctly named the shapes. 11B returned 404; 90B timed out. |
| `api.cloudflare.com` | CORS; Workers AI image | No CORS (OPTIONS 405). `@cf/meta/llama-3.2-11b-vision-instruct` returned 200 after licence acceptance and correctly named the shapes. |
| `api.blockrun.ai` | Text and image | 115 models listed, but both calls returned 402 `Payment verification failed`; no CORS. Paid and currently unusable with the supplied key. |
| `*.modal.run` | Deployed endpoint | **NOT TESTED.** No Modal deployment URL was available. It is paid; CORS is decided by the deployment. |

Cloud hosts used by the shipped software:

- **Desktop:** OpenRouter (`openrouter.ai`), NVIDIA NIM (`integrate.api.nvidia.com`),
  Cloudflare Workers AI (`api.cloudflare.com`), BlockRun (`api.blockrun.ai`),
  Modal (your `*.modal.run` deployment) and Groq (`api.groq.com`, text only).
- **Phone:** OpenRouter (`openrouter.ai`) and Groq (`api.groq.com`, text only)
  can be called directly. NVIDIA NIM, Cloudflare, BlockRun and Modal are listed
  with their endpoint and reason; they need the desktop app or a user relay.
- **No IntentLens-owned cloud.** No Supabase, Firebase, Vercel function, AWS
  service or application backend is used.

### Development models versus shipped calls

The development agents that helped build this repository were **not Meta
models**, because Meta model API access was not available to them. That does not
describe the shipped inference path:

- **Only Meta models are called**, on every provider. A hard allowlist check
  runs before any key check or request, and `metaOnly.test.js` fails the build
  if a non-Meta model appears in a catalogue.
- Vision: OpenRouter and BlockRun to Llama 4 Maverick, Modal to Llama 4
  Maverick, Cloudflare to Llama 3.2 11B Vision, NVIDIA-hosted Meta Muse Glimmer.
- Groq is **text only**; it never receives an image.
- Classifiers (Prompt Guard, Llama Guard) are never presented as chat or vision
  models.

### Typed model ids are sent exactly

Both clients pass the typed id through unchanged:

- **Phone:** `callModel` sends `{ model: requestedModel }`; the id is never
  replaced by another provider's default. An empty id fails with `NO_MODEL`
  before any request. The request log shows the exact model that was sent.
- **Desktop:** the server uses the supplied `modelId` verbatim after validating
  it against the Meta catalogue for that provider; a model from another
  provider's catalogue is rejected. The provider test response and server log
  include the exact model id.

### Real-board test status

**No real physical-board test has been run.** Every image verification in this
repository used a synthetic image (a red circle and a blue rectangle). A real
board photo, a real question and a live provider response remain **NOT TESTED**
and require a physical board plus a working provider key.

### Why the blocked providers stay visible on the phone

NVIDIA NIM, Cloudflare Workers AI and BlockRun do not return usable CORS headers
for a GitHub Pages origin. Hiding them made the phone look like it supported
fewer hosts than the PC and gave no explanation. They are now listed with their
exact endpoint, CORS evidence, price and the `PROVIDER_CORS_BLOCKED` reason, and
are refused before any network call. The desktop app can call all of them because
its local Node server makes the request. Modal and Custom relay take a user-owned
URL; their CORS policy is the deployment's responsibility.

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
- **Provider policy applies.** OpenRouter, Groq, NVIDIA, Cloudflare, BlockRun and
  your Modal deployment receive what you send. Free does not automatically mean
  private or no-training. Check the selected model page before sending sensitive
  images.
- **No application backend.** IntentLens cannot see or retain your requests; the
  provider can. A user-owned relay is controlled by you, not by IntentLens.
- **Synthetic test images only.** The live audit used a generated shape image,
  never personal or private photos.
- **CSP caveat.** GitHub Pages cannot set response headers, so the PWA CSP is a
  `<meta>` tag only. `connect-src` allows HTTPS because Modal deployments and
  the optional custom relay can live on any domain; the fixed providers are
  OpenRouter, Groq, NVIDIA NIM, Cloudflare Workers AI and BlockRun.

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
  is never used for Q&A or images. Meta Llama 3.3 70B is listed first but may not
  be enabled on a restricted account.
- **BlockRun is unusable with the supplied key.** HTTP 402 and no CORS. It remains
  visible and configurable so credit can be added and retried.
- **Modal is paid and untested.** No deployment URL was available in the audit.
  CORS and model availability depend on your deployment.
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
| `AI_NOT_CONFIGURED` | No desktop vision provider | Configure OpenRouter, NIM Muse, Cloudflare 11B, BlockRun or Modal. Groq cannot do vision on this account. |
| `NETWORK_DISABLED` | `ALLOW_OUTBOUND_NETWORK=false` | Set it to `true` and restart, or start with `start.cmd --online`. |
| `MODEL_AUTH_FAILED` | Bad/revoked key | Replace the key. |
| `MODEL_QUOTA_EXHAUSTED` | No credit | Add credit or change provider. |
| Phone `PROVIDER_CORS_BLOCKED` | NVIDIA NIM / Cloudflare / BlockRun has no browser CORS | Use the PC app or a user-owned relay; the message names the endpoint. |
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
  services/openaiCompatibleProvider.js  OpenRouter, BlockRun, Modal adapter
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
