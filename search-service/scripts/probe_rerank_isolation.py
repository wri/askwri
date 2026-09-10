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

`--pool-realistic` (2026-09-10, fix round 1 of task 3): the default 20-source batch
(expected chunks ∪ baseline final-15) flattered the zh lift — it validated byte-exact
against the 2026-09-09 recorded table, but Cohere scores are batch-relative: in a
realistic ~240-source pool (the product's seed-200 under the zh OR-join ∪ standard-100
under the EN question) the top-15 boundary sits at 0.83–0.90 and the zh fact chunks land
AT it, not above it — which is exactly what the corrected mirror runs then measured
(q3 1–2/5, not 4–5/5). This mode reconstructs that pool (doc-scoped dense top-200 under
the OR-join + top-100 under the EN question, texts from QA RDS), reranks it per query,
max-merges each map with the EN map, and predicts the final 15 (rerank_top_n=20 →
max_results=15) — reproducing the corrected mirror results. Gate prompt variants HERE,
not on the default batch: the default batch's absolute scores do not transfer to the
real pipeline.

Batching: the pool is sent to the rerank API as ONE call with all ~240 sources
(numberOfResults=len(pool)) — the 2026-09-10 pool-probe run that reproduced the
mirror runs did exactly this, and the pipeline's own score_documents sends the
~300-source candidate set in one call the same way. The "one billed query covers
≤100 documents" note in app/bedrock_rerank.py is about billing granularity, not a
request-size limit; no pagination here.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# --- pool-realistic mode constants (product-shape mirrors) --------------------
EMBED_REGION = "us-east-1"          # app/config.py bedrock_embed_region
EMBED_MODEL_ID = "cohere.embed-v4:0"  # app/config.py bedrock_embed_model_id
EMBED_DIM = 1536                    # app/config.py EMBEDDING_DIMENSIONS[cohere-embed-v4]
SEED_K = 200                        # answer_translation_seed_k default
EN_SEED_K = 100                     # standard candidates = rerank_candidates default
RERANK_TOP_N = 20                   # ANSWER_PRESET.rerankTopN
MAX_RESULTS = 15                    # ANSWER_PRESET.maxResults
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


# --- pool-realistic mode ------------------------------------------------------

def _embed_query(text, client=None):
    """Query embedding via bedrock-runtime InvokeModel (cohere.embed-v4,
    input_type=search_query) — replicates app/bedrock_embed.py::_invoke's
    request shape without importing app.* (standalone rule above)."""
    if not text or not text.strip():
        raise ValueError(
            "refusing to embed an empty query string — upstream produced an "
            "empty translation draw; fix the caller, not this")
    if client is None:
        import boto3
        client = boto3.client(
            "bedrock-runtime", region_name=EMBED_REGION,
            endpoint_url=f"https://bedrock-runtime.{EMBED_REGION}.amazonaws.com")
    body = json.dumps({"texts": [text], "input_type": "search_query",
                       "truncate": "END", "embedding_types": ["float"]})
    response = client.invoke_model(modelId=EMBED_MODEL_ID, body=body)
    # embeddings["float"] is List[List[float]] (one vector per input text —
    # app/bedrock_embed._invoke's shape); a single-text request indexes [0].
    return json.loads(response["body"].read())["embeddings"]["float"][0]


def dense_doc_top(database_url, query_text, doc_ids, k):
    """[chunk_id,...] — the doc-scoped dense top-k (pg_store's seed SQL shape)
    with the query vector passed as a bracket string + explicit cast (the
    instrument has no pgvector adapter registered)."""
    import psycopg

    qvec = _embed_query(query_text)
    qstr = "[" + ",".join(f"{v:.9g}" for v in qvec) + "]"
    sslmode = os.environ.get("PGSSLMODE") or "require"
    with psycopg.connect(database_url, sslmode=sslmode) as conn:
        rows = conn.execute(
            "SELECT dc.legacy_chunk_id "
            "FROM document_chunks dc "
            "JOIN documents d ON d.id = dc.document_id "
            "WHERE d.status = 'searchable' "
            "AND dc.embedding_model = 'cohere-embed-v4' "
            "AND d.external_id = ANY(%(doc_ids)s) "
            f"ORDER BY dc.embedding::vector({EMBED_DIM}) <=> %(q)s::vector "
            "LIMIT %(k)s",
            {"doc_ids": list(doc_ids), "q": qstr, "k": k},
        ).fetchall()
    return [r[0] for r in rows]


def build_pool(seed_ids, en_ids):
    """Seed-lane ids then EN-lane ids, deduped order-preserving (the pipeline's
    candidate union: nothing displaced, first occurrence keeps its lane)."""
    out = []
    for cid in list(seed_ids) + list(en_ids):
        if cid not in out:
            out.append(cid)
    return out


def predict_final15(en_map, zh_map, top_n=RERANK_TOP_N, cut=MAX_RESULTS):
    """The dual-query max-merge offline: per-chunk max across the two maps,
    sorted, cut at rerank_top_n then max_results — the final 15 the eval
    sees. Pure; [(chunk_id, merged_score), ...] in ranked order."""
    merged = {}
    for m in (en_map, zh_map):
        for cid, s in m.items():
            if s > merged.get(cid, float("-inf")):
                merged[cid] = s
    ranked = sorted(merged.items(), key=lambda kv: (-kv[1], kv[0]))
    return ranked[:top_n][:cut]


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



