# IntentLens Install & Run

IntentLens is a local-first web app served by a small Node.js backend. Camera,
grid, tap/drag tracking and the k-NN reference classifier run on this machine.
Cloud image analysis is optional and uses Meta-published vision models only.

## What you need

- **Windows 10/11** and **Node.js 22.5+** from https://nodejs.org/
- Internet on the first run (Electron is installed once)
- A provider key for cloud AI (Meta models only):
  - OpenRouter (recommended, paid per token): https://openrouter.ai/keys
  - Cloudflare Workers AI: https://dash.cloudflare.com/
  - NVIDIA NIM (hosts Meta models): https://build.nvidia.com/
  - Groq: text and voice only. It never receives images.
- **Phone:** no download. Open https://aizkinwork-star.github.io/intentlens/ ,
  served straight from this repository. See [../pwa/README.md](../pwa/README.md).

## Start

### Desktop app: download, extract, run (recommended)

1. On https://github.com/aizkinwork-star/intentlens click **Code -> Download ZIP**
   (direct link: https://github.com/aizkinwork-star/intentlens/archive/refs/heads/main.zip).
2. Right-click the ZIP -> **Extract All...** to a folder such as `C:\IntentLens`.
   Do not run it from inside the ZIP.
3. Open the extracted `intentlens-main` folder and double-click **`start.cmd`**.
   The first run installs Electron once, then the app opens.

```text
start.cmd            # desktop app, run from this folder's source
start.cmd --online   # same, with allowlisted provider hosts enabled
```

`start.cmd` always runs the code in the folder it sits in, so it is the version you
downloaded. To update, download the ZIP again into a new folder (or `git pull` if
you used `git clone`). Close any installed `IntentLens.exe` first: it is an older
frozen build and holds the single-instance lock. `start.cmd --packaged` launches an
installed or built exe instead.

The desktop app keeps cloud access **off by default** (`ALLOW_OUTBOUND_NETWORK=false`).
Pass `--online` when you want to use a cloud provider in that session.

### Optional: build an installer

```text
cd electron
npm install
npm run build        # -> electron\release\IntentLens Setup 0.4.0.exe
```

The installer is a frozen snapshot; rebuild it after every update. `setup.bat` and
`setup.ps1` are legacy installers that copy the folder elsewhere; prefer `start.cmd`.

### Manual

```text
node server/index.js
```

Then open `http://localhost:8000`.

## Connect a provider

Open the top-left menu and choose **Vision Provider & Model -> Configure provider**.
The first-run popup opens automatically when no provider is configured.

Supported Meta-model options (audit snapshot 2026-11-04):

| Priority | Provider | Default Meta model | Notes |
|---|---|---|---|
| 1 | OpenRouter | `meta-llama/llama-4-maverick` | Paid Meta vision, verified with a real image. |
| 2 | Cloudflare Workers AI | `@cf/meta/llama-3.2-11b-vision-instruct` | Real image verified after licence acceptance. |
| 3 | NVIDIA NIM | `meta/muse-glimmer-30b` | Real image returned valid JSON. 11B returned 404; 90B timed out. |
| 4 | BlockRun | `meta-llama/llama-4-maverick` | Paid x402 marketplace. The supplied key returned HTTP 402; restored for retry after credit. |
| 5 | Modal | `meta-llama/Llama-4-Maverick-17B-128E-Instruct` | Paid and **NOT tested**. Needs your deployed `*.modal.run` URL. |
| 6 | Groq | **text/voice only** | Never receives images. Meta Llama 3.3 70B Versatile is Enterprise-only on Groq. |

Enter the key, select a vision model, and press **Save & test**. A placeholder
key is never treated as configured. Non-Meta models are rejected. Any catalogued
vision model makes a provider eligible to be tested; unverified models keep a
visible warning and are never described as working.

Keys are encrypted at rest with Electron `safeStorage` under Electron, or Windows
DPAPI for the standalone server. They are never returned to the page and never logged.

### NVIDIA endpoint

Use the inference API host:

```text
NIM_BASE_URL=https://integrate.api.nvidia.com
```

The dashboard URL `https://build.nvidia.com` is not an inference endpoint. The server
normalizes an accidental dashboard URL to the allowlisted inference host.

### Environment variables instead of the UI

Copy `.env.example` to `.env` and fill in the values for the provider you use. Real
environment variables take precedence over `.env`.

```text
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

# Paid by default (Meta vision models are paid or account-gated).
MODEL_ACCESS_TIER=paid

GROQ_API_KEY=...

PROVIDER_PRIORITY=openrouter,cloudflare-workers-ai,nvidia-nim,blockrun,modal,groq
ALLOW_OUTBOUND_NETWORK=true
```

For headless use, keep `.env` out of source control. The file is gitignored.

## Network gate

`ALLOW_OUTBOUND_NETWORK=false` blocks cloud analysis and provider tests. Local camera,
grid, tap-to-track, local classification and project memory still work. Set it to
`true` and restart the server to use a cloud provider.

This app is **local-first, not fully offline**. It sends a captured frame, your
command and relevant task/object context to the selected Meta model host only when you
press **Find it**.

## Voice input (optional, local)

Electron cannot use Google's browser speech service, so voice input needs a local
speech-to-text process. Start whisper.cpp's server, then point `STT_URL` at it:

```text
whisper-server -m ggml-base.en.bin --host 127.0.0.1 --port 8080
```

```text
STT_URL=http://127.0.0.1:8080/inference
STT_LANGUAGE=en
```

Restart the app after changing `.env`. In the packaged desktop app the file lives at
`%APPDATA%\IntentLens\.env`; when running from source, the project `.env` also works.
`STT_URL` must be loopback-only; remote hosts are rejected. If it is not set, the mic
button shows the configuration hint and typing still works.

## Camera notes

- Laptop/USB camera usually works on `localhost`, which is a secure browser context.
- A phone camera needs HTTPS or USB port forwarding.
- Over plain HTTP, use **Upload photo**.
- Camera permission and tracking were not verified on physical hardware during the
  last audit.

## Verify local operation

1. Start the app and leave provider setup unconfigured, or set
   `ALLOW_OUTBOUND_NETWORK=false`.
2. Confirm camera preview or photo upload, grid size changes, tap/drag tracking and
   k-NN classification still work.
3. Confirm the UI says cloud AI is optional and does not claim a local Llama model.
4. Configure a provider only when you are ready to send a frame to that host.
5. Use **Logs** to inspect local diagnostics. Keys and image payloads are not logged.

## Troubleshooting

- **`NO CLOUD AI KEY` / `AI_NOT_CONFIGURED`** - open provider setup and save a real key.
- **`NETWORK_DISABLED`** - set `ALLOW_OUTBOUND_NETWORK=true` and restart.
- **`Speech error: network`** - Electron has no browser speech backend. Configure a
  local `STT_URL` (see Voice input) and use the mic again, or type the command.
- **`MODEL_AUTH_FAILED`** - replace the provider key.
- **`MODEL_NOT_META`** - choose a model from the Meta-only catalog.
- **`MODEL_QUOTA_EXHAUSTED`** - add credit or switch providers.
- **Camera unavailable** - use `localhost`/HTTPS or upload a photo.
- **Page says it is out of date after a server restart** - the page should refresh the
  token automatically; if it does not, reload once.

## Important files

| File | Purpose |
|---|---|
| `start.cmd` | Launches the Electron desktop app |
| `electron\release\IntentLens Setup 0.4.0.exe` | Desktop installer |
| `setup.bat` / `setup.ps1` | Legacy browser-server installers |
| `server/index.js` | Local HTTP backend and route dispatch |
| `server/config.js` | Meta-only catalog, priority and feature flags |
| `server/routes/providers.js` | Provider save/test/delete/status |
| `server/routes/analyze.js` | Request validation, network gate and orchestration |
| `server/services/nimProvider.js` | NVIDIA NIM adapter |
| `server/services/cloudflareProvider.js` | Cloudflare Workers AI adapter |
| `server/services/groqProvider.js` | Groq adapter |
| `server/services/provider.js` | Failover, health and error classification |
| `server/lib/credentialStore.js` | safeStorage/DPAPI credential persistence |
| `app.js` | UI, camera, tracking and provider setup |
| `looseObjectTracker.js` | Local component detection and k-NN tracking |
| `knn_reference_db_compact.bin` | Compact 2,027-dim reference index |

## Safety

IntentLens identifies and points at components. It does not verify circuit
connectivity and does not generate wiring or soldering instructions. Always verify
physical connections against a real schematic.
