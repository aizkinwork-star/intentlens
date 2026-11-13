#!/usr/bin/env python
"""Train a vision classifier for ElectroCom61 with a pretrained CNN backbone.

Two stages, both evaluated honestly:
  1. Frozen ImageNet backbone -> embeddings -> logistic regression.
     Fast, deterministic, and a strong baseline on small datasets.
  2. Optional head fine-tuning of the same backbone (backbone frozen) with
     light augmentation. Only enabled with --fine-tune.

Split discipline: the scaler / classifier / epoch count are chosen on
validation only. The test split is evaluated once after freezing.

Usage:
  python scripts/train_cnn_classifier.py \
      --root "datasets/.../ElectroCom61" \
      --out datasets/processed/cnn_v1 \
      --backbone resnet18 --fine-tune --export-onnx
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, confusion_matrix
from sklearn.preprocessing import StandardScaler

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
SPLITS = ("train", "valid", "test")
INPUT_SIZE = 224
CONTEXT_MARGIN = 0.10


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--out", default="datasets/processed/cnn_v1")
    parser.add_argument("--backbone", default="resnet18", choices=["resnet18", "mobilenet_v3_small", "mobilenet_v3_large"])
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--fine-tune", action="store_true")
    parser.add_argument("--export-onnx", action="store_true")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--threads", type=int, default=0)
    return parser.parse_args()


def read_class_names(root: Path) -> list[str]:
    text = (root / "data.yaml").read_text(encoding="utf-8", errors="replace")
    start = text.find("names:")
    seq = text[start + len("names:"):].strip()
    seq = seq[1:seq.find("]")]
    return [item.strip().strip("'\"") for item in seq.split(",") if item.strip()]


def load_split(root: Path, split: str, class_names: list[str]):
    images_dir = root / split / "images"
    labels_dir = root / split / "labels"
    by_image: dict[Path, list[tuple[int, float, float, float, float]]] = {}
    for label_path in sorted(labels_dir.glob("*.txt")):
        image_path = None
        for ext in IMAGE_EXTENSIONS:
            candidate = images_dir / (label_path.stem + ext)
            if candidate.exists():
                image_path = candidate
                break
        if image_path is None:
            continue
        rows = []
        for line in label_path.read_text(encoding="utf-8", errors="replace").splitlines():
            parts = line.split()
            if len(parts) < 5:
                continue
            try:
                class_id = int(float(parts[0]))
                x, y, w, h = (float(v) for v in parts[1:5])
            except ValueError:
                continue
            if 0 <= class_id < len(class_names) and w > 0 and h > 0:
                rows.append((class_id, x, y, w, h))
        if rows:
            by_image[image_path] = rows
    return by_image


def crop_box(image: Image.Image, x, y, w, h) -> Image.Image:
    iw, ih = image.size
    left = (x - w / 2 - w * CONTEXT_MARGIN) * iw
    top = (y - h / 2 - h * CONTEXT_MARGIN) * ih
    right = (x + w / 2 + w * CONTEXT_MARGIN) * iw
    bottom = (y + h / 2 + h * CONTEXT_MARGIN) * ih
    left = max(0, min(iw - 1, int(round(left))))
    top = max(0, min(ih - 1, int(round(top))))
    right = max(left + 1, min(iw, int(round(right))))
    bottom = max(top + 1, min(ih, int(round(bottom))))
    return image.crop((left, top, right, bottom))


IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


def build_backbone(name: str):
    from torchvision import models

    if name == "resnet18":
        weights = models.ResNet18_Weights.IMAGENET1K_V1
        model = models.resnet18(weights=weights)
        dim = model.fc.in_features
        model.fc = nn.Identity()
    elif name == "mobilenet_v3_small":
        weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1
        model = models.mobilenet_v3_small(weights=weights)
        dim = model.classifier[-1].in_features
        model.classifier[-1] = nn.Identity()
    else:
        weights = models.MobileNet_V3_Large_Weights.IMAGENET1K_V1
        model = models.mobilenet_v3_large(weights=weights)
        dim = model.classifier[-1].in_features
        model.classifier[-1] = nn.Identity()
    model.eval()
    return model, dim, IMAGENET_MEAN, IMAGENET_STD


def preprocess(image: Image.Image, mean, std) -> torch.Tensor:
    resized = image.convert("RGB").resize((INPUT_SIZE, INPUT_SIZE), Image.BILINEAR)
    array = np.asarray(resized, dtype=np.float32) / 255.0
    array = (array - np.asarray(mean, dtype=np.float32)) / np.asarray(std, dtype=np.float32)
    tensor = torch.from_numpy(array.transpose(2, 0, 1))
    return tensor


def augment(image: Image.Image) -> Image.Image:
    # Light, label-preserving augmentation that does not change component identity.
    if np.random.rand() < 0.5:
        image = image.transpose(Image.FLIP_LEFT_RIGHT)
    if np.random.rand() < 0.3:
        image = image.transpose(Image.FLIP_TOP_BOTTOM)
    if np.random.rand() < 0.3:
        angle = float(np.random.uniform(-12, 12))
        image = image.rotate(angle, resample=Image.BILINEAR, expand=False)
    if np.random.rand() < 0.3:
        width, height = image.size
        scale = float(np.random.uniform(0.85, 1.0))
        crop_w, crop_h = int(width * scale), int(height * scale)
        left = int(np.random.randint(0, max(1, width - crop_w + 1)))
        top = int(np.random.randint(0, max(1, height - crop_h + 1)))
        image = image.crop((left, top, left + crop_w, top + crop_h))
    return image


@torch.no_grad()
def embed_split(backbone, by_image, mean, std, batch_size, desc):
    features, labels = [], []
    batch, batch_labels = [], []
    started = time.time()
    done = 0
    total = sum(len(rows) for rows in by_image.values())
    for image_path, rows in by_image.items():
        with Image.open(image_path) as image:
            image = image.convert("RGB")
            for class_id, x, y, w, h in rows:
                crop = crop_box(image, x, y, w, h)
                batch.append(preprocess(crop, mean, std))
                batch_labels.append(class_id)
                done += 1
                if len(batch) >= batch_size:
                    tensor = torch.stack(batch)
                    features.append(backbone(tensor).numpy())
                    labels.extend(batch_labels)
                    batch, batch_labels = [], []
                    if done % 512 < batch_size:
                        rate = done / max(1e-6, time.time() - started)
                        print(f"  {desc}: {done}/{total} ({rate:.0f}/s)", flush=True)
            # images are processed one at a time; batch flushes at the end below
    if batch:
        features.append(backbone(torch.stack(batch)).numpy())
        labels.extend(batch_labels)
    matrix = np.concatenate(features).astype(np.float32)
    return matrix, np.asarray(labels, dtype=np.int16)


def fine_tune(backbone_name, train_by_image, valid_by_image, class_names, args, mean, std):
    from torchvision import models

    if backbone_name == "resnet18":
        weights = models.ResNet18_Weights.IMAGENET1K_V1
        model = models.resnet18(weights=weights)
        dim = model.fc.in_features
        model.fc = nn.Linear(dim, len(class_names))
    elif backbone_name == "mobilenet_v3_small":
        weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1
        model = models.mobilenet_v3_small(weights=weights)
        dim = model.classifier[-1].in_features
        model.classifier[-1] = nn.Linear(dim, len(class_names))
    else:
        weights = models.MobileNet_V3_Large_Weights.IMAGENET1K_V1
        model = models.mobilenet_v3_large(weights=weights)
        dim = model.classifier[-1].in_features
        model.classifier[-1] = nn.Linear(dim, len(class_names))

    # Freeze the backbone; only the classifier head learns.
    for parameter in model.parameters():
        parameter.requires_grad = False
    for parameter in (model.fc.parameters() if backbone_name == "resnet18" else model.classifier[-1].parameters()):
        parameter.requires_grad = True

    optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=3e-3, weight_decay=1e-4)
    criterion = nn.CrossEntropyLoss(label_smoothing=0.05)

    best_state = None
    best_valid = -1.0
    for epoch in range(args.epochs):
        model.train()
        running = 0.0
        seen = 0
        batch, batch_labels = [], []

        def step():
            nonlocal running, seen, batch, batch_labels
            if not batch:
                return
            tensor = torch.stack(batch)
            target = torch.tensor(batch_labels, dtype=torch.long)
            optimizer.zero_grad()
            logits = model(tensor)
            loss = criterion(logits, target)
            loss.backward()
            optimizer.step()
            running += float(loss.item()) * len(batch)
            seen += len(batch)
            batch, batch_labels = [], []

        for image_path, rows in train_by_image.items():
            with Image.open(image_path) as image:
                image = image.convert("RGB")
                for class_id, x, y, w, h in rows:
                    crop = augment(crop_box(image, x, y, w, h))
                    batch.append(preprocess(crop, mean, std))
                    batch_labels.append(class_id)
                    if len(batch) >= args.batch_size:
                        step()
        step()
        valid_accuracy = evaluate_model(model, valid_by_image, mean, std, args.batch_size)
        print(f"  epoch {epoch + 1}/{args.epochs}: loss={running / max(1, seen):.3f} valid={valid_accuracy * 100:.2f}%", flush=True)
        if valid_accuracy > best_valid:
            best_valid = valid_accuracy
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}

    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()
    return model, best_valid


@torch.no_grad()
def evaluate_model(model, by_image, mean, std, batch_size):
    predictions, truths = [], []
    batch, batch_labels = [], []
    for image_path, rows in by_image.items():
        with Image.open(image_path) as image:
            image = image.convert("RGB")
            for class_id, x, y, w, h in rows:
                batch.append(preprocess(crop_box(image, x, y, w, h), mean, std))
                batch_labels.append(class_id)
                if len(batch) >= batch_size:
                    predictions.extend(model(torch.stack(batch)).argmax(dim=1).tolist())
                    truths.extend(batch_labels)
                    batch, batch_labels = [], []
    if batch:
        predictions.extend(model(torch.stack(batch)).argmax(dim=1).tolist())
        truths.extend(batch_labels)
    return accuracy_score(truths, predictions)


def per_class_report(labels, predictions, class_names):
    matrix = confusion_matrix(labels, predictions, labels=list(range(len(class_names))))
    report = {}
    for index, name in enumerate(class_names):
        support = int(matrix[index].sum())
        correct = int(matrix[index, index]) if support else 0
        report[name] = {"support": support, "correct": correct, "recall": correct / support if support else None}
    return report, matrix


def main() -> None:
    args = parse_args()
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    if args.threads:
        torch.set_num_threads(args.threads)
    else:
        torch.set_num_threads(max(1, (os.cpu_count() or 4) // 2))

    root = Path(args.root).resolve()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    class_names = read_class_names(root)
    print(f"classes={len(class_names)} backbone={args.backbone}", flush=True)

    train_by_image = load_split(root, "train", class_names)
    valid_by_image = load_split(root, "valid", class_names)
    test_by_image = load_split(root, "test", class_names)
    print(
        f"images train={len(train_by_image)} valid={len(valid_by_image)} test={len(test_by_image)}",
        flush=True,
    )

    backbone, dim, mean, std = build_backbone(args.backbone)
    print(f"embedding dim={dim}", flush=True)
    checkpoint = out_dir / "embeddings.npz"
    if checkpoint.exists():
        cached = np.load(checkpoint)
        if str(cached["backbone"][0]) == args.backbone and cached["trainX"].shape[1] == dim:
            print(f"Reusing {checkpoint}", flush=True)
            train_x, train_y = cached["trainX"], cached["trainY"]
            valid_x, valid_y = cached["validX"], cached["validY"]
            test_x, test_y = cached["testX"], cached["testY"]
        else:
            cached = None
    else:
        cached = None
    if cached is None:
        train_x, train_y = embed_split(backbone, train_by_image, mean, std, args.batch_size, "train")
        valid_x, valid_y = embed_split(backbone, valid_by_image, mean, std, args.batch_size, "valid")
        test_x, test_y = embed_split(backbone, test_by_image, mean, std, args.batch_size, "test")
        np.savez_compressed(
            checkpoint,
            trainX=train_x, trainY=train_y,
            validX=valid_x, validY=valid_y,
            testX=test_x, testY=test_y,
            backbone=np.array([args.backbone]),
        )
        print(f"Wrote {checkpoint}", flush=True)

    scaler = StandardScaler().fit(train_x)
    train_scaled = scaler.transform(train_x)
    valid_scaled = scaler.transform(valid_x)

    selection = []
    best_model = None
    best_c = None
    best_valid = -1
    for c_value in (0.1, 1.0, 10.0, 100.0):
        model = LogisticRegression(C=c_value, max_iter=2000, n_jobs=-1, random_state=args.seed)
        model.fit(train_scaled, train_y)
        accuracy = float(accuracy_score(valid_y, model.predict(valid_scaled)))
        selection.append({"model": f"logreg-C{c_value}", "validAccuracy": accuracy})
        print(f"  frozen+logreg C={c_value}: valid={accuracy * 100:.2f}%", flush=True)
        if accuracy > best_valid:
            best_valid = accuracy
            best_model = model
            best_c = c_value

    if args.fine_tune:
        tuned_model, tuned_valid = fine_tune(args.backbone, train_by_image, valid_by_image, class_names, args, mean, std)
        if tuned_valid > best_valid:
            print(f"Fine-tuned head wins: valid={tuned_valid * 100:.2f}%", flush=True)
            # Evaluate on test once.
            test_accuracy = evaluate_model(tuned_model, test_by_image, mean, std, args.batch_size)
            truths, predictions = [], []
            # Recollect predictions for the report.
            with torch.no_grad():
                batch, batch_labels = [], []
                for image_path, rows in test_by_image.items():
                    with Image.open(image_path) as image:
                        image = image.convert("RGB")
                        for class_id, x, y, w, h in rows:
                            batch.append(preprocess(crop_box(image, x, y, w, h), mean, std))
                            batch_labels.append(class_id)
                            if len(batch) >= args.batch_size:
                                predictions.extend(tuned_model(torch.stack(batch)).argmax(dim=1).tolist())
                                truths.extend(batch_labels)
                                batch, batch_labels = [], []
                if batch:
                    predictions.extend(tuned_model(torch.stack(batch)).argmax(dim=1).tolist())
                    truths.extend(batch_labels)
            per_class, matrix = per_class_report(truths, predictions, class_names)
            report = {
                "backbone": args.backbone,
                "method": "pretrained-backbone-head-finetuned",
                "classes": class_names,
                "selection": selection,
                "validAccuracy": tuned_valid,
                "testAccuracy": float(test_accuracy),
                "measured": {
                    "testAccuracy": float(test_accuracy),
                    "validAccuracy": float(tuned_valid),
                    "samples": {"train": int(len(train_y)), "valid": int(len(valid_y)), "test": int(len(test_y))},
                    "trustworthy": int(len(test_y)) >= 30,
                },
                "perClass": per_class,
                "confusionMatrix": matrix.tolist(),
            }
            (out_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            torch.save(
                {
                    "stateDict": tuned_model.state_dict(),
                    "backbone": args.backbone,
                    "classes": class_names,
                    "mean": list(mean),
                    "std": list(std),
                    "inputSize": INPUT_SIZE,
                    "contextMargin": CONTEXT_MARGIN,
                },
                out_dir / "model.pt",
            )
            if args.export_onnx:
                export_onnx(tuned_model, args.backbone, len(class_names), out_dir / "model.onnx")
            print(f"TEST accuracy={test_accuracy * 100:.2f}%", flush=True)
            print(f"Wrote {out_dir / 'report.json'}", flush=True)
            return

    # Frozen path.
    best_model = best_model or LogisticRegression(C=1.0, max_iter=2000, n_jobs=-1).fit(train_scaled, train_y)
    test_predictions = best_model.predict(scaler.transform(test_x))
    test_accuracy = float(accuracy_score(test_y, test_predictions))
    per_class, matrix = per_class_report(test_y, test_predictions, class_names)
    report = {
        "backbone": args.backbone,
        "method": "frozen-imagenet-embeddings+logreg",
        "classes": class_names,
        "selection": selection,
        "selectedC": best_c,
        "validAccuracy": best_valid,
        "testAccuracy": test_accuracy,
        "measured": {
            "testAccuracy": test_accuracy,
            "validAccuracy": best_valid,
            "samples": {"train": int(len(train_y)), "valid": int(len(valid_y)), "test": int(len(test_y))},
            "trustworthy": int(len(test_y)) >= 30,
        },
        "perClass": per_class,
        "confusionMatrix": matrix.tolist(),
        "embedding": {"backbone": args.backbone, "dim": int(dim), "mean": list(mean), "std": list(std), "inputSize": INPUT_SIZE},
        "classifier": {
            "coef": best_model.coef_.astype(float).tolist(),
            "intercept": best_model.intercept_.astype(float).tolist(),
            "classes": [int(c) for c in best_model.classes_],
        },
        "scaler": {"mean": scaler.mean_.astype(float).tolist(), "scale": scaler.scale_.astype(float).tolist()},
    }
    (out_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"TEST accuracy={test_accuracy * 100:.2f}%", flush=True)
    print(f"Wrote {out_dir / 'report.json'}", flush=True)


def export_onnx(model, backbone_name, class_count, path):
    model = model.eval()
    dummy = torch.randn(1, 3, INPUT_SIZE, INPUT_SIZE)
    torch.onnx.export(
        model,
        dummy,
        str(path),
        input_names=["input"],
        output_names=["logits"],
        opset_version=17,
        dynamo=False,
    )
    print(f"Exported {path} ({path.stat().st_size / 1e6:.1f} MB)", flush=True)


if __name__ == "__main__":
    main()
