#!/usr/bin/env python3
"""One-shot reference comparison for the large (8,877-reference) candidate DB.

This is NOT used for tuning the shipped compact DB. It evaluates the large DB
with its own declared configuration on validation and test so the compact-DB
numbers have a fair reference point. The test split is evaluated once.
"""
from __future__ import annotations

import json
import time
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "datasets/processed/knn_reference_db_candidate_full.json"
VALID_PATH = ROOT / "datasets/processed/features_v1/valid_features.jsonl"
TEST_PATH = ROOT / "datasets/processed/features_v1/test_features.jsonl"
OUT_PATH = ROOT / "datasets/processed/full_db_eval.json"


def load_split(path: Path):
    X, y = [], []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            row = json.loads(line)
            X.append(row["features"])
            y.append(row["class_name"])
    return np.asarray(X, dtype=np.float32), y


def classify(Q, R, labels, k=3, max_dist=50.6, separation=1.5):
    n = Q.shape[0]
    qn = np.sum(Q * Q, axis=1)[:, None]
    rn = np.sum(R * R, axis=1)[None, :]
    preds, reasons = [], []
    nearest = []
    for start in range(0, n, 64):
        block = Q[start:start + 64]
        bqn = qn[start:start + 64]
        dists = np.sqrt(np.maximum(bqn + rn - 2.0 * (block @ R.T), 0.0))
        order = np.argpartition(dists, kth=min(k, R.shape[0] - 1), axis=1)[:, :k]
        for i in range(block.shape[0]):
            idxs = order[i]
            ds = dists[i, idxs]
            sort = np.argsort(ds)
            idxs, ds = idxs[sort], ds[sort]
            nearest.append(float(ds[0]))
            if float(ds[0]) > max_dist:
                preds.append("unknown")
                reasons.append("too_far")
                continue
            votes = {}
            for j in range(len(idxs)):
                lab = labels[int(idxs[j])]
                votes[lab] = votes.get(lab, 0.0) + 1.0 / (float(ds[j]) + 1e-6)
            ordered = sorted(votes.items(), key=lambda kv: -kv[1])
            best, best_score = ordered[0]
            second = ordered[1][1] if len(ordered) > 1 else 0.0
            if second > 0 and best_score / (second + 1e-6) < separation:
                preds.append("unknown")
                reasons.append("ambiguous")
            else:
                preds.append(best)
                reasons.append("ok")
    return preds, reasons, np.asarray(nearest)


def metrics(y, preds, reasons, nearest):
    total = len(y)
    correct = sum(1 for t, p in zip(y, preds) if t == p)
    accepted = sum(1 for p in preds if p != "unknown")
    accepted_correct = sum(1 for t, p in zip(y, preds) if p != "unknown" and t == p)
    return {
        "total": total,
        "accuracy": correct / total,
        "accepted": accepted,
        "accepted_accuracy": accepted_correct / accepted if accepted else 0.0,
        "unknown": total - accepted,
        "unknown_rate": (total - accepted) / total,
        "nearest_distance_median": float(np.median(nearest)),
        "unknown_reasons": dict(Counter(r for r in reasons if r != "ok")),
    }


def main():
    started = time.time()
    print("loading large DB ...", flush=True)
    data = json.loads(DB_PATH.read_text(encoding="utf-8"))
    refs = data["references"]
    R = np.asarray([r["features"] for r in refs], dtype=np.float32)
    labels = [r["className"] for r in refs]
    counts = Counter(labels)
    print(f"refs={R.shape[0]} dim={R.shape[1]} classes={len(counts)} "
          f"refs/class min={min(counts.values())} max={max(counts.values())} "
          f"mean={R.shape[0] / len(counts):.1f}", flush=True)
    del data, refs
    print("loading splits ...", flush=True)
    V, vy = load_split(VALID_PATH)
    T, ty = load_split(TEST_PATH)
    print(f"valid={V.shape[0]} test={T.shape[0]}", flush=True)

    configs = [
        ("shipped_rejecting", 3, 50.6, 1.5),
        ("top1_always_answer", 3, float("inf"), 1.0),
        ("k1_rejecting", 1, 50.6, 1.5),
        ("k1_always_answer", 1, float("inf"), 1.0),
    ]
    results = {}
    for label, k, max_dist, separation in configs:
        results[label] = {}
        for name, Q, y in (("valid", V, vy), ("test", T, ty)):
            preds, reasons, nearest = classify(Q, R, labels, k, max_dist, separation)
            m = metrics(y, preds, reasons, nearest)
            results[label][name] = m
            print(f"{label} {name}: acc={m['accuracy']:.4f} "
                  f"accepted_acc={m['accepted_accuracy']:.4f} "
                  f"unknown={m['unknown_rate']:.4f} median_nn={m['nearest_distance_median']:.2f}",
                  flush=True)

    OUT_PATH.write_text(json.dumps({
        "reference_db": {
            "path": str(DB_PATH),
            "count": int(R.shape[0]),
            "classes": len(counts),
            "refs_per_class": {"min": min(counts.values()), "max": max(counts.values()),
                               "mean": R.shape[0] / len(counts)},
        },
        "configs": results,
        "elapsed_seconds": round(time.time() - started, 1),
    }, indent=2), encoding="utf-8")
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
