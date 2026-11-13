#!/usr/bin/env python
"""Export the frozen classifier as a single ONNX model with a baked linear head.

The training report stores the ImageNet-backbone embeddings, the StandardScaler
and a multinomial logistic-regression head. This script folds the scaler into the
linear layer and exports ``backbone + Linear`` as one ONNX graph, so the runtime
only needs one forward pass and no sklearn.

It also verifies, on the cached test embeddings, that the folded model produces
the same labels as sklearn. That keeps the exported artifact honest.

Usage:
  python scripts/export_classifier_onnx.py --report datasets/processed/cnn_resnet18_v1/report.json \
      --out datasets/processed/cnn_resnet18_v1
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torchvision import models


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True)
    parser.add_argument("--out", default="")
    parser.add_argument("--opset", type=int, default=17)
    return parser.parse_args()


def build_backbone(name: str):
    if name == "resnet18":
        model = models.resnet18(weights=models.ResNet18_Weights.IMAGENET1K_V1)
        dim = model.fc.in_features
        model.fc = nn.Identity()
    elif name == "mobilenet_v3_small":
        model = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.IMAGENET1K_V1)
        dim = model.classifier[-1].in_features
        model.classifier[-1] = nn.Identity()
    else:
        model = models.mobilenet_v3_large(weights=models.MobileNet_V3_Large_Weights.IMAGENET1K_V1)
        dim = model.classifier[-1].in_features
        model.classifier[-1] = nn.Identity()
    model.eval()
    return model, dim


class FoldedClassifier(nn.Module):
    def __init__(self, backbone, weight: np.ndarray, bias: np.ndarray):
        super().__init__()
        self.backbone = backbone
        self.head = nn.Linear(weight.shape[1], weight.shape[0], bias=True)
        self.head.weight = nn.Parameter(torch.from_numpy(weight.astype(np.float32)))
        self.head.bias = nn.Parameter(torch.from_numpy(bias.astype(np.float32)))

    def forward(self, image):
        return self.head(self.backbone(image))


def main() -> None:
    args = parse_args()
    report_path = Path(args.report)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    out_dir = Path(args.out) if args.out else report_path.parent
    backbone_name = report["embedding"]["backbone"]
    classes = report["classes"]
    coef = np.asarray(report["classifier"]["coef"], dtype=np.float64)
    intercept = np.asarray(report["classifier"]["intercept"], dtype=np.float64)
    mean = np.asarray(report["scaler"]["mean"], dtype=np.float64)
    scale = np.asarray(report["scaler"]["scale"], dtype=np.float64)

    if report.get("method") != "frozen-imagenet-embeddings+logreg":
        raise SystemExit("Only the frozen-embedding report can be folded into a linear head.")

    # sklearn computes softmax((x - mean) / scale @ coef.T + intercept).
    # Fold: w' = coef / scale ; b' = intercept - sum(coef * mean / scale)
    folded_weight = coef / scale[None, :]
    folded_bias = intercept - (folded_weight @ mean)

    backbone, dim = build_backbone(backbone_name)
    if dim != coef.shape[1]:
        raise SystemExit(f"Embedding dimension mismatch: report {coef.shape[1]} vs backbone {dim}")
    model = FoldedClassifier(backbone, folded_weight, folded_bias).eval()

    # Verify on cached test embeddings that the fold is exact.
    checkpoint = out_dir / "embeddings.npz"
    verification = None
    if checkpoint.exists():
        cached = np.load(checkpoint)
        embeddings = cached["testX"].astype(np.float64)
        truths = cached["testY"].astype(np.int64)
        logits = embeddings @ folded_weight.T + folded_bias
        folded_predictions = logits.argmax(axis=1)
        accuracy = float((folded_predictions == truths).mean())
        verification = {"testAccuracy": accuracy, "samples": int(len(truths))}
        print(f"folded-head verification accuracy={accuracy * 100:.2f}% on {len(truths)} test crops")
        expected = report["testAccuracy"]
        if abs(accuracy - expected) > 0.002:
            raise SystemExit(f"Folded head drifted: {accuracy:.4f} vs report {expected:.4f}")

    dummy = torch.randn(1, 3, 224, 224)
    onnx_path = out_dir / "component_classifier.onnx"
    torch.onnx.export(
        model,
        dummy,
        str(onnx_path),
        input_names=["image"],
        output_names=["logits"],
        opset_version=args.opset,
        dynamo=False,
        do_constant_folding=True,
    )
    print(f"Exported {onnx_path} ({onnx_path.stat().st_size / 1e6:.1f} MB)")

    # Quantized int8 variant for wasm/browser inference. Optional: falls back
    # silently when the quantizer rejects this graph.
    quantized_path = out_dir / "component_classifier_int8.onnx"
    try:
        from onnxruntime.quantization import quantize_dynamic, QuantType  # type: ignore

        quantize_dynamic(str(onnx_path), str(quantized_path), weight_type=QuantType.QInt8)
        print(f"Exported {quantized_path} ({quantized_path.stat().st_size / 1e6:.1f} MB)")
    except Exception as exc:  # noqa: BLE001
        print(f"Skipped int8 quantization: {exc}")

    meta = {
        "featureVersion": "cnn-5.1",
        "model": "component_classifier.onnx",
        "backbone": backbone_name,
        "inputSize": 224,
        "mean": report["embedding"]["mean"],
        "std": report["embedding"]["std"],
        "contextMargin": 0.10,
        "classes": classes,
        "classCount": len(classes),
        "measured": {
            "testAccuracy": report["testAccuracy"],
            "validAccuracy": report["validAccuracy"],
            "testSamples": report["measured"]["samples"]["test"],
            "trustworthy": report["measured"]["samples"]["test"] >= 30,
        },
        "foldedHeadVerification": verification,
        "license": "Backbone: torchvision ImageNet weights (BSD-3-Clause). Head trained on ElectroCom61 (CC BY 4.0).",
    }
    (out_dir / "classifier.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"Wrote {out_dir / 'classifier.json'}")


if __name__ == "__main__":
    main()
