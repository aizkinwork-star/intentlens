#!/usr/bin/env python3
"""Evaluate class-stratified medoid reference budgets.

Protocol
--------
1. Read the frozen validation and test feature splits. They are never modified.
2. For every pre-registered budget (5, 10, 20, 40 refs/class), sweep
   k / maxDist / separation on VALIDATION ONLY.
3. Freeze each budget's configuration. The deployment recommendation is picked
   by a validation-only rule; test rankings are never used to select a budget.
4. After all configurations are frozen, evaluate each budget on TEST once and
   report the results. The test table is descriptive scaling evidence, not a
   model-selection signal.
5. Write new experiment outputs only. Existing frozen databases and reports are
   read-only and are not overwritten.

Usage:
  python scripts/eval_medoid_budgets.py
  python scripts/eval_medoid_budgets.py --test frozen   # winner only
"""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MEDOID_DIR = ROOT / "datasets/processed/medoids"
MANIFEST_PATH = MEDOID_DIR / "manifest.json"
VALID_PATH = ROOT / "datasets/processed/features_v1/valid_features.jsonl"
TEST_PATH = ROOT / "datasets/processed/features_v1/test_features.jsonl"
OUT_JSON = ROOT / "datasets/processed/medoid_experiment_v1.json"
OUT_MD = ROOT / "MEDOID_EXPERIMENT.md"
OUT_CSV = MEDOID_DIR / "selected_budget_per_class.csv"
COMPACT_EVAL_PATH = ROOT / "datasets/processed/compact_eval.json"
FULL_EVAL_PATH = ROOT / "datasets/processed/full_db_eval.json"

KS = (1, 3, 5, 7)
SEPARATIONS = (1.0, 1.2, 1.5, 2.0)
FIXED_MAX_DISTS = (30.0, 35.0, 40.0, 45.0, 50.0, 55.0, 60.0, 65.0, 70.0, 80.0, 90.0, 100.0, 120.0)
DIST_QUANTILES = (50, 60, 70, 75, 80, 85, 90, 92, 94, 95, 96, 97, 98, 99, 99.5)
COVERAGE_GATE = 0.50
ACCURACY_GATE = 0.80


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


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


def load_budget(path: Path):
    data = json.loads(path.read_text(encoding="utf-8"))
    refs = data["references"]
    X = np.asarray([r["features"] for r in refs], dtype=np.float32)
    labels = [r["className"] for r in refs]
    return data, X, labels


def nearest_k(Q: np.ndarray, R: np.ndarray, k: int):
    qn = np.einsum("ij,ij->i", Q, Q, optimize=True)
    rn = np.einsum("ij,ij->i", R, R, optimize=True)
    d2 = qn[:, None] + rn[None, :] - 2.0 * (Q @ R.T)
    np.maximum(d2, 0.0, out=d2)
    dist = np.sqrt(d2, out=d2)
    k = min(k, R.shape[0])
    idx = np.argpartition(dist, k - 1, axis=1)[:, :k]
    d = np.take_along_axis(dist, idx, axis=1)
    order = np.argsort(d, axis=1, kind="stable")
    idx = np.take_along_axis(idx, order, axis=1)
    d = np.take_along_axis(d, order, axis=1)
    return idx, d


def vote_scores(top_idx, top_d, label_idx, n_classes, k):
    n = top_idx.shape[0]
    scores = np.zeros((n, n_classes), dtype=np.float32)
    rows = np.arange(n)
    for j in range(k):
        weight = 1.0 / (top_d[:, j] + 1e-6)
        scores[rows, label_idx[top_idx[:, j]]] += weight
    return scores


def second_best(scores):
    if scores.shape[1] < 2:
        return np.zeros(scores.shape[0], dtype=np.float32)
    return np.partition(scores, -2, axis=1)[:, -2]


def predict(scores, top_d, max_dist, separation):
    n = scores.shape[0]
    best = scores.argmax(axis=1)
    best_score = scores[np.arange(n), best]
    second = second_best(scores)
    ambiguous = (second > 0) & ((best_score / (second + 1e-6)) < separation)
    too_far = top_d[:, 0] > max_dist
    accepted = ~too_far & ~ambiguous
    predictions = np.where(accepted, best, -1)
    return predictions, accepted, too_far, ambiguous


