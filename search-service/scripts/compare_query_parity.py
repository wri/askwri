#!/usr/bin/env python3
"""Compare /query output between two running service instances (legacy vs postgres).

Usage:
  ./venv/bin/python -m scripts.compare_query_parity \
      --legacy http://127.0.0.1:8000 --candidate http://127.0.0.1:8001

Reads the cite golden-set questions and reports top-N doc_id agreement.
Exit code 1 if mean overlap < 0.95 or any rank-1 result differs.
"""
import argparse
import json
import sys
from pathlib import Path

import httpx

GOLDEN = Path(__file__).resolve().parents[2] / "evaluation" / "golden-dataset.json"
PARAMS = {"mode": "cite", "vector_top_k": 800, "bm25_top_k": 800,
          "rerank_top_n": 250, "max_results": 100}
TOP_N = 20


def top_doc_ids(base_url: str, query: str):
    resp = httpx.post(f"{base_url}/query", json={"query": query, **PARAMS}, timeout=300)
    resp.raise_for_status()
    return [d["doc_id"] for d in resp.json()["docs"][:TOP_N]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--legacy", required=True)
    ap.add_argument("--candidate", required=True)
    args = ap.parse_args()

    cases = json.loads(GOLDEN.read_text())["test_cases"]
    overlaps, rank1_mismatches = [], []
    for case in cases:
        q = case["question"]
        a, b = top_doc_ids(args.legacy, q), top_doc_ids(args.candidate, q)
        inter = len(set(a) & set(b))
        denom = max(len(a), len(b)) or 1
        overlap = inter / denom
        overlaps.append(overlap)
        flag = ""
        if a and b and a[0] != b[0]:
            rank1_mismatches.append(case["id"])
            flag = "  RANK1-MISMATCH"
        print(f"{case['id']:<40} top{TOP_N} overlap {overlap:.2f}{flag}")
        if overlap < 1.0:
            print(f"   only-legacy:    {sorted(set(a) - set(b))}")
            print(f"   only-candidate: {sorted(set(b) - set(a))}")

    mean = sum(overlaps) / len(overlaps)
    print(f"\nMean top-{TOP_N} overlap: {mean:.3f}; rank-1 mismatches: {rank1_mismatches or 'none'}")
    if mean < 0.95 or rank1_mismatches:
        sys.exit(1)


if __name__ == "__main__":
    main()
