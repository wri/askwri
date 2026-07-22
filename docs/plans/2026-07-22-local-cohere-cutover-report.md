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
| Full re-embed take 2 (`--batch-size 24`, adaptive retry, login provider) | IN PROGRESS — fill in below |
| Remove `EMBEDDING_MODEL` pin from `search-service/.env.local` | pending |
| Service restart + health | pending |
| Post-cutover eval battery | pending |
| Floor re-validation (capture + sweep) | pending |

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

(to be filled in on completion)
