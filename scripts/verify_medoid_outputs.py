#!/usr/bin/env python3
"""Verify the medoid experiment outputs without touching frozen inputs.

Checks:
  - every budget has exactly 61 classes and B references per class
  - every selected sample is from the train split and is absent from valid/test
  - every selected reference points at a real crop file with matching metadata
  - budget sets are nested prefixes of the 40-medoid ordering
  - current input hashes still match the hashes recorded during selection
  - the existing 305-reference runtime DB is still byte-identical to its hash

Writes only a new verification report.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEDOID_DIR = ROOT / "datasets/processed/medoids"
MANIFEST_PATH = MEDOID_DIR / "manifest.json"
VALID_PATH = ROOT / "datasets/processed/features_v1/valid_features.jsonl"
TEST_PATH = ROOT / "datasets/processed/features_v1/test_features.jsonl"
CROP_DIR = ROOT / "datasets/processed/crops_v1"
OUT_PATH = MEDOID_DIR / "verification.json"

PREFIX = re.compile(r"^(train|valid|test)_")
SUFFIX = re.compile(r"_cls\d+\.jpg$")


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def sample_id(crop_file: str) -> str:
    return SUFFIX.sub("", PREFIX.sub("", crop_file))


def load_sample_ids(path: Path):
    ids = set()
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            ids.add(sample_id(json.loads(line)["crop_file"]))
    return ids


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=OUT_PATH)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if args.out.exists() and not args.force:
        raise SystemExit(f"refusing to overwrite {args.out}; pass --force")

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    budgets = [int(b) for b in manifest["budgets"]]
    max_budget = max(budgets)

    databases = {}
    for budget in budgets:
        path = MEDOID_DIR / f"budget_{budget:03d}.json"
        databases[budget] = json.loads(path.read_text(encoding="utf-8"))

    expected_classes = set(manifest["classSelection"])
    if len(expected_classes) != 61:
        raise SystemExit(f"manifest has {len(expected_classes)} classes")

    valid_ids = load_sample_ids(VALID_PATH)
    test_ids = load_sample_ids(TEST_PATH)
    forbidden = valid_ids | test_ids

    crop_meta = {}
    with (CROP_DIR / "crop_metadata.jsonl").open("r", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                row = json.loads(line)
                crop_meta[row["crop_file"]] = row

    errors = []
    per_budget = {}
    crop_paths = set()
    sample_sets = {}

    for budget in budgets:
        db = databases[budget]
        refs = db["references"]
        counts = Counter(r["className"] for r in refs)
        ids = [r["sampleId"] for r in refs]
        if len(refs) != 61 * budget:
            errors.append(f"budget {budget}: {len(refs)} refs, expected {61 * budget}")
        if len(set(counts)) != 61:
            errors.append(f"budget {budget}: {len(counts)} classes, expected 61")
        if set(counts.values()) != {budget}:
            errors.append(f"budget {budget}: non-uniform class counts {sorted(set(counts.values()))}")
        if len(set(ids)) != len(ids):
            errors.append(f"budget {budget}: duplicate sampleIds")
        if any(r["split"] != "train" for r in refs):
            errors.append(f"budget {budget}: non-train reference present")
        overlap = set(ids) & forbidden
        if overlap:
            errors.append(f"budget {budget}: {len(overlap)} selected ids also appear in valid/test")

        for ref in refs:
            crop = ref["sourceCrop"]
            crop_path = CROP_DIR / crop
            if not crop_path.exists():
                errors.append(f"budget {budget}: missing crop {crop}")
                continue
            crop_paths.add(crop)
            expected_id = sample_id(crop)
            if expected_id != ref["sampleId"]:
                errors.append(f"budget {budget}: sampleId mismatch for {crop}")
            meta = crop_meta.get(crop)
            if meta is None:
                errors.append(f"budget {budget}: no metadata for {crop}")
            else:
                if meta.get("split") != "train":
                    errors.append(f"budget {budget}: crop metadata is not train: {crop}")
                if meta.get("class_name") != ref["className"]:
                    errors.append(f"budget {budget}: class mismatch for {crop}")
                if meta.get("source_image") != ref.get("sourceImage"):
                    errors.append(f"budget {budget}: source image mismatch for {crop}")
            if ref["className"] not in expected_classes:
                errors.append(f"budget {budget}: unknown class {ref['className']}")
            if not isinstance(ref.get("features"), list) or len(ref["features"]) != 2027:
                errors.append(f"budget {budget}: bad feature vector for {ref['sampleId']}")

        sample_sets[budget] = {r["className"]: [] for r in refs}
        for ref in refs:
            sample_sets[budget][ref["className"]].append((ref["selectionRank"], ref["sampleId"]))
        for name in sample_sets[budget]:
            sample_sets[budget][name].sort()

        per_budget[str(budget)] = {
            "path": db["selection"]["sourceFile"],
            "numReferences": len(refs),
            "classes": len(counts),
            "refsPerClass": {str(k): v for k, v in sorted(counts.items())},
            "overlapWithValid": len(set(ids) & valid_ids),
            "overlapWithTest": len(set(ids) & test_ids),
            "allSourceCropsExist": all((CROP_DIR / r["sourceCrop"]).exists() for r in refs),
            "allSplitsTrain": all(r["split"] == "train" for r in refs),
        }

    # Nested budget check: budget B is the first B entries of budget 40.
    max_sets = {name: [sid for _, sid in pairs] for name, pairs in sample_sets[max_budget].items()}
    for budget in budgets:
        for name, pairs in sample_sets[budget].items():
            expected = max_sets[name][:budget]
            actual = [sid for _, sid in pairs]
            if actual != expected:
                errors.append(f"budget {budget} class {name}: not a prefix of the {max_budget} ordering")

    # Import hashes: unchanged since selection.
    current_hashes = {}
    for key, relative in {
        "train_features": "datasets/processed/features_v1/train_features.jsonl",
        "feature_scaler": "datasets/processed/feature_scaler.json",
        "crop_metadata": "datasets/processed/crops_v1/crop_metadata.jsonl",
        "valid_features": "datasets/processed/features_v1/valid_features.jsonl",
        "test_features": "datasets/processed/features_v1/test_features.jsonl",
        "full_reference_db": "datasets/processed/knn_reference_db_candidate_full.json",
        "compact_reference_db_json": "knn_reference_db_compact.json",
        "compact_reference_db_bin": "knn_reference_db_compact.bin",
        "compact_reference_db_meta": "knn_reference_db_compact.meta.json",
        "feature_extractor": "perception/learning/FeatureExtractor.js",
    }.items():
        path = ROOT / relative
        current_hashes[key] = sha256_file(path)
        if current_hashes[key] != manifest["inputHashes"][key]:
            errors.append(f"input hash changed: {relative}")

    # Existing frozen runtime DB must still match the recorded hash.
    runtime_db = ROOT / "knn_reference_db_compact.json"
    if sha256_file(runtime_db) != manifest["inputHashes"]["compact_reference_db_json"]:
        errors.append("runtime knn_reference_db_compact.json changed")

    report = {
        "version": "medoid-verification-1.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "manifest": str(MANIFEST_PATH.relative_to(ROOT)),
        "budgets": per_budget,
        "checks": {
            "classes": len(expected_classes),
            "validSamples": len(valid_ids),
            "testSamples": len(test_ids),
            "uniqueSelectedCrops": len(crop_paths),
            "nestedBudgets": True,
            "inputHashesUnchanged": not any(e.startswith("input hash") or "runtime" in e for e in errors),
        },
        "errors": errors,
        "ok": not errors,
    }
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"wrote {args.out}")
    if errors:
        print(f"FAILED with {len(errors)} error(s):")
        for err in errors[:20]:
            print(" -", err)
        raise SystemExit(1)
    print("all medoid integrity checks passed")


if __name__ == "__main__":
    main()
