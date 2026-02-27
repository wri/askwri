#!/usr/bin/env python3
"""
AskWRI Answer Mode Synthesis Evaluation

Uses RAGAS to evaluate answer quality (faithfulness, relevancy, correctness).

Two modes:
  --mode isolated      Feed golden passages to answer API, evaluate with RAGAS
  --mode end-to-end    Actual retrieval -> answer API -> evaluate with RAGAS

Usage:
  python evaluation/run-answer-synthesis-eval.py --mode isolated
  python evaluation/run-answer-synthesis-eval.py --mode end-to-end
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from datetime import datetime

import requests

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent / "lib"))
from ragas_adapter import load_golden_dataset, to_ragas_dataset, golden_passages_as_contexts

NEXTJS_URL = os.environ.get("NEXTJS_SERVER_URL", "http://localhost:3000")
PYTHON_URL = os.environ.get("LLAMAINDEX_SERVICE_URL", "http://127.0.0.1:8002")


def check_services(mode: str) -> bool:
    """Verify required services are running."""
    # Always need Next.js for /api/answer
    try:
        r = requests.get(f"{NEXTJS_URL}/api/llamaindex", timeout=5)
        if not r.ok:
            print(f"ERROR: Next.js returned status {r.status_code} at {NEXTJS_URL}")
            return False
    except Exception:
        print(f"ERROR: Next.js not available at {NEXTJS_URL}")
        return False

    if mode == "end-to-end":
        try:
            r = requests.get(f"{PYTHON_URL}/health", timeout=5)
            data = r.json()
            if not (data.get("status") == "healthy" or data.get("ok")):
                raise Exception("unhealthy")
        except Exception:
            print(f"ERROR: Python service not available at {PYTHON_URL}")
            return False

    return True


def call_answer_api(query: str, docs: list[dict]) -> str:
    """Call the /api/answer endpoint and return the synthesized answer string."""
    r = requests.post(
        f"{NEXTJS_URL}/api/answer",
        json={"query": query, "docs": docs},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    sentences = data.get("synthesis", {}).get("sentences", [])
    return " ".join(sentences)


def retrieve_passages(query: str) -> list[dict]:
    """Call hybrid service in answer mode, return docs formatted for answer API."""
    r = requests.post(
        f"{PYTHON_URL}/query",
        json={
            "query": query,
            "mode": "answer",
            "max_results": 100,
            "rerank": True,
            "vector_top_k": 150,
            "bm25_top_k": 150,
            "rerank_top_n": 20,
        },
        timeout=60,
    )
    r.raise_for_status()
    data = r.json()

    # Transform to DocMeta-like format expected by /api/answer
    docs = []
    for doc in data.get("docs", []):
        score = doc.get("score", 0)
        docs.append({
            "doc_id": doc["doc_id"],
            "title": doc.get("title", "Untitled"),
            "score": score,
            "kps": [{
                "kp_relevance": score,
                "snippet": doc.get("content", ""),
                "page": doc.get("page", 1),
                "passage_id": doc.get("chunk_id", doc["doc_id"]),
                "citation_targets": [{
                    "score": score,
                    "page": doc.get("page", 1),
                    "passage_id": doc.get("chunk_id", doc["doc_id"]),
                }],
            }],
        })
    return docs


def golden_to_docs(golden: dict, test_case_id: str) -> list[dict]:
    """Convert golden passages to DocMeta-like format for isolated mode."""
    tc = next(tc for tc in golden["test_cases"] if tc["id"] == test_case_id)
    docs = []
    for p in tc["retrieval_ground_truth"]["expected_passages"]:
        docs.append({
            "doc_id": p["doc_id"],
            "title": f"Document {p['doc_id']}",
            "score": 1.0,
            "kps": [{
                "kp_relevance": 1.0,
                "snippet": p["text_snippet"],
                "page": p.get("page", 1),
                "passage_id": p["chunk_id"],
                "citation_targets": [{
                    "score": 1.0,
                    "page": p.get("page", 1),
                    "passage_id": p["chunk_id"],
                }],
            }],
        })
    return docs


def run_eval(mode: str):
    golden = load_golden_dataset()
    test_cases = golden["test_cases"]
    print(f"Loaded {len(test_cases)} test cases (status: {golden.get('metadata', {}).get('status', 'unknown')})")

    generated_answers: dict[str, str] = {}
    contexts_map: dict[str, list[str]] = {}
    results_detail: list[dict] = []

    for tc in test_cases:
        tc_id = tc["id"]
        print(f"\nProcessing: {tc_id}")
        print(f"  Question: {tc['question'][:80]}...")
        start = time.time()

        if mode == "isolated":
            docs = golden_to_docs(golden, tc_id)
            context_texts = [
                p["text_snippet"]
                for p in tc["retrieval_ground_truth"]["expected_passages"]
                if p.get("text_snippet")
            ]
        else:  # end-to-end
            docs = retrieve_passages(tc["question"])
            context_texts = [
                d["kps"][0]["snippet"]
                for d in docs
                if d.get("kps") and d["kps"][0].get("snippet")
            ]

        if not docs:
            print(f"  WARNING: No documents for {tc_id}, skipping")
            continue

        answer = call_answer_api(tc["question"], docs)
        elapsed = time.time() - start

        generated_answers[tc_id] = answer
        contexts_map[tc_id] = context_texts

        # Key facts coverage check (simple substring matching)
        key_facts = tc["synthesis_ground_truth"].get("key_facts", [])
        answer_lower = answer.lower()
        covered = [f for f in key_facts if f.lower() in answer_lower]
        missed = [f for f in key_facts if f.lower() not in answer_lower]

        results_detail.append({
            "test_case_id": tc_id,
            "question": tc["question"],
            "generated_answer": answer,
            "canonical_answer": tc["synthesis_ground_truth"]["canonical_answer"],
            "key_facts_covered": covered,
            "key_facts_missed": missed,
            "key_facts_coverage": len(covered) / len(key_facts) if key_facts else 1.0,
            "execution_time_ms": int(elapsed * 1000),
            "mode": mode,
        })

        print(f"  Answer: {answer[:120]}...")
        print(f"  Key facts: {len(covered)}/{len(key_facts)} covered ({elapsed:.1f}s)")
        time.sleep(1)  # rate limit

    # Run RAGAS evaluation
    if generated_answers:
        print("\nRunning RAGAS evaluation...")
        try:
            from ragas import evaluate
            from ragas.metrics import faithfulness, answer_relevancy, answer_correctness

            dataset = to_ragas_dataset(golden, generated_answers, contexts_map)
            ragas_results = evaluate(
                dataset,
                metrics=[faithfulness, answer_relevancy, answer_correctness],
            )

            # Merge RAGAS scores into detail results
            ragas_df = ragas_results.to_pandas()
            for i, row in ragas_df.iterrows():
                if i < len(results_detail):
                    results_detail[i]["faithfulness"] = float(row.get("faithfulness", 0))
                    results_detail[i]["answer_relevancy"] = float(row.get("answer_relevancy", 0))
                    results_detail[i]["answer_correctness"] = float(row.get("answer_correctness", 0))

            print("RAGAS evaluation complete")
        except ImportError:
            print("WARNING: RAGAS not installed. Install with: pip install -r evaluation/requirements-eval.txt")
            print("Skipping RAGAS metrics (key facts coverage still calculated)")
        except Exception as e:
            print(f"WARNING: RAGAS evaluation failed: {e}")
            print("Skipping RAGAS metrics (key facts coverage still calculated)")

    # Build report
    n = max(len(results_detail), 1)
    report = {
        "timestamp": datetime.now().isoformat(),
        "mode": mode,
        "test_cases_total": len(results_detail),
        "results": results_detail,
        "aggregate": {
            "avg_faithfulness": sum(r.get("faithfulness", 0) for r in results_detail) / n,
            "avg_answer_relevancy": sum(r.get("answer_relevancy", 0) for r in results_detail) / n,
            "avg_answer_correctness": sum(r.get("answer_correctness", 0) for r in results_detail) / n,
            "avg_key_facts_coverage": sum(r.get("key_facts_coverage", 0) for r in results_detail) / n,
        },
    }

    # Save report
    results_dir = Path(__file__).parent / "results"
    results_dir.mkdir(exist_ok=True)
    report_path = results_dir / f"answer-synthesis-{mode}-{int(time.time() * 1000)}.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)

    # Print summary
    print("\n" + "=" * 70)
    print(f"ANSWER MODE SYNTHESIS EVALUATION SUMMARY (mode: {mode})")
    print("=" * 70)
    agg = report["aggregate"]
    print(f"  Test cases:         {len(results_detail)}")
    print(f"  Faithfulness:       {agg['avg_faithfulness']:.1%}")
    print(f"  Answer Relevancy:   {agg['avg_answer_relevancy']:.1%}")
    print(f"  Answer Correctness: {agg['avg_answer_correctness']:.1%}")
    print(f"  Key Facts Coverage: {agg['avg_key_facts_coverage']:.1%}")
    print(f"\nReport saved: {report_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AskWRI Answer Synthesis Evaluation")
    parser.add_argument(
        "--mode",
        choices=["isolated", "end-to-end"],
        default="isolated",
        help="isolated: golden passages -> synthesis. end-to-end: retrieval -> synthesis",
    )
    args = parser.parse_args()

    if not check_services(args.mode):
        sys.exit(1)

    run_eval(args.mode)
