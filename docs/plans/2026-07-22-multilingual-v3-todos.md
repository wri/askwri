# Multilingual v3 — Running TODO List

Started 2026-07-22 during the Bedrock validation + cite tuning session.
Items found along the way that we are NOT fixing inline. Keep appending;
check items off with a pointer to the commit/PR that resolved them.

## Retrieval quality (cite)

- [ ] **Fusion misses**: 6 of 70 golden expected docs are absent from the
  top-500 fused chunks entirely (q5 ×1, q10 ×1, q11 ×4) — a retrieval-lane
  (dense/sparse fusion) recall gap, NOT a rerank/floor issue (verified:
  per-doc-cap=1 doubling doc coverage does not recover them). Revisit after
  the cohere re-embed — embed-v4 may shift dense recall on these.
- [ ] **Negation queries** (q11 "urban finance — exclude electric buses",
  R 45%): rerankers score topical similarity and cannot negate. Needs
  query-side handling (e.g. parse exclusions into `excluded_keywords`,
  which the pipeline already supports in Stage 2.5).
- [ ] **q7 Jakarta housing** R 50%: geography+solutions intersection where
  half the expected docs score < floor. Case study for the golden-set redo.
- [ ] **TODO(golden-set)**: formal per-language floor/tier recalibration
  once the redone golden set lands (markers in `app/config.py`).

## Answer mode (post-cutover, 2026-07-22)

- [ ] **ans_006 regression under embed-v4**: answer-mode doc-F1 dropped
  85.8 → 75.6 at the corpus cutover, almost entirely ans_006
  ("nature-based solutions": 5 retrieved docs → 1). embed-v4's chunk
  ranking concentrates that query's top-15 chunks in one doc. Investigate
  with (or fold into) the answer-golden-set redo — possibly an answer-mode
  analog of the cite per-doc candidate cap.

## Eval infrastructure

- [ ] **Answer golden set is flawed and needs a redo** (dgutelius
  2026-07-22). Known artifacts: ans_002 scores 0% at chunk level in every
  run (old + new pipeline) — expected-chunk IDs likely don't match corpus
  chunking; ans_008 chunk precision >100% (adjacent-tolerance double-count).
- [ ] Cite golden set: q9 (World Resources Report membership) and q10/q11
  (temporal cutoffs, negation) test capabilities the retrieval layer
  doesn't claim (program membership metadata, date filtering at query
  parse). Decide: metadata-filter features vs golden-set rescope.

## Performance / cost (flagged by dgutelius 2026-07-22 — "for later")