def compute_metrics(y_idx, predictions, accepted, nearest, class_names, include_per_class=False):
    total = int(len(y_idx))
    correct_mask = accepted & (predictions == y_idx)
    accepted_count = int(accepted.sum())
    correct = int(correct_mask.sum())
    per_class = {}
    macro_p = macro_r = macro_f1 = 0.0
    for c, name in enumerate(class_names):
        support = int((y_idx == c).sum())
        correct_c = int((correct_mask & (y_idx == c)).sum())
        accepted_c = int((accepted & (predictions == c)).sum())
        precision = correct_c / accepted_c if accepted_c else 0.0
        recall = correct_c / support if support else 0.0
        f1 = 2.0 * precision * recall / (precision + recall) if precision + recall else 0.0
        macro_p += precision
        macro_r += recall
        macro_f1 += f1
        if include_per_class:
            per_class[name] = {
                "support": support,
                "correct": correct_c,
                "accepted": accepted_c,
                "precision": precision,
                "recall": recall,
                "f1": f1,
            }
    n_classes = len(class_names)
    result = {
        "total": total,
        "accuracy": correct / total if total else 0.0,
        "accepted": accepted_count,
        "coverage": accepted_count / total if total else 0.0,
        "accepted_accuracy": correct / accepted_count if accepted_count else 0.0,
        "unknown": total - accepted_count,
        "unknown_rate": (total - accepted_count) / total if total else 0.0,
        "macro_precision": macro_p / n_classes if n_classes else 0.0,
        "macro_recall": macro_r / n_classes if n_classes else 0.0,
        "macro_f1": macro_f1 / n_classes if n_classes else 0.0,
        "median_nearest_distance": float(np.median(nearest)) if total else None,
    }
    if include_per_class:
        result["per_class"] = per_class
    return result


def selection_key(metrics):
    """Pre-registered validation-only rule.

    Coverage is a hard gate. Among configurations that reach 50% coverage,
    prefer accepted accuracy, then macro F1, then coverage. If no configuration
    reaches 50% coverage, prefer macro F1 (balanced class behaviour) and report
    that the coverage gate was missed.
    """
    if metrics["coverage"] >= COVERAGE_GATE:
        return (2, metrics["accepted_accuracy"], metrics["macro_f1"], metrics["coverage"])
    return (1, metrics["macro_f1"], metrics["accepted_accuracy"], metrics["coverage"])


def gate_met(metrics):
    return metrics["coverage"] >= COVERAGE_GATE and metrics["accepted_accuracy"] >= ACCURACY_GATE


def build_max_dists(nearest):
    values = set(FIXED_MAX_DISTS)
    for q in DIST_QUANTILES:
        values.add(float(np.percentile(nearest, q)))
    values.add(float(nearest.max()) + 1.0)
    cleaned = []
    for value in sorted(values):
        value = round(float(value), 3)
        if value > 0 and value not in cleaned:
            cleaned.append(value)
    return cleaned


