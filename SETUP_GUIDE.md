# IntentLens Setup Guide

IntentLens is local-first. Camera preview, grid, tap/drag tracking and the k-NN
reference classifier run on this computer. Cloud image analysis is optional and is
sent only to the Meta-published vision provider you configure.

## Start

1. Double-click `start.cmd` to open the Electron desktop app.
   Use `start.cmd --online` if you want cloud providers enabled for that session.
2. For the browser UI instead: install Node.js 20+, run `start-browser.cmd`
   (or `node server/index.js`), then open Chrome or Edge at `http://localhost:8000`.
3. If no provider is configured, the first-run popup opens automatically.

## Connect a provider

Open the top-left menu -> **Vision Provider & Model** -> **Configure provider**.

Supported providers, in default failover order:

| Priority | Provider | Vision model examples |
|---|---|---|
| 1 | NVIDIA NIM | `meta/llama-3.2-11b-vision-instruct` |
| 2 | Cloudflare Workers AI | `@cf/meta/llama-4-scout-17b-16e-instruct` |
| 3 | Groq | `meta-llama/llama-4-scout-17b-16e-instruct` |

Only Meta vision models are accepted. Text-only Meta models are not sent images, and
non-Meta models are rejected.

### NVIDIA NIM (default)

1. Create a key at https://build.nvidia.com/.
2. In IntentLens choose **NVIDIA NIM**.
3. Keep the base URL `https://integrate.api.nvidia.com`. A dashboard link such as
   `https://build.nvidia.com` is not an inference endpoint.
4. Paste the key and press **Save & test**.

### Cloudflare Workers AI (fallback)

1. Sign in at https://dash.cloudflare.com/.
2. Create a Workers AI API token.
3. Copy the **Account ID** and **API Token**.
4. In IntentLens choose **Cloudflare Workers AI**, enter both values, and test.

### Groq (fallback, explicit Meta vision model)

1. Create a key at https://console.groq.com/.
2. In IntentLens choose **Groq**.
3. Select a Meta vision model. Groq is not used with a text-only model.

## How credentials are stored

Keys are encrypted at rest with Electron `safeStorage` under Electron, or Windows
DPAPI for the standalone server. They are never returned to the browser and never
written to logs. Placeholder values from `.env.example` are rejected.

The app does not write keys to plaintext `intentlens-config.json`. Legacy plaintext
configuration is migrated to the secure store when possible.

## Environment configuration

You can configure a headless server with `.env` instead of the UI:

```text
NIM_ENABLED=true
NIM_API_KEY=...
NIM_BASE_URL=https://integrate.api.nvidia.com
NIM_MODEL_ID=meta/llama-3.2-11b-vision-instruct
PROVIDER_PRIORITY=nvidia-nim,cloudflare-workers-ai,groq
ALLOW_OUTBOUND_NETWORK=true
```

`ALLOW_OUTBOUND_NETWORK=false` disables cloud analysis and provider tests. Local
camera, grid, tracking and k-NN still work.

Voice input is local: start a whisper.cpp server and set
`STT_URL=http://127.0.0.1:8080/inference` (loopback only). In the packaged desktop app
put that in `%APPDATA%\IntentLens\.env`; from source, the project `.env` works too.
Without it, typing works and the mic button explains what is missing.

## Verify

1. Start the camera or upload a photo.
2. Confirm the grid, tap-to-track and local k-NN work with no provider configured.
3. Configure a provider and press **Save & test**.
4. Type "where is the battery connector?" and press **Find it**.
5. Check **Logs** for provider, model and failover details. Keys are redacted.

## Common messages

- **`NO CLOUD AI KEY` / `AI_NOT_CONFIGURED`** - no usable provider is configured.
- **`NETWORK_DISABLED`** - set `ALLOW_OUTBOUND_NETWORK=true` and restart.
- **`MODEL_AUTH_FAILED`** - replace the provider key.
- **`MODEL_NOT_META`** - choose a Meta model from the catalog.
- **`MODEL_QUOTA_EXHAUSTED`** - add credit or switch providers.
- **Camera unavailable** - use `localhost`/HTTPS or **Upload photo**.

## Hardware note

There is no local LLM and no local Llama model in this build. The local classifier is
a k-NN reference index over 2,027-dimension frozen/LBP features, not a generative
language model. Do not download a 7.8 GB Llama vision model expecting the app to use
it.

## Phone use

A phone camera needs HTTPS or USB port forwarding. Plain `http://192.168.x.x` will
not get camera permission in most browsers; use **Upload photo** instead.

## Safety

Use an unpowered, disconnected board. IntentLens identifies and points at components.
It does not verify circuit connectivity and does not generate wiring or soldering
instructions.