- [ ] **Query latency & processing budget**: cite query = embed hop
  (us-east-1) + 800+800 lane fetch + RRF + Bedrock rerank of 100 candidates
  (us-west-2 cross-region) ≈ 1.0–1.6s local, plus ~2s cold-start spikes.
  Ideas when we get there: co-locate rerank region with infra when Cohere
  expands hosting; trim vector_top_k/bm25_top_k (800 each is generous for a
  171-doc corpus but won't scale); cache query embeddings; parallelize the
  embed hop with the sparse lane fetch.
- [ ] Corpus-scale check: candidate diversification (cap=2, 100 slots ≈ 50
  docs) is calibrated for a ~170-doc corpus; at 10× corpus size revisit
  rerank_candidates and the cap.

## Phase C — parser selection (updated 2026-07-22)

- [x] **Phase 0 parse bake-off RUN 2026-07-22** — results + recommendation:
  `docs/plans/2026-07-22-parse-bakeoff-phase0-results.md`. Winner on
  quality/cost/coverage: **Mistral OCR** (advance to eval-gated Phase 1);
  BDA = AWS-boundary fallback (needs caption dedup); Gemini 3.1 Pro not
  advancing (truncates long docs, slowest, priciest, no quality edge).
  **RATIFIED 2026-07-22 (dgutelius): Mistral OCR is the Phase C parser**;
  egress accepted (public corpus). Spec §7 amended.
- [ ] **Phase 1 (binding gate)**: `parse_backend` flag + mistral branch in
  `worker/stages/parse.py` (per-page emission — fixes R4 zh page
  boundaries), `reingest_all.py`, full re-parse + sparse rebuild,
  baseline suite under `parse-mistral` label, plan §7 gate.
- [ ] **Language-label vs content mismatches** (found in the Phase 1
  pilot): `detect()` was fooled by bilingual English covers (fixed —
  multi-window voting), but 3 fixture docs are genuinely ENGLISH-edition
  PDFs carrying zh/es/pt CSV labels (3778, 2705, 6821 — each has a
  native-edition sibling in the corpus). Re-ingest will re-label them
  'en'; diff documents.language before/after the full run and review the
  flips as corrections vs regressions with the team.
- [ ] **8 production docs have pypdf glyph-ID garbage** (`/gid00017…`) in
  live `document_texts` (en 5 / es 2 / pt 1, ~2,600 occurrences) —
  discovered via the bake-off oracle diagnostics. Any re-parse fixes
  them; prioritize regardless of parser choice.
- [ ] Bake-off cleanup after the Phase 1 decision: delete BDA project
  `07aee510a362` + scratch bucket `askwri-parse-bakeoff-905418285725`.

## Deploy / ops

- [x] **Deploy account confirmed 2026-07-22**: `askwri-app-qa-cluster` and
  `askwri-app-production-cluster` both live in 905418285725 (us-east-2) —
  the account where Bedrock invokes are verified live. "Enable model
  access" is genuinely done for both models.
- [ ] Full re-embed used the `us.cohere.embed-v4:0` cross-region inference
  profile (300k TPM bucket, ~4x observed throughput vs the drained
  on-demand bucket). Consider defaulting `BEDROCK_EMBED_MODEL_ID` to the
  profile for the deployed re-embed too (works with the same
  `bedrock:InvokeModel` grant IF the terraform policy covers the profile
  ARN + underlying regional model ARNs — verify before relying on it).
- [ ] **Deploy ordering**: terraform apply (task-role `bedrock:InvokeModel`
  + `bedrock:Rerank`) MUST precede the Phase B image deploy, or qa's rerank
  silently degrades to fused results (graceful but invisible). Consider a
  health-endpoint field exposing "rerank live vs degraded" so degradation
  is observable.
- [ ] Local-dev footgun: service launched with exported SSO creds loses
  Bedrock when the session expires (~hourly) and quietly degrades to
  fused. Deployed env uses the task role (immune). Maybe log a WARNING on
  first rerank failure per process.

## Pre-cutover checklist (FULL re-embed gate — added 2026-07-22 review)

- [ ] **Back up the vectors first** — the re-embed rewrites in place and the
  only documented rollback is re-embedding back through OpenAI. A one-liner
  makes it a two-way door (~200MB locally):
  `CREATE TABLE document_chunks_embedding_backup_20260722 AS
   SELECT id, embedding, embedding_model FROM document_chunks;`
  Same insurance for the deployed cutover (RDS). Drop after validation.
- [ ] **Dense lane has NO graceful degradation post-cutover** (verified:
  `BedrockCohereQueryEmbedding.get_query_embedding` has no fallback; the
  /query handler will 500 where rerank degrades to fused). Locally this is
  guaranteed to bite when the SSO session expires. Decide before deploy:
  sparse-only fallback + logged warning vs accept the hard dependency.
- [ ] **Refresh `aws login` immediately before the full run** — 45–60 min
  run vs ~hourly session expiry; exported creds are a static snapshot.
  The script IS resumable (skips already-cohere rows), so a mid-run death
  loses nothing, but know that's the failure mode.
- [ ] **Worker parity at cutover**: the ingestion worker's embed stage
  reads EMBEDDING_MODEL too. When the pin is removed, the (deployed)
  worker must pick up the same setting at the same time or new ingests
  silently write 3-small rows post-cutover. Local: moot (worker not
  running).
- [x] **Floor re-validated post-cutover** (2026-07-22): embed-v4 candidate
  pool moved the macro-F1 peak 0.08 → 0.10 (P29.5/R83.1); config updated,
  tiers unchanged. The predicted shift was real — keep this re-validation
  step in the deployed-cutover runbook too.
- [ ] **Post-cutover index hygiene**: the 3-small partial HNSW index goes
  empty after the rewrite — write the drop migration (anticipated in the
  1783454000000 migration comment). Rewriting 30k rows also bloats the
  cohere HNSW index — check size / consider REINDEX.
- [ ] Decide whether to commit this session's before/after eval JSONs
  (currently untracked in `evaluation/results/`) for provenance.

## Re-embed / Bedrock quotas (found during the canary, 2026-07-22)

- [ ] **Deployed re-embed must use `--batch-size 24` + `AWS_RETRY_MODE=adaptive`**
  (now in the runbook): default batch 96 bursts past the 150k tokens/min
  on-demand embed-v4 quota and dies on ThrottlingException. Ensure the
  deploy runbook's re-embed step inherits this before the qa cutover.
- [x] `reembed_cohere.py` stats bug (`documents` counted chunk ids under
  `--limit`) — fixed with the per-batch-commit change (2026-07-22).
- [x] `reembed_cohere.py` unclosed pool warnings — pool closed in main()
  (2026-07-22).
- [x] **`reembed_cohere.py` was NOT crash-safe** (found the hard way: the
  first full-corpus attempt embedded for 13 min and persisted nothing —
  single transaction, rolled back on credential expiry). Now commits per
  batch; reruns resume from the last committed batch. Regression-tested.
- [x] **`aws configure export-credentials` is a static ~1h snapshot** and
  re-running it does NOT mint a fresh token while the cached one is valid
  — useless for long runs. Long-running local Bedrock scripts use the
  auto-refreshing `login` provider instead (`botocore[crt]` in
  requirements-dev.txt + pop the fake .env.local AWS keys; runbook Step 2
  updated).
- [ ] Optional headroom: cross-region inference profile for embed-v4 has
  2× the TPM quota (300k) if the full re-embed ever needs to go faster.

## Docs / hygiene

- [ ] Resume doc still says "re-ingest the 169 migrated docs" (Phase D) —
  corpus is already 172; phrase as "all published docs at re-ingest time".
- [ ] `worker-health.db.test.ts` races parallel db suites (expects
  idle/pending, sees a concurrent test's queued job). Serialize or scope
  the assertion.
- [ ] Node engine warning: repo wants node >=24, machine runs v23.10.
- [ ] starlette TestClient deprecation warning (httpx → httpx2) in
  test_query_e2e.
