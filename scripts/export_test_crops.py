#!/usr/bin/env python
"""Export a small raw-RGBA sample of held-out test crops for the JS runtime test.

The JavaScript test cannot decode JPEGs without an extra dependency, so this
script writes already-cropped RGBA buffers plus their labels. The JS classifier
then performs its own resize/normalisation, so the test still exercises the real
runtime preprocessing and ONNX session.

Usage:
  python scripts/export_test_crops.py --root "datasets/.../ElectroCom61" \
      --out datasets/processed/eval_samples --count 60 --seed 7
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import numpy as np
from PIL import Image

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
CONTEXT_MARGIN = 0.10


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--out", default="datasets/processed/eval_samples")
    parser.add_argument("--count", type=int, default=60)
    parser.add_argument("--seed", type=int, default=7)
    return parser.parse_args()


def read_class_names(root: Path) -> list[str]:
    text = (root / "data.yaml").read_text(encoding="utf-8", errors="replace")
    start = text.find("names:")
    seq = text[start + len("names:"):].strip()
    seq = seq[1:seq.find("]")]
    return [item.strip().strip("'\"") for item in seq.split(",") if item.strip()]


def crop_box(image: Image.Image, x, y, w, h) -> Image.Image:
    iw, ih = image.size
    left = max(0, min(iw - 1, int(round((x - w / 2 - w * CONTEXT_MARGIN) * iw))))
    top = max(0, min(ih - 1, int(round((y - h / 2 - h * CONTEXT_MARGIN) * ih))))
    right = max(left + 1, min(iw, int(round((x + w / 2 + w * CONTEXT_MARGIN) * iw))))
    bottom = max(top + 1, min(ih, int(round((y + h / 2 + h * CONTEXT_MARGIN) * ih))))
    return image.crop((left, top, right, bottom)).convert("RGBA")


def main() -> None:
    args = parse_args()
    root = Path(args.root).resolve()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    class_names = read_class_names(root)

    items = []
    for label_path in sorted((root / "test" / "labels").glob("*.txt")):
        image_path = None
        for ext in IMAGE_EXTENSIONS:
            candidate = root / "test" / "images" / (label_path.stem + ext)
            if candidate.exists():
                image_path = candidate
                break
        if image_path is None:
            continue
        for line in label_path.read_text(encoding="utf-8", errors="replace").splitlines():
            parts = line.split()
            if len(parts) < 5:
                continue
            class_id = int(float(parts[0]))
            x, y, w, h = (float(v) for v in parts[1:5])
            if 0 <= class_id < len(class_names) and w > 0 and h > 0:
                items.append((image_path, class_id, x, y, w, h))

    random.Random(args.seed).shuffle(items)
    # Cover many classes: take at most one sample per class first, then fill.
    seen = set()
    selected = []
    for item in items:
        if item[1] not in seen:
            seen.add(item[1])
            selected.append(item)
        if len(selected) >= args.count:
            break
    for item in items:
        if len(selected) >= args.count:
            break
        if item not in selected:
            selected.append(item)

    samples = []
    with (out / "crops.rgba").open("wb") as handle:
        for index, (image_path, class_id, x, y, w, h) in enumerate(selected):
            with Image.open(image_path) as image:
                crop = crop_box(image, x, y, w, h)
            rgba = np.asarray(crop, dtype=np.uint8)
            handle.write(rgba.tobytes())
            samples.append({
                "index": index,
                "width": int(rgba.shape[1]),
                "height": int(rgba.shape[0]),
                "offset": index,
                "classId": int(class_id),
                "className": class_names[class_id],
                "source": image_path.name,
            })

    meta = {
        "dataset": str(root),
        "split": "test",
        "count": len(samples),
        "classes": class_names,
        "samples": samples,
        "note": "Held-out test crops. The JS test resizes/normalises these itself.",
    }
    (out / "samples.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"Wrote {len(samples)} samples to {out}")


if __name__ == "__main__":
    main()
