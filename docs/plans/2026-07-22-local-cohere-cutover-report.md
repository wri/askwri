# Local Cohere embed-v4 Cutover — Execution Report

**Date:** 2026-07-22 · **Branch:** `multilingual-v3` (worktree `.worktrees/multilingual-v3`)
**Scope:** LOCAL qa database only. The deployed qa cutover is a separate, later
event following `docs/runbooks/qa-push-deploy.md` + the Bedrock runbook.

This documents the full local cutover from `text-embedding-3-small` (OpenAI)
to `cohere-embed-v4` (Bedrock) — runbook Steps 5–6 of
`docs/runbooks/bedrock-local-testing.md` — plus the pre-cutover review
findings that reshaped the procedure. Running follow-ups live in
`docs/plans/2026-07-22-multilingual-v3-todos.md`.

## Pre-cutover state (all verified, not assumed)

- Corpus: 172 docs (171 searchable, 1 withdrawn), 30,843 chunks.
- Canary already done: 500 chunks (4 docs) tagged `cohere-embed-v4`;
  mixed-corpus lanes smoke identical to baseline (bm25 11/16, dense 16/16).
- Cite pipeline tuned on live Bedrock (commit `58631df`): per-doc candidate
  cap=2, floor 0.08, tiers 0.30/0.70. Cite P28.1/R82.1/F1 40.9 (9/11);
  answer doc-F1 85.8; smoke 16/16 `tier=strong`.
- Scoped HNSW index `idx_chunks_embedding_hnsw_cohere_v4`
  (`WHERE embedding_model = 'cohere-embed-v4'`) in place alongside the
  3-small index (migration `1783454000000`).

## Pre-cutover review findings (what we almost missed)

1. **Vector backup** — the re-embed rewrites vectors in place; the runbook's
   only rollback was "re-embed back via OpenAI". Executed instead:
   ```sql
   CREATE TABLE document_chunks_embedding_backup_20260722 AS
   SELECT id, embedding, embedding_model FROM document_chunks;
   -- 30,843 rows, 247 MB
   ```
   Rollback is now `UPDATE ... FROM` restore + service restart with the pin
   re-added. Drop the table after the cutover is validated. Do the same on
   RDS before the deployed cutover.
2. **Dense lane has no graceful degradation post-cutover** (verified in
   code): `BedrockCohereQueryEmbedding.get_query_embedding` has no
   fallback, so an embed failure 500s `/query`, unlike rerank which
   degrades to fused. Decision needed before the qa deploy (sparse-only
   fallback vs hard dependency). Locally: SSO expiry makes this a
   when-not-if event for a long-running service.
3. **Credential expiry vs. run length**: `aws configure export-credentials`
   is a static snapshot of a ~1h login-session token (measured: ~14 min of
   runway remained at launch). The cutover runner therefore loops:
   re-export → resume on failure. `reembed_cohere.py` skips rows already
   tagged `cohere-embed-v4`, so every restart is lossless.
4. **Worker parity**: the ingestion worker's embed stage also reads
   `EMBEDDING_MODEL`. Local worker isn't running (moot here); at the
   deployed cutover the worker must pick up the new setting when the pin
   flips or new ingests silently write 3-small rows.
5. **Floor re-validation required post-cutover**: floor 0.08 was derived
   with the 3-small dense lane feeding the fused candidate pool; embed-v4
   changes that pool. Tooling committed for the re-check
   (`search-service/scripts/capture_cite_scores.py` +
   `analyze_cite_scores.py`, commit `49a9b41`).
6. **Bedrock quota reality** (from the canary): on-demand embed-v4 is
   150k tokens/min; batch 96 dies on ThrottlingException. All re-embeds use
   `--batch-size 24` + `AWS_RETRY_MODE=adaptive` (runbook updated).

## Cutover execution log

| Step | Result |
|---|---|
| Vector backup (30,843 rows, 247 MB) | ✅ `document_chunks_embedding_backup_20260722` |
| Full re-embed take 1 (static exported creds) | ❌ FAILED — see below; zero rows lost thanks to the backup being unneeded (nothing had committed) |
| Fix: per-batch commits in `reembed_cohere.py` + `login` credential provider | ✅ regression-tested (188 pytest green) |
| Full re-embed take 2 (login provider, per-batch commits) | ⚠️ resumed progress but repeated ThrottlingException deaths on the drained 150k-TPM on-demand bucket |
| Full re-embed take 3 (`us.cohere.embed-v4:0` cross-region profile, 300k-TPM bucket) | ✅ 30,843/30,843 chunks, 172 docs, ~44 min total across 3 auto-resumed attempts; collection cutover marker set |
| Remove `EMBEDDING_MODEL` pin (worktree + main-checkout copies, with notes) | ✅ |
| Service restart via login-provider driver + health | ✅ (first driver version had a pop-before-import bug — env.py re-inserted the fake keys; fixed by popping after full import) |
| Floor re-validation (capture + sweep on embed-v4 candidate pool) | ✅ macro-F1 peak moved 0.08 → **0.10** (same recall, +2 precision); tiers 0.30/0.70 still match the band-precision steps; config updated |
| Post-cutover eval battery | ✅ see results |

