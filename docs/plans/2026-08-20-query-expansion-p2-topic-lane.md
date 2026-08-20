# P2.5 — Topic-retrieval lane (replace the alias lane with the semantic tag path)

> The topic tagging system is embedded (757 tags, `tag_embeddings`), attached
> to docs (1,927 `document_tags` assignments), and already semantically matched
> to the query at query time (`topic_sense.py`, P1). But `topic_sense`'s output
> is **suggestions only** (Invariant 2) — it is thrown away for retrieval. The
> dense lane matches the query embedding against chunk-text embeddings and
> ignores the tag taxonomy. P2's alias lane was a literal-synonym workaround
> for a gap the semantic path already fills. This plan wires the semantic
> query→tag match into retrieval as a fusion lane, and retires the alias lane.

## Why this is the right fix (and the alias lane wasn't)

- **Uses the full embedded taxonomy.** 757 tags, semantic cosine match. No
  19-row literal-alias table, no hand-seeding, no vocabulary drift.
- **Already runs on every query.** `topic_sense.nearby_topics(query_embedding)`
  is an LRU-cached query-embedding hit after stage 1 — zero extra Bedrock calls.
- **Semantically correct.** "heat resilience" → `Climate Resilience` (cosine),
  not "emissions" (alphabetical alias of `Climate Change`). d12 regressed
  because the alias lane fired the wrong group; the topic lane fires the
  right one.
- **Smaller surface than aliases.** One new retriever class + one lane dict.
  No `tag_aliases` dependency at query time (the table stays for admin UI /
  `embed_tags` composition; the lane reads `tag_embeddings` + `document_tags`).

## Architecture

A new lane: **`topic_dense`** — a dense retrieval over the docs tagged with
the query's top-N `nearby_topics`. It runs alongside (and eventually instead
of) `alias_sparse`, behind the same `lanes_active(settings, request)` guard,
dark by default. The reranker still only ever sees the original query (§4.4).

```
query embedding (LRU hit after stage 1)
  → topic_sense.nearby_topics() → top-K tag labels (cosine ≥ threshold)
  → for each tag: SELECT docs tagged with it (document_tags)
  → score each doc by (max tag cosine × doc-tag confidence), ranked
  → emit as NodeWithScore[] using the doc's representative chunk(s)
  → feed to RRF as a lane with 1× weight
```

The lane reuses the existing `HybridFusionRetriever` lane-list (P2 Task 4):
a lane dict `{name, retriever, query_str, weight, top_k}`. The "retriever" is
a new pure class that returns `NodeWithScore[]` from the tag→docs lookup.

## Tasks (TDD, sequential)

### Task 1: `TopicTagRetriever` — docs-by-tag retrieval, pure + tested ✅ DONE

**Files:**
- Create: `search-service/app/topic_retrieval.py`
- Test: `search-service/tests/test_topic_retrieval.py`

**Interface:**
- `TopicTagRetriever(nearby_topics: list[(label, cosine)], pool, weight_by_confidence: bool=True)`.
  Has `.retrieve(query_bundle) -> list[NodeWithScore]` (LlamaIndex signature,
  so it slots into `extra_lanes`).
- Pure + deterministic: for each tag, `SELECT d.id, d.external_id, chunk
  rep` via `document_tags JOIN documents JOIN document_chunks` (the doc's
  best chunk — highest `chunk_idx` or a title chunk), score = `cosine ×
  tag_confidence` (or just `cosine` if `weight_by_confidence=False`). Dedup
  docs across tags (highest score wins). Rank, take top_k.