def run_snapshot_flow(args, log=print):
    """--snapshot: validity gate FIRST (exact-equality against recorded runs;
    non-zero exit and NO snapshots when it fails), then the per-case EN-only
    snapshots with resolved expected_detail and drift-attributed baseline
    structural checks."""
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL not set — invoke via "
                         "scripts/with-remote-env.sh qa <cmd>")
    case_ids = measurable_case_ids() if args.all_cases else [args.case_id]
    demotion = not args.no_demote
    log(f"snapshot: validity gate over {len(case_ids)} case(s); "
        f"demotion={'on' if demotion else 'off'}")
    rows, all_pass = run_validity_gate(database_url, case_ids, demotion=demotion,
                                       log=log)
    gate = {
        "probe": "rerank-snapshot-validity",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "cases": case_ids, "demotion_applied": demotion,
        "rows": rows, "passed": all_pass,
        "convention": SNAPSHOT_BASELINE_CONVENTION,
        "gating_criterion": (
            "expected-hit set equality on mirror2 replays (gate-A); "
            "full-15 set/order reported as diagnostics — the standard lane "
            "is a dense-only approximation of the fused hybrid candidates, "
            "so tail composition diverges while expected-chunk placement "
            "reproduces; pool-absence conclusions for standard-lane-only "
            "chunks carry the same limit (seed-lane membership is exact)"),
    }
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    out = ARTIFACT_DIR / f"snapshot-validity-{args.label}.json"
    out.write_text(json.dumps(gate, ensure_ascii=False, indent=2))
    log(f"gate artifact: {out}")
    if not all_pass:
        log("VALIDITY GATE FAILED — the snapshot is not trustworthy; "
            "no snapshots written (a failed gate is a finding, not a tune-away)")
        return 1
    text_cache, idx_cache, summary_cache = {}, {}, {}
    new_docs, drift_column = new_doc_ids_since(database_url)
    log(f"corpus drift since {BASELINE_DATE}: {len(new_docs)} new searchable "
        f"docs (column: {drift_column})")
    for case_id in case_ids:
        snapshot_case(case_id, database_url, text_cache, idx_cache,
                      summary_cache, new_docs, drift_column,
                      demotion=demotion, label=args.label, log=log)
    return 0


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
    parser.add_argument("--snapshot", action="store_true",
                        help="program Step 1: validity gate (exact-equality "
                             "against the recorded mirror2/pool-probe runs) "
                             "then per-case EN-only snapshots with resolved "
                             "expected_detail — see the snapshot docstring "
                             "block for the baseline-state convention")
    parser.add_argument("--all-cases", action="store_true",
                        help="with --snapshot: run every measurable case "
                             "(fixture cases with expected_passages), not "
                             "just --case-id")
    parser.add_argument("--no-demote", action="store_true",
                        help="disable the Stage 2.1 page-1 demotion in "
                             "snapshot/gate predictions (production applies "
                             "it; default ON)")
    parser.add_argument("--pool-realistic", action="store_true",
                        help="reconstruct the product's ~240-source candidate "
                             "pool (seed-200 under the zh OR-join + standard-100 "
                             "under the EN question) and predict the final 15 "
                             "(max-merge + 20→15 cut) per query — see the "
                             "docstring; replaces the default 20-source batch "
                             "and its recorded-table gate")
    args = parser.parse_args(argv)

    if args.snapshot:
        return run_snapshot_flow(args)

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

    if queries.get("machine_zh") is None and (not args.queries_json or args.pool_realistic):
        # the OR-join rendering is both a standard scored query and (pool
        # mode) the seed lane's query text
        queries["machine_zh"] = translate_orjoined(question)

    if args.pool_realistic:
        database_url = os.environ.get("DATABASE_URL")
        if not database_url:
            raise SystemExit("DATABASE_URL not set — invoke via "
                             "scripts/with-remote-env.sh qa <cmd>")
        doc_ids = sorted({c["doc_id"] for c in batch})
        seed_ids = dense_doc_top(database_url, queries["machine_zh"], doc_ids, SEED_K)
        en_ids = dense_doc_top(database_url, question, doc_ids, EN_SEED_K)
        pool_ids = build_pool(seed_ids, en_ids)
        batch = [{"chunk_id": cid, "text": None,
                  "doc_id": cid.rsplit("_chunk_", 1)[0],
                  "source": "P", "rank": None} for cid in pool_ids]
        # pool sources' texts come from the same SELECT-only RDS path the
        # 20-source mode uses — a missing id aborts (the pool must not
        # silently shrink, and Bedrock rejects null document text)
        pool_texts = fetch_chunk_texts(database_url, pool_ids)
        for chunk in batch:
            chunk["text"] = pool_texts[chunk["chunk_id"]]
        print(f"pool-realistic: {len(seed_ids)} seed + {len(en_ids)} en-lane "
              f"-> {len(batch)}-source pool over docs {doc_ids}")

    scores_by_query = {}
    for label, text in queries.items():
        if not text:
            raise SystemExit(f"query {label!r} is empty")
        scores_by_query[label] = rerank_scores(text, batch)

    if args.pool_realistic:
        en_map = scores_by_query.get("en", {})
        predictions = {}
        for label, scores in scores_by_query.items():
            top15 = predict_final15(en_map, scores if label != "en" else {})
            ids15 = [cid for cid, _ in top15]
            hits = [c for c in expected_ids if c in ids15]
            predictions[label] = {
                "predicted_final15": top15,
                "expected_hits": hits,
                "n_hits": len(hits),
                "expected_detail": {
                    c: {"rank": (ids15.index(c) + 1) if c in ids15 else None,
                        "score": dict(top15).get(c)} for c in expected_ids},
            }
            print(f"[{label}] predicted final-15 hits: {len(hits)}/{len(expected_ids)} "
                  f"-> {[h.rsplit('_', 1)[-1] for h in hits]}")
        print("pool-realistic mode: the recorded-table validation gate does not "
              "apply (it was a 20-source-batch artifact) — compare predictions "
              "across variants instead.")
    else:
        predictions = None

    gated = not args.queries_json and not args.pool_realistic
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
    if predictions is not None:
        artifact["mode"] = "pool-realistic"
        artifact["pool"] = {"seed_k": SEED_K, "en_k": EN_SEED_K,
                            "rerank_top_n": RERANK_TOP_N, "max_results": MAX_RESULTS}
        artifact["predictions"] = predictions
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    out = ARTIFACT_DIR / f"probe-isolation-{args.label}.json"
    out.write_text(json.dumps(artifact, ensure_ascii=False, indent=2))
    print(f"artifact: {out}")

    if gated and not all_pass:
        return 1
    return 0



