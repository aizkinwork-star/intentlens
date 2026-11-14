#!/usr/bin/env python
"""Train a lighting- and rotation-robust ElectroCom61 classifier.

The baseline frozen-embedding classifier is accurate on clean dataset crops but
was never trained on dim frames. This script keeps the same backbone + linear
head design and adds the augmentations the device actually sees:

  * opacity stages 0.75 / 0.50 / 0.30 (crop blended toward black, i.e. dim light)
  * a small rotation, uniformly sampled in [-3, +3] degrees

Embeddings for the clean crops are reused from the baseline cache when the
labels match, so the extra cost is only the augmented copies. Every metric is
reported per lighting stage, and the test split is evaluated once per stage
after the head is frozen. Selection uses validation only.

Usage:
  python scripts/train_robust_classifier.py \
      --root "datasets/.../ElectroCom61" \
      --out datasets/processed/cnn_resnet18_robust_v1 \
      --baseline datasets/processed/cnn_resnet18_v1
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, confusion_matrix
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_cnn_classifier import (  # noqa: E402
    IMAGENET_MEAN,
    IMAGENET_STD,
    INPUT_SIZE,
    build_backbone,
    crop_box,
    load_split,
    preprocess,
    read_class_names,
)

# Opacity here means "fraction of the original pixel value over black": 1.0 is a
# normal frame, 0.3 is a badly lit one. The runtime benchmark uses the same
# numbers, so a reported stage number can be reproduced in the shipped JS path.
STAGES = (("slight", 0.75), ("medium", 0.50), ("low", 0.30))
STAGE_NAMES = tuple(name for name, _ in STAGES)
C_GRID = (0.03, 0.1, 0.3, 1.0)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--out", default="datasets/processed/cnn_resnet18_robust_v1")
    parser.add_argument("--baseline", default="datasets/processed/cnn_resnet18_v1")
    parser.add_argument("--backbone", default="resnet18", choices=["resnet18", "mobilenet_v3_small", "mobilenet_v3_large"])
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--limit-per-class", type=int, default=110,
                        help="Cap augmented training crops per class and stage (0 = no cap).")
    parser.add_argument("--valid-limit-per-class", type=int, default=30,
                        help="Cap augmented validation crops per class and stage (0 = no cap).")
    parser.add_argument("--test-limit-per-class", type=int, default=0,
                        help="Smoke-test only: cap test crops per class and stage (0 = full test split).")
    parser.add_argument("--rotation", type=float, default=3.0)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--threads", type=int, default=0)
    return parser.parse_args()


def stage_opacity(name: str) -> float:
    for stage, opacity in STAGES:
        if stage == name:
            return opacity
    raise KeyError(name)


def apply_stage(image: Image.Image, stage: str, rotation: float, rng: random.Random) -> Image.Image:
    """Apply one lighting stage plus an optional small rotation."""
    out = image.convert("RGB")
    if stage == "clean" and not rotation:
        return out
    if rotation:
        angle = rng.uniform(-rotation, rotation)
        out = out.rotate(angle, resample=Image.BILINEAR, expand=False)
    if stage != "clean":
        array = np.asarray(out, dtype=np.float32) * stage_opacity(stage)
        out = Image.fromarray(np.clip(array, 0, 255).astype(np.uint8), mode="RGB")
    return out


def _rng_for(stage_index: int, class_id: int, row_index: int, seed: int) -> random.Random:
    # random.Random(int) is stable across processes and Python versions.
    return random.Random(seed + stage_index * 104729 + class_id * 100003 + row_index * 7919)


def expected_labels(by_image, class_limit: int | None = None) -> np.ndarray:
    labels = []
    seen: Counter = Counter()
    for rows in by_image.values():
        for class_id, *_ in rows:
            if class_limit:
                if seen[class_id] >= class_limit:
                    continue
                seen[class_id] += 1
            labels.append(class_id)
    return np.asarray(labels, dtype=np.int16)


def iter_crops(by_image: dict, class_limit: int | None = None):
    """Yield (image, class_id, x, y, w, h, row_index) honouring a per-class cap."""
    seen: Counter = Counter()
    row_index = 0
    for image_path, rows in by_image.items():
        with Image.open(image_path) as image:
            image = image.convert("RGB")
            for class_id, x, y, w, h in rows:
                row_index += 1
                if class_limit:
                    if seen[class_id] >= class_limit:
                        continue
                    seen[class_id] += 1
                yield image, class_id, x, y, w, h, row_index


@torch.inference_mode()
def embed_stage(backbone, by_image, stage: str, stage_index: int, rotation: float,
                class_limit: int | None, mean, std, batch_size: int, desc: str, seed: int):
    features, labels = [], []
    batch, batch_labels = [], []
    started = time.time()
    done = 0
    total = len(expected_labels(by_image, class_limit))
    for image, class_id, x, y, w, h, row_index in iter_crops(by_image, class_limit):
        crop = crop_box(image, x, y, w, h)
        crop = apply_stage(crop, stage, rotation, _rng_for(stage_index, class_id, row_index, seed))
        batch.append(preprocess(crop, mean, std))
        batch_labels.append(class_id)
        done += 1
        if len(batch) >= batch_size:
            features.append(backbone(torch.stack(batch)).numpy())
            labels.extend(batch_labels)
            batch, batch_labels = [], []
            if done % (batch_size * 8) < batch_size:
                rate = done / max(1e-6, time.time() - started)
                print(f"  {desc}: {done}/{total} ({rate:.0f}/s)", flush=True)
    if batch:
        features.append(backbone(torch.stack(batch)).numpy())
        labels.extend(batch_labels)
    matrix = np.concatenate(features).astype(np.float32)
    print(f"  {desc}: {done} crops in {time.time() - started:.0f}s", flush=True)
    return matrix, np.asarray(labels, dtype=np.int16)


def load_cached_split(path: Path, split: str, expected: np.ndarray, dim: int):
    """Reuse clean embeddings only when the cached labels line up exactly."""
    if not path.exists():
        return None
    cached = np.load(path)
    key_x, key_y = f"{split}X", f"{split}Y"
    if key_x not in cached or key_y not in cached:
        return None
    matrix, labels = cached[key_x], cached[key_y]
    if matrix.shape[1] != dim or len(labels) != len(expected) or not np.array_equal(labels, expected):
        return None
    print(f"Reusing clean {split} embeddings from {path}", flush=True)
    return matrix.astype(np.float32), labels.astype(np.int16)


def evaluate(model, scaler, matrix, labels, class_names, min_class_support=1):
    predictions = model.predict(scaler.transform(matrix))
    accuracy = float(accuracy_score(labels, predictions))
    confusion = confusion_matrix(labels, predictions, labels=list(range(len(class_names))))
    per_class = {}
    for index, name in enumerate(class_names):
        support = int(confusion[index].sum())
        correct = int(confusion[index, index]) if support else 0
        per_class[name] = {
            "support": support,
            "correct": correct,
            "recall": correct / support if support else None,
        }
    below = [
        {"name": name, "recall": stats["recall"], "support": stats["support"]}
        for name, stats in per_class.items()
        if stats["support"] >= min_class_support and stats["recall"] is not None and stats["recall"] < 0.90
    ]
    below.sort(key=lambda item: item["recall"])
    measured = {
        "accuracy": accuracy,
        "correct": int((predictions == labels).sum()),
        "samples": int(len(labels)),
        "perClass": per_class,
        "classesBelow90": below,
        "minClassRecall": min(
            (stats["recall"] for stats in per_class.values()
             if stats["support"] >= min_class_support and stats["recall"] is not None),
            default=None,
        ),
    }
    return measured, confusion


def main() -> None:
    args = parse_args()
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads or max(1, (os.cpu_count() or 4) // 2))

    root = Path(args.root).resolve()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    baseline = Path(args.baseline)
    class_names = read_class_names(root)
    class_count = len(class_names)
    print(f"classes={class_count} backbone={args.backbone} stages={STAGE_NAMES}", flush=True)

    train_by_image = load_split(root, "train", class_names)
    valid_by_image = load_split(root, "valid", class_names)
    test_by_image = load_split(root, "test", class_names)
    print(
        f"images train={len(train_by_image)} valid={len(valid_by_image)} test={len(test_by_image)}",
        flush=True,
    )

    backbone, dim, mean, std = build_backbone(args.backbone)
    print(f"embedding dim={dim}", flush=True)

    base_cache = baseline / "embeddings.npz"
    clean = {}
    test_limit = args.test_limit_per_class or None
    for split, by_image, limit in (
        ("train", train_by_image, None),
        ("valid", valid_by_image, None),
        ("test", test_by_image, test_limit),
    ):
        labels = expected_labels(by_image, limit)
        cached = load_cached_split(base_cache, split, labels, dim) if limit is None else None
        if cached is None:
            cached = embed_stage(backbone, by_image, "clean", 0, 0.0, limit,
                                 mean, std, args.batch_size, f"{split} clean", args.seed)
        clean[split] = cached

    robust_cache_path = out_dir / "robust_embeddings.npz"
    cache = {}
    if robust_cache_path.exists():
        stored = np.load(robust_cache_path)
        cache = {key: stored[key] for key in stored.files}
        print(f"Loaded {len(cache)} cached stage arrays from {robust_cache_path}", flush=True)

    def stage_matrix(split: str, by_image, stage: str, stage_index: int, limit: int | None, rotation: float):
        tag = "rot" if rotation else "plain"
        key_x, key_y = f"{split}_{stage}_{tag}X", f"{split}_{stage}_{tag}Y"
        if key_x in cache and key_y in cache:
            return cache[key_x], cache[key_y]
        matrix, labels = embed_stage(backbone, by_image, stage, stage_index, rotation, limit,
                                     mean, std, args.batch_size, f"{split} {stage}", args.seed)
        cache[key_x], cache[key_y] = matrix, labels
        np.savez_compressed(robust_cache_path, **cache)
        return matrix, labels

    train_parts = [clean["train"]]
    valid_parts = [clean["valid"]]
    test_parts = {"clean": clean["test"]}
    for index, (stage, opacity) in enumerate(STAGES, start=1):
        # Train with the tiny rotation; evaluate the lighting stage on its own so
        # the reported number is not mixed with rotation error.
        train_parts.append(stage_matrix("train", train_by_image, stage, index, args.limit_per_class, args.rotation))
        valid_parts.append(stage_matrix("valid", valid_by_image, stage, index, args.valid_limit_per_class, args.rotation))
        test_parts[stage] = stage_matrix("test", test_by_image, stage, index, test_limit, 0.0)
        print(f"stage {stage} (opacity {opacity}): train/valid/test embeddings ready", flush=True)

    train_x = np.concatenate([part[0] for part in train_parts])
    train_y = np.concatenate([part[1] for part in train_parts])
    valid_x = np.concatenate([part[0] for part in valid_parts])
    valid_y = np.concatenate([part[1] for part in valid_parts])
    print(f"train rows={len(train_y)} valid rows={len(valid_y)}", flush=True)

    scaler = StandardScaler().fit(train_x)
    train_scaled = scaler.transform(train_x)
    valid_scaled = scaler.transform(valid_x)

    selection = []
    best_model = None
    best_c = None
    best_valid = -1.0
    for c_value in C_GRID:
        model = LogisticRegression(C=c_value, max_iter=1500, tol=1e-4, random_state=args.seed)
        model.fit(train_scaled, train_y)
        accuracy = float(accuracy_score(valid_y, model.predict(valid_scaled)))
        selection.append({"model": f"logreg-C{c_value}", "validAccuracy": accuracy})
        print(f"  robust logreg C={c_value}: valid={accuracy * 100:.2f}%", flush=True)
        if accuracy > best_valid:
            best_valid, best_model, best_c = accuracy, model, c_value

    if best_model is None:
        raise SystemExit("No classifier was fitted.")
    model = best_model

    stage_reports = {}
    for stage in ("clean",) + STAGE_NAMES:
        matrix, labels = test_parts[stage]
        measured, confusion = evaluate(model, scaler, matrix, labels, class_names)
        measured["opacity"] = 1.0 if stage == "clean" else stage_opacity(stage)
        measured["confusionMatrix"] = confusion.tolist()
        stage_reports[stage] = measured
        print(
            f"TEST {stage:<7} opacity={measured['opacity']:.2f} "
            f"accuracy={measured['accuracy'] * 100:.2f}% "
            f"minClass={measured['minClassRecall'] * 100:.1f}% "
            f"below90={len(measured['classesBelow90'])}",
            flush=True,
        )

    clean_report = stage_reports["clean"]
    report = {
        "backbone": args.backbone,
        "method": "frozen-imagenet-embeddings+logreg+robust-augmentation",
        "classes": class_names,
        "augmentation": {
            "opacityStages": {name: opacity for name, opacity in STAGES},
            "rotationDegrees": args.rotation,
            "trainLimitPerClass": args.limit_per_class,
            "validLimitPerClass": args.valid_limit_per_class,
            "note": "Opacity is a blend toward black (dim lighting), not alpha transparency.",
        },
        "selection": selection,
        "selectedC": best_c,
        "validAccuracy": best_valid,
        "testAccuracy": clean_report["accuracy"],
        "measured": {
            "testAccuracy": clean_report["accuracy"],
            "validAccuracy": best_valid,
            "samples": {
                "train": int(len(train_y)),
                "valid": int(len(valid_y)),
                "test": int(clean_report["samples"]),
            },
            "trustworthy": int(clean_report["samples"]) >= 30,
            "stages": {
                name: {
                    "accuracy": stats["accuracy"],
                    "opacity": stats["opacity"],
                    "samples": stats["samples"],
                    "minClassRecall": stats["minClassRecall"],
                    "classesBelow90": stats["classesBelow90"],
                }
                for name, stats in stage_reports.items()
            },
            "minClassRecall": clean_report["minClassRecall"],
            "classesBelow90": clean_report["classesBelow90"],
        },
        "perStage": stage_reports,
        "perClass": clean_report["perClass"],
        "confusionMatrix": clean_report["confusionMatrix"],
        "embedding": {"backbone": args.backbone, "dim": int(dim), "mean": list(mean), "std": list(std), "inputSize": INPUT_SIZE},
        "classifier": {
            "coef": model.coef_.astype(float).tolist(),
            "intercept": model.intercept_.astype(float).tolist(),
            "classes": [int(c) for c in model.classes_],
        },
        "scaler": {"mean": scaler.mean_.astype(float).tolist(), "scale": scaler.scale_.astype(float).tolist()},
    }
    (out_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote {out_dir / 'report.json'}", flush=True)


if __name__ == "__main__":
    main()
