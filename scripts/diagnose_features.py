import json
import numpy as np
from pathlib import Path

root = Path(".")
db = json.loads((root / "knn_reference_db_compact.json").read_text())
R = np.asarray([r["features"] for r in db["references"]], dtype=np.float32)
print("refs", R.shape, "mean", float(R.mean()), "std", float(R.std()))
print("per-dim mean range", float(R.mean(0).min()), float(R.mean(0).max()))
print("per-dim std range", float(R.std(0).min()), float(R.std(0).max()))
norms = np.linalg.norm(R, axis=1)
print("row norms min/median/max", float(norms.min()), float(np.median(norms)), float(norms.max()))
print("sampleIds first 10", [r.get("sampleId") for r in db["references"][:10]])
print("scaler numSamples", db["scaler"].get("numSamples"), "fittedOn", db["scaler"].get("fittedOn"))

def load(path, n=None):
    X, y, ids = [], [], []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if n and len(X) >= n:
                break
            o = json.loads(line)
            X.append(o["features"])
            y.append(o["class_name"])
            ids.append(o["crop_file"])
    return np.asarray(X, dtype=np.float32), y, ids

V, vy, vid = load("datasets/processed/features_v1/valid_features.jsonl")
print("valid", V.shape, "mean", float(V.mean()), "std", float(V.std()))
print("valid per-dim mean range", float(V.mean(0).min()), float(V.mean(0).max()))
vn = np.linalg.norm(V, axis=1)
print("valid row norms min/median/max", float(vn.min()), float(np.median(vn)), float(vn.max()))
print("valid crop ids first 3", vid[:3])