# --- snapshot mode (program Step 1) -------------------------------------------
#
# docs/superpowers/plans/2026-09-10-answer-eval-next-levers.md Step 1.
#
# BASELINE-STATE CONVENTION (premise-check premise 8): every snapshot states
# its baseline as the EN-only SHIPPED state (flag off — standard candidates
# only, no translation lanes, no seed). Grounding-state numbers never come
# from a snapshot; they come from validity-gate replays of the recorded served
# strings (probe-mirror2-served-bundles-20260910.json), which ARE production
# runs.
#
# TIE-BREAK DIVERGENCE NOTE (final-review minor #1): production sorts
# candidates stably — ties keep candidate-list order, and the candidate list
# is standard-lane-first with seeds appended. The legacy predict_final15 sorts
# by (score, chunk_id) instead, and the legacy pool union is seed-first. The
# snapshot uses the production order (standard-first, stable ties); recorded
# artifacts made with the legacy ordering are compared set-first, with order
# differences accepted only when every reordered adjacent pair has equal
# scores (tie-explainable).
#
# FIDELITY CAVEAT (measured, not assumed): the standard candidates here are a
# DENSE-ONLY approximation (doc-scoped dense top-100 under the EN question over
# the selection's docs) — production fuses dense+sparse (RRF 0.65/0.35) over
# the whole corpus before filtering to the selection. The validity gate's
# mirror2 replays measure this approximation end-to-end; the baseline
# structural check reports it per case (shared-chunk fraction + attribution).

SNAPSHOT_BASELINE_CONVENTION = (
    "baseline = EN-only shipped state (standard candidates only); "
    "grounding-state numbers come from validity replays of recorded served strings")

MIRROR2_CASE_ORDER = [
    "q3_regional-vs-longhaul-adoption",
    "q4_bev-payback-periods",
    "q5_bikeshare-trip-substitution",
    "q7_bikeshare-travel-behavior",
]
MIRROR2_R1_NAME = "probe-mirror2-grounded-r1-20260910.json"
MIRROR2_R2_NAME = "probe-mirror2-confirm-r2-20260910.json"
SERVED_BUNDLES_NAME = "probe-mirror2-served-bundles-20260910.json"
POOL_PROBE_NAMES = {
    "q3_regional-vs-longhaul-adoption": "pool-probe-q3.json",
    "q7_bikeshare-travel-behavior": "pool-probe-q7.json",
}
BASELINE_DATE = "2026-09-09"  # corpus drift horizon: QA grew 201 -> 206 docs


def _artifact(name):
    return ARTIFACT_DIR / name


def measurable_case_ids():
    """Fixture cases with non-empty expected_passages (10 of 16; the rest
    carry no retrieval ground truth and are unmeasurable by construction)."""
    fixture = json.loads(FIXTURE_PATH.read_text())
    return [c["id"] for c in fixture["test_cases"]
            if (c.get("retrieval_ground_truth") or {}).get("expected_passages")]


def load_selection_doc_ids(case_id):
    """The case's full selection (cite_doc_ids) from the baseline capture —
    the production pool's doc universe (standard candidates are fused over the
    corpus then filtered to this selection; the seed is doc-scoped to it)."""
    capture = json.loads(CAPTURE_PATH.read_text())
    for case in capture["cases"]:
        if case["case_id"] == case_id:
            return list(case["passes"][0]["selected_doc_ids"])
    raise SystemExit(f"case id {case_id!r} not in capture {CAPTURE_PATH}")


