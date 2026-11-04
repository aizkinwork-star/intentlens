import json
from pathlib import Path

r = json.loads(Path("datasets/processed/compact_eval.json").read_text(encoding="utf-8"))
print("FROZEN TEST per-class (sorted by recall ascending):")
rows = sorted(r["test"]["per_class"].items(), key=lambda kv: (kv[1]["recall"], kv[1]["support"]))
print("class\tsupport\tcorrect\tprecision\trecall\tf1")
for name, m in rows:
    print(f"{name}\t{m['support']}\t{m['correct']}\t{m['precision']:.3f}\t{m['recall']:.3f}\t{m['f1']:.3f}")

print("\nSHIPPED TEST per-class accepted predictions (only classes with accepted > 0):")
rows2 = sorted(r["shipped_metrics"]["test"]["per_class"].items(), key=lambda kv: -kv[1]["accepted"])
for name, m in rows2:
    if m["accepted"]:
        print(f"{name}\tsupport={m['support']} correct={m['correct']} accepted={m['accepted']} "
              f"p={m['precision']:.2f} r={m['recall']:.2f} f1={m['f1']:.2f}")

print("\nclasses with zero accepted predictions under shipped config:",
      sum(1 for m in r["shipped_metrics"]["test"]["per_class"].values() if m["accepted"] == 0))
print("median per-class recall (frozen):",
      sorted(m["recall"] for m in r["test"]["per_class"].values())[len(r["test"]["per_class"]) // 2])
