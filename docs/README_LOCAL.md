# IntentLens - Local-First Overview

IntentLens is a local-first visual grounding prototype for electronics work. Camera
preview, grid interaction, tap/drag tracking and k-NN component classification run on
this computer. Cloud generative analysis is optional.

For installation and provider setup, see [INSTALL.md](INSTALL.md) or
[SETUP_GUIDE.md](SETUP_GUIDE.md). For the master overview, architecture and
limitations, see [../README.md](../README.md).

## What runs locally

- Camera preview and photo upload
- Normalized overlay grid, default 64x64
- Tap/drag local tracking
- Compact k-NN reference classifier: 2,027-dim features, 305 references, 61 classes
- SQLite project memory, images and task history
- Browser Web Speech API for speech recognition and TTS (platform-dependent)

## What uses the cloud

Only the optional Meta vision analysis. The provider order is:

1. NVIDIA NIM (Meta Muse Glimmer 30B — verified)
2. Cloudflare Workers AI (Meta Llama 3.2 11B — verified)
3. Groq — skipped: the supplied account has only Prompt Guard classifiers

A captured frame is sent only when the user presses **Find it**. No continuous video
is streamed. The app is local-first, not fully offline.

There is **no local LLM** and no local Llama model in this build. Local classification
produces candidates, not electrical facts. Confirm component identity before relying
on it.

## Meta-only policy

Only models published by Meta are eligible. Non-Meta models are rejected before
saving. Text-only Meta models are never sent images.

Provider keys are encrypted at rest with Electron `safeStorage` or Windows DPAPI and
are never returned to the browser or written to logs.

## Safety

Use an unpowered, disconnected board. A visual inference is not a measurement.
IntentLens does not verify circuit connectivity and does not generate wiring or
soldering instructions.