def load_served_bundles(path=None):
    """{"r1": {case_id: zh_text}, "r2": ...} — the recorded served rerank-bundle
    strings. The run_r1/run_r2 arrays are in MIRROR2_CASE_ORDER (the mirror
    driver iterated the cases in that order); mapping by position is the
    recorded contract (schema probe-mirror2-served-bundles@1)."""
    path = path or _artifact(SERVED_BUNDLES_NAME)
    if not Path(path).exists():
        return {}  # no recording — absent, not an error (snapshot falls back
        # to a fresh draw per case)
    data = json.loads(Path(path).read_text())
    out = {}
    for run_key, list_key in (("r1", "run_r1"), ("r2", "run_r2")):
        entries = data[list_key]
        if len(entries) != len(MIRROR2_CASE_ORDER):
            raise SystemExit(
                f"{list_key} has {len(entries)} entries; expected "
                f"{len(MIRROR2_CASE_ORDER)} (MIRROR2_CASE_ORDER) — the "
                f"positional mapping contract is broken")
        out[run_key] = dict(zip(MIRROR2_CASE_ORDER,
                                [e["text"] for e in entries]))
    return out


def load_mirror2_run(path=None):
    """{case_id: {"final15_ids": [...], "expected_hits": [...],
    "expected_chunk_ids": [...]}} from one mirror2 run artifact (cases keyed
    by case_id; final15 entries carry chunk_id/doc_id/score/raw_score)."""
    path = path or _artifact(MIRROR2_R1_NAME)
    data = json.loads(Path(path).read_text())
    out = {}
    for case_id, case in data["cases"].items():
        out[case_id] = {
            "final15_ids": [e["chunk_id"] for e in case["final15"]],
            "expected_hits": list(case["expected_hits"]),
            "expected_chunk_ids": list(case["expected_chunk_ids"]),
        }
    return out


def load_pool_probe_en(path=None):
    """Recorded pool-probe EN view ({top15_ids, top15_scores, hits15, n_hits,
    pool_size}) or None when the case has no pool-probe recording."""
    if path is None or not Path(path).exists():
        return None  # no recording for this case — absent, not zero
    data = json.loads(Path(path).read_text())
    en = data["en"]
    return {"top15_ids": [cid for cid, _ in en["top15"]],
            "top15_scores": {cid: s for cid, s in en["top15"]},
            "hits15": list(en["hits15"]), "n_hits": en["n_hits"],
            "pool_size": data["pool_size"]}


def load_pool_probe_orjoin(path=None):
    """The orjoined seed query recorded in the pool-probe artifact (the draw
    that produced its recorded pool) — deterministic replay input for the
    legacy gate-B construction. The 2026-09-10 artifacts store per-variant
    RESULT BLOCKS under "orjoin" (a dict), not the query text — return None
    for those (the recorded draw is unrecoverable; gate-B falls back to a
    fresh draw, report-only)."""
    if path is None or not Path(path).exists():
        return None
    value = json.loads(Path(path).read_text()).get("orjoin")
    return value if isinstance(value, str) and value.strip() else None


def resolve_expected_detail(expected_ids, pool_order, scores, final15_ids):
    """Kill the below-cut-vs-absent ambiguity (premise-check premise 2):
    every expected chunk gets in_pool/pool_rank (1-based position in
    pool_order; None iff absent), in_final15/final_rank (None iff not in the
    final list), and its raw score under the query (None iff absent)."""
    pool_pos = {cid: i + 1 for i, cid in enumerate(pool_order)}
    final_pos = {cid: i + 1 for i, cid in enumerate(final15_ids)}
    return [{
        "chunk_id": cid,
        "in_pool": cid in pool_pos,
        "pool_rank": pool_pos.get(cid),
        "in_final15": cid in final_pos,
        "final_rank": final_pos.get(cid),
        "score": scores.get(cid),
    } for cid in expected_ids]


def stable_rank(pool_order, score_map, top_n, cut, chunk_index_of=None,
                exclude=None):
    """Production-faithful ranking of a candidate pool.

    1. stable sort by -score (ties keep pool order — production candidate
       order is standard-lane-first, seeds appended; Python's sort is stable);
    2. cut to top_n (rerank_top_n=20 — the rerank's own cut);
    3. Stage 2.1 page-1 demotion when chunk_index_of is given:
       chunk_index == 0 -> score * 0.5, INCLUDING chunks whose metadata is
       missing entirely (production reads metadata.get("chunk_index", 0));
       stable re-sort;
    4. answer-mode summary strip (main.py: stage2_results are filtered of
       is_summary_node chunks AFTER the rerank cut and demotion — a summary
       can occupy a rerank slot but never the final list; chunks beyond
       top_n do NOT get promoted into the vacated slots);
    5. cut to `cut` (max_results=15).
    Returns [(chunk_id, effective_score), ...] in ranked order. Pure.
    """
    ranked = sorted(pool_order,
                    key=lambda cid: -score_map.get(cid, float("-inf")))[:top_n]
    pairs = [(cid, score_map.get(cid, float("-inf"))) for cid in ranked]
    if chunk_index_of is not None:
        pairs = [(cid, s * 0.5 if chunk_index_of.get(cid, 0) == 0 else s)
                 for cid, s in pairs]
        pairs.sort(key=lambda kv: -kv[1])
    if exclude:
        pairs = [(cid, s) for cid, s in pairs if cid not in exclude]
    return pairs[:cut]


