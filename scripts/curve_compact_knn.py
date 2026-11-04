import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("ev", Path("scripts/eval_compact_knn.py"))
ev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ev)

data, R, labels, ref_ids, ref_counts = ev.load_reference_db(ev.DB_PATH)
V, vy, vid = ev.load_split(ev.VALID_PATH)
T, ty, tid = ev.load_split(ev.TEST_PATH)

print("VALIDATION CURVE (separation=1.5)")
print("k maxDist accept acceptedAcc accuracy unknown macroF1")
for k in (1, 3, 5):
    for md in (40, 45, 50.6, 55, 60, 65, 70, 80, 100):
        preds, reasons, nearest = ev.classify_batch(V, R, labels, k, md, 1.5)
        m = ev.metrics(vy, preds, reasons, nearest)
        print(f"{k:2d} {md:6.1f} {m['accepted']/m['total']:6.3f} {m['accepted_accuracy']:11.3f} "
              f"{m['accuracy']:8.3f} {m['unknown_rate']:7.3f} {m['macro_f1']:7.3f}")

print("\nTEST CURVE for the same operating points (for reference; not used for tuning)")
for k, md in ((3, 50.6), (1, 80), (3, 65), (5, 65), (3, 60)):
    preds, reasons, nearest = ev.classify_batch(T, R, labels, k, md, 1.5)
    m = ev.metrics(ty, preds, reasons, nearest)
    print(f"k={k} maxDist={md}: accept={m['accepted']/m['total']:.3f} "
          f"acceptedAcc={m['accepted_accuracy']:.3f} acc={m['accuracy']:.3f} "
          f"unknown={m['unknown_rate']:.3f} macroF1={m['macro_f1']:.3f}")