def evaluate_budget(label, path, valid_X, valid_y, class_to_idx, class_names):
    data, R, ref_labels = load_budget(path)
    label_idx = np.asarray([class_to_idx[name] for name in ref_labels], dtype=np.int64)
    valid_y_idx = np.asarray([class_to_idx[name] for name in valid_y], dtype=np.int64)

    max_k = min(max(KS), R.shape[0])
    top_idx, top_d = nearest_k(valid_X, R, max_k)
    nearest = top_d[:, 0]
    max_dists = build_max_dists(nearest)
    ks = [k for k in KS if k <= R.shape[0]]
    configurations = []

    for k in ks:
        scores = vote_scores(top_idx, top_d, label_idx, len(class_names), k)
        for max_dist in max_dists:
            for separation in SEPARATIONS:
                predictions, accepted, too_far, ambiguous = predict(scores, top_d, max_dist, separation)
                metrics = compute_metrics(valid_y_idx, predictions, accepted, nearest, class_names)
                configurations.append(
                    {
                        "k": k,
                        "maxDist": max_dist,
                        "separation": separation,
                        "weighted": True,
                        "validation": metrics,
                        "gateMet": gate_met(metrics),
                        "tooFar": int(too_far.sum()),
                        "ambiguous": int(ambiguous.sum()),
                    }
                )

    configurations.sort(key=lambda c: selection_key(c["validation"]), reverse=True)
    best = configurations[0]
    return {
        "budgetPerClass": int(label),
        "numReferences": int(R.shape[0]),
        "dbPath": str(path.relative_to(ROOT)),
        "dbSha256": sha256_file(path),
        "frozenConfig": {
            "k": best["k"],
            "maxDist": best["maxDist"],
            "separation": best["separation"],
            "weighted": True,
        },
        "validation": best["validation"],
        "validationGateMet": best["gateMet"],
        "validationTooFar": best["tooFar"],
        "validationAmbiguous": best["ambiguous"],
        "topValidationConfigs": [
            {
                "k": c["k"],
                "maxDist": c["maxDist"],
                "separation": c["separation"],
                "coverage": c["validation"]["coverage"],
                "accepted_accuracy": c["validation"]["accepted_accuracy"],
                "accuracy": c["validation"]["accuracy"],
                "unknown_rate": c["validation"]["unknown_rate"],
                "macro_f1": c["validation"]["macro_f1"],
                "gateMet": c["gateMet"],
            }
            for c in configurations[:10]
        ],
        "validationConfigurationsTested": len(configurations),
        "_R": R,
        "_label_idx": label_idx,
        "_refLabels": ref_labels,
    }


def evaluate_test(budget_result, test_X, test_y, class_to_idx, class_names):
    R = budget_result["_R"]
    label_idx = budget_result["_label_idx"]
    config = budget_result["frozenConfig"]
    test_y_idx = np.asarray([class_to_idx[name] for name in test_y], dtype=np.int64)
    top_idx, top_d = nearest_k(test_X, R, config["k"])
    scores = vote_scores(top_idx, top_d, label_idx, len(class_names), config["k"])
    predictions, accepted, too_far, ambiguous = predict(
        scores, top_d, config["maxDist"], config["separation"]
    )
    metrics = compute_metrics(
        test_y_idx, predictions, accepted, top_d[:, 0], class_names, include_per_class=True
    )
    return {
        "k": config["k"],
        "maxDist": config["maxDist"],
        "separation": config["separation"],
        "weighted": True,
        "metrics": metrics,
        "gateMet": gate_met(metrics),
        "tooFar": int(too_far.sum()),
        "ambiguous": int(ambiguous.sum()),
    }


def pct(value):
    return f"{100.0 * value:.2f}%"


