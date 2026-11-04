#!/usr/bin/env python3
"""Evaluate the shipped 305-reference k-NN database against held-out splits.

Calibration rule: choose k / maxDist / separation on VALIDATION only, freeze
that configuration, then report the single TEST evaluation. The test split is
never used for tuning.

Usage:
  python scripts/eval_compact_knn.py
  python scripts/eval_compact_knn.py --json datasets/processed/compact_eval.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "knn_reference_db_compact.json"
VALID_PATH = ROOT / "datasets/processed/features_v1/valid_features.jsonl"
TEST_PATH = ROOT / "datasets/processed/features_v1/test_features.jsonl"

DEFAULT_K = 3
DEFAULT_MAX_DIST = 50.6
DEFAULT_SEPARATION = 1.5
DEFAULT_WEIGHTED = True


def load_reference_db(path: Path):
    data = json.loads(path.read_text(encoding="utf-8"))
    refs = data["references"]
    X = np.asarray([r["features"] for r in refs], dtype=np.float32)
    labels = [r["className"] for r in refs]
    ids = [r.get("sampleId", str(i)) for i, r in enumerate(refs)]
    counts = Counter(labels)
    return data, X, labels, ids, counts


def load_split(path: Path):
    X, y, ids = [], [], []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            row = json.loads(line)
            X.append(row["features"])
            y.append(row["class_name"])
            ids.append(row.get("crop_file", ""))
    return np.asarray(X, dtype=np.float32), y, ids


def feature_hashes(X, ids, digits=5):
    out = {}
    for vec, ident in zip(X, ids):
        key = np.round(vec, digits).tobytes()
        out.setdefault(hashlib.sha256(key).hexdigest(), []).append(ident)
    return out


def classify_batch(Q, R, labels, k, max_dist, separation, weighted=True):
    """Vectorized k-NN matching the runtime classifier's Euclidean weighted vote."""
    n = Q.shape[0]
    qn = np.sum(Q * Q, axis=1)[:, None]
    rn = np.sum(R * R, axis=1)[None, :]
    dists = np.sqrt(np.maximum(qn + rn - 2.0 * (Q @ R.T), 0.0))
    order = np.argsort(dists, axis=1)[:, :k]
    preds: list[str] = []
    reasons: list[str] = []
    nearest_dist = np.empty(n, dtype=np.float32)
    for i in range(n):
        idxs = order[i]
        ds = dists[i, idxs]
        nearest_dist[i] = float(ds[0])
        if float(ds[0]) > max_dist:
            preds.append("unknown")
            reasons.append("too_far")
            continue
        votes = defaultdict(float)
        for j in range(len(idxs)):
            weight = 1.0 if not weighted else 1.0
            votes[labels[int(idxs[j])]] += weight / (float(ds[j]) + 1e-6)
        sorted_votes = sorted(votes.items(), key=lambda item: -item[1])
        best, best_score = sorted_votes[0]
        second = sorted_votes[1][1] if len(sorted_votes) > 1 else 0.0
        if second > 0 and best_score / (second + 1e-6) < separation:
            preds.append("unknown")
            reasons.append("ambiguous")
        else:
            preds.append(best)
            reasons.append("ok")
    return preds, reasons, nearest_dist


