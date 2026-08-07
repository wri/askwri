# QA Deploy Runbook — Multilingual v3 (all-Bedrock retrieval + Mistral parse)

**Scope:** deploying the `multilingual-v3` branch to the qa environment: Bedrock
Cohere embed-v4 dense lane, Bedrock Rerank 3.5 + tuned cite floor/tiers, the
RDS corpus re-embed cutover, and (gate-dependent) the Mistral parse backend.
Written 2026-07-22 from the LOCAL cutover execution — every gotcha below was
hit for real; see `docs/plans/2026-07-22-local-cohere-cutover-report.md`.

**Ordering is the point.** The deploy workflow runs terraform apply and image
deploys in one push, so anything that must precede the new images has to be
done before pushing, and the embed cutover is a *separate, later* event.

---

## Phase A — before merging/pushing anything

1. **GitHub secrets additions — EXECUTED 2026-07-22 (pins only):**
   - `SEARCH_SERVICE_ENV`: **`EMBEDDING_MODEL=text-embedding-3-small` added** ✅
     (secret rebuilt from the live task definition minus terraform-static
     keys: HOTJAR_ID, LLAMA_CLOUD_API_KEY, DATABASE_URL, OPENAI_API_KEY,
     RETRIEVAL_BACKEND + the pin). The new code DEFAULTS to
     `cohere-embed-v4`; the RDS corpus is still 3-small until Phase C.
     Without this pin the deployed dense lane queries the (empty) cohere
     index — silent empty dense results.
   - `INGESTION_WORKER_ENV`: **same `EMBEDDING_MODEL` pin added** ✅
     (DATABASE_URL, OPENAI_API_KEY + the pin). Worker parity — new ingests
     must keep writing 3-small until the cutover.
   - `MISTRAL_API_KEY`: **deliberately DEFERRED to Phase D.** Nothing
     consumes it until `PARSE_BACKEND=mistral` is set, and the value lands
     as PLAINTEXT in the ECS task definition — provision an **org/team
     Mistral key** for it (never a personal key), then rotate the personal
     key used during local Phase 0/1 work.
   - `INGESTION_WORKER_ENV` (post-cutover): also `AWS_RETRY_MODE=adaptive`,
     `AWS_MAX_ATTEMPTS=10`, `BEDROCK_EMBED_MODEL_ID=us.cohere.embed-v4:0` —
     the worker embed stage bursts 96-chunk batches and errors jobs on the
     on-demand quota with default retries (hit during the local Phase 1
     bulk re-ingest: 8 of the first 17 docs errored on ThrottlingException
     until the drain env carried these).
   - For BULK re-ingests specifically, also `BEDROCK_EMBED_BATCH_SIZE=24`:
     large docs (500+ chunks) at batch 96 blow the 300k-TPM bucket within a
     single embed stage and error-loop even with adaptive retries (11 docs
     hit this locally). And run **ONE worker** for bulk jobs — parallel
     workers multiply demand into the same shared token bucket (3 workers
     tripled the throttle-error rate locally). Normal per-doc intake at the
     default 96 with a single worker is fine.
2. **Terraform sanity:** `ecs.tf` now grants `bedrock:InvokeModel` on the
   Cohere foundation models AND the `us.cohere.embed-v4:0` inference-profile
   ARN (the re-embed path of record — 300k tokens/min vs 150k on-demand),
   plus `bedrock:Rerank` on `*`. This applies in the same push as the images
   (single workflow), which is acceptable for rerank: worse case during the
   window is graceful degradation to fused results. It is NOT acceptable to
   push images that *require* Bedrock before the policy exists — don't
   reorder the workflow steps.
3. **Bedrock model access:** already effective in account 905418285725
   (verified by live invokes 2026-07-22 — embed-v4 us-east-1, Rerank 3.5
   us-west-2). Nothing to click.

## Phase B — push (images + terraform + migration)

4. Migration `1783454000000` (scoped cohere HNSW index) is PENDING on RDS and
   sorts *before* already-applied migrations — TypeORM runs it anyway
   (proven on the local DB). Run migrations per the existing deploy flow
   BEFORE the service deploy completes serving traffic.
5. After deploy: `/health` should be healthy; rerank live (check a cite
   query returns `relevance_tier`); dense lane still 3-small via the pin.

