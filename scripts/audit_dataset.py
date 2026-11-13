#!/usr/bin/env python
"""Audit a YOLO-format dataset before training.

Writes a machine-readable inventory (JSON) plus a short markdown summary. The
audit is intentionally dependency-light: Python stdlib + Pillow + numpy.

Checks:
  * split counts, missing/unreadable images, orphan label files
  * annotations and distinct images per class
  * box validity / clipping / degenerate boxes
  * exact duplicate images across splits (leakage risk)
  * per-split class coverage and imbalance

Usage:
  python scripts/audit_dataset.py --root "datasets/.../ElectroCom61" \
      --out datasets/processed/audit.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
SPLITS = ("train", "valid", "test")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, help="Dataset root containing data.yaml")
    parser.add_argument("--out", default="datasets/processed/audit.json")
    parser.add_argument("--max-images", type=int, default=0, help="Limit per split (0 = all)")
    parser.add_argument("--hash-images", action="store_true", default=True)
    parser.add_argument("--no-hash-images", dest="hash_images", action="store_false")
    return parser.parse_args()


def read_class_names(root: Path) -> list[str]:
    yaml_path = root / "data.yaml"
    if not yaml_path.exists():
        raise SystemExit(f"data.yaml not found under {root}")
    text = yaml_path.read_text(encoding="utf-8", errors="replace")
    # The names list is a single YAML flow sequence in Roboflow exports.
    start = text.find("names:")
    if start < 0:
        raise SystemExit("data.yaml has no names: field")
    seq = text[start + len("names:"):].strip()
    if seq.startswith("["):
        end = seq.find("]")
        seq = seq[1:end]
        names = [item.strip().strip("'\"") for item in seq.split(",") if item.strip()]
        return names
    # Fallback: - name per line
    names = []
    for line in text.splitlines()[start + 1:]:
        line = line.strip()
        if line.startswith("- "):
            names.append(line[2:].strip().strip("'\""))
        elif line and not line.startswith("#"):
            break
    if not names:
        raise SystemExit("Could not parse class names from data.yaml")
    return names


def find_dirs(root: Path, split: str) -> tuple[Path, Path]:
    candidates = [(root / split / "images", root / split / "labels")]
    if split == "valid":
        candidates.insert(0, (root / "valid" / "images", root / "valid" / "labels"))
    for images, labels in candidates:
        if images.is_dir():
            return images, labels
    raise SystemExit(f"Missing images directory for split {split!r} under {root}")


def image_fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def audit_split(root: Path, split: str, class_names: list[str], max_images: int, hash_images: bool):
    images_dir, labels_dir = find_dirs(root, split)
    image_files = sorted(
        p for p in images_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
    )
    if max_images:
        image_files = image_files[:max_images]

    label_by_stem = {}
    if labels_dir.is_dir():
        for p in labels_dir.iterdir():
            if p.is_file() and p.suffix.lower() == ".txt":
                label_by_stem[p.stem] = p

    class_annotations = Counter()
    class_images = defaultdict(set)
    box_counts = Counter()
    degenerate = 0
    out_of_range = 0
    clipped = 0
    tiny_boxes = 0
    unknown_class = 0
    empty_labels = []
    missing_labels = []
    unreadable = []
    sizes = Counter()
    fingerprints = {}
    annotation_rows = 0

    for path in image_files:
        label_path = label_by_stem.get(path.stem)
        if label_path is None:
            missing_labels.append(path.name)
        try:
            with Image.open(path) as img:
                width, height = img.size
                img.verify()
            sizes[f"{width}x{height}"] += 1
        except Exception as exc:  # noqa: BLE001
            unreadable.append({"image": path.name, "error": str(exc)})
            continue
        if hash_images:
            fingerprints[path.name] = image_fingerprint(path)

        if label_path is None:
            continue
        rows = []
        for line_number, line in enumerate(
            label_path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1
        ):
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) < 5:
                unknown_class += 1
                continue
            try:
                class_id = int(float(parts[0]))
                x, y, w, h = (float(v) for v in parts[1:5])
            except ValueError:
                unknown_class += 1
                continue
            if class_id < 0 or class_id >= len(class_names):
                unknown_class += 1
                continue
            rows.append((class_id, x, y, w, h))
            annotation_rows += 1
            if w <= 0 or h <= 0:
                degenerate += 1
                continue
            if x < 0 or y < 0 or x > 1 or y > 1:
                out_of_range += 1
            if w * h < 1e-5:
                tiny_boxes += 1
            if x - w / 2 < -1e-6 or y - h / 2 < -1e-6 or x + w / 2 > 1 + 1e-6 or y + h / 2 > 1 + 1e-6:
                clipped += 1
            name = class_names[class_id]
            class_annotations[name] += 1
            class_images[name].add(path.name)

        box_counts[len(rows)] += 1
        if not rows:
            empty_labels.append(path.name)

    classes = []
    for class_id, name in enumerate(class_names):
        classes.append(
            {
                "id": class_id,
                "name": name,
                "annotations": class_annotations.get(name, 0),
                "images": len(class_images.get(name, ())),
            }
        )

    return {
        "split": split,
        "images": len(image_files),
        "labelFiles": len(label_by_stem),
        "annotations": annotation_rows,
        "classesPresent": sum(1 for c in classes if c["annotations"]),
        "classAnnotations": dict(sorted(class_annotations.items())),
        "classImages": {k: len(v) for k, v in sorted(class_images.items())},
        "classes": classes,
        "missingLabelFiles": missing_labels[:50],
        "missingLabelCount": len(missing_labels),
        "emptyLabelFiles": empty_labels[:50],
        "emptyLabelCount": len(empty_labels),
        "unreadableImages": unreadable,
        "degenerateBoxes": degenerate,
        "outOfRangeBoxes": out_of_range,
        "clippedBoxes": clipped,
        "tinyBoxes": tiny_boxes,
        "unknownClassRows": unknown_class,
        "imageSizes": dict(sizes.most_common(20)),
        "imagesPerBoxCount": {str(k): v for k, v in sorted(box_counts.items())},
        "fingerprints": fingerprints,
    }


def main() -> None:
    args = parse_args()
    root = Path(args.root).resolve()
    class_names = read_class_names(root)
    result = {
        "root": str(root),
        "classes": class_names,
        "classCount": len(class_names),
        "splits": {},
    }
    prints: dict[str, dict[str, str]] = {}
    for split in SPLITS:
        try:
            data = audit_split(root, split, class_names, args.max_images, args.hash_images)
        except SystemExit as exc:
            print(f"Skipping {split}: {exc}")
            continue
        prints[split] = data.pop("fingerprints")
        result["splits"][split] = data

    # Cross-split duplicate detection by exact file bytes.
    if prints:
        seen: dict[str, str] = {}
        duplicates = []
        for split, fingerprints in prints.items():
            for name, fp in fingerprints.items():
                if fp in seen:
                    duplicates.append({"first": seen[fp], "duplicate": f"{split}/{name}"})
                else:
                    seen[fp] = f"{split}/{name}"
        result["duplicateImagesAcrossSplits"] = duplicates[:100]
        result["duplicateImageCount"] = len(duplicates)

    totals = {
        "images": sum(s["images"] for s in result["splits"].values()),
        "annotations": sum(s["annotations"] for s in result["splits"].values()),
    }
    result["totals"] = totals

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    summary_path = out_path.with_suffix(".md")
    lines = [
        "# Dataset audit",
        "",
        f"Root: `{root}`",
        "",
        f"Classes: **{len(class_names)}**  |  Images: **{totals['images']}**  |  Annotations: **{totals['annotations']}**",
        "",
        "| Split | Images | Labels | Annotations | Classes present | Missing labels | Empty labels | Degenerate | Clipped |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for split, data in result["splits"].items():
        lines.append(
            f"| {split} | {data['images']} | {data['labelFiles']} | {data['annotations']} | "
            f"{data['classesPresent']} | {data['missingLabelCount']} | {data['emptyLabelCount']} | "
            f"{data['degenerateBoxes']} | {data['clippedBoxes']} |"
        )
    lines += [
        "",
        f"Exact duplicate images across splits: **{result.get('duplicateImageCount', 0)}**",
        "",
        "## Per-class annotation counts",
        "",
        "| Class | train | valid | test |",
        "| --- | ---: | ---: | ---: |",
    ]
    for name in class_names:
        counts = []
        for split in SPLITS:
            data = result["splits"].get(split)
            counts.append(data["classAnnotations"].get(name, 0) if data else 0)
        lines.append(f"| {name} | {counts[0]} | {counts[1]} | {counts[2]} |")
    summary_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"Wrote {out_path}")
    print(f"Wrote {summary_path}")
    print(
        f"images={totals['images']} annotations={totals['annotations']} "
        f"classes={len(class_names)} duplicates={result.get('duplicateImageCount', 0)}"
    )


if __name__ == "__main__":
    main()
