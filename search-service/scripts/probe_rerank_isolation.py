#!/usr/bin/env python
"""Rerank-isolation probe — the cheap gate for translation-prompt changes.

Plan: docs/superpowers/plans/2026-09-10-answer-translation-terminology-grounding.md §4.1.

The answer-mode translation workstream lives or dies on one measured fact
(2026-09-09): the same zh fact chunks score 0.70-0.79 under the shipped
machine translation but 0.83-0.95 under a corpus-terminology rendering —
the rerank's 15-chunk cut sits exactly between. This instrument scores a
fixed candidate batch of chunks under candidate query renderings via direct
Bedrock agent-runtime `rerank` calls (~$0.002 per call), so every prompt
variant is gated here before anything more expensive runs.

STANDALONE on purpose: it must never import app.* modules, and never loads
search-service/.env.local — that file's MinIO placeholder AWS keys leak into
boto3 and break Bedrock (runbook: docs/runbooks/local-testing.md creds
footgun). AWS creds come from the ambient SSO session (`aws login`);
DATABASE_URL comes from the environment (invoke via
`scripts/with-remote-env.sh qa search-service/venv/bin/python <this>`).

Read-only: RDS access is SELECT-only; the rerank API mutates nothing.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = REPO_ROOT / "evaluation/eval-review/evalsets/evalset_answer_02.json"
CAPTURE_PATH = REPO_ROOT / "evaluation/answer/artifacts/capture-baseline-noselection-20260909.json"
ARTIFACT_DIR = REPO_ROOT / "evaluation/answer/artifacts"

DEFAULT_CASE_ID = "q3_regional-vs-longhaul-adoption"
BATCH_CAP = 100  # one billed rerank query covers <=100 documents

RERANK_REGION = "us-east-1"
RERANK_MODEL_ID = "cohere.rerank-v3-5:0"
RERANK_ENDPOINT = f"https://bedrock-agent-runtime.{RERANK_REGION}.amazonaws.com"
RERANK_MODEL_ARN = (
    f"arn:aws:bedrock:{RERANK_REGION}::foundation-model/{RERANK_MODEL_ID}"
)

TRANSLATION_MODEL = "gpt-5-mini"

# Verbatim copy of query_translate._ANSWER_SYSTEM (shipped answer-mode
# translation prompt). Copied, not imported: this script must not touch app.*.
ANSWER_SYSTEM_PROMPT = (
    "You translate research questions for a retrieval system over transport, "
    "energy and climate policy publications. For each requested language, "
    "return TWO renderings: 'literal' (a faithful translation) and 'field' "
    "(rephrased the way a transport-energy policy researcher publishing in "
    "that language would put it \u2014 using that field's standard terminology for "
    "the concepts, e.g. the sector's usual term for the vehicle class and for "
    "market adoption). Return JSON mapping each language code to an object "
    "with 'literal' and 'field' keys. No commentary, no extra terms."
)

# Instrument-validation query only (plan §3 guardrail: corpus-derived
# vocabulary, no fact angles from the evalset). 新能源重卡 is the corpus's
# term for the vehicle class; 推广潜力 is phrased after the document's own
# title. Never iterate this text — that is tuning to the test.
ORACLE_ZH = "新能源重卡在区域运输场景与长途运输场景中的推广潜力有何差异？"

# Recorded 2026-09-09 table (plan §1). Validation reference for the q3
# isolation probe — the rebuilt instrument must reproduce it.
RECORDED_REFERENCE = {
    "2025_zero-emission-heavy-duty-trucks_00015_chunk_25": {
        "en": 0.718, "machine_zh": 0.749, "oracle_zh": 0.947},
    "2025_zero-emission-heavy-duty-trucks_00015_chunk_27": {
        "en": 0.466, "machine_zh": 0.654, "oracle_zh": 0.926},
    "2025_zero-emission-heavy-duty-trucks_00015_chunk_29": {
        "en": 0.624, "machine_zh": 0.610, "oracle_zh": 0.900},
    "2025_zero-emission-heavy-duty-trucks_00015_chunk_30": {
        "en": 0.461, "machine_zh": 0.548, "oracle_zh": 0.895},
    "2025_zero-emission-heavy-duty-trucks_00015_chunk_209": {
        "en": 0.108, "machine_zh": 0.198, "oracle_zh": 0.828},
}


# --- pure assembly -----------------------------------------------------------

def load_fixture_case(case_id):
    """(question, [expected_chunk_id, ...]) from the evalset fixture."""
    fixture = json.loads(FIXTURE_PATH.read_text())
    for case in fixture["test_cases"]:
        if case["id"] == case_id:
            passages = case["retrieval_ground_truth"]["expected_passages"]
            return case["question"], [p["chunk_id"] for p in passages]
    raise SystemExit(f"case id {case_id!r} not in fixture {FIXTURE_PATH}")


def load_capture_winners(case_id):
    """The baseline run's final-15 chunks (rank order) from the capture."""
    capture = json.loads(CAPTURE_PATH.read_text())
    for case in capture["cases"]:
        if case["case_id"] == case_id:
            chunks = case["passes"][0]["retrieval"]["chunks"]
            return [
                {"chunk_id": c["chunk_id"], "doc_id": c["doc_id"],
                 "text": c["text"], "rank": c["rank"]}
                for c in chunks
            ]
    raise SystemExit(f"case id {case_id!r} not in capture {CAPTURE_PATH}")


