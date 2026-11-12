# Hosted segmentation (SAM 2 via Replicate)

**Status:** optional, off by default. Implemented on the server; not yet wired into the PWA overlay.

## What this is

A server-side adapter that asks a hosted SAM model for masks, then returns those
masks to the app as same-origin PNGs plus pixel metadata:

```json
{
  "ok": true,
  "segmentationId": "seg_...",
  "image": { "width": 1280, "height": 720 },
  "masks": [
    {
      "index": 0,
      "url": "/api/segmentation/seg_.../mask/0",
      "width": 1280,
      "height": 720,
      "bbox": { "x": 412, "y": 208, "width": 96, "height": 74 },
      "centroid": { "x": 460.2, "y": 245.8 },
      "areaPixels": 3841,
      "coverage": 0.0042,
      "score": 0.91,
      "method": "box-overlap",
      "decode": "png-8bit"
    }
  ],
  "provenance": {
    "provider": "replicate",
    "modelId": "meta/sam-2",
    "inputStyle": "automatic",
    "promptStrategy": "filter",
    "mode": "boxes",
    "predictionId": "...",
    "elapsedMs": 4210,
    "costUsd": 0.01,
    "costSource": "flat-rate estimate",
    "maskCount": 1,
    "candidateCount": 18
  }
}
```

The browser never receives the Replicate token. The mask URL is on the IntentLens
origin, so an overlay can draw it without CORS or expiring signed URLs.

## What this is not

**SAM is a promptable segmenter, not a component classifier.** It can isolate a
region. It cannot decide "resistor vs capacitor vs IC", "which pin is pin 1", or
"which way this connector faces". Those require labelled identity and guidance
data plus a classifier or vision model.

The adapter therefore reports masks and provenance only. It does not emit a
component name, a confidence that a part is correct, or an assembly step.

## Verified provider facts

As of this implementation:

| Fact | Value |
|---|---|
| Hosted model used | `meta/sam-2` on Replicate |
| Model family | SAM 2 (large variant only on this endpoint) |
| Input | Image only. The model README says video is not supported. |
| Output | `{ combined_mask, individual_masks }`, where each mask is a PNG URL |
| Prompting | Automatic mask generation (`points_per_side`, thresholds, `mask_limit`) |
| Native box/point prompts | **Not exposed by this endpoint** |
| `meta/sam-2.1` on Replicate | Not found (404 when checked) |

Meta's latest official SAM 2 checkpoint line is **SAM 2.1**. Replicate's public
`meta/sam-2` model is the SAM 2 large checkpoint with automatic mask generation.
If you have a specific SAM 2.1 deployment or version hash, set
`REPLICATE_SAM_MODEL` / `REPLICATE_SAM_VERSION` (or `inputStyle: "promptable"`)
and the adapter will use it.

Do not describe this integration as "SAM 2.5". No official Meta checkpoint by
that name was verifiable.

## Enable it