def compare_final15(predicted_ids, recorded_ids):
    """Set equality is the hard criterion; order equality is reported
    separately (tie-explainable divergence is assessed by the caller against
    the score map)."""
    only_pred = [c for c in predicted_ids if c not in set(recorded_ids)]
    only_rec = [c for c in recorded_ids if c not in set(predicted_ids)]
    return {"set_equal": not only_pred and not only_rec,
            "order_equal": list(predicted_ids) == list(recorded_ids),
            "only_predicted": only_pred, "only_recorded": only_rec}


def attribute_baseline_drift(predicted_ids, baseline_entries, new_doc_ids,
                             doc_of):
    """Baseline structural deltas with attribution: a chunk whose document is
    in new_doc_ids (corpus drift since BASELINE_DATE) is 'new-doc-drift';
    anything else is 'lane-approximation' (the dense-only standard lane).
    The baseline capture CANNOT be byte-reproduced (corpus drift), so this
    check is a fidelity indicator, not an equality gate."""
    pred_set, base_set = set(predicted_ids), {e["chunk_id"] for e in baseline_entries}
    def _label(cid):
        d = doc_of(cid)
        return "new-doc-drift" if d in (new_doc_ids or set()) else "lane-approximation"
    return {
        "shared": [c for c in predicted_ids if c in base_set],
        "predicted_only": [{"chunk_id": c, "doc_id": doc_of(c),
                            "attribution": _label(c)}
                           for c in predicted_ids if c not in base_set],
        "baseline_only": [{"chunk_id": e["chunk_id"], "doc_id": e["doc_id"],
                           "attribution": _label(e["chunk_id"])}
                          for e in baseline_entries if e["chunk_id"] not in pred_set],
    }


def fetch_chunk_meta(database_url, chunk_ids):
    """({chunk_id: chunk_index}, {chunk_id: is_summary_node}) — Stage 2.1's
    demotion input and the answer-mode summary-strip flag. Production reads
    node.metadata.get("chunk_index", 0): a chunk whose node_metadata is NULL
    or lacks the key is treated as index 0 (demoted). Summary nodes carry
    chunk_index=-1 (a sentinel — NOT demoted) and is_summary_node=True;
    production strips them from the answer results AFTER the rerank cut and
    demotion and BEFORE the max_results cut (main.py answer branch: "strip
    summary nodes — they helped retrieval find the right documents but their
    content isn't a real PDF passage"). SELECT-only."""
    import psycopg

    ids = list(chunk_ids)
    if not ids:
        return {}, {}
    sslmode = os.environ.get("PGSSLMODE") or "require"
    with psycopg.connect(database_url, sslmode=sslmode) as conn:
        rows = conn.execute(
            "SELECT dc.legacy_chunk_id, dc.node_metadata "
            "FROM document_chunks dc "
            "WHERE dc.legacy_chunk_id = ANY(%(ids)s)",
            {"ids": ids},
        ).fetchall()
    meta = {legacy_id: m for legacy_id, m in rows}
    if len(meta) != len(ids):
        missing = [cid for cid in ids if cid not in meta]
        raise SystemExit(f"chunks missing from QA RDS (meta): {missing}")
    indexes, summaries = {}, {}
    for legacy_id, m in meta.items():
        if isinstance(m, str):
            try:
                m = json.loads(m)
            except json.JSONDecodeError:
                m = {}
        if not isinstance(m, dict):
            m = {}
        indexes[legacy_id] = m.get("chunk_index", 0)
        summaries[legacy_id] = bool(m.get("is_summary_node", False))
    return indexes, summaries


def new_doc_ids_since(database_url, date_str=BASELINE_DATE):
    """Documents added to the corpus since the baseline date (the 201->206
    drift), for baseline-delta attribution. Returns (ids, column_used) —
    the column is discovered from information_schema; empty set with a note
    when no timestamp column exists. SELECT-only."""
    import psycopg

    sslmode = os.environ.get("PGSSLMODE") or "require"
    with psycopg.connect(database_url, sslmode=sslmode) as conn:
        cols = conn.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'documents' "
            "AND (column_name ILIKE '%creat%' OR column_name ILIKE '%added%') "
            "AND data_type IN ('timestamp without time zone', "
            "'timestamp with time zone', 'date')"
        ).fetchall()
        if not cols:
            return set(), None
        column = cols[0][0]
        rows = conn.execute(
            f"SELECT external_id FROM documents WHERE {column} >= %(d)s "
            "AND status = 'searchable'",
            {"d": date_str},
        ).fetchall()
    return {r[0] for r in rows}, column


