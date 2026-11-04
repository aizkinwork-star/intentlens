# IntentLens Setup Guide

IntentLens is local-first. Camera preview, grid, tap/drag tracking and the k-NN
reference classifier run on this computer. Cloud image analysis is optional and is
sent only to the Meta-published vision provider you configure.

## Start

1. Double-click `start.cmd` to open the Electron desktop app.
   Use `start.cmd --online` if you want cloud providers enabled for that session.
2. For the browser UI instead: install Node.js 22.5+, run `node server/index.js`, then open Chrome or Edge at `http://localhost:8000`.
3. If no provider is configured, the first-run popup opens automatically.

## Connect a provider

Open the top-left menu -> **Vision Provider & Model** -> **Configure provider**.

Supported providers, in default failover order:

| Priority | Provider | Default Meta model |
|---|---|---|
| 1 | OpenRouter | `meta-llama/llama-4-maverick` (vision, paid) |
| 2 | NVIDIA NIM | `meta/muse-glimmer-30b` |
| 3 | Cloudflare Workers AI | `@cf/meta/llama-3.2-11b-vision-instruct` |
| 4 | BlockRun | `meta-llama/llama-4-maverick` (paid; HTTP 402 on the test key) |
| 5 | Modal | `meta-llama/Llama-4-Maverick-17B-128E-Instruct` (paid; NOT tested) |
| 6 | Groq | **no vision** (Prompt Guard classifiers only; Meta Llama 3.3 text first) |

Only Meta models are accepted. Text-only and classifier models are not sent
images, non-Meta models are rejected, and unverified models are labelled instead
of being described as working. Any catalogued vision model can be tested.

### OpenRouter (default)

1. Create a key at https://openrouter.ai/keys.
2. In IntentLens choose **OpenRouter**.
3. Keep `meta-llama/llama-4-maverick` or choose a free vision model with the
   price shown. Maverick is paid per token.
4. Paste the key and press **Save & test**.

### NVIDIA NIM

1. Create a key at https://build.nvidia.com/.
2. In IntentLens choose **NVIDIA NIM**.
3. Keep the base URL `https://integrate.api.nvidia.com`. A dashboard link such as
   `https://build.nvidia.com` is not an inference endpoint.
4. Paste the key and press **Save & test**.
5. Muse Glimmer is a reasoning model: a full request can take 80-120 seconds.

### BlockRun and Modal (paid)

- **BlockRun:** `https://api.blockrun.ai`. The supplied key returned HTTP 402
  `Payment verification failed`; add credit before expecting a reply.
- **Modal:** deploy your own OpenAI-compatible endpoint, paste its HTTPS
  `*.modal.run` URL and your token. This path is **NOT tested** in the audit and
  bills your Modal account.

### Cloudflare Workers AI (fallback)

1. Sign in at https://dash.cloudflare.com/.
2. Create a Workers AI API token.
3. Copy the **Account ID** and **API Token**.
4. In IntentLens choose **Cloudflare Workers AI**, enter both values, and test.

### Groq (account-dependent preview; no default)

1. Create a key at https://console.groq.com/.
2. There is **no default model**. Access and vision support depend on your
   account, so choose a model explicitly and press **Test connection**.
3. **Llama 3.3 70B Versatile is Enterprise-only**, was retired for Free and
   Developer users on 2026-08-16, and is text-only. It is never a default and
   never used for images.
4. Documented vision candidates are **Meta Muse Spark Open** (limited preview)
   and **Qwen 3.8 27B**. Enable Preview access before selecting one; neither is
   verified on the supplied account.
5. Prompt Guard entries are classifiers, not chat or vision models.
6. If your account has no vision model, use OpenRouter, NVIDIA NIM,
   Cloudflare Workers AI, BlockRun or Modal for image analysis.

## How credentials are stored

Keys are encrypted at rest with Electron `safeStorage` under Electron, or Windows
DPAPI for the standalone server. They are never returned to the browser and never
written to logs. Placeholder values from `.env.example` are rejected.

The app does not write keys to plaintext `intentlens-config.json`. Legacy plaintext
configuration is migrated to the secure store when possible.

## Environment configuration

You can configure a headless server with `.env` instead of the UI:

```text
OPENROUTER_API_KEY=...
OPENROUTER_MODEL_ID=meta-llama/llama-4-maverick

NIM_ENABLED=true
NIM_API_KEY=...
NIM_BASE_URL=https://integrate.api.nvidia.com
NIM_MODEL_ID=meta/muse-glimmer-30b

BLOCKRUN_API_KEY=...
MODAL_API_KEY=...
MODAL_BASE_URL=https://your-workspace--your-app.modal.run

GROQ_API_KEY=...
GROQ_VISION_MODEL=

MODEL_ACCESS_TIER=free
PROVIDER_PRIORITY=nvidia-nim,cloudflare-workers-ai,groq,openrouter,blockrun,modal
ALLOW_OUTBOUND_NETWORK=true
```

`ALLOW_OUTBOUND_NETWORK=false` disables cloud analysis and provider tests. Local
camera, grid, tracking and k-NN still work.

IntentLens uses text-only commands and responses.

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