def metrics(y, preds, reasons, nearest_dist):
    total = len(y)
    correct = sum(1 for t, p in zip(y, preds) if t == p)
    accepted = sum(1 for p in preds if p != "unknown")
    accepted_correct = sum(1 for t, p in zip(y, preds) if p != "unknown" and t == p)
    unknown = total - accepted
    classes = sorted(set(y))
    per_class = {}
    for cls in classes:
        tp = sum(1 for t, p in zip(y, preds) if t == cls and p == cls)
        fp = sum(1 for t, p in zip(y, preds) if t != cls and p == cls)
        fn = sum(1 for t, p in zip(y, preds) if t == cls and p != cls)
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per_class[cls] = {
            "support": tp + fn,
            "correct": tp,
            "accepted": tp + fp,
            "precision": precision,
            "recall": recall,
            "f1": f1,
        }
    macro_p = sum(v["precision"] for v in per_class.values()) / len(classes)
    macro_r = sum(v["recall"] for v in per_class.values()) / len(classes)
    macro_f1 = sum(v["f1"] for v in per_class.values()) / len(classes)
    return {
        "total": total,
        "accuracy": correct / total if total else 0.0,
        "accepted": accepted,
        "accepted_accuracy": accepted_correct / accepted if accepted else 0.0,
        "unknown": unknown,
        "unknown_rate": unknown / total if total else 0.0,
        "macro_precision": macro_p,
        "macro_recall": macro_r,
        "macro_f1": macro_f1,
        "nearest_distance": {
            "min": float(nearest_dist.min()) if total else None,
            "p25": float(np.percentile(nearest_dist, 25)) if total else None,
            "median": float(np.percentile(nearest_dist, 50)) if total else None,
            "p75": float(np.percentile(nearest_dist, 75)) if total else None,
            "p90": float(np.percentile(nearest_dist, 90)) if total else None,
            "max": float(nearest_dist.max()) if total else None,
        },
        "unknown_reasons": dict(Counter(r for r in reasons if r != "ok")),
        "per_class": per_class,
    }


