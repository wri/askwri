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

- [ ] **Query latency workstream — now PLANNED** (three-Opus-analysis
  synthesis, 2026-07-22): `docs/plans/2026-07-22-query-latency-workstream.md`
  (raw analyses in `docs/research/2026-07-22-latency-report-{1,2,3}-*.md`).
  Headlines: merging v3 IS the ~100x fix for the deployed >300s reranker
  problem; stranded off-event-loop fix `d214f3f` (branch fix/query-latency)
  should be adopted onto v3; L0 quick wins (instrumentation, botocore
  timeouts, client warmup, embed LRU) belong on this branch; the biggest
  PERCEIVED lever is streaming the answer synthesis (frontend, separate
  track).
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
- [x] **Phase 1 gate: PASS (2026-07-22)** — full-corpus Mistral re-parse,
  sparse rebuild, floor re-derived to 0.09, cite P30.6/R83.1/F1 43.2
  (recall exactly at baseline, best F1 recorded), answer doc-F1 77.5
  (+1.9), smoke 16/16 strong. Verdict + honest ledger in the Phase 0
  results doc. Local corpus is now Mistral-parsed.
- [x] **2 worker-uploaded docs re-parsed locally — DONE 2026-07-22**
  (bf38c0f8 whos-driving-this-bus…, 5da1ee93 climate-readiness…). Repaired via
  `reingest_all --ids …` + a worker at `PARSE_BACKEND=mistral`. Both now
  searchable, Mistral markdown, no glyph garbage, 100% cohere-embed-v4 chunks
  + sparse (179 / 121). Local corpus is now uniform (172 docs: 171 with `#`
  headers — the one without is a pre-existing headingless PDF, not pypdf).
  **Credential footgun hit + solved**: the worker embed stage failed with
  `UnrecognizedClientException` because `search-service/.env.local`'s FAKE
  MinIO AWS keys load into `os.environ` and, since `app/env.py` uses
  `load_dotenv(override=False)`, they only lose to REAL shell env. Fix:
  inject real static SSO creds (`eval $(aws configure export-credentials
  --format env)`) before launching, and RESUME at the embed stage (parse
  already persisted Mistral text) so MinIO is never needed — the startup
  intake sweep logs one harmless `InvalidAccessKeyId` against localhost:9000
  and continues. Same class of footgun as the reembed_cohere note below, but
  via the worker's dual-client (MinIO + Bedrock) path. DEPLOYED worker is
  immune (task role, real S3, no fake keys).
- [x] **`parse_backend` default stays `pypdf`** (decided 2026-07-22, post-
  merge). Flipping to mistral in config would hard-fail every ingest
  (`worker/stages/parse.py:159` raises without `MISTRAL_API_KEY`, and the
  key is deliberately deferred to Phase D). The flip is a worker-env change
  at Phase D per the runbook, not a code default.
- [ ] **Language-label vs content mismatches** (found in the Phase 1
  pilot): `detect()` was fooled by bilingual English covers (fixed —
  multi-window voting), but 3 fixture docs are genuinely ENGLISH-edition
  PDFs carrying zh/es/pt CSV labels (3778, 2705, 6821 — each has a
  native-edition sibling in the corpus). Re-ingest will re-label them
  'en'; diff documents.language before/after the full run and review the
  flips as corrections vs regressions with the team.
- [x] **8 production docs had pypdf glyph-ID garbage — FIXED on qa 2026-07-23.**
  Confirmed the deployed RDS `document_texts` was pypdf all along (only 4/168
  docs had markdown headers; Mistral had been local-only). Configured the qa
  worker for Mistral (`PARSE_BACKEND=mistral` + `MISTRAL_API_KEY` + a bulk
  `BEDROCK_EMBED_BATCH_SIZE=24`; deploy `29976819358`) and targeted-re-ingested
  the 8 via `reingest_all --ids`. Result: 8 → 0 `/gid`, all clean Mistral
  markdown, re-embedded `cohere-embed-v4`, `searchable`, languages unchanged.
  Backups `document_texts/chunks_glyph_backup_20260723`. The worker is now
  Mistral for all future ingests (personal key — rotation debt); the other ~160
  docs stay pypdf (clean, and re-parse is recall-neutral).