- Failure-soft: a DB error returns `[]` (the lane drops, `degraded_lanes`
  records it — already handled by Task 4's `HybridFusionRetriever`).
- `requires_db` test marker for the DB-backed path; unit tests stub the pool.

**Tests (RED → GREEN):**
- `test_retrieve_returns_docs_for_matched_tags` — stub pool returns 2 docs
  for tag "Climate Resilience"; retriever returns 2 NodeWithScore, score =
  cosine × confidence.
- `test_dedup_across_tags` — doc tagged by two matched tags appears once,
  keeps max score.
- `test_top_k_caps` — 5 docs, top_k=2 → 2 returned.
- `test_empty_nearby_topics_returns_empty` — no tags → no retrieve.
- `test_db_failure_returns_empty` — pool raises → `[]` (no re-raise).
- `@requires_db test_retrieves_real_docs_for_climate_resilience` — against
  local docker (19 tags — limited, but the query path works), or skipped
  cleanly without `DATABASE_URL`.

### Task 2: `understanding.topic_tags` — carry the semantic matches ✅ DONE

**Files:**
- Modify: `search-service/app/understanding.py` (schema + `build_understanding`)
- Test: `search-service/tests/test_understanding.py` (extend)

**Interface:**
- Add `QueryUnderstanding.topic_tags: list[tuple[str, float]]` (label, cosine)
  — additive schema field, default `[]`.
- `build_understanding(..., expansion_lanes: bool = False)` already exists;
  when True, it currently runs `db_expander().expand(query)`. Change the
  `expansion_lanes` branch to ALSO populate `topic_tags` from
  `topic_sense.nearby_topics(query_embedding)`. The query embedding comes
  from the shared embed model (LRU hit after stage 1 in the real path; tests
  stub `embed_model.get_query_embedding`).
- `alias_expansions` stays (the alias lane stays wired but the /query path
  will stop constructing it — see Task 3). Keep the field for diagnosis.

**Tests:**
- `test_topic_tags_populated_when_lanes_on` — stub embed_model + topic_sense
  → `topic_tags` non-empty.
- `test_topic_tags_empty_when_lanes_off` — default `expansion_lanes=False` →
  `topic_tags == []` (byte-identical flag-off).
- `test_topic_sense_failure_soft` — topic_sense raises → `degraded.append("topic_sense")`,
  `topic_tags == []`.

### Task 3: `/query` wiring — add `topic_dense` lane, retire `alias_sparse`

**Files:**
- Modify: `search-service/app/main.py` (~1115-1136: the alias-lane block)
- Test: `search-service/tests/test_lane_wiring.py` (extend)

**Change:**
- When `lanes_on and understanding is not None and understanding.topic_tags`:
  build the `topic_dense` lane:
  ```python
  topic_retriever = TopicTagRetriever(understanding.topic_tags, get_pool())
  extra_lanes = [{
      "name": "topic_dense",
      "retriever": topic_retriever,
      "query_str": request.query,  # unused by the retriever (it uses tag lookups), but required by the lane dict
      "weight": None,   # 1x
      "top_k": request.bm25_top_k,
  }]
  ```
- **Remove the `alias_sparse` lane construction** (the alias lane is retired;
  the `alias_expansions` field stays for diagnosis). The `domain_expansion=
  not lanes_on` retirement of `DOMAIN_EXPANSIONS` stays (raw query on the
  original sparse lane when lanes on).
- Debug: replace `alias_lane_size` with `topic_tags_count` (len of
  `understanding.topic_tags`). Keep `lanes_degraded`, `fused_nodes`,
  `rerank_window_ids` (Task 5). EMF: `topic_tags_count`.
- Leak detectors: `test_flag_off_no_alias_code_touched` →
  `test_flag_off_no_topic_lane_code_touched` (monkeypatch
  `TopicTagRetriever` to throw, assert flag-off never calls it).

**Tests:**
- `test_lanes_on_topic_dense_lane_built_from_topic_tags` — lanes on,
  understanding.topic_tags non-empty → extra_lanes has `topic_dense`, no
  `alias_sparse`.
- `test_lanes_on_no_topic_tags_no_extra_lane` — topic_tags empty → no extra
  lane (degrade toward P1, same as alias lane did).
- `test_flag_off_no_topic_lane_code_touched` — flag-off → topic retriever
  never constructed; sparse lane byte-identical (OR-stuffed).
- `test_p1_only_keeps_or_stuffing` — unchanged from P2 (P1-on/P2-off parity).

### Task 4: Leak detectors + full suite green

- `tests/test_diagnostic_parity.py` + `tests/test_query_nonblocking.py` green.
- Full suite: `tests/` no new failures.
- Leak-detector stub signatures updated if `build_understanding`'s call
  changed (it didn't — `expansion_lanes` kwarg already exists).

### Task 5: Gate re-run on both cite sets (latest harness)

- Rig: local service on qa RDS, `EVAL_TARGET=http://127.0.0.1:3000`
  (Next.js gateway → :8000 search-service), `CITE_LOGIT_FLOOR=0.0`,
  `postgres/sparse`.
- Run cite_01 + cite_02, flag-off vs flag-on (both flags on), via
  `run-evalset.ts`. Attribution run with `EVAL_LANE_ATTRIBUTION=1`.
- **Decision rule:** flag-on ≥ flag-off (excl geo: q2/q4 on cite_01, d2 on
  cite_02). Zero `displaced_by_variant_lane`. Per-query: list movements with
  `topic_tags_count`.
- Write `docs/plans/2026-08-20-query-expansion-p2-topic-lane-gate-results.md`.
  PASS → P3 unblocked. FAIL → analysis.

## Non-goals

- No new Python deps. No admin UI changes. No `tag_aliases` changes (the
  table stays; the alias lane is retired but the field + seed stay for
  diagnosis / admin / `embed_tags` composition).
- No flag flips anywhere deployed. No push/PR without operator approval.
- `DOMAIN_EXPANSIONS` retirement stays (the original sparse lane still drops
  OR-stuffing when lanes on). Physical deletion deferred per operator
  decision b.

## Success criterion

Flag-on ≥ flag-off on both cite sets (excl geo), zero displacement. If the
topic lane beats the alias lane's cite_01 +4.4 and fixes d12, the alias
lane retires cleanly and P2's goal (safe query expansion) is met via the
semantic path that was always there.