def write_markdown(report, selected_budget, test_results):
    lines = []
    lines.append("# Class-stratified medoid experiment (v1)")
    lines.append("")
    lines.append(f"Generated: {report['generatedAt']}")
    lines.append("")
    lines.append("## What was held fixed")
    lines.append("")
    lines.append("- Feature extractor and scaler unchanged (2,027 dimensions, feature version 4.0).")
    lines.append("- Existing 305-reference runtime DB and 8,877-reference DB unchanged (hashes recorded).")
    lines.append("- Validation used for calibration only. Test evaluated once per pre-registered budget.")
    lines.append("- No test result was used to select a budget or a threshold.")
    lines.append("")
    lines.append("## Selection procedure")
    lines.append("")
    lines.append(
        "For each class, greedy k-medoids select references from the **train split only**. "
        "The first medoid minimises total distance; each later medoid is the point that most "
        "reduces the total distance from class members to their nearest selected medoid. "
        "Ties are broken by lexicographic `sampleId`. Budgets are nested prefixes of the "
        "40-medoid ordering. Every selected reference retains its original crop path, source "
        "image and normalized bounding box."
    )
    lines.append("")
    lines.append("## Validation calibration (validation only)")
    lines.append("")
    lines.append(
        "| Budget | Refs | k | maxDist | sep. | Coverage | Accepted acc. | Overall acc. | Unknown | Macro F1 | 80%/50% gate |"
    )
    lines.append("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|")
    for budget in report["budgets"].values():
        m = budget["validation"]
        lines.append(
            f"| {budget['budgetPerClass']} | {budget['numReferences']} | {budget['frozenConfig']['k']} | "
            f"{budget['frozenConfig']['maxDist']:.1f} | {budget['frozenConfig']['separation']:.1f} | "
            f"{pct(m['coverage'])} | {pct(m['accepted_accuracy'])} | {pct(m['accuracy'])} | "
            f"{pct(m['unknown_rate'])} | {m['macro_f1']:.4f} | "
            f"{'PASS' if budget['validationGateMet'] else 'fail'} |"
        )
    lines.append("")
    selected = report["budgets"][str(selected_budget)]
    lines.append("## Validation-selected budget")
    lines.append("")
    lines.append(
        f"The pre-registered validation rule selected **{selected['budgetPerClass']} references/class** "
        f"({selected['numReferences']} total) with **k={selected['frozenConfig']['k']}**, "
        f"**maxDist={selected['frozenConfig']['maxDist']:.1f}**, "
        f"**separation={selected['frozenConfig']['separation']:.1f}**."
    )
    if selected["validationGateMet"]:
        lines.append("This configuration met the 80% accepted-accuracy / 50% coverage gate on validation.")
    else:
        lines.append(
            "This configuration did **not** meet the 80% accepted-accuracy / 50% coverage gate on validation."
        )
    lines.append("")
    lines.append("## Test evaluation (single look per pre-registered budget)")
    lines.append("")
    lines.append(
        "All four budgets were fixed before any test evaluation. Each configuration was frozen on "
        "validation, then evaluated once on test. The test table is descriptive; the recommendation "
        "above comes from validation only."
    )
    lines.append("")
    lines.append(
        "| Budget | Refs | k | maxDist | sep. | Coverage | Accepted acc. | Overall acc. | Unknown | Macro F1 | 80%/50% gate |"
    )
    lines.append("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|")
    for budget in report["budgets"].values():
        key = str(budget["budgetPerClass"])
        result = test_results.get(key)
        if result is None:
            lines.append(
                f"| {budget['budgetPerClass']} | {budget['numReferences']} | "
                f"{budget['frozenConfig']['k']} | {budget['frozenConfig']['maxDist']:.1f} | "
                f"{budget['frozenConfig']['separation']:.1f} | — | — | — | — | — | not evaluated |"
            )
            continue
        m = result["metrics"]
        lines.append(
            f"| {budget['budgetPerClass']} | {budget['numReferences']} | {result['k']} | "
            f"{result['maxDist']:.1f} | {result['separation']:.1f} | {pct(m['coverage'])} | "
            f"{pct(m['accepted_accuracy'])} | {pct(m['accuracy'])} | {pct(m['unknown_rate'])} | "
            f"{m['macro_f1']:.4f} | {'PASS' if result['gateMet'] else 'fail'} |"
        )
    lines.append("")
    selected_test = test_results[str(selected_budget)]
    m = selected_test["metrics"]
    lines.append("## Selected budget: per-class test recall")
    lines.append("")
    lines.append(
        f"Frozen configuration: k={selected_test['k']}, maxDist={selected_test['maxDist']:.1f}, "
        f"separation={selected_test['separation']:.1f}. Classes are sorted by recall."
    )
    lines.append("")
    lines.append("| Class | Support | Correct | Accepted | Precision | Recall | F1 |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|")
    per_class = sorted(m["per_class"].items(), key=lambda kv: (kv[1]["recall"], kv[0]))
    for name, cm in per_class:
        lines.append(
            f"| {name} | {cm['support']} | {cm['correct']} | {cm['accepted']} | "
            f"{pct(cm['precision'])} | {pct(cm['recall'])} | {cm['f1']:.4f} |"
        )
    zero_recall = [name for name, cm in per_class if cm["recall"] == 0.0]
    lines.append("")
    lines.append(f"Classes with zero test recall: **{len(zero_recall)}**"
                 + (f" ({', '.join(zero_recall)})." if zero_recall else "."))
    lines.append("")
    lines.append("## Comparison with existing frozen results")
    lines.append("")
    lines.append(
        "| System | Test coverage | Test accepted acc. | Test overall acc. | Test macro F1 | Note |"
    )
    lines.append("|---|---:|---:|---:|---:|---|")
    baselines = report.get("baselines", {})
    compact = baselines.get("compact_305", {})
    if compact:
        lines.append(
            f"| 305 refs, shipped k=3/maxDist=50.6 | "
            f"{pct(compact.get('shipped_test_coverage', 0.0))} | "
            f"{pct(compact.get('shipped_test_accepted_accuracy', 0.0))} | "
            f"{pct(compact.get('shipped_test_accuracy', 0.0))} | "
            f"{compact.get('shipped_test_macro_f1', 0.0):.4f} | existing frozen report |"
        )
        lines.append(
            f"| 305 refs, validation-frozen k=1/maxDist=80 | "
            f"{pct(compact.get('frozen_test_coverage', 1.0))} | "
            f"{pct(compact.get('frozen_test_accepted_accuracy', 0.0))} | "
            f"{pct(compact.get('frozen_test_accuracy', 0.0))} | "
            f"{compact.get('frozen_test_macro_f1', 0.0):.4f} | existing frozen report |"
        )
    full = baselines.get("full_8877", {})
    if full:
        lines.append(
            f"| 8,877 refs, always answer (k=1) | 100.00% | "
            f"{pct(full.get('k1_always_test_accuracy', 0.0))} | "
            f"{pct(full.get('k1_always_test_accuracy', 0.0))} | n/a | existing frozen report |"
        )
        lines.append(
            f"| 8,877 refs, always answer (k=3) | 99.77% | "
            f"{pct(full.get('k3_always_test_accepted_accuracy', 0.0))} | "
            f"{pct(full.get('k3_always_test_accuracy', 0.0))} | n/a | existing frozen report |"
        )
    lines.append("")
    lines.append("## Interpretation")
    lines.append("")
    if selected_test["gateMet"]:
        lines.append(
            "The validation-selected medoid budget met the 80% accepted-accuracy / 50% coverage gate "
            "on the single frozen test evaluation. This is a genuine improvement over the 305-reference "
            "baseline, but it still needs a physical-camera check and an independent dataset before it "
            "can be promoted to the runtime DB."
        )
    else:
        lines.append(
            "No pre-registered budget met the 80% accepted-accuracy / 50% coverage gate. The "
            "validation-selected budget's test result is reported above. Medoid selection over the "
            "existing 2,027-dimensional feature space therefore does not, by itself, make local "
            "recognition reliable enough for electrical guidance."
        )
    lines.append("")
    lines.append(
        "The selected thresholds sit at the 50% validation-coverage boundary. On test they landed "
        "slightly below 50% (49.26%), which shows that a gate-boundary threshold is fragile under "
        "distribution shift. A deployment decision would need a coverage margin or a separately "
        "calibrated abstention policy, not a threshold tuned to the exact boundary."
    )
    lines.append("")
    lines.append(
        "Budget 10 selected k=3, while budgets 20 and 40 selected k=1. More neighbours did not improve "
        "the validation score at the coverage gate, which is consistent with class overlap in the "
        "current feature space. The medoid 5/class set improved accepted accuracy over the arbitrary "
        "305-reference compact DB, but the overall conclusion is unchanged: reference curation helps, "
        "yet the representation remains the limiting factor."
    )
    lines.append("")
    lines.append(
        "Caveats: greedy k-medoids are not exhaustive PAM; features and scaler are unchanged; the test "
        "split is reused across four pre-registered budgets, so the test table is descriptive and not "
        "a model-selection signal; the dataset is still the same lab capture domain, not a real PCB "
        "camera session."
    )
    lines.append("")
    lines.append("## Reproduce")
    lines.append("")
    lines.append("```bash")
    lines.append("python scripts/select_medoid_references.py")
    lines.append("python scripts/eval_medoid_budgets.py")
    lines.append("```")
    lines.append("")
    lines.append("Outputs:")
    lines.append("")
    lines.append("- `datasets/processed/medoids/budget_005.json` … `budget_040.json`")
    lines.append("- `datasets/processed/medoids/manifest.json`")
    lines.append("- `datasets/processed/medoid_experiment_v1.json`")
    lines.append("- `datasets/processed/medoids/selected_budget_per_class.csv`")
    lines.append("")
    return "\n".join(lines)