def reconstruct_pool(database_url, question, zh_seed_text, doc_ids):
    """(pool_ids, seed_ids, en_ids) — the production candidate union in
    PRODUCTION ORDER: standard candidates first (approximated by the
    doc-scoped dense top-100 under the EN question over the selection's docs),
    seeds appended (doc-scoped dense top-200 under the zh seed text). Dense
    approximations both; the validity gate measures the gap end-to-end."""
    seed_ids = dense_doc_top(database_url, zh_seed_text, doc_ids, SEED_K)
    en_ids = dense_doc_top(database_url, question, doc_ids, EN_SEED_K)
    pool_ids = []
    for cid in list(en_ids) + list(seed_ids):
        if cid not in pool_ids:
            pool_ids.append(cid)
    return pool_ids, seed_ids, en_ids


def pool_batches(pool_ids, text_cache, database_url):
    """[{chunk_id, text, doc_id}] for rerank calls, fetching missing texts
    once into text_cache (a missing id is a hard error — no silent shrink)."""
    missing = [cid for cid in pool_ids if cid not in text_cache]
    if missing:
        text_cache.update(fetch_chunk_texts(database_url, missing))
    return [{"chunk_id": cid, "text": text_cache[cid],
             "doc_id": cid.rsplit("_chunk_", 1)[0]} for cid in pool_ids]


def doc_of_chunk(cid):
    """The chunk's document external_id — legacy ids are '<doc>_chunk_<n>',
    summary nodes are '<doc>_summary' (app/indexing.py)."""
    if cid.endswith("_summary"):
        return cid[: -len("_summary")]
    return cid.rsplit("_chunk_", 1)[0]


def max_merge_maps(maps):
    """Per-chunk max across score maps (mirrors app.bedrock_rerank.max_merge)."""
    merged = {}
    for m in maps:
        for cid, s in m.items():
            if s > merged.get(cid, float("-inf")):
                merged[cid] = s
    return merged


def ties_explain_order(predicted_ids, recorded_ids, score_map):
    """True when every adjacent reordered pair (vs the recorded order) has
    EQUAL scores in the score map — i.e. the order divergence is purely a
    tie-break artifact, not a score divergence."""
    if predicted_ids == recorded_ids:
        return True
    a, b = list(predicted_ids), list(recorded_ids)
    if set(a) != set(b) or len(a) != len(b):
        return False
    # walk both lists; allow swaps only among equal-score runs
    i = 0
    while i < len(a):
        if a[i] == b[i]:
            i += 1
            continue
        j = i
        while j < len(b) and b[j] != a[i]:
            j += 1
        if j >= len(b):
            return False
        block = b[i:j + 1]                      # recorded block that moved
        scores = {score_map.get(c) for c in block}
        if len(scores) != 1:
            return False
        # consume the block from both lists
        a[i:j + 1] = []
        b[i:j + 1] = []
    return True


def get_indexes(pool_ids, idx_cache, summary_cache, database_url):
    """Stage 2.1 demotion inputs + answer-mode summary-strip flags for the
    pool, fetched once per run into the caches (production defaults:
    chunk_index 0 when the node_metadata lacks the key; is_summary_node
    False when absent)."""
    missing = [cid for cid in pool_ids
               if cid not in idx_cache or cid not in summary_cache]
    if missing:
        indexes, summaries = fetch_chunk_meta(database_url, missing)
        idx_cache.update(indexes)
        summary_cache.update(summaries)
    return idx_cache, summary_cache


