"""Score parse-fixture outputs against the pypdf baseline (Phase 0 §5.2).

Automatic metrics per doc, per candidate vs parse-fixture-pypdf.json:
  chars_per_page   — len(full_text) / pages_expected
  length_ratio     — candidate chars / pypdf chars
  num_recall       — fraction of pypdf's numeric tokens present in candidate
                     (order-insensitive multiset recall; the anti-hallucination
                     / anti-omission signal that matters most for WRI data docs)
  num_extra        — numeric tokens in candidate absent from pypdf (potential
                     hallucination OR recovered content pypdf missed — inspect)
  wall_ms          — parse latency

Manual metrics (§5.2: table recovery, reading order, reference detection)
are scored by inspecting the saved full_text/markdown per doc.

Run: ./venv/bin/python -m scripts.score_parse_fixture [backend ...]
(default: every parse-fixture-*.json present except pypdf)
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RESULTS = REPO_ROOT / "evaluation" / "results"

_NUM = re.compile(r"\d[\d,.]*")


def _numbers(text: str) -> Counter:
    # normalize thousands separators so "1,234" == "1234"
    return Counter(t.replace(",", "").rstrip(".") for t in _NUM.findall(text))


def main():
    base = json.load(open(RESULTS / "parse-fixture-pypdf.json"))
    oracle = {r["external_id"]: r for r in base["results"] if "error" not in r}

    backends = sys.argv[1:] or sorted(
        p.stem.replace("parse-fixture-", "")
        for p in RESULTS.glob("parse-fixture-*.json")
        if p.stem != "parse-fixture-pypdf")

    for backend in backends:
        path = RESULTS / f"parse-fixture-{backend}.json"
        if not path.exists():
            print(f"== {backend}: no results file, skipping")
            continue
        cand = json.load(open(path))
        print(f"\n== {backend} vs pypdf ==")
        print(f"{'doc':<52} {'lang':<4} {'ch/pg':>6} {'ratio':>6} "
              f"{'numR':>6} {'numX':>6} {'ms':>7}")
        for r in cand["results"]:
            eid = r["external_id"]
            if "error" in r:
                print(f"{eid:<52} ERROR {r['error'][:60]}")
                continue
            o = oracle.get(eid)
            cpp = r["chars"] / max(r["pages_expected"], 1)
            ratio = r["chars"] / max(o["chars"], 1) if o else float("nan")
            if o:
                on, cn = _numbers(o["full_text"]), _numbers(r["full_text"])
                total = sum(on.values())
                hit = sum(min(on[t], cn.get(t, 0)) for t in on)
                num_recall = hit / total if total else float("nan")
                extra = sum(cn.values()) - sum(min(cn[t], on.get(t, 0))
                                               for t in cn)
            else:
                num_recall, extra = float("nan"), 0
            print(f"{eid:<52} {r['language']:<4} {cpp:>6.0f} {ratio:>6.2f} "
                  f"{num_recall:>6.1%} {extra:>6d} {r['wall_ms']:>7d}")


if __name__ == "__main__":
    main()
