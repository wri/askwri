# Multilingual v3 — Running TODO List

Started 2026-07-22 during the Bedrock validation + cite tuning session.
Items found along the way that we are NOT fixing inline. Keep appending;
check items off with a pointer to the commit/PR that resolved them.

## Retrieval quality (cite)

- [ ] **Fusion misses — RE-MEASURED 2026-07-23 on the final all-Mistral corpus:
  7 of 66 expected docs never reach the reranker** at `fusion_top_k=500`
  (q5 ×1, q10 ×1, **q11 ×5**). Note the denominator changed 70 -> 66 (#250
  removed q11's 4 self-contradicting expectations). Macro recall therefore
  ceilings at **90.7% (top-30)**; top-40 adds nothing. Still a retrieval-lane
  gap, unchanged by the cohere re-embed or the Mistral re-parse. **Three of
  q11's five are land-value-capture docs** — this is the LVC vocabulary-drift
  lane below, and it is now the single biggest recall lever, larger than any
  remaining threshold tuning.
- [x] **Cite thresholds re-derived on the all-Mistral corpus (2026-07-23)** —
  `docs/research/2026-07-23-cite-floor-rederivation.md`. Shipped
  `CITE_PRESET.maxResults` 100 -> 25 (Pareto: same recall, +2.8pp precision,
  +2.9 F1, list bounded 46 -> 25); floor HELD at 0.09 against a macro-F1 peak
  at 0.14 that would cost 13pp recall. Key structural finding: **the UI renders
  every returned doc**, so `maxResults` — not the floor — is the list-length
  control.
- [ ] **Floor 0.06 as a deliberate recall purchase**: +2.3pp recall for
  -2.2pp precision / -2.3 F1 vs the shipped config. Deferred as an independent
  decision, not rejected on merits. Capture JSON retained — no re-run needed.
- [ ] **Tier boundaries (0.30 / 0.70) were NOT re-derived** in the 2026-07-23
  pass — only the floor and the cap. Band precision suggests the steps may
  have moved (bands: <0.05 1.7%, 0.05-0.10 3.9%, 0.10-0.20 20.5%, 0.40-0.60
  40-50%, 0.70+ 62.5%).
- [ ] **Golden-set precision is systematically understated**: a returned doc
  counts as relevant only if it is in `expected_urls`, so reported precision
  conflates genuine noise with incomplete labelling. Treat cite precision
  figures as a lower bound, not an estimate.
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

## Security / credentials (found 2026-07-23)

- [ ] **ROTATE BOTH API KEYS — they were printed in plaintext.** pydantic
  `BaseSettings` has no custom `__repr__`, so any exception embedding the
  settings object renders every field. A routine `monkeypatch.setattr`
  `AttributeError` in a normal pytest run printed the live `OPENAI_API_KEY`
  and `MISTRAL_API_KEY`. Masking is fixed (PR #258, `SecretStr`), but the
  values are exposed and need rotating. Scope: NOT leaked to git (only
  `.env.example` is tracked) and NOT to CI (no real values there) — but CI
  being clean is an accident of configuration, not a safeguard.
  - `OPENAI_API_KEY` originates from the **shell profile**, so it is in every
    local command's environment.
  - `MISTRAL_API_KEY` is the **personal** key (see rotation debt below) and is
    the same credential deployed to the qa worker.
  - Procedure + secrets architecture: `docs/runbooks/secret-rotation.md`.
- [ ] **OpenAI key still needs rotating** — the other key printed in the leak;
  present in BOTH environments' secrets, local value from the shell profile.
  Procedure in the rotation runbook; not yet done.
- [ ] **Keys are plaintext `environment` entries in the ECS task definitions**,
  not `secrets` references — anyone with `ecs:DescribeTaskDefinition` can read
  them with no failure required. Larger and more durable than the repr leak.
  Move to Secrets Manager / SSM (also enables console rotation without a full
  redeploy — see the rotation runbook). (Out of scope for #258.)
- [x] **Mistral org-key rotation on qa — DONE 2026-07-23.** Personal -> org key;
  validated against `api.mistral.ai`, deployed value confirmed changed (task-def
  rev :4 -> :5, distinct digests), worker rolled to :5, canary re-ingest passed
  the Mistral parse stage clean. Old personal key cleared for revocation after
  the canary — **confirm revocation completed**. Production has NO Mistral key
  (pypdf, no `PARSE_BACKEND=mistral`), so nothing to rotate there. Full record +
  reusable procedure: `docs/runbooks/secret-rotation.md`. Note: **Mistral OCR is
  NOT on Bedrock** (verified 2026-07-23, zero `ocr` models in us-east-1/us-east-2),
  so there is no task-role escape from the external key; the AWS-native path is
  BDA + caption dedup per the bake-off.

## Worker mechanics (found during the Phase D bulk run, 2026-07-23)

- [ ] **Bulk enqueue defeats FIFO claim ordering.** `enqueue()` inserts every
  id in ONE transaction and `created_at` defaults to `now()` — the
  *transaction* timestamp — so all rows share an identical timestamp and
  `_CLAIM_SQL`'s `ORDER BY created_at LIMIT 1` becomes arbitrary among the
  batch. Benign (no starvation, stages idempotent) but it makes bulk runs
  interleave stages instead of completing docs depth-first, so `done` stays
  flat for a long stretch and then jumps. Not a stall.
- [ ] **`reap_stale_jobs` vs slow OCR**: it requeues anything `running` for
  >15 min, so a large-PDF Mistral call exceeding that gets reclaimed while
  still in flight — duplicate work, not corruption (the chunk write takes an
  advisory lock and deletes-then-inserts). Did not fire during Phase D; watch
  `attempts` on larger corpora.

## Eval infrastructure

- [x] **Answer golden-set chunk IDs remapped 2026-07-23** (PR #257,
  `docs/research/2026-07-23-answer-golden-remap.md`). `chunk_id` is positional,
  so the Mistral re-parse renumbered all 190. **ans_002 went 0% -> 26.7/28.6**
  at chunk level, confirming it was a broken label set, not a retrieval
  failure. No passage needed manual relabelling (min overlap 34.1%); doc IDs
  byte-identical, so doc-F1 held at 77.5. Also deduped 190 -> 178 passages:
  re-chunking collapsed 12 formerly-distinct passages into shared chunks, and
  `calculateChunkMetrics` counts one exact match per EXPECTED passage against a
  denominator that counts each retrieved chunk once — the same double-count
  class #250 fixed for adjacent credit.
- [ ] **Answer-mode chunk recall is capped by construction**: cases expect
  14-29 passages but answer mode returns `maxResults: 15`, so recall above
  ~50% is unreachable for the larger cases regardless of retrieval quality.
  Rescope the expected sets or read chunk recall only against that ceiling.
- [ ] **`ANSWER_PRESET` has never been re-derived on cohere** — `fusionTopK:
  100` and answer-mode thresholds still carry text-embedding-3-small-era
  calibration. The cite side was re-derived 2026-07-23; answer was not.
- [ ] **Answer golden set still needs a broader redo** (dgutelius
  2026-07-22). The chunk-ID remap above fixed ans_002 and the >100% precision
  artifact; the remaining question is whether the expected sets themselves are
  right.
- [ ] **Two db tests carry stale expectations** (surfaced 2026-07-23):
  `migration-178132.db.test.ts` expects 33 non-English docs (local has 29 after
  the Mistral re-parse relabeled languages) and `pdf-route.db.test.ts` expects
  an unprefixed `s3Key` (actual is `documents/`-prefixed). Neither relates to
  indexes or retrieval.
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
- [x] **Post-cutover index hygiene — drop migration WRITTEN 2026-07-23**
  (PR #256, `1784815300000`). Deliberately **conditional**: it drops the
  3-small partial HNSW index only where the corpus holds zero 3-small rows and
  otherwise no-ops with a `NOTICE`. Production has not cut over and migrations
  run there too — an unconditional drop would strip the index serving its live
  dense lane and turn every dense query into a sequential scan. Both branches
  verified against the local corpus (drop via real `migration:run`; keep via a
  3-small row inside a rolled-back transaction). **Still TODO: run
  `migration:run` against qa** (CI does not run migrations).
- [ ] **Cohere HNSW bloat**: two full rewrites of the chunk table (Phase C
  re-embed + Phase D re-parse) — check index size and consider `REINDEX`.
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