def run_validity_gate(database_url, case_ids, demotion=True, log=print):
    """Prove the reconstruction against recorded reality before any snapshot
    is trusted. GATING criterion (gate-A, mirror2 replays): the predicted
    EXPECTED-HIT set must equal the recorded one, 8/8 (4 cases x r1/r2) —
    this is the quantity the census consumes. The full final-15 set/order
    are REPORTED diagnostics, not gated: the standard lane is a dense-only
    approximation of the fused hybrid candidates (fidelity_caveat), so tail
    composition diverges while expected-chunk placement reproduces.
    Gate-B (pool-probe legacy replays) is REPORT-ONLY: the recorded pool-probe
    artifacts saved no zh query strings (verified 2026-09-10), so their seed
    lane replays with a fresh draw and cannot be deterministic.
    The seed lane replays the recorded served string — zero LLM calls;
    deterministic pool (a fresh draw changed the pool itself: q4 238 vs 264).
    Returns (rows, all_pass).
    """
    served = load_served_bundles()
    mirror = {"r1": load_mirror2_run(_artifact(MIRROR2_R1_NAME)),
              "r2": load_mirror2_run(_artifact(MIRROR2_R2_NAME))}
    text_cache, idx_cache, summary_cache = {}, {}, {}
    rows = []
    for run in ("r1", "r2"):
        for case_id in MIRROR2_CASE_ORDER:
            if case_id not in case_ids:
                continue
            question, expected_ids = load_fixture_case(case_id)
            doc_ids = load_selection_doc_ids(case_id)
            # The seed lane replays the RECORDED served string: the pool's
            # dense retrieval is draw-dependent, so a fresh draw changes the
            # pool itself (measured: q4 pool 238 vs 264 across draws). Only
            # the recorded string reproduces the recorded pool.
            orjoined = served[run][case_id]
            pool_ids, seed_ids, en_ids = reconstruct_pool(
                database_url, question, orjoined, doc_ids)
            batch = pool_batches(pool_ids, text_cache, database_url)
            indexes, summaries = get_indexes(
                pool_ids, idx_cache, summary_cache, database_url)
            en_map = rerank_scores(question, batch)
            zh_map = rerank_scores(served[run][case_id], batch)
            merged = max_merge_maps([en_map, zh_map])
            ranked = stable_rank(
                pool_ids, merged, RERANK_TOP_N, MAX_RESULTS,
                chunk_index_of=indexes if demotion else None,
                exclude={c for c, is_sum in summaries.items() if is_sum})
            pred_ids = [cid for cid, _ in ranked]
            rec = mirror[run][case_id]
            cmp = compare_final15(pred_ids, rec["final15_ids"])
            hits = [c for c in expected_ids if c in set(pred_ids)]
            order_ok = cmp["order_equal"] or ties_explain_order(
                pred_ids, rec["final15_ids"], merged)
            ok = set(hits) == set(rec["expected_hits"])
            rows.append({
                "check": f"mirror2-{run}", "case_id": case_id, "pass": ok,
                "gating": True,
                "set_equal": cmp["set_equal"], "order_equal": order_ok,
                "hits_predicted": hits, "hits_recorded": rec["expected_hits"],
                "only_predicted": cmp["only_predicted"],
                "only_recorded": cmp["only_recorded"],
                "pool_size": len(pool_ids), "seed_n": len(seed_ids),
                "en_n": len(en_ids),
                "seed_query": "recorded served string (deterministic replay)"})
            log(f"[gate-A {run} {case_id.split('_')[0]}] hits {len(hits)} "
                f"vs recorded {len(rec['expected_hits'])} | "
                f"set_equal={cmp['set_equal']} order_ok={order_ok} "
                f"pool={len(pool_ids)}")
    for case_id, name in POOL_PROBE_NAMES.items():
        if case_id not in case_ids:
            continue
        recorded = load_pool_probe_en(_artifact(name))
        if recorded is None:
            continue
        question, _ = load_fixture_case(case_id)
        winners = load_capture_winners(case_id)
        batch_docs = sorted({c["doc_id"] for c in build_batch(
            load_fixture_case(case_id)[1], winners) if c["doc_id"]})
        orjoined = load_pool_probe_orjoin(_artifact(name))
        source = "recorded orjoin string"
        if not orjoined:
            # the recorded pool-probe artifacts saved no zh strings (verified
            # 2026-09-10) — fresh draw, REPORT-ONLY (cannot be deterministic)
            orjoined = translate_orjoined(question)
            source = "fresh orjoined draw (recorded string unsaved)"
        if not orjoined.strip():
            log(f"[gate-B {case_id.split('_')[0]}] SKIPPED — empty translation "
                f"draw (report-only check; rerun to retry)")
            continue
        seed_ids = dense_doc_top(database_url, orjoined, batch_docs, SEED_K)
        en_ids = dense_doc_top(database_url, question, batch_docs, EN_SEED_K)
        pool_ids = build_pool(seed_ids, en_ids)  # legacy seed-first union
        batch = pool_batches(pool_ids, text_cache, database_url)
        en_map = rerank_scores(question, batch)
        top15 = predict_final15(en_map, {})  # legacy (score, chunk_id) tiebreak
        pred_ids = [cid for cid, _ in top15]
        scores_match = all(
            dict(top15).get(cid) == recorded["top15_scores"].get(cid)
            for cid in recorded["top15_ids"])
        ok = pred_ids == recorded["top15_ids"] and scores_match
        rows.append({
            "check": "pool-probe-en-legacy", "case_id": case_id,
            "pass": ok, "gating": False,
            "order_equal": pred_ids == recorded["top15_ids"],
            "scores_byte_equal": scores_match,
            "pool_size": len(pool_ids),
            "recorded_pool_size": recorded["pool_size"],
            "seed_query": source})
        log(f"[gate-B {case_id.split('_')[0]}] order_equal="
            f"{pred_ids == recorded['top15_ids']} "
            f"scores_byte_equal={scores_match} pool={len(pool_ids)} "
            f"(recorded {recorded['pool_size']}) REPORT-ONLY")
    return rows, all(r["pass"] for r in rows if r.get("gating"))