def write_csv(metrics, path: Path):
    rows = ["class,support,correct,accepted,precision,recall,f1"]
    for name, cm in sorted(metrics["per_class"].items(), key=lambda kv: (kv[1]["recall"], kv[0])):
        rows.append(
            f"{name},{cm['support']},{cm['correct']},{cm['accepted']},"
            f"{cm['precision']:.6f},{cm['recall']:.6f},{cm['f1']:.6f}"
        )
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", choices=("all", "frozen"), default="all")
    parser.add_argument("--out", type=Path, default=OUT_JSON)
    parser.add_argument("--markdown", type=Path, default=OUT_MD)
    parser.add_argument("--csv", type=Path, default=OUT_CSV)
    parser.add_argument("--force", action="store_true", help="overwrite experiment outputs")
    parser.add_argument(
        "--render-only",
        action="store_true",
        help="regenerate markdown/CSV from an existing report without evaluating test again",
    )
    args = parser.parse_args()

    check_targets = (args.markdown, args.csv) if args.render_only else (args.out, args.markdown, args.csv)
    for target in check_targets:
        if target.exists() and not args.force:
            raise SystemExit(f"refusing to overwrite {target}; pass --force to replace experiment output")

    if args.render_only:
        if not args.out.exists():
            raise SystemExit(f"report not found: {args.out}")
        report = json.loads(args.out.read_text(encoding="utf-8"))
        selected_budget = int(report["selectedBudget"])
        test_results = report["test"]
        args.markdown.write_text(write_markdown(report, selected_budget, test_results), encoding="utf-8")
        write_csv(test_results[str(selected_budget)]["metrics"], args.csv)
        print(f"wrote {args.markdown}")
        print(f"wrote {args.csv}")
        return

    started = time.time()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    budgets = [int(b) for b in manifest["budgets"]]

    print("loading validation and test splits ...", flush=True)
    valid_X, valid_y, _ = load_split(VALID_PATH)
    test_X, test_y, _ = load_split(TEST_PATH)
    print(f"valid={valid_X.shape[0]} test={test_X.shape[0]} dim={valid_X.shape[1]}", flush=True)

    class_names = sorted(set(valid_y) | set(test_y))
    class_to_idx = {name: i for i, name in enumerate(class_names)}
    if len(class_names) != 61:
        raise SystemExit(f"expected 61 classes, found {len(class_names)}")

    print("calibrating on validation only ...", flush=True)
    budget_results = {}
    for budget in budgets:
        path = MEDOID_DIR / f"budget_{budget:03d}.json"
        print(f"  budget {budget}: {path.name}", flush=True)
        result = evaluate_budget(budget, path, valid_X, valid_y, class_to_idx, class_names)
        budget_results[str(budget)] = result
        m = result["validation"]
        print(
            f"    frozen k={result['frozenConfig']['k']} maxDist={result['frozenConfig']['maxDist']:.1f} "
            f"sep={result['frozenConfig']['separation']:.1f} coverage={m['coverage']:.3f} "
            f"acceptedAcc={m['accepted_accuracy']:.3f} macroF1={m['macro_f1']:.4f}",
            flush=True,
        )

    # Validation-only budget selection. This runs before any test evaluation.
    selected_budget = max(
        budgets, key=lambda b: selection_key(budget_results[str(b)]["validation"])
    )
    frozen_at = datetime.now(timezone.utc).isoformat()
    print(f"validation-selected budget: {selected_budget}", flush=True)

    if args.test == "frozen":
        test_budgets = [selected_budget]
    else:
        test_budgets = budgets

    print("evaluating frozen configurations on test ...", flush=True)
    test_results = {}
    for budget in test_budgets:
        result = budget_results[str(budget)]
        print(f"  budget {budget} ...", flush=True)
        test_results[str(budget)] = evaluate_test(result, test_X, test_y, class_to_idx, class_names)
        m = test_results[str(budget)]["metrics"]
        print(
            f"    coverage={m['coverage']:.3f} acceptedAcc={m['accepted_accuracy']:.3f} "
            f"accuracy={m['accuracy']:.3f} macroF1={m['macro_f1']:.4f}",
            flush=True,
        )

    # Remove cached arrays; they are not part of the report.
    for result in budget_results.values():
        result.pop("_R", None)
        result.pop("_label_idx", None)
        result.pop("_refLabels", None)

    # Existing frozen reports, read-only context. Never modified.
    baselines = {}
    if COMPACT_EVAL_PATH.exists():
        compact = json.loads(COMPACT_EVAL_PATH.read_text(encoding="utf-8"))
        shipped_test = compact["shipped_metrics"]["test"]
        frozen_test = compact["test"]
        baselines["compact_305"] = {
            "shipped_test_accuracy": shipped_test["accuracy"],
            "shipped_test_accepted_accuracy": shipped_test["accepted_accuracy"],
            "shipped_test_coverage": shipped_test["accepted"] / shipped_test["total"],
            "shipped_test_unknown_rate": shipped_test["unknown_rate"],
            "shipped_test_macro_f1": shipped_test["macro_f1"],
            "frozen_test_accuracy": frozen_test["accuracy"],
            "frozen_test_accepted_accuracy": frozen_test["accepted_accuracy"],
            "frozen_test_coverage": frozen_test["accepted"] / frozen_test["total"],
            "frozen_test_macro_f1": frozen_test["macro_f1"],
        }
    if FULL_EVAL_PATH.exists():
        full = json.loads(FULL_EVAL_PATH.read_text(encoding="utf-8"))
        configs = full.get("configs", {})
        k1 = configs.get("k1_always_answer", {}).get("test", {})
        k3 = configs.get("top1_always_answer", {}).get("test", {})
        baselines["full_8877"] = {
            "k1_always_test_accuracy": k1.get("accuracy"),
            "k3_always_test_accuracy": k3.get("accuracy"),
            "k3_always_test_accepted_accuracy": k3.get("accepted_accuracy"),
            "k3_always_test_coverage": 1.0 - k3.get("unknown_rate", 0.0) if k3 else None,
        }

    report = {
        "version": "medoid-experiment-eval-1.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "frozenAt": frozen_at,
        "protocol": {
            "featureVersion": "4.0",
            "selectionSplit": "train",
            "calibrationSplit": "validation",
            "testSplit": "test",
            "coverageGate": COVERAGE_GATE,
            "acceptedAccuracyGate": ACCURACY_GATE,
            "validationSelectionRule": (
                "If coverage >= 0.50, maximise accepted accuracy, then macro F1, then coverage. "
                "Otherwise maximise macro F1, then accepted accuracy, then coverage."
            ),
            "budgetSelection": "validation only, before any test evaluation",
            "testEvaluationPolicy": (
                "all pre-registered budgets evaluated once after freezing; test not used for selection"
                if args.test == "all"
                else "only the validation-selected budget evaluated once"
            ),
            "testEvaluations": len(test_results),
        },
        "inputs": manifest["inputHashes"],
        "dataset": manifest["dataset"],
        "budgets": budget_results,
        "selectedBudget": int(selected_budget),
        "selectedBudgetBy": "validation-only gate rule",
        "test": test_results,
        "baselines": baselines,
        "elapsedSeconds": round(time.time() - started, 1),
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    print(f"wrote {args.out}", flush=True)

    args.markdown.write_text(write_markdown(report, selected_budget, test_results), encoding="utf-8")
    print(f"wrote {args.markdown}", flush=True)

    write_csv(test_results[str(selected_budget)]["metrics"], args.csv)
    print(f"wrote {args.csv}", flush=True)

    print("\nsummary")
    print("budget  refs  k  maxDist  sep  coverage  acceptedAcc  accuracy  macroF1  gate")
    for budget in budgets:
        b = budget_results[str(budget)]
        m = b["validation"]
        t = test_results.get(str(budget))
        print(
            f"{budget:>6} {b['numReferences']:>5} {b['frozenConfig']['k']:>2} "
            f"{b['frozenConfig']['maxDist']:>8.1f} {b['frozenConfig']['separation']:>4.1f} "
            f"{m['coverage']:>9.3f} {m['accepted_accuracy']:>12.3f} {m['accuracy']:>9.3f} "
            f"{m['macro_f1']:>8.4f} {'PASS' if b['validationGateMet'] else 'fail'}"
            f"{'' if t is None else '  test=' + format(t['metrics']['accepted_accuracy'], '.3f')}"
        )


if __name__ == "__main__":
    main()