### Phase B validation — EXECUTED 2026-07-22 (PASS)

Deploy: PR #248 merged → qa run `29961853452`. Terraform apply (bedrock
grants) landed before the ECS deploy per `deploy-qa.yml`
`needs: deploy-infrastructure`. New search-service task rev `:134`.

- **Migration**: `1783454000000` applied manually via
  `./scripts/with-remote-env.sh qa npm run migration:run` (CI does NOT run
  migrations). Verified `idx_chunks_embedding_hnsw_cohere_v4` present on RDS;
  it is an empty partial index (corpus still 3-small under the pin), so no
  build cost. (The stale main checkout had to be fast-forwarded to the merge
  commit first — it lacked the migration file.)
- **/health** (via `GET qa.askwri-app.org/api/llamaindex` →
  `hybrid_service`): healthy, `dense_lane.status: "live"`, both rerankers
  loaded, `retrieval_backend: postgres`, `keyword_backend: sparse`, 168 docs.
- **Rerank live**: cite query `POST /api/llamaindex` → `reranking_applied:
  true`, 23 docs, tiers strong 13 / partial 9 / weak 1; top hit on-topic,
  rerank raw scores descending 0.95→0.85.
- **Lanes**: dense 458ms (embed 149 via Bedrock + db 304 HNSW), sparse
  252ms, **total 1122ms** — the ~100x fix over the old >300s reranker path.
- **EMF**: `AskWRI/Query` namespace populated in CloudWatch (us-east-2):
  total_ms, dense_ms, dense_db_ms, rerank_ms, stage1_ms, sparse_ms.
- Bedrock grants (task-role `InvokeModel` + `Rerank`) proven live by the
  working dense+rerank path.

## Phase C — RDS embed cutover (separate event, after B soaks)

6. **Back up the vectors first** (one-way door → two-way):
   ```sql
   CREATE TABLE document_chunks_embedding_backup_<date> AS
   SELECT id, embedding, embedding_model FROM document_chunks;
   ```
   (~250MB per 30k chunks; drop after validation.)