def build_batch(expected_ids, winners, cap=BATCH_CAP):
    """Expected chunks first (fixture order), then winners by rank; deduped
    by chunk_id; capped at `cap` (one billed rerank query). Pure."""
    batch, seen = [], set()

    def _add(chunk_id, source, doc_id, text, rank=None):
        if chunk_id in seen or len(batch) >= cap:
            return
        seen.add(chunk_id)
        batch.append({"chunk_id": chunk_id, "source": source,
                      "doc_id": doc_id, "text": text, "rank": rank})

    for chunk_id in expected_ids:
        _add(chunk_id, "expected", chunk_id.rsplit("_chunk_", 1)[0], None)
    for w in sorted(winners, key=lambda x: x["rank"]):
        _add(w["chunk_id"], "winner", w["doc_id"], w["text"], w["rank"])
    return batch


def orjoin_rendering(response_json):
    """'literal / field' from the translator's JSON (the
    translate_query_orjoined join rule: non-empty parts, ' / '-joined)."""
    try:
        data = json.loads(response_json)
    except json.JSONDecodeError:
        return None
    entry = data.get("zh") if isinstance(data, dict) else None
    if not isinstance(entry, dict):
        return None
    parts = [str(entry.get(k, "")).strip() for k in ("literal", "field")]
    parts = [p for p in parts if p]
    return " / ".join(parts) if parts else None


def validation_verdict(scores_by_query):
    """{query_label: {chunk_id: score}} -> per-column verdict rows.

    EN column is STRICT (every score within +/-0.02 of the recorded value AND
    the same descending order). machine-zh is a BAND SIGNATURE: >=3 of the 5
    recorded chunks in 0.55-0.80 AND none above 0.81 (the ~0.81 cut) — the
    recorded signature of the failure mode. The plan §1 table itself has
    fact_209's machine score at 0.198, so a literal all-five band would fail
    on the recorded data it validates against; the signature check is the
    faithful reading. The translator legitimately varies run to run.
    oracle-zh is DIRECTIONAL (every expected chunk >= 0.80). Pure.
    Returns (rows, all_pass).
    """
    ref_order = sorted(
        RECORDED_REFERENCE, key=lambda cid: -RECORDED_REFERENCE[cid]["en"])
    rows, all_pass = [], True
    for label, kind, tol in (("en", "strict", 0.02),
                             ("machine_zh", "band", None),
                             ("oracle_zh", "directional", None)):
        scores = scores_by_query.get(label, {})
        col = []
        for cid in ref_order:
            got, want = scores.get(cid), RECORDED_REFERENCE[cid][label]
            if kind == "strict":
                ok = got is not None and abs(got - want) <= tol
            elif kind == "band":
                ok = got is not None and 0.55 <= got <= 0.80
            else:
                ok = got is not None and got >= 0.80
            col.append(ok)
            rows.append({"query": label, "chunk_id": cid, "score": got,
                         "recorded": want, "criterion": kind, "ok": ok})
        if kind == "strict":
            achieved = sorted(
                ref_order,
                key=lambda c: -(scores.get(c)
                                if scores.get(c) is not None
                                else float("-inf")))
            col_ok = all(col) and achieved == ref_order
        elif kind == "band":
            got_vals = [scores.get(c) for c in ref_order]
            in_band = [v for v in got_vals if v is not None and 0.55 <= v <= 0.80]
            top = max((v for v in got_vals if v is not None), default=-1.0)
            col_ok = len(in_band) >= 3 and top <= 0.81
        else:
            col_ok = all(col)
        all_pass = all_pass and col_ok
        rows.append({"query": label, "chunk_id": None, "score": None,
                     "recorded": None, "criterion": kind,
                     "ok": col_ok, "_column": True})
    return rows, all_pass


