# IntentLens Install & Run

IntentLens is a local-first web app served by a small Node.js backend. Camera,
grid, tap/drag tracking and the k-NN reference classifier run on this machine.
Cloud image analysis is optional and uses Meta-published vision models only.

## What you need

- **Node.js 20+** from https://nodejs.org/
- A browser such as Chrome or Edge
- Optional: a Meta vision provider key
  - NVIDIA NIM (default): https://build.nvidia.com/
  - Cloudflare Workers AI: https://dash.cloudflare.com/
  - Groq, only when an explicit Meta vision model is available: https://console.groq.com/

## Start

### Desktop app (recommended)

```text
start.cmd            # launches the Electron desktop app
start.cmd --online   # same, with allowlisted provider hosts enabled
```

`start.cmd` opens the installed app if present, otherwise the packaged build in
`electron\release\win-unpacked\IntentLens.exe`.

The desktop app keeps cloud access **off by default** (`ALLOW_OUTBOUND_NETWORK=false`).
Pass `--online` when you want to use NVIDIA, Cloudflare or Groq in that session.

### Installer

```text
electron\release\IntentLens Setup 0.4.0.exe   # Electron desktop installer
setup.bat                                    # legacy browser-server installer
setup.ps1                                    # legacy PowerShell installer
```

### Browser UI (development only)

```text
start-browser.cmd    # Node backend + default browser
```

This starts the backend at `http://localhost:8000`. Do not run it at the same time
as the desktop app: both use port 8000.

### Manual

```text
node server/index.js
```

Then open `http://localhost:8000`.

## Connect a provider

Open the top-left menu and choose **Vision Provider & Model -> Configure provider**.
The first-run popup opens automatically when no provider is configured.

Supported Meta-only options:

| Priority | Provider | Vision model examples |
|---|---|---|
| 1 | NVIDIA NIM | `meta/llama-3.2-11b-vision-instruct`, `meta/llama-3.2-90b-vision-instruct` |
| 2 | Cloudflare Workers AI | `@cf/meta/llama-4-scout-17b-16e-instruct`, `@cf/meta/llama-3.2-11b-vision-instruct` |
| 3 | Groq | `meta-llama/llama-4-scout-17b-16e-instruct` |

Enter the key, select a vision model, and press **Save & test**. A placeholder key is
never treated as configured. Non-Meta models are rejected.

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
NIM_ENABLED=true
NIM_API_KEY=...
NIM_BASE_URL=https://integrate.api.nvidia.com
NIM_MODEL_ID=meta/llama-3.2-11b-vision-instruct
PROVIDER_PRIORITY=nvidia-nim,cloudflare-workers-ai,groq
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
| `start-browser.cmd` | Browser development launcher (port 8000) |
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