### Take-1 failure analysis (2026-07-22 13:31–13:46 UTC)

Two compounding defects, both now fixed and regression-tested:

1. **`reembed_cohere.py` was one giant transaction** — commit only on clean
   exit. The run embedded ~13 minutes of chunks, died on credential expiry,
   and Postgres rolled back everything. The "resumable" property everyone
   assumed (skip already-converted rows) only worked ACROSS successful
   runs, never through a crash. Fix: commit per batch; a killed run now
   keeps every finished batch and reruns pick up the remainder
   (test: `test_partial_run_commits_completed_batches`).
2. **`aws configure export-credentials` is a static snapshot** of the
   login-session token (~1h life; 14 min of runway remained at launch),
   and re-running the export does NOT refresh a still-valid cached token —
   so the retry loop kept exporting the same dying credentials. Fix:
   `botocore[crt]` in the venv lets boto3 use the CLI's `login` credential
   provider directly (verified `provider=login`), which auto-refreshes.
   The driver pops the fake MinIO AWS_* keys that `.env.local` loads into
   the process env so the profile chain is reachable.

## Post-cutover local-machine consequences (IMPORTANT)

- **The main checkout (qa branch) can no longer serve dense retrieval
  against this DB.** qa's search service embeds queries with
  text-embedding-3-small and has no model-aware chunk filtering — against
  an all-cohere corpus its dense scores are garbage. Until `multilingual-v3`
  merges, run the search service from the worktree only, or restore the
  backup table to go back.
- The 3-small partial HNSW index is now empty. Do NOT write the drop
  migration yet — the deployed env is still on 3-small until its own
  cutover; the drop migration ships after the DEPLOYED cutover validates.
- `search-service/.env.local` pin removal applies to BOTH copies (worktree
  and main checkout) — the main-checkout copy documents the deploy-day
  reference and its pin is now stale either way; see todos.

## Post-cutover results

All runs live against Bedrock, service on production config (floor 0.10):

| Metric | Jul-7 (ONNX rerank, 3-small) | Tuned pre-cutover (Bedrock rerank, 3-small dense) | **Post-cutover (all-Bedrock)** |
|---|---|---|---|
| Cite P / R / F1 | 24.2 / 82.2 / ~37 | 28.1 / 82.1 / 40.9 | **29.5 / 83.1 / 42.4** |
| Cite passing | — | 9/11 | **9/11** |
| Answer doc-level F1 | 78.2 | 85.8 | **75.6** ⚠️ |
| Smoke lanes | 11/16 bm25, 16/16 dense | identical | **identical** |
| Smoke rerank | — | 16/16 tier=strong | **16/16 tier=strong** |

- **Cite: best result recorded** — precision, recall, and F1 all above every
  prior state. The two failing cases remain q11 (negation) and q7 (Jakarta),
  both pre-existing and tracked in the todos.
- **Answer mode regressed 85.8 → 75.6 doc-F1.** Almost entirely ans_006
  ("nature-based solutions": 5 retrieved docs → 1; doc-F1 90.9 → 28.6) plus
  smaller drift on ans_002/ans_009 — embed-v4's chunk ranking concentrates
  answer-mode retrieval for that query. Flagged in the todos to fold into
  the planned answer-golden-set redo (the set is known-flawed: ans_002 has
  scored 0% at chunk level in every run of every configuration). Cite was
  the stated priority for this phase.
- Dense lane cross-lingual behavior is unchanged at the smoke level
  (16/16, rank 1 everywhere, all tier=strong) with slightly wider
  floor-survivor sets (floor_docs up to 21 vs 16), consistent with
  embed-v4 retrieving more cross-lingual neighbors.
- Latency: lanes ~0.7–1.2s, rerank path ~1.2–1.9s per query from a laptop
  with two cross-region hops — same envelope as pre-cutover; the tracked
  latency workstream is unaffected by the cutover.

## Rollback (while the backup table exists)

```sql
UPDATE document_chunks c
SET embedding = b.embedding, embedding_model = b.embedding_model
FROM document_chunks_embedding_backup_20260722 b WHERE b.id = c.id;
```
then re-add `EMBEDDING_MODEL=text-embedding-3-small` to
`search-service/.env.local` and restart. Drop the backup table once the
cutover has soaked.
