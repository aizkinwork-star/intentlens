#!/usr/bin/env python
"""Fine-tune the last ResNet-18 block for ElectroCom61 (CPU-friendly).

The frozen-embedding + logistic-regression model is a strong, cheap baseline, but
its per-class accuracy plateaus: the linear head cannot separate components that
ImageNet features place close together. This script keeps the same runtime
contract (224x224 ImageNet-normalised input, one logits output) and fine-tunes
only ``layer4`` + the classifier, with the lighting/rotation augmentation the
device sees:

  * opacity sampled uniformly in [--min-opacity, 1.0] (blend toward black)
  * rotation uniformly in [-rotation, +rotation]
  * label smoothing to avoid over-confident head

BatchNorm statistics stay frozen at their ImageNet values (the batch is small),
which also makes the run deterministic and cheap. Validation picks the epoch;
the test split is evaluated once, per lighting stage.

Usage:
  python scripts/train_finetune_classifier.py \
      --root "datasets/.../ElectroCom61" \
      --out datasets/processed/cnn_resnet18_finetuned_v1 \
      --epochs 8 --threads 2
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
import torch.nn as nn
from PIL import Image
from sklearn.metrics import confusion_matrix
from torchvision import models

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_cnn_classifier import (  # noqa: E402
    INPUT_SIZE,
    build_backbone,
    crop_box,
    load_split,
    preprocess,
    read_class_names,
)

STAGES = (("clean", 1.0), ("slight", 0.75), ("medium", 0.50), ("low", 0.30))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--out", default="datasets/processed/cnn_resnet18_finetuned_v1")
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--rotation", type=float, default=3.0)
    parser.add_argument("--min-opacity", type=float, default=0.30)
    parser.add_argument("--lr-head", type=float, default=1e-3)
    parser.add_argument("--lr-backbone", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--label-smoothing", type=float, default=0.05)
    parser.add_argument("--valid-per-class", type=int, default=8)
    parser.add_argument("--patience", type=int, default=2)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--bench-steps", type=int, default=0,
                        help="Stop after this many optimizer steps (timing probe).")
    return parser.parse_args()


def transform(image: Image.Image, opacity: float, rotation: float, rng: random.Random) -> Image.Image:
    out = image.convert("RGB")
    if rotation:
        out = out.rotate(rng.uniform(-rotation, rotation), resample=Image.BILINEAR, expand=False)
    if opacity < 1:
        array = np.asarray(out, dtype=np.float32) * opacity
        out = Image.fromarray(np.clip(array, 0, 255).astype(np.uint8), mode="RGB")
    return out


def iter_crops(by_image):
    for image_path, rows in by_image.items():
        with Image.open(image_path) as image:
            image = image.convert("RGB")
            for row in rows:
                yield image, *row


def build_model(class_count: int):
    backbone, dim, _, _ = build_backbone("resnet18")
    for parameter in backbone.parameters():
        parameter.requires_grad = False
    for parameter in backbone.layer4.parameters():
        parameter.requires_grad = True
    backbone.fc = nn.Linear(dim, class_count)
    for parameter in backbone.fc.parameters():
        parameter.requires_grad = True
    return backbone


def forward_logits(model, batch):
    return model(batch)


@torch.inference_mode()
def evaluate(model, by_image, class_count, mean, std, batch_size, limit_per_class=0, stages=None, rotation=0.0):
    """Evaluate fixed lighting stages, optionally capped per class for speed."""
    model.eval()
    reports = {}
    for stage, opacity in stages or STAGES:
        seen = Counter()
        predictions, truths = [], []
        batch, labels = [], []
        for image, class_id, x, y, w, h in iter_crops(by_image):
            if limit_per_class:
                if seen[class_id] >= limit_per_class:
                    continue
                seen[class_id] += 1
            crop = crop_box(image, x, y, w, h)
            crop = transform(crop, opacity, rotation, random.Random(0))
            batch.append(preprocess(crop, mean, std))
            labels.append(class_id)
            if len(batch) >= batch_size:
                predictions.extend(model(torch.stack(batch)).argmax(dim=1).tolist())
                truths.extend(labels)
                batch, labels = [], []
        if batch:
            predictions.extend(model(torch.stack(batch)).argmax(dim=1).tolist())
            truths.extend(labels)
        predictions = np.asarray(predictions)
        truths = np.asarray(truths)
        accuracy = float((predictions == truths).mean()) if len(truths) else 0.0
        reports[stage] = {"accuracy": accuracy, "samples": int(len(truths)), "predictions": predictions, "truths": truths}
    return reports


def per_class_report(truths, predictions, class_names, min_support=1):
    confusion = confusion_matrix(truths, predictions, labels=list(range(len(class_names))))
    per_class = {}
    for index, name in enumerate(class_names):
        support = int(confusion[index].sum())
        correct = int(confusion[index, index]) if support else 0
        per_class[name] = {"support": support, "correct": correct, "recall": correct / support if support else None}
    below = sorted(
        (
            {"name": name, "recall": stats["recall"], "support": stats["support"]}
            for name, stats in per_class.items()
            if stats["support"] >= min_support and stats["recall"] is not None and stats["recall"] < 0.90
        ),
        key=lambda item: item["recall"],
    )
    return per_class, below, confusion, min(
        (stats["recall"] for stats in per_class.values() if stats["support"] >= min_support and stats["recall"] is not None),
        default=None,
    )


def main() -> None:
    args = parse_args()
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.set_num_threads(max(1, args.threads))
    torch.set_flush_denormal(True)

    root = Path(args.root).resolve()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    class_names = read_class_names(root)
    class_count = len(class_names)
    _, dim, mean, std = build_backbone("resnet18")

    train_by_image = load_split(root, "train", class_names)
    valid_by_image = load_split(root, "valid", class_names)
    test_by_image = load_split(root, "test", class_names)
    train_crops = sum(len(rows) for rows in train_by_image.values())
    valid_crops = sum(len(rows) for rows in valid_by_image.values())
    print(f"classes={class_count} train crops={train_crops} threads={torch.get_num_threads()}", flush=True)

    model = build_model(class_count)
    head_params = list(model.fc.parameters())
    backbone_params = [p for p in model.layer4.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(
        [
            {"params": backbone_params, "lr": args.lr_backbone},
            {"params": head_params, "lr": args.lr_head},
        ],
        weight_decay=args.weight_decay,
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, args.epochs))
    loss_fn = nn.CrossEntropyLoss(label_smoothing=args.label_smoothing)

    rng = random.Random(args.seed)
    best_state = None
    best_valid = -1.0
    history = []
    steps = 0
    started = time.time()

    for epoch in range(1, args.epochs + 1):
        model.train()
        # Keep BatchNorm statistics frozen; only layer4 weights and the head move.
        for module in model.modules():
            if isinstance(module, nn.BatchNorm2d):
                module.eval()
        epoch_started = time.time()
        batch, labels = [], []
        running, seen = 0.0, 0
        # Shuffle at the image level: generator-yielded PIL images are closed
        # once consumed, so the whole set cannot be materialised and shuffled.
        image_items = list(train_by_image.items())
        rng.shuffle(image_items)
        for image_path, rows in image_items:
            with Image.open(image_path) as opened:
                image = opened.convert("RGB")
                row_list = list(rows)
                rng.shuffle(row_list)
                for class_id, x, y, w, h in row_list:
                    opacity = rng.uniform(args.min_opacity, 1.0)
                    crop = crop_box(image, x, y, w, h)
                    crop = transform(crop, opacity, args.rotation, rng)
                    batch.append(preprocess(crop, mean, std))
                    labels.append(class_id)
                    if len(batch) < args.batch_size:
                        continue
                    optimizer.zero_grad(set_to_none=True)
                    logits = forward_logits(model, torch.stack(batch))
                    loss = loss_fn(logits, torch.as_tensor(labels))
                    loss.backward()
                    optimizer.step()
                    running += float(loss.detach()) * len(labels)
                    seen += len(labels)
                    steps += 1
                    batch, labels = [], []
                    if steps % 40 == 0:
                        rate = seen / max(1e-6, time.time() - epoch_started)
                        print(f"  epoch {epoch} step {steps} loss={running / max(1, seen):.3f} ({rate:.0f} crops/s)", flush=True)
                    if args.bench_steps and steps >= args.bench_steps:
                        print(f"bench: {steps} steps in {time.time() - started:.1f}s", flush=True)
                        return
        if batch:
            optimizer.zero_grad(set_to_none=True)
            loss = loss_fn(forward_logits(model, torch.stack(batch)), torch.as_tensor(labels))
            loss.backward()
            optimizer.step()
            running += float(loss.detach()) * len(labels)
            seen += len(labels)
        scheduler.step()

        valid = evaluate(
            model, valid_by_image, class_count, mean, std, args.batch_size,
            limit_per_class=args.valid_per_class,
            stages=(("clean", 1.0), ("medium", 0.50)),
        )
        valid_accuracy = (valid["clean"]["accuracy"] + valid["medium"]["accuracy"]) / 2
        history.append({
            "epoch": epoch,
            "trainLoss": running / max(1, seen),
            "validClean": valid["clean"]["accuracy"],
            "validMedium": valid["medium"]["accuracy"],
            "seconds": round(time.time() - epoch_started, 1),
        })
        print(
            f"epoch {epoch}/{args.epochs} loss={running / max(1, seen):.3f} "
            f"valid clean={valid['clean']['accuracy'] * 100:.2f}% medium={valid['medium']['accuracy'] * 100:.2f}% "
            f"({time.time() - epoch_started:.0f}s)",
            flush=True,
        )
        if valid_accuracy > best_valid:
            best_valid = valid_accuracy
            best_state = {key: value.detach().clone() for key, value in model.state_dict().items()}
            patience_left = args.patience
        else:
            patience_left -= 1
            if patience_left <= 0:
                print("early stop: validation stopped improving", flush=True)
                break

    if best_state is None:
        raise SystemExit("No epoch completed.")
    model.load_state_dict(best_state)
    model.eval()
    torch.save(best_state, out_dir / "finetuned_state.pt")

    stage_reports = {}
    for stage, opacity in STAGES:
        result = evaluate(
            model, test_by_image, class_count, mean, std, args.batch_size,
            stages=((stage, opacity),),
        )[stage]
        per_class, below, confusion, min_recall = per_class_report(result["truths"], result["predictions"], class_names)
        stage_reports[stage] = {
            "opacity": opacity,
            "accuracy": result["accuracy"],
            "correct": int((result["predictions"] == result["truths"]).sum()),
            "samples": result["samples"],
            "perClass": per_class,
            "classesBelow90": below,
            "minClassRecall": min_recall,
            "confusionMatrix": confusion.tolist(),
        }
        print(
            f"TEST {stage:<7} opacity={opacity:.2f} accuracy={result['accuracy'] * 100:.2f}% "
            f"minClass={min_recall * 100:.1f}% below90={len(below)}",
            flush=True,
        )

    report = {
        "backbone": "resnet18",
        "method": "finetuned-resnet18-layer4",
        "classes": class_names,
        "augmentation": {
            "opacityRange": [args.min_opacity, 1.0],
            "rotationDegrees": args.rotation,
            "labelSmoothing": args.label_smoothing,
        },
        "epochs": len(history),
        "history": history,
        "validAccuracy": best_valid,
        "testAccuracy": stage_reports["clean"]["accuracy"],
        "measured": {
            "testAccuracy": stage_reports["clean"]["accuracy"],
            "validAccuracy": best_valid,
            "samples": {"train": train_crops, "valid": valid_crops, "test": stage_reports["clean"]["samples"]},
            "trustworthy": stage_reports["clean"]["samples"] >= 30,
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
            "minClassRecall": stage_reports["clean"]["minClassRecall"],
            "classesBelow90": stage_reports["clean"]["classesBelow90"],
        },
        "perStage": stage_reports,
        "perClass": stage_reports["clean"]["perClass"],
        "confusionMatrix": stage_reports["clean"]["confusionMatrix"],
        "embedding": {"backbone": "resnet18", "dim": dim, "mean": list(mean), "std": list(std), "inputSize": INPUT_SIZE},
    }
    (out_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote {out_dir / 'report.json'} in {time.time() - started:.0f}s", flush=True)


if __name__ == "__main__":
    main()
