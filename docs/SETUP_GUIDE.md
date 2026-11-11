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

| Priority | Provider | Notes |
|---|---|---|
| 1 | OpenRouter | widest vision catalogue; free and paid models |
| 2 | Groq | vision availability depends on your account |
| 3 | Google AI Studio | Gemini; free tier available |
| 4 | NVIDIA NIM | inference host `integrate.api.nvidia.com` |
| 5 | Cloudflare Workers AI | needs an Account ID plus a Workers AI token |
| 6 | Mistral | Pixtral / Mistral Small |
| 7 | Cerebras | text catalogue only in this build; no vision model listed |
| 8 | Together AI | open-weight vision models |
| 9 | Hugging Face | router-style OpenAI-compatible endpoint |
| 10 | DeepInfra | paid open-weight models |
| 11 | OpenAI | GPT-4.1 / GPT-4o family |
| 12 | Anthropic | Claude via the Messages API |
| 13 | Ollama | local loopback, no key, no cloud request |
| 14 | Custom relay | your own HTTPS OpenAI-compatible endpoint |

Only **vision-capable** models receive an image. Text-only and classifier models
are refused before a request is sent. Entries marked *verified* have answered a
real image request on a test machine; everything else should be checked with
**Test connection**. Prices in `modelRegistry.js` are planning figures, not
invoices.

### OpenRouter (default)

1. Create a key at https://openrouter.ai/keys.
2. In IntentLens choose **OpenRouter**.
3. Keep the default model or choose a free or paid vision model. The price is shown.
4. Paste the key and press **Save & test**.

### NVIDIA NIM

1. Create a key at https://build.nvidia.com/.
2. In IntentLens choose **NVIDIA NIM**.
3. Keep the base URL `https://integrate.api.nvidia.com`. A dashboard link such as
   `https://build.nvidia.com` is not an inference endpoint.
4. Paste the key and press **Save & test**.
5. Some large models are slow: a full request can take 80-120 seconds.

### Custom relay

Deploy your own OpenAI-compatible endpoint and paste its HTTPS URL plus a token.
HTTPS is required for non-loopback hosts. Plain HTTP is accepted only for
`localhost`/`127.0.0.1`, and private LAN IP literals are refused so a saved relay
cannot turn the server into a local-network proxy.

### Cloudflare Workers AI (fallback)

1. Sign in at https://dash.cloudflare.com/.
2. Create a Workers AI API token.
3. Copy the **Account ID** and **API Token**.
4. In IntentLens choose **Cloudflare Workers AI**, enter both values, and test.

### Groq (account-dependent)

1. Create a key at https://console.groq.com/.
2. Access and vision support depend on your account, so choose a model explicitly
   and press **Test connection**.
3. Text-only model ids are refused before an image is sent.
4. Classifier entries (for example Prompt Guard) are not chat or vision models.
5. If your account has no vision model, use OpenRouter, Google AI Studio, NVIDIA
   NIM, Cloudflare Workers AI, Mistral or a custom relay for image analysis.

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
# OPENROUTER_MODEL_ID=google/gemini-2.5-flash

NIM_ENABLED=true
NIM_API_KEY=...
NIM_BASE_URL=https://integrate.api.nvidia.com
# NIM_MODEL_ID=meta/muse-glimmer-30b

CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
MISTRAL_API_KEY=...
CEREBRAS_API_KEY=...
TOGETHER_API_KEY=...
HF_TOKEN=...
DEEPINFRA_API_KEY=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...

GROQ_API_KEY=...
# GROQ_VISION_MODEL=

CUSTOM_API_KEY=...
CUSTOM_BASE_URL=https://your-relay.example.workers.dev

MODEL_ACCESS_TIER=free
PROVIDER_PRIORITY=openrouter,groq,google-ai-studio,nvidia-nim,cloudflare-workers-ai,mistral,cerebras,together,huggingface,deepinfra,openai,anthropic,ollama,custom
ALLOW_OUTBOUND_NETWORK=true
DAILY_BUDGET_USD=1.00
MONTHLY_BUDGET_USD=10.00
MAX_REQUEST_USD=0.25
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
- **`MODEL_NOT_VISION`** - choose a vision-capable model.
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