7. **Re-embed** with the settings that survived contact with the quota:
   ```
   AWS_RETRY_MODE=adaptive AWS_MAX_ATTEMPTS=10 \
   BEDROCK_EMBED_MODEL_ID=us.cohere.embed-v4:0 \
   python -m scripts.reembed_cohere --batch-size 24
   ```
   - Default batch 96 dies on ThrottlingException (150k tokens/min
     on-demand); the cross-region profile bucket is 2×.
   - The script commits PER BATCH and skips converted rows — a killed run
     resumes losslessly.
   - Credentials: run from an environment with role/auto-refreshing creds
     (a static ~1h token WILL expire mid-run; that's how local take 1 died).
8. **Flip the pins together**: remove `EMBEDDING_MODEL` from BOTH
   `SEARCH_SERVICE_ENV` and `INGESTION_WORKER_ENV`, redeploy both services.
   A worker left pinned silently writes 3-small rows into an all-cohere
   corpus.
9. **Re-validate the cite floor** — the embed-v4 candidate pool MOVES it
   (locally: 0.08 → 0.10). Run `scripts/capture_cite_scores.py` with
   `CITE_LOGIT_FLOOR=0` + `scripts/analyze_cite_scores.py`, adjust config
   if the peak shifted, then run the full eval battery for the
   before/after record.
10. After soak: write the 3-small partial-index DROP migration (anticipated
    in `1783454000000`'s comment) and drop the backup table.

### Phase C execution — EXECUTED 2026-07-23 (cutover done; step 10 pending soak)

- **Backup** (step 6): `document_chunks_embedding_backup_20260722` on RDS,
  30,435 rows (id, embedding, embedding_model), all embeddings non-null.
  Rollback table intact until the soak completes.
- **Re-embed** (step 7): 30,435 chunks → `cohere-embed-v4`, **zero**
  `text-embedding-3-small` remaining; all 1536-dim, non-null. Ran ONE process,
  `--batch-size 24` + `AWS_RETRY_MODE=adaptive AWS_MAX_ATTEMPTS=10` +
  `BEDROCK_EMBED_MODEL_ID=us.cohere.embed-v4:0` (cross-region profile, 300k
  TPM). Auto-resumed through 2 ThrottlingException deaths (per-batch commit =
  lossless resume); ~1h wall across the resumes. Credentials: the
  auto-refreshing `~/.aws` login provider (fake MinIO keys popped from
  `.env.local` for the run, restored after) — the static-snapshot expiry that
  killed the local take-1 was avoided.
- **Pins flipped** (step 8): `EMBEDDING_MODEL` removed from BOTH
  `SEARCH_SERVICE_ENV` (→ 5 keys) and `INGESTION_WORKER_ENV`; the worker
  secret also GAINED `AWS_RETRY_MODE=adaptive` / `AWS_MAX_ATTEMPTS=10` /
  `BEDROCK_EMBED_MODEL_ID=us.cohere.embed-v4:0` (bulk-safety for future
  re-ingests). Secrets rebuilt from the live task defs (values never printed);
  redeploy `29968575474` (workflow_dispatch) SUCCESS — both task defs
  re-rendered without `EMBEDDING_MODEL`.
- **Floor re-validation** (step 9): kept `cite_logit_floor = 0.09` (the
  locally-derived optimum). Deployed measurement against RDS cohere (golden +
  smoke replayed through `/api/llamaindex` at the eval config) shows cite macro
  **P35.2 / R66.9 / F1 44.4** (F1 above the local 42.4) and non-English smoke
  **16/16 present, 16/16 rank-1** — the cross-lingual win confirmed live. The
  peak did not shift adversely, so no floor change (a floor=0 sweep against RDS
  was not run — the deployed floor cannot be zeroed without a redeploy; the
  deployed data + prior local sweep support 0.09). The lower recall vs the
  local 83.1 is a corpus/parser difference (RDS text is still pypdf; Mistral is
  Phase D) plus 4 fewer docs — not a cutover regression.
- **Rerank region flip** (folded into step 9): `bedrock_rerank_region`
  us-west-2 → us-east-1 (commit `7048fd6`) — deploys with this PR. Pre-flip
  rerank baseline: server-side stage2 median **610ms** (warm, us-west-2);
  expected ~35-55ms saving. Post-deploy `stage2_time` / EMF `rerank_ms` to be
  recorded against that baseline.
- **Latency**: post-cutover warm total **1055ms** (== pre-cutover 1054ms) —
  envelope preserved; dense on cohere HNSW (`dense_db_ms` ~458).

## Phase D — Mistral parse flip (only after the bake-off Phase 1 gate passes)

11. Set `PARSE_BACKEND=mistral` in `INGESTION_WORKER_ENV`, redeploy the
    worker. New ingests parse via Mistral OCR; existing docs re-parse via
    `scripts/reingest_all.py` (per-batch pipeline; language stage now uses
    multi-window detection so bilingual covers don't flip
    `documents.language`).
12. Diff `documents.language` before/after any bulk re-ingest; expected
    legitimate flips: English-edition PDFs carrying native-language CSV
    labels (see todos).

### Phase D execution — EXECUTED 2026-07-23 (full corpus re-parse, PASS)

Scope: the 160 still-pypdf qa docs (the other 8 were repaired in the
2026-07-23 glyph fix). Deployed worker already on `PARSE_BACKEND=mistral` +
`BEDROCK_EMBED_BATCH_SIZE=24` + `AWS_RETRY_MODE=adaptive` +
`BEDROCK_EMBED_MODEL_ID=us.cohere.embed-v4:0`, **one** worker task.

- **Backups first** (two-way door, all verified non-null):
  `reparse_pypdf_docs_20260723` (160 ids + pre-state language/char/chunk counts),
  `document_texts_reparse_backup_20260723` (160),
  `document_chunks_reparse_backup_20260723` (28,699 rows / 281 MB),
  and `document_chunks_sparse_backup_20260723` (27,878) before the sparse rebuild.
- **Preflight**: all 160 source PDFs confirmed present in
  `s3://askwri-data/documents/`; sparse vocab headroom 190,070 / 1,000,000.
- **Enqueue**: `reingest_all --ids <160>` at 13:47:46Z. Ran ~2h50m.
- **Result: 160/160 `done`, ZERO errors, zero `needs_review`** — no throttling
  intervention needed (batch 24 + adaptive retries held).
- **Verification**: 168/168 docs carry Mistral markdown, **0 pypdf, 0 `/gid`**;
  27,878 chunks across all 168 docs, **0 non-cohere, 0 null embedding, 0 null
  sparse**; all 168 `searchable`; chunk count -8.2% on the re-parsed set
  (28,699 -> 26,346), matching the predicted ~9%; no doc lost all chunks or
  shrank >60%.
- **Language diff — 7 flips, all CORRECTIONS, and all in the opposite
  direction to this runbook's prediction.** Expected was 3 docs (3778, 2705,
  6821) flipping *to* `en`; those were **already `en` on qa** (that prediction
  described the LOCAL corpus, whose CSV labels were stale) and correctly did
  not move. What actually flipped was 7 docs `en` -> es/zh/id whose bodies are
  genuinely non-English — pypdf's garbled/cover-biased text had them mislabeled,
  and Mistral's clean body text lets multi-window detection read the real
  language. Spot-verified: `mexican-cities...9595` (es body),
  `deciphering-chinas...5424` (zh body), `panduan...4324` (id body).
  Final distribution: en 139, zh 16, es 9, pt 3, id 1.
  `documents.language` does not filter retrieval — it is metadata only.
- **Sparse rebuild (REQUIRED, not optional)**: `build_sparse_keyword.py` —
  `keyword_corpus_stats` was stale at `n_chunks` 30,435 vs an actual 27,878.
  After: 27,878 / `avgdl` 199.8 / vocab 233,936 (23% of `SPARSE_DIM`) / 0 nulls.
  Run this before ANY threshold derivation on a re-parsed corpus.

### Phase D step 13 — cite re-derivation on the final corpus (2026-07-23)

Full record: `docs/research/2026-07-23-cite-floor-rederivation.md`.

- Method: local search-service pointed at RDS with `CITE_LOGIT_FLOOR=0` (the
  deployed floor cannot be zeroed without a redeploy), corrected golden set
  from #250 (66 expected docs, not 70 — q11 lost 4 self-contradicting entries).
- **Outcome: `CITE_PRESET.maxResults` 100 -> 25; floor HELD at 0.09.**
  The UI renders every returned doc (`results/page.tsx` `pageDocs = supporting`,
  no slice), so `maxResults` — not the floor — bounds list length; at 100 the
  lists ran from a handful to 46 docs. Capping at 25 is a Pareto improvement:
  recall identical (83.3 macro / 90.2 excl-q11), precision 29.2 -> 32.0,
  F1 43.3 -> 46.2. The discarded tail held no relevant docs.
- Macro-F1 peaks at floor 0.14 (robust with and without q11) and was
  **rejected**: it costs 13pp recall, and cite mode is recall-first by design.
  Band precision agrees — 0.14 cuts into the [0.10,0.20) band (20.5% precise)
  while the band below it is 3.9%.
- Cross-lingual unaffected: smoke relevant minimums es 0.824 / pt 0.888 /
  zh 0.516; **16/16 smoke targets present**.
- **Recall ceiling is 90.7% (top-30)** — 59/66 expected docs reach the reranker
  at `fusion_top_k=500`. The missing 7 are a fusion/vocabulary gap (LVC drift),
  not a threshold or truncation problem. q11 alone accounts for 5 of them and
  was excluded from the derivation.

## Open decision that gates this deploy — RESOLVED (2026-07-22, shipped in #248)

- **Dense-lane failure mode**: RESOLVED via sparse-only fallback. A Bedrock
  embed failure no longer 500s `/query`; `main.py:244-255` serves sparse-only,
  logs a WARNING, and records `dense_degraded_at`/`dense_error` in
  `service_state` (surfaced at `/health`). Recovery clears the flags on the
  next successful dense call. Covered by `tests/test_dense_fallback.py`.
  Sparse-only is English-keyword-only, hence visible at /health rather than
  silent. No longer gates the deploy.

## Rollback

- Retrieval (pre-cutover): revert images; the pin means the corpus was
  untouched.
- Embed cutover: restore vectors from the backup table
  (`UPDATE … FROM document_chunks_embedding_backup_<date>`), re-add the
  pins, redeploy.
- Parse flip: unset `PARSE_BACKEND`; previously parsed docs keep their
  Mistral text until re-ingested (contract-compatible either way).
