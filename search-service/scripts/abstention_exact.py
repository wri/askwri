"""Exact coverage SQL against every extraction, in a read-only transaction.

Run from the repo root via scripts/with-remote-env.sh qa, with PYTHONPATH set
to search-service. Unlike the catalog approximation this consults actual
titles, authors, summaries, tags and aliases. It makes no LLM calls.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import time


def evaluate_cases(cases, probe):
    out = {}
    for key, case in cases.items():
        samples = case.get("samples", [])
        if not samples or any(not isinstance(s, str) or not s.strip() for s in samples):
            raise ValueError(f"{key}: missing or blank extraction; refresh samples first")
        if case["polarity"] not in ("positive", "negative"):
            raise ValueError(f"{key}: unknown polarity")
        results = []
        for sample in dict.fromkeys(samples):
            start = time.monotonic()
            result = probe(sample)
            if result.get("present") is True and not result.get("matched_term"):
                raise ValueError(f"{key}: degraded check cannot be scored")
            results.append({"core_topic": sample, **result,
                            "elapsed_ms": round((time.monotonic() - start) * 1000, 2)})
        out[key] = {"polarity": case["polarity"], "results": results}
    return out


def compare_reports(before, after):
    if before["corpus_sha256"] != after["corpus_sha256"]:
        raise ValueError("corpus changed; capture a comparable baseline")
    if before["cases"].keys() != after["cases"].keys():
        raise ValueError("extractions changed: different cases")
    regressions = []
    for key, case in after["cases"].items():
        old_case = before["cases"][key]
        old = {r["core_topic"]: r["present"] for r in old_case["results"]}
        new = {r["core_topic"]: r["present"] for r in case["results"]}
        if old.keys() != new.keys() or old_case["polarity"] != case["polarity"]:
            raise ValueError(f"extractions changed: {key}")
        expected = case["polarity"] == "positive"
        regressions.extend(f"{key}: {t}" for t in new if old[t] == expected and new[t] != expected)
    return regressions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extractions", type=Path, default=Path(__file__).resolve().parents[2]
                        / "evaluation/extractions/core-topics.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--baseline", type=Path)
    args = parser.parse_args()

    import psycopg
    from app.main import match_core_topic

    extractions = json.loads(args.extractions.read_text())
    with psycopg.connect(os.environ["DATABASE_URL"], connect_timeout=10) as conn:
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        conn.execute("SET LOCAL statement_timeout = '10s'")
        # Fingerprint exactly the fields consulted by old and new policies.
        # Including ALL summary languages/kinds is conservative: a change to
        # any of them invalidates comparison instead of silently mixing data.
        surface = [conn.execute(sql).fetchall() for sql in (
            "SELECT id,title,title_en,authors,source_metadata->>'summary' FROM documents ORDER BY id",
            "SELECT document_id,language,kind,text FROM document_summaries ORDER BY document_id,language,kind",
            "SELECT id,value_id FROM tags ORDER BY id",
            "SELECT tag_id,alias FROM tag_aliases ORDER BY tag_id,alias",
        )]
        report = {
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "corpus_sha256": hashlib.sha256(json.dumps(surface, default=str, ensure_ascii=False).encode()).hexdigest(),
            "extractions_sha256": hashlib.sha256(args.extractions.read_bytes()).hexdigest(),
            "cases": evaluate_cases(extractions["cases"], lambda topic: match_core_topic(conn, topic)),
        }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")

    print("| Case | Polarity | Correct variants | Matched terms/surfaces |")
    print("|---|---|---|---|")
    for key, case in report["cases"].items():
        expected = case["polarity"] == "positive"
        correct = sum(r["present"] == expected for r in case["results"])
        matches = list(dict.fromkeys(
            f"{r['matched_term']} ({r['matched_surface']})" if r["present"] else "absent"
            for r in case["results"]
        ))
        print(f"| {key} | {case['polarity']} | {correct}/{len(case['results'])} | {'; '.join(matches)} |")
    for polarity in ("positive", "negative"):
        cases = [c for c in report["cases"].values() if c["polarity"] == polarity]
        correct = sum(all(r["present"] == (polarity == "positive") for r in c["results"]) for c in cases)
        print(f"{polarity}: all variants correct {correct}/{len(cases)}")
    if args.baseline:
        regressions = compare_reports(json.loads(args.baseline.read_text()), report)
        print(f"Regressions: {len(regressions)}")
        for regression in regressions:
            print(f"  {regression}")
        if regressions:
            return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        sys.exit(1)