- [ ] Bake-off cleanup after the Phase 1 decision: delete BDA project
  `07aee510a362` + scratch bucket `askwri-parse-bakeoff-905418285725`.

## Deploy / ops

- [x] **Deploy account confirmed 2026-07-22**: `askwri-app-qa-cluster` and
  `askwri-app-production-cluster` both live in 905418285725 (us-east-2) —
  the account where Bedrock invokes are verified live. "Enable model
  access" is genuinely done for both models.
- [x] **Inference-profile ARN grant VERIFIED** (2026-07-22): the deployed
  task-role policy (`terraform/infrastructure/ecs.tf:127-162`) grants
  `bedrock:InvokeModel` on the `us.cohere.embed-v4:0` inference-profile ARN
  AND the underlying `foundation-model/cohere.embed-v4:0` (wildcard region),
  so the profile is usable for the deployed re-embed. Still a decision
  whether to DEFAULT `BEDROCK_EMBED_MODEL_ID` to the profile, but the grant
  no longer blocks it.
- [x] **Deploy ordering ENFORCED by the workflow** (verified 2026-07-22):
  `deploy-qa.yml` `deploy-service` declares `needs: deploy-infrastructure`,
  so `terraform apply` (the bedrock grants) always lands before the ECS
  force-new-deployment. No manual sequencing risk at merge. (Health-endpoint
  "rerank live vs degraded" field still a nice-to-have.)
- [ ] Local-dev footgun: service launched with exported SSO creds loses
  Bedrock when the session expires (~hourly) and quietly degrades to
  fused. Deployed env uses the task role (immune). Maybe log a WARNING on
  first rerank failure per process.

## Pre-cutover checklist (FULL re-embed gate — added 2026-07-22 review)

- [x] **Back up the vectors first — RDS DONE 2026-07-23** (`document_chunks_embedding_backup_20260722`, 30,435 rows; drop after soak) — the re-embed rewrites in place and the
  only documented rollback is re-embedding back through OpenAI. A one-liner
  makes it a two-way door (~200MB locally):
  `CREATE TABLE document_chunks_embedding_backup_20260722 AS
   SELECT id, embedding, embedding_model FROM document_chunks;`
  Same insurance for the deployed cutover (RDS). Drop after validation.
- [x] **Dense lane graceful degradation — DONE** (decision + impl 2026-07-22,
  shipped in #248). `main.py:244-255` catches any dense-lane failure, serves
  sparse-only, logs a WARNING, and records `dense_degraded_at`/`dense_error`
  in `service_state`, surfaced at `/health` (`main.py:830`). Recovery clears
  the flags on the next successful dense call. Covered by
  `tests/test_dense_fallback.py` (degrade + recover). Chose sparse-only
  fallback over the hard dependency; sparse-only is English-keyword-only, so
  it is intentionally visible via /health rather than silent.
- [x] **Refresh `aws login` immediately before the full run — DONE 2026-07-23
  (moot in practice)**: the RDS run used the auto-refreshing `~/.aws` login
  provider (aws configure list → TYPE `login`), which rotates every ~15 min
  under a 12h umbrella — the opposite of the static-snapshot expiry this warns
  about. Resumability still bore out: the run auto-resumed through 2 throttle
  deaths losslessly.
- [x] **Worker parity at cutover — DONE 2026-07-23**: `EMBEDDING_MODEL`
  removed from `INGESTION_WORKER_ENV` in the SAME redeploy (`29968575474`) as
  the search-service pin, so the worker now defaults to cohere-embed-v4. Also
  added `AWS_RETRY_MODE=adaptive`/`AWS_MAX_ATTEMPTS=10`/`BEDROCK_EMBED_MODEL_ID=
  us.cohere.embed-v4:0` to the worker secret for future bulk re-ingests
  (normal single-doc intake at default batch 96 is fine without them).
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

- [x] **Deployed re-embed used `--batch-size 24` + `AWS_RETRY_MODE=adaptive` +
  the `us.cohere.embed-v4:0` profile — DONE 2026-07-23**: even the 300k-TPM
  profile bucket threw ThrottlingException twice mid-run; the auto-resume loop
  (per-batch commits + 45s backoff) carried it to 30,435/30,435 across 3
  attempts. Batch 96 would have been worse. Confirms the runbook setting.
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