def calibration_grid(valid_X, valid_y, R, labels):
    """Sweep only over validation data; return the frozen winner."""
    candidates = []
    for k in (1, 3, 5, 7):
        for max_dist in (30.0, 35.0, 40.0, 45.0, 50.6, 55.0, 60.0, 65.0, 70.0, 80.0, 100.0):
            for separation in (1.0, 1.2, 1.5, 2.0):
                preds, reasons, nearest = classify_batch(
                    valid_X, R, labels, k, max_dist, separation
                )
                m = metrics(valid_y, preds, reasons, nearest)
                # Selection target: COVERAGE-AWARE macro F1 on predictions the
                # system actually accepts, penalized when acceptance is tiny.
                # Accuracy alone would reward rejecting everything.
                accepted_frac = m["accepted"] / m["total"]
                score = m["accepted_accuracy"] * math.sqrt(accepted_frac)
                candidates.append(
                    {
                        "k": k,
                        "maxDist": max_dist,
                        "separation": separation,
                        "score": score,
                        "accuracy": m["accuracy"],
                        "accepted_accuracy": m["accepted_accuracy"],
                        "accepted_fraction": accepted_frac,
                        "unknown_rate": m["unknown_rate"],
                        "macro_f1": m["macro_f1"],
                    }
                )
    candidates.sort(key=lambda c: (-c["score"], -c["macro_f1"], c["maxDist"]))
    return candidates


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", type=Path, default=ROOT / "datasets/processed/compact_eval.json")
    parser.add_argument("--db", type=Path, default=DB_PATH)
    args = parser.parse_args()

    started = time.time()
    data, R, labels, ref_ids, ref_counts = load_reference_db(args.db)
    print(f"reference DB: {R.shape[0]} refs, dim {R.shape[1]}, {len(ref_counts)} classes")
    print("refs/class: min=%d max=%d mean=%.2f" % (
        min(ref_counts.values()), max(ref_counts.values()), R.shape[0] / len(ref_counts)
    ))

    valid_X, valid_y, valid_ids = load_split(VALID_PATH)
    test_X, test_y, test_ids = load_split(TEST_PATH)
    print(f"valid: {valid_X.shape[0]} samples; test: {test_X.shape[0]} samples")

    # Leakage / overlap audit (rounded feature-vector identity).
    ref_hash = feature_hashes(R, ref_ids)
    for name, Q, ids in (("valid", valid_X, valid_ids), ("test", test_X, test_ids)):
        q_hash = feature_hashes(Q, ids)
        overlap = set(ref_hash).intersection(q_hash)
        print(f"feature-identical overlap with {name}: {len(overlap)} vectors")

    print("\ncurrent shipped config (k=3, maxDist=50.6, separation=1.5):")
    shipped = {}
    for name, Q, y in (("valid", valid_X, valid_y), ("test", test_X, test_y)):
        preds, reasons, nearest = classify_batch(
            Q, R, labels, DEFAULT_K, DEFAULT_MAX_DIST, DEFAULT_SEPARATION, DEFAULT_WEIGHTED
        )
        m = metrics(y, preds, reasons, nearest)
        shipped[name] = m
        print(f"  {name}: acc={m['accuracy']:.4f} accepted_acc={m['accepted_accuracy']:.4f} "
              f"unknown={m['unknown_rate']:.4f} macroF1={m['macro_f1']:.4f} "
              f"median_nn_dist={m['nearest_distance']['median']:.2f}")

    print("\ncalibrating on validation only ...")
    candidates = calibration_grid(valid_X, valid_y, R, labels)
    best = candidates[0]
    print("frozen config:", {k: best[k] for k in ("k", "maxDist", "separation", "score",
                                                    "accuracy", "accepted_accuracy",
                                                    "accepted_fraction", "unknown_rate",
                                                    "macro_f1")})
    print("top 5 validation candidates:")
    for c in candidates[:5]:
        print("  ", {k: round(c[k], 4) if isinstance(c[k], float) else c[k]
                     for k in ("k", "maxDist", "separation", "score", "accuracy",
                               "accepted_accuracy", "unknown_rate", "macro_f1")})

    preds, reasons, nearest = classify_batch(
        test_X, R, labels, best["k"], best["maxDist"], best["separation"], DEFAULT_WEIGHTED
    )
    test_m = metrics(test_y, preds, reasons, nearest)
    print("\nfrozen config on TEST (single evaluation):")
    print(f"  accuracy={test_m['accuracy']:.4f} accepted_acc={test_m['accepted_accuracy']:.4f} "
          f"unknown={test_m['unknown_rate']:.4f} macroP={test_m['macro_precision']:.4f} "
          f"macroR={test_m['macro_recall']:.4f} macroF1={test_m['macro_f1']:.4f}")

    print("\nvalidation threshold curve (separation=1.5):")
    curve = []
    for k in (1, 3, 5):
        for max_dist in (45.0, 50.6, 55.0, 60.0, 65.0, 70.0, 80.0):
            preds_c, reasons_c, nearest_c = classify_batch(
                valid_X, R, labels, k, max_dist, 1.5
            )
            m = metrics(valid_y, preds_c, reasons_c, nearest_c)
            row = {
                "k": k,
                "maxDist": max_dist,
                "accepted_fraction": m["accepted"] / m["total"],
                "accepted_accuracy": m["accepted_accuracy"],
                "accuracy": m["accuracy"],
                "unknown_rate": m["unknown_rate"],
                "macro_f1": m["macro_f1"],
            }
            curve.append(row)
    for row in curve:
        print(f"  k={row['k']} maxDist={row['maxDist']:.1f} accept={row['accepted_fraction']:.3f} "
              f"acceptedAcc={row['accepted_accuracy']:.3f} acc={row['accuracy']:.3f} "
              f"unknown={row['unknown_rate']:.3f} macroF1={row['macro_f1']:.3f}")

    report = {
        "reference_db": {
            "path": str(args.db),
            "count": int(R.shape[0]),
            "dim": int(R.shape[1]),
            "classes": len(ref_counts),
            "refs_per_class": {"min": min(ref_counts.values()), "max": max(ref_counts.values()),
                               "mean": R.shape[0] / len(ref_counts)},
            "distribution": dict(sorted(ref_counts.items())),
            "declared_k": data.get("k"),
            "declared_maxDist": data.get("maxDist"),
            "scaler_numSamples": data.get("scaler", {}).get("numSamples"),
            "scaler_fittedOn": data.get("scaler", {}).get("fittedOn"),
        },
        "splits": {"valid": int(valid_X.shape[0]), "test": int(test_X.shape[0])},
        "shipped_config": {
            "k": DEFAULT_K, "maxDist": DEFAULT_MAX_DIST,
            "separation": DEFAULT_SEPARATION, "weighted": DEFAULT_WEIGHTED,
        },
        "shipped_metrics": shipped,
        "frozen_config": best,
        "validation_top5": candidates[:5],
        "validation_curve": curve,
        "test": test_m,
        "elapsed_seconds": round(time.time() - started, 2),
    }
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nwrote {args.json}")


if __name__ == "__main__":
    main()