def snapshot_case(case_id, database_url, text_cache, idx_cache, summary_cache,
                  new_docs, drift_column, demotion=True, label=None, log=print):
    """One case's EN-only snapshot: reconstruct the production pool
    (standard-first union over the case's selection), score the EN question
    once over the union (cross-encoder scores are per-(query,doc) pairs, so
    one call serves both views), and record both views with resolved
    expected_detail plus the baseline structural check with drift
    attribution. Writes snapshot-<case>-<label>.json; returns its path."""
    question, expected_ids = load_fixture_case(case_id)
    winners = load_capture_winners(case_id)
    doc_ids = load_selection_doc_ids(case_id)
    served = load_served_bundles()
    if case_id in served.get("r2", {}):
        orjoined = served["r2"][case_id]
        seed_query_source = "recorded served r2 string (deterministic replay)"
    else:
        orjoined = translate_orjoined(question)
        seed_query_source = "fresh orjoined draw (single sample; string recorded " \
                            "below for replay)"
        if not orjoined.strip():
            raise SystemExit(
                f"{case_id}: translation draw came back EMPTY — the seed lane "
                f"cannot be built; rerun (transient translator behavior)")
    pool_ids, seed_ids, en_ids = reconstruct_pool(
        database_url, question, orjoined, doc_ids)
    batch = pool_batches(pool_ids, text_cache, database_url)
    indexes, summaries = get_indexes(
        pool_ids, idx_cache, summary_cache, database_url)
    exclude = {c for c, is_sum in summaries.items() if is_sum}
    en_map = rerank_scores(question, batch)
    standard_set = set(en_ids)
    shipped_pool = [cid for cid in pool_ids if cid in standard_set]
    shipped = stable_rank(shipped_pool, en_map, RERANK_TOP_N, MAX_RESULTS,
                          chunk_index_of=indexes if demotion else None,
                          exclude=exclude)
    union = stable_rank(pool_ids, en_map, RERANK_TOP_N, MAX_RESULTS,
                        chunk_index_of=indexes if demotion else None,
                        exclude=exclude)
    shipped_ids = [cid for cid, _ in shipped]
    union_ids = [cid for cid, _ in union]
    doc_of = doc_of_chunk
    structural = attribute_baseline_drift(
        shipped_ids, winners, new_docs, doc_of)
    struct_shared_frac = len(structural["shared"]) / max(len(winners), 1)
    artifact = {
        "probe": "rerank-snapshot",
        "case_id": case_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "convention": SNAPSHOT_BASELINE_CONVENTION,
        "fidelity_caveat": (
            "standard lane = doc-scoped dense top-%d under the EN question "
            "(dense-only approximation of the fused hybrid standard "
            "candidates); the validity gate (mirror2 replays) measures this "
            "approximation end-to-end" % EN_SEED_K),
        "doc_universe": {"mode": "selection", "doc_ids": doc_ids},
        "seed_query": {"source": seed_query_source, "text": orjoined},
        "pool": {
            "standard_n": len(en_ids), "seed_n": len(seed_ids),
            "union_n": len(pool_ids),
            "order": "standard-first (production union); stable ties",
            "ids": pool_ids,
            "seed_ids": seed_ids, "en_ids": en_ids,
            "doc_composition": {
                "standard": {d: sum(1 for c in en_ids if doc_of(c) == d)
                              for d in doc_ids},
                "union": {d: sum(1 for c in pool_ids if doc_of(c) == d)
                           for d in doc_ids},
            },
        },
        "queries": {"en": question, "seed_zh_orjoined": orjoined},
        "en_scores": en_map,
        "views": {
            "shipped_en_only": {
                "note": "the EN-only shipped state's predicted final 15 "
                        "(standard candidates only)",
                "final15": shipped,
                "expected_detail": resolve_expected_detail(
                    expected_ids, shipped_pool, en_map, shipped_ids),
            },
            "en_over_union_pool": {
                "note": "EN scores over the standard+seed union pool — NOT a "
                        "production state (the real grounding state max-merges "
                        "a zh map over this pool); recorded for the T2 census",
                "final15": union,
                "expected_detail": resolve_expected_detail(
                    expected_ids, pool_ids, en_map, union_ids),
            },
        },
        "baseline_structural": {
            "note": "fidelity indicator, not an equality gate — the baseline "
                    "capture predates corpus drift (201->206 docs)",
            "shared_n": len(structural["shared"]),
            "baseline_n": len(winners),
            "shared_fraction": round(struct_shared_frac, 3),
            **structural,
            "drift_column": drift_column,
        },
        "demotion_applied": bool(demotion),
        "chunk_index_default": "production metadata.get('chunk_index', 0)",
    }
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    out = ARTIFACT_DIR / f"snapshot-{case_id}-{label or datetime.now(timezone.utc).strftime('%Y%m%d')}.json"
    out.write_text(json.dumps(artifact, ensure_ascii=False, indent=2))
    hits_s = [d for d in artifact["views"]["shipped_en_only"]["expected_detail"]
              if d["in_final15"]]
    absent_s = [d["chunk_id"] for d
                in artifact["views"]["shipped_en_only"]["expected_detail"]
                if not d["in_pool"]]
    log(f"[snapshot {case_id.split('_')[0]}] shipped hits "
        f"{len(hits_s)}/{len(expected_ids)} | pool {len(en_ids)}+{len(seed_ids)}"
        f"={len(pool_ids)} | shared-vs-baseline "
        f"{len(structural['shared'])}/{len(winners)} | pool-absent: "
        f"{[a.rsplit('_chunk_',1)[-1] for a in absent_s] or 'none'}")
    log(f"artifact: {out}")
    return out

if __name__ == "__main__":
    sys.exit(main())
