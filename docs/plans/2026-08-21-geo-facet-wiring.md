# Geo Facet Wiring — Query Expansion P2.6

**Branch:** `feature/geo-facet-wiring`
**Date:** 2026-08-21
**Predecessors:** P2.5 topic lane (PR #350, merged) + geography facet data (PR #351, merged + backfilled to qa 2026-08-20).
**Design:** `docs/plans/2026-08-19-query-expansion-design.md` §4.1, §4.3, §4.4.
**Goal:** Generalize the P2.5 topic-retrieval lane from `facet='topic'` to a config-driven facet list so the `geography` facet contributes a `geo_dense` lane to query expansion, then gate it.

## Context

P2.5 (merged) wires **one** semantic lane: `topic_dense`. It hardcodes `facet='topic'`
in three query-path files (`topic_sense.py`, `topic_retrieval.py`, `understanding.py`)
plus the `/query` lane construction in `main.py`. The geography facet data
(201 tags, embedded, assigned to docs via the P1 classify path) now exists on qa but
cannot reach retrieval — the query path only looks at topic.

The P2.5 gate (2026-08-20) PROVEN on both cite sets excl geo; the geo queries
(q2, q4 on cite_01; d2 on cite_02) are the documented gap. This plan wires geo so
those queries can recover once the lane is active.

## Decisions (locked, 2026-08-20 with operator)

1. **Facet name: `geography`** — matches the merged migration (`1787251200000`),
   worker `EMBEDDED_FACETS`, admin UI, and backfill script. The kickoff brief's
   `facet='geo'` was shorthand written before PR #351 landed; unifying on
   `geography` avoids a rename migration + worker/admin churn for zero functional
   gain.
2. **`matched_tags: dict[str, list[tuple[str, float]]]`** keyed by facet —
   replaces `understanding.topic_tags`. Scales to N facets without schema
   changes. Flag-off is byte-identical (empty dict). (Brief decision 3, dict option.)
3. **`expansion_facets: list[str] = ['topic']`** in `config.py` — one master flag
   (`QUERY_EXPANSION_LANES_ENABLED`) + a config list. Add `'geography'` to the
   list only after the gate passes. No per-facet flag. (Brief decision 2.)
4. **One lane per matching facet.** Each facet with semantic matches gets its own
   lane (`topic_dense`, `geo_dense`). Attributable in `lane_ranks`. A facet that
   matches nothing doesn't materialize (no cost). The 2× original-weight rule
   (operator decision c, P2) already handles "any extra lane materialized."
5. **`value_id` is unique PER FACET, not globally** — the retriever SQL MUST keep
   the facet filter. Parameterize, don't remove. (Brief constraint, verified.)

## Binding rules inherited (P2 investigation §9)

- Flag-off byte-identical; all new code behind `lanes_active(settings, request)`.
- Reranker only ever sees the original query (§4.4) — `postprocess_nodes`'s
  `query_bundle` untouched.
- No retry loops; failure-soft; no 500s.
- `QueryRequest`/`QueryResponse` fields additive; `debug` is `Dict[str, Any]`.
- No new Python deps. `tag_aliases` is app-owned; Python only reads it.
- Both flags stay OFF everywhere deployed. No flag flip in any deployed env.
- Do not re-try: alphabetical alias selection, the query-in-lane + 2× combination,
  or removing the 2× while the lane carries the query.

## Architecture (the generalization)

```
expansion_facets = ['topic']                  # config; 'geography' added after gate
  ↓
for facet in expansion_facets:
    matched_tags[facet] = nearby_tags(query_embedding, facet)   # cosine vs tag_embeddings
    if matched_tags[facet]:
        lane = TagRetriever(facet, matched_tags[facet], pool)    # one lane per matching facet
        extra_lanes.append({name: f"{facet}_dense", retriever: lane, weight: 1x})
  ↓
RRF(dense_2x, sparse_2x, *extra_lanes_1x) → rerank(original query) → assemble
```

The lane name is `f"{facet}_dense"` so `lane_ranks` attributes per-facet
(`topic_dense`, `geo_dense`). A facet with no matches above threshold produces no
lane — no DB query for docs-by-tag, no cost.

## Tasks (TDD, sequential)

### Task 1: `understanding.matched_tags` — dict keyed by facet

**Files:** `search-service/app/understanding.py`, test `tests/test_understanding.py`

- Add `matched_tags: dict[str, list[tuple[str, float]]] = Field(default_factory=dict)`
  to `QueryUnderstanding`.
- Keep `topic_tags` as a **deprecated alias** property returning
  `matched_tags.get("topic", [])` — so `main.py`'s existing `understanding.topic_tags`
  reads keep working until Task 3 rewires them. (Avoids a flag-off byte-identical
  break: `topic_tags` still reads the same data.)
- `build_understanding`: when `expansion_lanes`, loop over `settings.expansion_facets`
  and populate `matched_tags[facet]` via `topic_sense.nearby_tags(emb, facet)`.
  Default `expansion_facets=['topic']` → topic path identical to today.

**Tests:**
- `test_matched_tags_populated_per_facet` — stub embed_model + nearby_tags →
  `matched_tags['topic']` and `matched_tags['geography']` both non-empty when
  `expansion_facets=['topic','geography']`.
- `test_matched_tags_default_topic_only` — default config → only `topic` key
  (byte-identical to P2.5 flag-on).
- `test_matched_tags_empty_when_lanes_off` — flag-off → `matched_tags == {}`.
- `test_topic_tags_alias_returns_topic_key` — legacy `topic_tags` reads
  `matched_tags['topic']`.

### Task 2: `topic_sense.nearby_tags(emb, facet)` — parameterize the SQL

**Files:** `search-service/app/topic_sense.py`, test `tests/test_topic_sense.py`

- Rename `nearby_topics(query_embedding)` → `nearby_tags(query_embedding, facet)`.
  Parameterize `_TOPIC_SQL`'s `t.facet = 'topic'` → `t.facet = %(facet)s`.
- Keep `nearby_topics` as a thin wrapper `nearby_topics(emb) = nearby_tags(emb, 'topic')`
  for the `attach_topic_suggestions` caller (P1 suggestions, unchanged).
- `attach_topic_suggestions` (P1) stays topic-only — it produces *suggestions*,
  not lanes; geo suggestions are out of scope (Invariant 2: suggestions only,
  and the geo facet's query-path value is the retrieval lane, not suggestions).

**Tests:**
- `test_nearby_tags_filters_by_facet` — geography embeddings present, topic
  absent → `nearby_tags(emb, 'geography')` returns geo labels, `nearby_tags(emb,
  'topic')` returns [].
- `test_nearby_topics_wrapper_uses_topic_facet` — legacy wrapper hits topic.
- Existing `test_topic_sense.py` tests pass (topic path unchanged).

### Task 3: `TagRetriever` — accept a `facet` param

**Files:** `search-service/app/topic_retrieval.py`, test `tests/test_topic_retrieval.py`

- Rename `TopicTagRetriever` → `TagRetriever` (or add `facet` to the existing
  class; prefer rename — the class is facet-agnostic now). Keep
  `TopicTagRetriever = TagRetriever` alias for the `main.py` import until Task 4
  rewires it.
- Add `facet: str` to `__init__`; parameterize `_DOC_BY_TAG_SQL`'s
  `t.facet = 'topic'` → `t.facet = %(facet)s`. The `value_id` lookup stays
  facet-scoped (decision 5: `value_id` is unique per facet, not globally).
- Failure-soft unchanged: DB error → `[]` (lane drops).

**Tests:**
- `test_retrieve_filters_by_facet` — stub pool returns docs for geography tag
  "Kenya" only when `facet='geography'`; topic facet returns [].
- Existing `test_topic_retrieval.py` tests pass (topic path unchanged via
  default `facet='topic'`).

### Task 4: `/query` wiring — loop over `expansion_facets`, one lane each

**Files:** `search-service/app/main.py` (~1112-1136), test `tests/test_lane_wiring.py`

- Replace the single `topic_dense` lane block with a loop over
  `settings.expansion_facets`:
  ```python
  extra_lanes = []
  if lanes_on and understanding is not None:
      for facet in settings.expansion_facets:
          tags = understanding.matched_tags.get(facet, [])
          if not tags:
              continue
          retriever = TagRetriever(facet, tags, get_pool(), top_k=request.bm25_top_k)
          extra_lanes.append({
              "name": f"{facet}_dense",
              "retriever": retriever,
              "query_str": request.query,
              "weight": None,   # 1x
              "top_k": request.bm25_top_k,
          })
          logger.info(f"{facet} lane: {len(tags)} tags ...")
  ```
- Debug: replace `topic_tags_count` with `matched_tags_count: {facet: len}`
  (dict per facet). Keep `lanes_degraded`, `fused_nodes`, `rerank_window_ids`.
  EMF: emit one `matched_tags_count` per facet (or a dict; additive).
- `domain_expansion=not lanes_on` unchanged (OR-stuffing retired when lanes on).
- Leak detector: `test_flag_off_no_topic_lane_code_touched` →
  `test_flag_off_no_tag_lane_code_touched` (monkeypatch `TagRetriever` to throw,
  assert flag-off never calls it; true for all facets).

**Tests:**
- `test_lanes_on_builds_topic_dense_from_matched_tags` — topic only in
  `expansion_facets`, `matched_tags['topic']` non-empty → `extra_lanes` has
  `topic_dense`, no `geo_dense`.
- `test_lanes_on_builds_geo_dense_when_geo_matched` — `expansion_facets=['topic',
  'geography']`, both matched → both lanes built.
- `test_lanes_on_no_geo_match_no_geo_lane` — geography in list but
  `matched_tags['geography']` empty → no `geo_dense` lane (no cost).
- `test_flag_off_no_tag_lane_code_touched` — flag-off → no `TagRetriever`
  constructed for any facet; sparse lane byte-identical (OR-stuffed).
- `test_p1_only_keeps_or_stuffing` — unchanged (P1-on/P2-off parity).

### Task 5: `config.py` — `expansion_facets` setting

**Files:** `search-service/app/config.py`, test `tests/test_config.py`

- Add `expansion_facets: list[str] = ["topic"]` (default topic-only → P2.5
  byte-identical flag-on). Document: add `'geography'` to enable the geo lane;
  activation is a gated ops step, not a code change.
- No new flag (decision 2). `QUERY_EXPANSION_LANES_ENABLED` stays the one master.

**Tests:**
- `test_default_expansion_facets_is_topic_only` — default `['topic']`.
- `test_expansion_facets_accepts_geography` — env override includes geography.

### Task 6: Leak detectors + full suite green

- `tests/test_diagnostic_parity.py` + `tests/test_query_nonblocking.py` green.
- Full suite: `tests/` no new failures.
- `test_understanding.py`, `test_topic_sense.py`, `test_topic_retrieval.py`,
  `test_lane_wiring.py` all green.

### Task 7: Gate — both cite sets, flag-on ≥ flag-off

**Rig** (per brief):
- Service: `./scripts/with-remote-env.sh qa bash -c 'export RETRIEVAL_BACKEND=postgres
  KEYWORD_BACKEND=sparse CITE_LOGIT_FLOOR=0.0 [QUERY_UNDERSTANDING_ENABLED=true
  QUERY_EXPANSION_LANES_ENABLED=true] && cd search-service && python -m app.main'`
  (worktree has no venv; use the main repo's; needs `aws login --region us-east-2`).
- Harness: gen-2 `run-evalset.ts` → `${TARGET}/api/llamaindex` (Next.js gateway →
  search-service). Boot `SEARCH_SERVICE_URL=http://localhost:8000 npm run dev`
  (background, :3000), then `EVAL_TARGET=http://127.0.0.1:3000 npx tsx
  evaluation/run-evalset.ts evaluation/eval-review/evalsets/evalset_cite_0X.json`.
- `CITE_LOGIT_FLOOR=0.0` for both runs.

**Decision rule:** flag-on ≥ flag-off on both cite sets (excl any remaining
unmapped geo gap). Expect q2 (cite_01), q4 (cite_01), d2 (cite_02) to recover
once the geo lane is active and `expansion_facets` includes `'geography'`.

**Two runs:**
1. **Flag-on, `expansion_facets=['topic']`** (topic only) — must reproduce P2.5
   gate numbers (byte-identical to P2.5). Confirms the generalization is neutral.
2. **Flag-on, `expansion_facets=['topic','geography']`** (geo added) — the real
   gate. q2/q4/d2 should recover. If they don't, the geo tags don't cover those
   queries → data-coverage finding, not a wiring failure (per brief).

**Report:** `docs/plans/2026-08-21-geo-facet-wiring-gate-results.md`. PASS →
`'geography'` added to `expansion_facets` default in a follow-up ops step (not
this PR — no flag flip in any deployed env). FAIL → analysis.

## Non-goals

- No new Python deps. No admin UI changes. No `tag_aliases` changes.
- No flag flips anywhere deployed. No push/PR without operator approval.
- `DOMAIN_EXPANSIONS` retirement stays (original sparse lane drops OR-stuffing
  when lanes on).
- Geo suggestions (`attach_topic_suggestions` for geo) out of scope — the lane is
  the value, not the suggestion chip.
- Retrieval tuning (RRF weights, rerankers, thresholds) unchanged.

## Success criterion

Flag-on ≥ flag-off on both cite sets (excl any remaining unmapped geo gap), zero
`displaced_by_variant_lane`. The generalization is neutral (run 1 reproduces
P2.5), and the geo lane recovers the documented geo gap (run 2). If the geo gap
doesn't recover, it's a data-coverage finding, not a wiring failure.