# --- live side (lazy imports; never app.*) -----------------------------------

def _openai_api_key():
    """Process env first; else root .env (never search-service/.env.local,
    never printed)."""
    key = os.environ.get("OPENAI_API_KEY")
    if key:
        return key
    env_file = REPO_ROOT / ".env"
    for line in env_file.read_text().splitlines():
        if line.startswith("OPENAI_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("OPENAI_API_KEY not in env or root .env")


def translate_orjoined(question, api_key=None):
    """One OpenAI call with the shipped _ANSWER_SYSTEM prompt; returns the
    OR-joined 'literal / field' rendering (translate_query_orjoined's rule)."""
    from openai import OpenAI

    client = OpenAI(api_key=api_key or _openai_api_key(), timeout=60.0,
                    max_retries=0)  # probe-side budget; not the request path
    resp = client.chat.completions.create(
        model=TRANSLATION_MODEL,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": ANSWER_SYSTEM_PROMPT},
            {"role": "user",
             "content": f"Languages: zh (Simplified Chinese)\nQuery: {question}"},
        ],
    )
    rendered = orjoin_rendering(resp.choices[0].message.content or "")
    if not rendered:
        raise SystemExit("machine translation returned no usable rendering")
    return rendered


def fetch_chunk_texts(database_url, chunk_ids):
    """{chunk_id: text} for the given legacy_chunk_ids. SELECT-only; a
    missing id is a hard error — the batch must not silently shrink."""
    import psycopg

    sslmode = os.environ.get("PGSSLMODE") or "require"
    with psycopg.connect(database_url, sslmode=sslmode) as conn:
        rows = conn.execute(
            "SELECT dc.legacy_chunk_id, dc.text "
            "FROM document_chunks dc "
            "JOIN documents d ON d.id = dc.document_id "
            "WHERE d.status = 'searchable' "
            "AND dc.legacy_chunk_id = ANY(%(ids)s)",
            {"ids": list(chunk_ids)},
        ).fetchall()
    found = {legacy_id: text for legacy_id, text in rows}
    missing = [cid for cid in chunk_ids if cid not in found]
    if missing:
        raise SystemExit(f"chunks missing from QA RDS: {missing}")
    return found


def rerank_scores(query, batch, client=None):
    """{chunk_id: relevance score} for one query over the batch — one
    bedrock-agent-runtime rerank call, mirroring
    app/bedrock_rerank.py::score_documents' request shape."""
    if client is None:
        import boto3
        client = boto3.client(
            "bedrock-agent-runtime", region_name=RERANK_REGION,
            endpoint_url=RERANK_ENDPOINT)
    response = client.rerank(
        queries=[{"type": "TEXT", "textQuery": {"text": query}}],
        sources=[
            {"type": "INLINE",
             "inlineDocumentSource": {
                 "type": "TEXT",
                 "textDocument": {"text": chunk["text"]},
             }}
            for chunk in batch
        ],
        rerankingConfiguration={
            "type": "BEDROCK_RERANKING_MODEL",
            "bedrockRerankingConfiguration": {
                "modelConfiguration": {"modelArn": RERANK_MODEL_ARN},
                "numberOfResults": len(batch),
            },
        },
    )
    return {batch[r["index"]]["chunk_id"]: float(r["relevanceScore"])
            for r in response["results"]}


# --- reporting ---------------------------------------------------------------

