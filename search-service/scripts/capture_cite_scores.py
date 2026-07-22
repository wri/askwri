"""Capture raw rerank score distributions for cite-mode threshold derivation.

Replays the 11 cite golden-set queries and 16 non-English smoke queries
against /query (cite mode, rerank=true) and records every returned doc's
raw rerank score (metadata.raw_score) plus relevance labels.

Run with the service's CITE_LOGIT_FLOOR=0.0 (env override) so sub-floor
scores actually come back — otherwise the distribution is truncated at the
current floor and the sweep in analyze_cite_scores.py is meaningless.

Usage (service running on :8000 with Bedrock creds + floor zeroed):
    ./venv/bin/python -m scripts.capture_cite_scores [out.json]

Derivation history: first used 2026-07-22 to derive cite_logit_floor=0.08
and validate the per-doc candidate cap (see config.py comments). Re-run
after anything that shifts the candidate pool (embedding model cutover,
fusion-lane changes) or when the golden set is redone.
"""
import json
import re
import sys
import time
from pathlib import Path

import requests

BASE = "http://127.0.0.1:8000"
REPO_ROOT = Path(__file__).resolve().parents[2]
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else (
    REPO_ROOT / "evaluation" / "results" / "cite-score-capture.json")


def slug(url: str) -> str:
    """Mirror evaluation/lib/metrics.ts extractUrlSlug."""
    if not url:
        return ""
    s = url.lower()
    s = re.sub(r"^https?://", "", s)
    s = re.sub(r"^www\.", "", s)
    parts = [p for p in s.split("/") if p]
    last = parts[-1] if parts else ""
    last = last.split("?")[0]
    last = re.sub(r"\.(pdf|docx?|html?)$", "", last, flags=re.I)
    last = re.sub(r"[^a-z0-9\-]", "", last)
    return last.strip("_")


def query(q: str) -> list:
    r = requests.post(f"{BASE}/query", json={
        "query": q,
        "mode": "cite",
        "max_results": 200,
        "similarity_threshold": 0.0,
        "include_metadata": True,
        "rerank": True,
        "vector_top_k": 800,
        "bm25_top_k": 800,
        "rerank_top_n": 500,
    }, timeout=600)
    r.raise_for_status()
    return r.json().get("docs", [])


def main():
    golden = json.load(open(REPO_ROOT / "evaluation" / "golden-dataset.json"))
    smoke = json.load(open(REPO_ROOT / "evaluation" / "non-english-smoke.json"))

    capture = {"golden": [], "smoke": []}

    for tc in golden["test_cases"]:
        full_query = f"{tc['question']}\n\nTask: {tc['task_description']}"
        t0 = time.time()
        docs = query(full_query)
        expected_slugs = [slug(u) for u in tc["expected_urls"]]
        rows = []
        for d in docs:
            u = (d.get("metadata") or {}).get("url") or ""
            rows.append({
                "doc_id": d["doc_id"],
                "slug": slug(u),
                "raw_score": (d.get("metadata") or {}).get("raw_score"),
                "relevant": slug(u) in expected_slugs,
            })
        found = {r["slug"] for r in rows if r["relevant"]}
        capture["golden"].append({
            "id": tc["id"],
            "expected_slugs": expected_slugs,
            "n_docs": len(rows),
            "missing_from_candidates": [s for s in expected_slugs if s not in found],
            "latency_ms": int((time.time() - t0) * 1000),
            "docs": rows,
        })
        print(f"{tc['id']}: {len(rows)} docs, "
              f"{len(found)}/{len(set(expected_slugs))} expected present", flush=True)

    for sq in smoke["queries"]:
        t0 = time.time()
        docs = query(sq["query"])
        rows = [{
            "doc_id": d["doc_id"],
            "raw_score": (d.get("metadata") or {}).get("raw_score"),
            "relevant": d["doc_id"] in sq["target_doc_ids"],
        } for d in docs]
        capture["smoke"].append({
            "id": sq["id"],
            "language": sq["language"],
            "n_docs": len(rows),
            "target_present": any(r["relevant"] for r in rows),
            "latency_ms": int((time.time() - t0) * 1000),
            "docs": rows,
        })
        print(f"{sq['id']} ({sq['language']}): {len(rows)} docs, "
              f"target_present={any(r['relevant'] for r in rows)}", flush=True)

    json.dump(capture, open(OUT, "w"))
    print(f"saved {OUT}")


if __name__ == "__main__":
    main()
