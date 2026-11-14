#!/usr/bin/env python
"""Export the fine-tuned ResNet-18 recogniser as one ONNX graph.

The fine-tuned model keeps the same runtime contract as the frozen-embedding
model: 224x224 RGB input, ImageNet per-channel normalisation applied by the
runtime, one ``logits`` output over the 61 classes. Only the weights change, so
``OnnxComponentClassifier.js`` needs no branch.

Accuracy is not asserted here. It is measured on the shipped path by
``node scripts/eval-runtime-accuracy.mjs --model <out>``; this script only
exports the graph and writes the metadata the runtime reads.

Usage:
  python scripts/export_finetuned_onnx.py \
      --report datasets/processed/cnn_resnet18_finetuned_v1/report.json \
      --state datasets/processed/cnn_resnet18_finetuned_v1/finetuned_state.pt \
      --out datasets/processed/cnn_resnet18_finetuned_v1
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
import torch.nn as nn
from torchvision import models


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--out", default="")
    parser.add_argument("--opset", type=int, default=17)
    return parser.parse_args()


def build_model(class_count: int) -> nn.Module:
    # weights=None: never download at export time; the state dict is the model.
    model = models.resnet18(weights=None)
    model.fc = nn.Linear(model.fc.in_features, class_count)
    return model


def main() -> None:
    args = parse_args()
    report_path = Path(args.report)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    out_dir = Path(args.out) if args.out else report_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    classes = report["classes"]

    if report.get("method") != "finetuned-resnet18-layer4":
        raise SystemExit("This exporter only handles the fine-tuned ResNet-18 report.")

    model = build_model(len(classes))
    state = torch.load(args.state, map_location="cpu")
    model.load_state_dict(state)
    model.eval()

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

    stages = report.get("perStage", {})
    meta = {
        "featureVersion": "cnn-5.1",
        "model": "component_classifier.onnx",
        "backbone": "resnet18",
        "inputSize": 224,
        "mean": report["embedding"]["mean"],
        "std": report["embedding"]["std"],
        "contextMargin": 0.10,
        "classes": classes,
        "classCount": len(classes),
        "trainingMethod": report.get("method"),
        "measured": {
            "testAccuracy": report["testAccuracy"],
            "validAccuracy": report["validAccuracy"],
            "testSamples": report["measured"]["samples"]["test"],
            "trustworthy": report["measured"]["samples"]["test"] >= 30,
        },
        "lightingRobustness": {
            "opacityStages": {name: stats["opacity"] for name, stats in stages.items() if name != "clean"},
            "rotationDegrees": report.get("augmentation", {}).get("rotationDegrees"),
            "stages": {
                name: {
                    "opacity": stats["opacity"],
                    "testAccuracy": stats["accuracy"],
                    "samples": stats["samples"],
                    "minClassRecall": stats["minClassRecall"],
                    "classesBelow90": len(stats.get("classesBelow90") or []),
                }
                for name, stats in stages.items()
            },
        },
        "license": "Backbone: torchvision ImageNet weights (BSD-3-Clause), fine-tuned on ElectroCom61 (CC BY 4.0).",
    }
    (out_dir / "classifier.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"Wrote {out_dir / 'classifier.json'}")


if __name__ == "__main__":
    main()