def print_report(queries, batch, scores_by_query, rows, all_pass,
                 gated=True):
    if not gated:
        print(f"batch: {len(batch)} sources")
        for label, scores in scores_by_query.items():
            top = sorted(scores.items(), key=lambda kv: -kv[1])[:10]
            print(f"\n{label}: top-10")
            for cid, score in top:
                print(f"  {score:.3f}  {cid}")
        return
    expected_in_batch = [c["chunk_id"] for c in batch if c["source"] == "expected"]
    ref_order = sorted(
        RECORDED_REFERENCE, key=lambda cid: -RECORDED_REFERENCE[cid]["en"])
    labels = {cid: f"chunk_{cid.rsplit('_chunk_', 1)[1]}"
              for cid in ref_order}
    header = "chunk".ljust(12) + "".join(
        q.ljust(14) for q in scores_by_query) + "recorded(en/mach/oracle)"
    print("\n=== expected chunks under each query ===")
    print(header)
    for cid in ref_order:
        line = labels[cid].ljust(12)
        for q in scores_by_query:
            line += f"{scores_by_query[q].get(cid, float('nan')):.3f}".ljust(14)
        ref = RECORDED_REFERENCE[cid]
        line += f"{ref['en']:.3f} / {ref['machine_zh']:.3f} / {ref['oracle_zh']:.3f}"
        print(line)
    print("\n=== validation verdicts ===")
    for row in rows:
        if row.get("_column"):
            print(f"[{'PASS' if row['ok'] else 'FAIL'}] column {row['query']} ({row['criterion']})")
        else:
            got = "n/a" if row["score"] is None else f"{row['score']:.3f}"
            print(f"  {row['query']:<10} {labels.get(row['chunk_id'], row['chunk_id']):<12} "
                  f"got {got} vs recorded {row['recorded']}")
    print(f"\nbatch: {len(batch)} sources "
          f"({sum(1 for c in batch if c['source'] == 'expected')} expected, "
          f"{sum(1 for c in batch if c['source'] == 'winner')} winners)")
    print(f"expected chunks covered: {len(expected_in_batch)}")
    print(f"VALIDATION {'PASSED' if all_pass else 'FAILED'}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case-id", default=DEFAULT_CASE_ID)
    parser.add_argument("--label", default=datetime.now(timezone.utc).strftime("%Y%m%d"))
    parser.add_argument("--dry-run", action="store_true",
                        help="print batch + queries, make no AWS/OpenAI calls")
    parser.add_argument("--queries-json", default=None,
                        help="JSON {label: query_text} — explicit queries to "
                             "score (prompt-variant iteration); skips the "
                             "standard three and the validation gate")
    args = parser.parse_args(argv)

    question, expected_ids = load_fixture_case(args.case_id)
    winners = load_capture_winners(args.case_id)
    batch = build_batch(expected_ids, winners)

    if args.queries_json:
        queries = json.loads(args.queries_json)
    else:
        queries = {"en": question, "machine_zh": None, "oracle_zh": ORACLE_ZH}

    if args.dry_run:
        print(f"case: {args.case_id}")
        print(f"question: {question}")
        print(f"expected chunks: {expected_ids}")
        print(f"batch ({len(batch)}):")
        for c in batch:
            text_len = len(c["text"]) if c["text"] else "NEEDS_RDS"
            print(f"  {'E' if c['source'] == 'expected' else 'W'} "
                  f"rank={c['rank']} {c['chunk_id']} len={text_len}")
        for label, text in queries.items():
            shown = text if text else (
                "<OpenAI call: shipped _ANSWER_SYSTEM, gpt-5-mini>" if label == "machine_zh"
                else text)
            print(f"query[{label}]: {shown}")
        return 0

    # expected chunks' texts come from QA RDS (winners carry theirs in the
    # capture); a missing chunk aborts — the batch must not silently shrink
    missing = [c["chunk_id"] for c in batch if not c["text"]]
    if missing:
        database_url = os.environ.get("DATABASE_URL")
        if not database_url:
            raise SystemExit("DATABASE_URL not set — invoke via "
                             "scripts/with-remote-env.sh qa <cmd>")
        texts = fetch_chunk_texts(database_url, missing)
        for chunk in batch:
            if chunk["text"] is None:
                chunk["text"] = texts[chunk["chunk_id"]]

    if queries.get("machine_zh") is None and not args.queries_json:
        queries["machine_zh"] = translate_orjoined(question)

    scores_by_query = {}
    for label, text in queries.items():
        if not text:
            raise SystemExit(f"query {label!r} is empty")
        scores_by_query[label] = rerank_scores(text, batch)

    gated = not args.queries_json
    rows, all_pass = validation_verdict(scores_by_query) if gated else ([], True)
    print_report(queries, batch, scores_by_query, rows, all_pass, gated=gated)

    artifact = {
        "probe": "rerank-isolation",
        "case_id": args.case_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "batch": [{"chunk_id": c["chunk_id"], "source": c["source"],
                   "doc_id": c["doc_id"],
                   "text_chars": len(c["text"] or "")} for c in batch],
        "queries": queries,
        "scores": scores_by_query,
        "recorded_reference": RECORDED_REFERENCE,
    }
    if rows:
        artifact["validation"] = {"rows": rows, "passed": all_pass}
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    out = ARTIFACT_DIR / f"probe-isolation-{args.label}.json"
    out.write_text(json.dumps(artifact, ensure_ascii=False, indent=2))
    print(f"artifact: {out}")

    if gated and not all_pass:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
