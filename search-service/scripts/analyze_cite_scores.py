"""Analyze a capture_cite_scores.py output: distributions, floor sweep, tiers.

Prints:
- relevant vs irrelevant raw-score distributions (golden EN + smoke per lang)
- coarse + fine floor sweeps (macro-averaged P/R/F1 over the golden set)
- tier-band precision (what fraction of docs in each score band is relevant)
- per-query relevant-doc score lists and smoke top-target scores

Usage:
    ./venv/bin/python -m scripts.analyze_cite_scores [capture.json]

The floor/tier values in app/config.py were derived from this output on
2026-07-22 (floor 0.08 = macro-F1 peak; tiers 0.30/0.70 matched the band
precision steps ~15%/~40%/~65%). Re-derive after candidate-pool changes.
"""
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CAP = Path(sys.argv[1]) if len(sys.argv) > 1 else (
    REPO_ROOT / "evaluation" / "results" / "cite-score-capture.json")
cap = json.load(open(CAP))


def dist(scores):
    if not scores:
        return "n=0"
    s = sorted(scores)
    n = len(s)
    q = lambda p: s[min(n - 1, int(p * n))]
    return (f"n={n} min={s[0]:.4f} p10={q(.1):.4f} p25={q(.25):.4f} "
            f"med={q(.5):.4f} p75={q(.75):.4f} p90={q(.9):.4f} max={s[-1]:.4f}")


def sweep(floors):
    for floor in floors:
        ps, rs = [], []
        for g in cap["golden"]:
            kept = [d for d in g["docs"] if (d["raw_score"] or 0) >= floor]
            tp = sum(1 for d in kept if d["relevant"])
            n_exp = len(set(g["expected_slugs"]))
            ps.append(tp / len(kept) if kept else 0.0)
            rs.append(tp / n_exp if n_exp else 0.0)
        p, r = sum(ps) / len(ps), sum(rs) / len(rs)
        f1 = 2 * p * r / (p + r) if p + r else 0.0
        print(f"  floor={floor:<6} P={p * 100:5.1f} R={r * 100:5.1f} F1={f1 * 100:5.1f}")


rel = [d["raw_score"] for g in cap["golden"] for d in g["docs"] if d["relevant"]]
irr = [d["raw_score"] for g in cap["golden"] for d in g["docs"] if not d["relevant"]]
print("GOLDEN (English cite):")
print(f"  relevant   {dist(rel)}")
print(f"  irrelevant {dist(irr)}")

langs = sorted({s["language"] for s in cap["smoke"]})
for lang in langs:
    srel = [d["raw_score"] for s in cap["smoke"] if s["language"] == lang
            for d in s["docs"] if d["relevant"]]
    sirr = [d["raw_score"] for s in cap["smoke"] if s["language"] == lang
            for d in s["docs"] if not d["relevant"]]
    print(f"SMOKE {lang}: relevant {dist(srel)}")
    print(f"          irrelevant {dist(sirr)}")

print("\nCoarse floor sweep (golden, macro-averaged):")
sweep((0.0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5))
print("\nFine floor sweep:")
sweep((0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.12, 0.15))

rows = [d for g in cap["golden"] for d in g["docs"]]
smoke_rows = [d for s in cap["smoke"] for d in s["docs"]]
print("\nBand precision (golden EN / smoke non-EN):")
bands = [(0.0, 0.05), (0.05, 0.1), (0.1, 0.2), (0.2, 0.3), (0.3, 0.4),
         (0.4, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 1.01)]
for lo, hi in bands:
    g_in = [d for d in rows if lo <= (d["raw_score"] or 0) < hi]
    s_in = [d for d in smoke_rows if lo <= (d["raw_score"] or 0) < hi]
    gp = (sum(d["relevant"] for d in g_in) / len(g_in) * 100) if g_in else float("nan")
    sp = (sum(d["relevant"] for d in s_in) / len(s_in) * 100) if s_in else float("nan")
    print(f"  [{lo:.2f},{hi:.2f})  golden n={len(g_in):3d} P={gp:5.1f}%   "
          f"smoke n={len(s_in):3d} P={sp:5.1f}%")

print("\nPer-query relevant-doc scores (golden):")
for g in cap["golden"]:
    scores = sorted((d["raw_score"] for d in g["docs"] if d["relevant"]), reverse=True)
    print(f"  {g['id']:<35} {[round(x, 4) for x in scores]}  "
          f"missing={len(g['missing_from_candidates'])}")

print("\nSmoke per-query TOP target score:")
for s in cap["smoke"]:
    tops = max((d["raw_score"] for d in s["docs"] if d["relevant"]), default=None)
    print(f"  {s['id']} ({s['language']}): {tops:.4f}" if tops is not None
          else f"  {s['id']}: TARGET MISSING")
