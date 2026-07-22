# Resuming the Multilingual v3 Retrieval Workstream

> **STATUS 2026-07-22 — much of this document is now historical.** The
> branch is rebased onto qa (mechanics section done); Phase B is live-
> validated and cite-tuned; the LOCAL embed cutover is complete (corpus
> all cohere-embed-v4); the parser is **Mistral OCR, not Gemini** (spec §7
> amendment); the parse Phase 1 gate run is in flight. Current state
> lives in: `2026-07-22-multilingual-v3-todos.md` (running list),
> `2026-07-22-local-cohere-cutover-report.md` (cutover execution),
> `2026-07-22-parse-bakeoff-phase0-results.md` (parser decision), and
> `docs/runbooks/qa-deploy-multilingual-v3.md` (deploy ordering).

**Branch:** `multilingual-v3` (this branch)
**Split off:** `qa-wip-david` on 2026-07-08. The retrieval work was stacked on
top of the doc-mgmt work; `qa-wip-david` was reset back to `0042875` (pure
doc-mgmt) and the five retrieval commits live here:

| Commit | What |
|---|---|
| `a9ebc16` | (superseded) self-hosted bge-reranker swap — v1 spec |
| `83da460` | revert of the above (spec v3 §0.1: no self-hosted models) |
| `d46ece1` | **v3 B1** — dense lane → Cohere embed-v4 via Bedrock (provider, model-aware embed stage + dense retriever, HNSW index migration `1783454000000`, `scripts/reembed_cohere.py`, Bedrock IAM in terraform) |
| `a2d9356` | **v3 B2** — rerank → Cohere Rerank 3.5 via Bedrock (BedrockReranker, candidate cut, 0–1 floor/tiers, floor gated on rerank-actually-ran, model-free image) |
| `0d39fd2` | `docs/runbooks/bedrock-local-testing.md` |

Spec: `docs/plans/2026-07-07-multilingual-retrieval-ingestion-design-spec.md`
(v3, all-Bedrock — committed on this branch). **v1/v2 self-hosted approaches
are dead; never reintroduce in-process models.**

## Branch mechanics

This branch **contains** the doc-mgmt work as its base — it is a stacked
branch, not an independent one (the retrieval code builds on branch-only
worker/embed/test code). Merge order:

1. `qa-wip-david` (doc-mgmt) PRs into `qa` first.
2. Then: `git switch multilingual-v3 && git rebase qa` — after the rebase the
   diff vs `qa` is just the retrieval commits. Its PR reads clean.
3. Continuing work before doc-mgmt merges is fine — just keep committing here.

If `qa-wip-david` gains MORE doc-mgmt commits before merging, rebase this
branch onto it to stay stacked: `git rebase qa-wip-david`.

## Local-machine state left behind (2026-07-08)

- `search-service/.env.local` (gitignored) has a pre-cutover pin at the
  bottom: `EMBEDDING_MODEL=text-embedding-3-small`. Harmless on the doc-mgmt
  branch (settings ignore unknown vars). **Remove it only after the
  full-corpus re-embed** (runbook Step 6).
- The local qa DB already has the cohere HNSW index applied (migration
  `1783454000000`) and its row in the `migrations` table. Harmless — but
  **do not run `npm run migration:revert` while on a branch that lacks this
  migration file** (TypeORM reverts the last APPLIED migration and won't
  find the class). Switch to `multilingual-v3` first if a revert is ever
  needed.
- No AWS/Bedrock credentials exist on this machine (only MinIO stubs in
  `.env.local`).

## What is DONE

- Phase B code-complete, all suites green at `0d39fd2` (pytest 160, jest
  260, `/query` contract e2e, mixed-model coexistence tests).
- Verified without creds: lanes smoke matches baseline (bm25 11/16, dense
  16/16); `rerank=true` degrades gracefully to fused results when Bedrock is
  unreachable.
- Terraform: `bedrock:InvokeModel` + `bedrock:Rerank` on the shared ECS task
  role (in `terraform/infrastructure/ecs.tf`) — written, **not applied**.

## What is NOT done (resume here)

1. **Live Bedrock validation** — blocked on AWS credentials + model-access
   enablement. Follow `docs/runbooks/bedrock-local-testing.md` Steps 1–4
   (sanity calls, latency vs the §9 budget, smoke set with `--rerank`).
2. **Derive the real 0–1 cite floor/tiers** on the smoke set. The values in
   `search-service/app/config.py` (floor 0.01 / partial 0.30 / strong 0.70)
   are PROVISIONAL placeholders. `TODO(golden-set)` markers stand for the
   formal per-language recalibration when labels arrive.
3. **Canary re-embed** (`scripts/reembed_cohere.py --limit 500`), then
   **PAUSE for review** (spec-mandated) before the full-corpus re-embed +
   removing the `.env.local` pin.
4. **Phase C** — ingestion upgrade (spec §7): Gemini parse + retained
   markdown/layout artifacts, pypdf text-layer validation gate
   (numeric-token equality), heading-aware chunking with char offsets +
   heading_path, per-chunk context line. Disjoint files from Phase B; needs
   a Gemini API key.
5. **Phase D** — batch re-ingest the 169 migrated docs through the upgraded
   pipeline.
6. **Phase E** — English-display surface (title_en/summary_en + labeled
   native passage; leave the snippet-translation seam).
7. **Deploy prerequisites** — terraform apply (IAM), Bedrock model access in
   us-east-1 (embed-v4) + us-west-2 (Rerank 3.5), then the deploy runbook
   ordering (`docs/runbooks/qa-push-deploy.md`) + re-embed in the deployed
   env.

## Kickoff prompt for a future session

```
Resume the multilingual v3 retrieval workstream on branch multilingual-v3.
Read docs/plans/2026-07-08-multilingual-v3-resume.md and the v3 spec
(docs/plans/2026-07-07-multilingual-retrieval-ingestion-design-spec.md),
then continue from the "What is NOT done" list. TDD, conventional commits
(no Co-Authored-By), stage files explicitly, preserve the /query contract
shape. The golden set is still blocked — interim gate is the non-English
smoke set (--rerank flag) + spot-checks. PAUSE before the full-corpus
re-embed cutover.
```

The interim eval gate, smoke-set baselines, and English eval baselines from
2026-07-07 are in `evaluation/results/` (`non-english-smoke-reranker-before-*`,
`eval-report-1783452392011.json` = cite baseline P24.2/R82.2,
`answer-retrieval-1783452426704.json` = doc-level F1 78.2).