In `.env` (or the packaged app's `%APPDATA%\IntentLens\.env`):

```dotenv
SAM2_ENABLED=true
REPLICATE_API_TOKEN=r8_...
REPLICATE_SAM_MODEL=meta/sam-2
# Optional pin for reproducible runs:
# REPLICATE_SAM_VERSION=fe97b453a6455861e3bac769b441ca1f1086110da7466dbb65cf1eecfd60dc83
SAM2_INPUT_STYLE=automatic
SAM2_MAX_MASKS=12
SAM2_MAX_MASK_BYTES=4194304
SAM2_TIMEOUT_MS=180000
SAM2_MAX_WAIT_MS=180000
SAM2_COST_PER_RUN_USD=0.01
```

Also required:

```dotenv
ALLOW_OUTBOUND_NETWORK=true
```

Or save the same settings through the encrypted credential store:

```http
POST /api/segmentation/config
Content-Type: application/json

{ "enabled": true, "apiToken": "r8_...", "modelId": "meta/sam-2", "inputStyle": "automatic" }
```

The token is stored by the same `credentialStore` used for chat providers and is
never echoed in a response. `GET /api/segmentation` returns key-free status.

## Prompt strategies

The contract accepts normalized prompts (`0..1`), with an optional
`coordinateSpace: "pixels"` for callers that already know image dimensions.

### `promptStrategy: "filter"` (default with `meta/sam-2`)

The model gets one automatic mask-generation run. The server then ranks the
proposals against the request:

- **Box:** intersection-over-union plus how much of the box the proposal covers.
  A proposal must reach a minimum score; otherwise the result is empty.
- **Point:** prefer the smallest proposal that contains the point, then the
  nearest proposal centre.
- **Auto:** return the highest-scoring proposals, then larger areas.

This is **post-filtering**, not native prompting. The response says so. Never
present a filtered mask as if the model understood the box.

### `promptStrategy: "native"`

Set `SAM2_INPUT_STYLE=promptable` only for a deployment that actually accepts
`box`/`points`/`point_labels` inputs. The adapter maps normalized coordinates to
pixel coordinates and sends them directly. Verify the deployment's schema first;
a wrong mapping is worse than automatic proposals.

### Text prompts

Not supported by `meta/sam-2`. Text-guided segmentation needs a different model
(for example a Grounding DINO + SAM pipeline). The server rejects text prompts
with `SEGMENTATION_PROMPT_UNSUPPORTED` rather than silently ignoring them.

## Server API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/segmentation` | Key-free status, limits and budget |
| `POST` | `/api/segmentation` | Run one segmentation request |
| `POST` | `/api/segmentation/config` | Save token/model/toggle securely |
| `GET` | `/api/segmentation/:id/mask/:index` | Same-origin mask PNG |
| `DELETE` | `/api/segmentation/:id` | Drop cached masks |

Request:

```json
{
  "imageDataUrl": "data:image/jpeg;base64,...",
  "width": 1280,
  "height": 720,
  "mode": "boxes",
  "boxes": [{ "x": 0.32, "y": 0.28, "w": 0.08, "h": 0.1 }],
  "maxMasks": 4
}
```

`imageUrl` may be used instead of `imageDataUrl`, but only HTTPS URLs are
accepted. Private hosts, credentials in the URL and plain HTTP are refused.

## Limits and cost

- Inline image cap: `MAX_IMAGE_BYTES` (default 8 MB).
- Mask count cap: `SAM2_MAX_MASKS` (default 12, hard cap 32).
- Per-mask byte cap: `SAM2_MAX_MASK_BYTES` (default 4 MB).
- Provider wait cap: `SAM2_MAX_WAIT_MS` (default 180 s).
- Flat planning cost: `SAM2_COST_PER_RUN_USD` (default `$0.01`).
- A run is refused before the provider call if the estimate exceeds
  `MAX_REQUEST_USD` or the remaining daily/monthly budget.
- The ledger entry uses `source: "flat-rate"`. It is a guardrail, not an invoice.
- Mask PNGs are cached under `intentlens-data/segmentation/` for
  `SAM2_CACHE_TTL_MS` (default 24 h) and swept at startup.

Replicate bills by hardware time, so the actual cost varies. The flat estimate is
deliberately simple and conservative enough to stop accidental loops; it cannot
predict a slow prediction.

## Privacy

When enabled, the captured image is sent to Replicate. No continuous video is
sent. Mask output is downloaded to the local data directory and served only on
the IntentLens origin. The token stays in the server process and encrypted store.
If hosted segmentation is disabled, no image leaves the machine for segmentation.

## Evaluation rules

Do not collapse these into one "accuracy" number:

1. **Mask quality:** intersection-over-union against labelled masks, per class
   and overall. Report the sample count. Fewer than 30 labelled masks is not a
   trustworthy claim.
2. **Identity:** top-1 on masked crops vs the existing box-crop baseline. A mask
   that improves IoU but lowers top-1 is not an improvement.
3. **Guidance correctness:** for assembly, did the instruction name the right
   part, location and orientation? For inspection, did it point to the right pin,
   connector, polarity mark or solder region? These need step-level labels.

The existing pipeline is still the reproducible path:

```bat
node scripts/eval-accuracy.mjs --train train.jsonl --valid valid.jsonl --test test.jsonl --out datasets/processed/accuracy.json
```

It selects references on train, calibrates on validation and evaluates test once.
See `docs/PERCEPTION_AND_ACCURACY.md` and `docs/KNN_EVALUATION.md`.

## Why this does not close the 85% gap

Measured on ElectroCom61 (2,071 images / 12,667 boxes / 61 classes):

| System | Test top-1 | Coverage |
|---|---:|---:|
| 305-reference shipped index | 0.86% | 2.26% |
| 305 refs, validation-frozen threshold | 13.72% | 100% |
| Full 8,877 train references, k=1 | 53.78% | 100% |

SAM can improve mask boundaries and remove background from a crop. It cannot
create identity information that is not in the labels. Moving 54% to 85% needs
more labelled, varied instances and a stronger classifier, not only better masks.

For guidance, boxes are also insufficient. You still need:

- masks for component and board-region boundaries,
- connector and pin locations,
- polarity/orientation labels,
- step-level assembly and inspection labels.

Until those exist, the app must describe segmentation output as a proposal and
must not claim a measured build-guidance accuracy.
