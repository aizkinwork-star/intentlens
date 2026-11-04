#!/usr/bin/env python3
"""Reproducible class-stratified medoid selection for IntentLens.

This is an experiment, not a replacement for the frozen runtime database.

Inputs (read only, never modified):
  datasets/processed/features_v1/train_features.jsonl
  datasets/processed/feature_scaler.json
  datasets/processed/crops_v1/crop_metadata.jsonl
  knn_reference_db_compact.{json,bin,meta.json}
  datasets/processed/knn_reference_db_candidate_full.json
  perception/learning/FeatureExtractor.js

Outputs (new files only):
  datasets/processed/medoids/budget_005.json
  datasets/processed/medoids/budget_010.json
  datasets/processed/medoids/budget_020.json
  datasets/processed/medoids/budget_040.json
  datasets/processed/medoids/manifest.json

Algorithm
---------
For each class independently:
  1. Compute the Euclidean distance matrix in the existing scaled feature
     space (the same space the runtime k-NN uses).
  2. Start from the 1-medoid (the point with the smallest total distance).
  3. Repeatedly add the point that most reduces the total distance from every
     class member to its nearest selected medoid.
  4. Tie-break deterministically by sampleId (class members are sorted first).

Greedy selection is incremental, so a budget-B set is exactly the first B
entries of the 40-medoid ordering. That makes budgets comparable and keeps the
procedure reproducible without a random seed.

Every selected reference keeps its original crop path, source image and
normalized bounding box so a reviewer can trace it back to the dataset.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
TRAIN_PATH = ROOT / "datasets/processed/features_v1/train_features.jsonl"
SCALER_PATH = ROOT / "datasets/processed/feature_scaler.json"
CROP_META_PATH = ROOT / "datasets/processed/crops_v1/crop_metadata.jsonl"
VALID_PATH = ROOT / "datasets/processed/features_v1/valid_features.jsonl"
TEST_PATH = ROOT / "datasets/processed/features_v1/test_features.jsonl"
FULL_DB_PATH = ROOT / "datasets/processed/knn_reference_db_candidate_full.json"
COMPACT_JSON_PATH = ROOT / "knn_reference_db_compact.json"
COMPACT_BIN_PATH = ROOT / "knn_reference_db_compact.bin"
COMPACT_META_PATH = ROOT / "knn_reference_db_compact.meta.json"
EXTRACTOR_PATH = ROOT / "perception/learning/FeatureExtractor.js"
OUT_DIR = ROOT / "datasets/processed/medoids"

TRAIN_PREFIX = "train_"
CLS_SUFFIX = re.compile(r"_cls\d+\.jpg$")


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def sample_id_from_crop(crop_file: str) -> str:
    name = crop_file
    if name.startswith(TRAIN_PREFIX):
        name = name[len(TRAIN_PREFIX):]
    return CLS_SUFFIX.sub("", name)


def count_lines(path: Path) -> int:
    total = 0
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                total += 1
    return total


def load_train(path: Path):
    rows = count_lines(path)
    with path.open("r", encoding="utf-8") as fh:
        first = json.loads(fh.readline())
        dim = len(first["features"])
        X = np.empty((rows, dim), dtype=np.float32)
        ids: list[str] = []
        labels: list[str] = []
        class_ids: list[int] = []
        crop_files: list[str] = []

        def consume(row, index: int):
            X[index] = np.asarray(row["features"], dtype=np.float32)
            ids.append(sample_id_from_crop(row["crop_file"]))
            labels.append(row["class_name"])
            class_ids.append(int(row["class_id"]))
            crop_files.append(row["crop_file"])

        consume(first, 0)
        index = 1
        for line in fh:
            if not line.strip():
                continue
            consume(json.loads(line), index)
            index += 1

    if index != rows:
        raise RuntimeError(f"expected {rows} train rows, loaded {index}")
    if len(set(ids)) != len(ids):
        raise RuntimeError("train sampleIds are not unique")
    if not np.isfinite(X).all():
        raise RuntimeError("train features contain non-finite values")
    return X, ids, labels, class_ids, crop_files


def load_metadata(path: Path):
    by_crop = {}
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            row = json.loads(line)
            by_crop[row["crop_file"]] = row
    return by_crop


def greedy_medoid_order(Xc: np.ndarray, max_budget: int):
    """Return selected local indices and objective after each addition."""
    n = Xc.shape[0]
    if max_budget > n:
        raise ValueError(f"budget {max_budget} exceeds class size {n}")
    gram = Xc @ Xc.T
    sq = np.einsum("ij,ij->i", Xc, Xc)
    d2 = sq[:, None] + sq[None, :] - 2.0 * gram
    np.maximum(d2, 0.0, out=d2)
    dist = np.sqrt(d2).astype(np.float64)
    np.fill_diagonal(dist, 0.0)

    first = int(np.argmin(dist.sum(axis=1)))
    selected = [first]
    nearest = dist[first].copy()
    order = [first]
    objectives = [float(nearest.sum())]

    for _ in range(2, max_budget + 1):
        candidate_objective = np.minimum(nearest[None, :], dist).sum(axis=1)
        candidate_objective[selected] = np.inf
        chosen = int(np.argmin(candidate_objective))
        selected.append(chosen)
        nearest = np.minimum(nearest, dist[chosen])
        order.append(chosen)
        objectives.append(float(nearest.sum()))
    return order, objectives


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--budgets", default="5,10,20,40")
    parser.add_argument("--out-dir", type=Path, default=OUT_DIR)
    parser.add_argument("--force", action="store_true", help="overwrite experiment outputs")
    args = parser.parse_args()

    budgets = sorted({int(v) for v in args.budgets.split(",") if v.strip()})
    if not budgets or min(budgets) <= 0:
        raise SystemExit("budgets must be positive integers")
    args.out_dir = args.out_dir.resolve()
    max_budget = max(budgets)

    scaler = json.loads(SCALER_PATH.read_text(encoding="utf-8"))
    if scaler.get("dimension") != 2027 or scaler.get("version") != "4.0":
        raise SystemExit("unexpected feature scaler; refusing to select references")
    if scaler.get("numSamples") != 8877 or scaler.get("fittedOn") != "train":
        raise SystemExit("scaler was not fitted on the expected 8,877 train samples")

    print("loading train features ...", flush=True)
    X, ids, labels, class_ids, crop_files = load_train(TRAIN_PATH)
    print(f"train: {X.shape[0]} rows, {X.shape[1]} dims, {len(set(labels))} classes", flush=True)

    by_class = defaultdict(list)
    class_id_of = {}
    for i, name in enumerate(labels):
        by_class[name].append(i)
        class_id_of.setdefault(name, class_ids[i])
    for name in by_class:
        # Deterministic tie-break: lexicographic sampleId.
        by_class[name].sort(key=lambda i: ids[i])

    counts = {name: len(idx) for name, idx in by_class.items()}
    if min(counts.values()) < max_budget:
        raise SystemExit(f"smallest class has {min(counts.values())} refs, budget is {max_budget}")

    metadata = load_metadata(CROP_META_PATH)
    missing = [crop_files[i] for i in range(len(crop_files)) if crop_files[i] not in metadata]
    if missing:
        raise SystemExit(f"{len(missing)} train crops have no metadata row; first={missing[0]}")

    print("computing class-stratified greedy medoids ...", flush=True)
    selection = {}
    for name in sorted(by_class):
        idxs = by_class[name]
        order, objectives = greedy_medoid_order(X[idxs], max_budget)
        selection[name] = {
            "classId": class_id_of[name],
            "trainCount": len(idxs),
            "localIndices": [int(i) for i in order],
            "sampleIds": [ids[idxs[i]] for i in order],
            "objectives": objectives,
        }
        print(f"  {name}: {len(idxs)} train refs -> 40 medoids", flush=True)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    output_paths = {}
    input_hashes = {
        "train_features": sha256_file(TRAIN_PATH),
        "feature_scaler": sha256_file(SCALER_PATH),
        "crop_metadata": sha256_file(CROP_META_PATH),
        "valid_features": sha256_file(VALID_PATH),
        "test_features": sha256_file(TEST_PATH),
        "full_reference_db": sha256_file(FULL_DB_PATH),
        "compact_reference_db_json": sha256_file(COMPACT_JSON_PATH),
        "compact_reference_db_bin": sha256_file(COMPACT_BIN_PATH),
        "compact_reference_db_meta": sha256_file(COMPACT_META_PATH),
        "feature_extractor": sha256_file(EXTRACTOR_PATH),
    }

    generated_at = datetime.now(timezone.utc).isoformat()
    for budget in budgets:
        refs = []
        for name in sorted(by_class):
            info = selection[name]
            idxs = by_class[name]
            for rank in range(budget):
                local = info["localIndices"][rank]
                global_index = idxs[local]
                crop = crop_files[global_index]
                meta = metadata[crop]
                refs.append(
                    {
                        "sampleId": ids[global_index],
                        "classId": int(class_ids[global_index]),
                        "className": name,
                        "features": [float(v) for v in X[global_index]],
                        "selectionRank": rank + 1,
                        "selectionObjective": info["objectives"][rank],
                        "split": "train",
                        "sourceCrop": crop,
                        "sourceImage": meta.get("source_image"),
                        "annotationId": meta.get("annotation_id"),
                        "bboxNorm": meta.get("bbox_norm"),
                        "bboxAbs": meta.get("bbox_abs"),
                        "cropW": meta.get("crop_w"),
                        "cropH": meta.get("crop_h"),
                    }
                )
        payload = {
            "version": "medoid-experiment-1.0",
            "featureVersion": "4.0",
            "scaler": scaler,
            "selection": {
                "algorithm": "class-stratified greedy k-medoids (incremental, Euclidean, sampleId tie-break)",
                "budgetPerClass": budget,
                "sourceSplit": "train",
                "sourceFile": "datasets/processed/features_v1/train_features.jsonl",
                "sourceSha256": input_hashes["train_features"],
                "generatedAt": generated_at,
                "nested": True,
                "note": "A budget-B set is the first B entries of the 40-medoid greedy ordering.",
            },
            "classes": sorted(by_class),
            "numReferences": len(refs),
            "references": refs,
        }
        out_path = args.out_dir / f"budget_{budget:03d}.json"
        if out_path.exists() and not args.force:
            raise SystemExit(f"refusing to overwrite {out_path}; pass --force to replace experiment output")
        out_path.write_text(
            json.dumps(payload, allow_nan=False, separators=(",", ":")),
            encoding="utf-8",
        )
        output_paths[str(budget)] = {
            "path": str(out_path.relative_to(ROOT)),
            "sha256": sha256_file(out_path),
            "numReferences": len(refs),
        }
        print(f"wrote {out_path} ({len(refs)} refs)", flush=True)

    manifest = {
        "version": "medoid-experiment-1.0",
        "generatedAt": generated_at,
        "algorithm": {
            "name": "class-stratified greedy k-medoids",
            "metric": "Euclidean distance in the existing scaled feature space",
            "deterministic": True,
            "randomSeed": None,
            "nestedBudgets": True,
            "tieBreak": "lexicographic sampleId",
            "note": "Greedy addition, not exhaustive PAM. Budget-B sets are prefixes of the 40-medoid order.",
        },
        "budgets": budgets,
        "maxBudgetPerClass": max_budget,
        "dataset": {
            "trainRows": int(X.shape[0]),
            "dim": int(X.shape[1]),
            "classes": len(by_class),
            "refsPerClass": {"min": min(counts.values()), "max": max(counts.values())},
            "split": "train only",
        },
        "inputHashes": input_hashes,
        "classSelection": selection,
        "outputs": output_paths,
    }
    manifest_path = args.out_dir / "manifest.json"
    if manifest_path.exists() and not args.force:
        raise SystemExit(f"refusing to overwrite {manifest_path}; pass --force to replace experiment output")
    manifest_path.write_text(json.dumps(manifest, indent=2, allow_nan=False), encoding="utf-8")
    print(f"wrote {manifest_path}", flush=True)


if __name__ == "__main__":
    main()
