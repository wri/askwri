# Multilingual v3 — Session Handoff (updated 2026-07-23, post-Phase-D)

Pick-up doc for a fresh agent. **Phase D is DONE** — the qa corpus is now
uniformly Mistral-parsed and all-cohere, and the cite thresholds have been
re-derived on it. Retrieval/latency tuning is unblocked.

Companions: `docs/runbooks/qa-deploy-multilingual-v3.md` (Phase A-D runbook +
execution logs), `docs/plans/2026-07-22-multilingual-v3-todos.md` (running
todos), `docs/research/2026-07-23-cite-floor-rederivation.md` and
`docs/research/2026-07-23-answer-golden-remap.md` (this session's derivations).

Work happens in worktree `.worktrees/multilingual-v3`. RDS access:
`./scripts/with-remote-env.sh qa <cmd>` (reads DB creds from the qa ECS task
def, forces SSL; needs a live `aws login` + your IP on the RDS SG, us-east-2,
acct 905418285725).

---

## CURRENT STATE (verified 2026-07-23, post-Phase-D)

**qa (RDS `qa` on askwri-db1):** 168 docs, **27,878 chunks**, 100%
`cohere-embed-v4`, **168/168 Mistral-parsed** (0 pypdf, 0 `/gid`), all
`searchable`. Sparse rebuilt: `n_chunks` 27,878, `avgdl` 199.8, vocab 233,936
(23% of `SPARSE_DIM`), 0 nulls. Languages: en 139, zh 16, es 9, pt 3, id 1.

**Retrieval config:** dense `cohere-embed-v4` via Bedrock us-east-1; sparse
Postgres BM25 (English-only stemmer); RRF alpha 0.5; rerank Cohere Rerank 3.5
via Bedrock **us-east-1**, `rerank_candidates=100`, cite `per_doc_cap=2`;
cite floor **0.09**, tiers 0.30/0.70; `CITE_PRESET` fusionTopK **500**,
rerankTopN 500, maxResults **25** (was 100 — see below).

**local (docker `qa` on localhost:5432):** 171 docs, ~28.2k chunks, Mistral,
all cohere. Shares **zero** doc IDs with qa and has its own `keyword_vocab`,
so rows are never copyable between them.

**Deployed worker:** `PARSE_BACKEND=mistral` + `MISTRAL_API_KEY` (**personal
key — rotation debt, now urgent**) + `BEDROCK_EMBED_BATCH_SIZE=24` +
`AWS_RETRY_MODE=adaptive`/`AWS_MAX_ATTEMPTS=10`/`BEDROCK_EMBED_MODEL_ID=us.cohere.embed-v4:0`.

**RDS backup tables (keep until soak completes):**
`document_chunks_embedding_backup_20260722` (30,435 — pre-cohere vectors),
`document_texts/chunks_glyph_backup_20260723` (8 / 1,736),
`reparse_pypdf_docs_20260723` (160 ids + pre-state),
`document_texts_reparse_backup_20260723` (160),
`document_chunks_reparse_backup_20260723` (28,699 / 281 MB),
`document_chunks_sparse_backup_20260723` (27,878).

---

## WHAT HAPPENED THIS SESSION (2026-07-23)

**Phase D — full corpus re-parse (DONE).** 160 pypdf docs re-parsed via the
deployed Mistral worker. **160/160 done, ZERO errors**, ~2h50m, one worker.
Chunks -8.2% on the re-parsed set, matching prediction. Full log in the runbook.

**Language flips went the OPPOSITE way to the prediction — and that was
correct.** Expected: 3 docs (3778/2705/6821) flipping *to* `en`; they were
already `en` on qa and correctly did not move (that prediction described the
LOCAL corpus). What actually happened: **7 docs flipped `en` -> es/zh/id**,
all verified corrections — pypdf's cover-biased text had genuinely non-English
documents mislabeled. `documents.language` is metadata; it does not filter
retrieval.

**Sparse rebuild is mandatory after a bulk re-parse.** `keyword_corpus_stats`
was stale (30,435 vs 27,878 actual) and the embed stage assigns new tokens
IDF from those frozen stats. Rebuilt before any threshold work.

**Cite re-derivation (DONE).** The structural finding: **the UI renders every
returned doc** (`results/page.tsx` `pageDocs = supporting`, no slice), so
`maxResults` — not the logit floor — bounds list length; at 100 lists ran from
a handful to 46 docs. Shipped `maxResults` 100 -> **25**: recall IDENTICAL
(83.3 macro / 90.2 excl-q11), precision 29.2 -> 32.0, F1 43.3 -> 46.2. Floor
**held at 0.09** against a macro-F1 peak at 0.14 that costs 13pp recall —
cite is recall-first by design, and 0.14 cuts into a 20.5%-precision band.

**Recall ceiling is 90.7% (top-30):** 59/66 expected docs reach the reranker.
**LVC vocabulary drift is now the biggest remaining lever**, bigger than any
threshold tuning.

**q11 excluded from threshold derivation.** 5 of its 7 expected docs never
enter the candidate pool (3 are LVC docs); recall capped at 2/7 regardless of
threshold. It informs the LVC + golden-set-rescope lanes, not thresholds.

**SECURITY: both API keys were printed in plaintext** by a routine pytest
failure (pydantic `Settings` repr). Masking fixed in #258; **the keys still
need rotating**. See the todos' Security section.

---

## OPEN PRs (all green, none merged as of writing)

| PR | What | Note |
|---|---|---|
| #250 | eval harness corrections (chunk double-count, q11) | **merge FIRST** — #257 is based on it |
| #255 | configurable answer per-doc rerank cap | default `None`, no behaviour change |
| #256 | conditional 3-small index drop migration | needs manual `migration:run` on qa after |
| #257 | answer golden-set chunk-ID remap | needs #250 |
| #258 | `SecretStr` masking for API keys | |
| #259 | cite `maxResults` 100 -> 25 | |

**Merge caveat:** every merge to `qa` triggers a full deploy and there is **no
`concurrency:` guard** in `deploy-qa.yml`, so back-to-back merges race
overlapping deploys. Merge all, then fire ONE
`gh workflow run deploy-qa.yml --ref qa`.

---

## WHAT'S LEFT (prioritized)

1. **Merge the six PRs + single redeploy**, then run `migration:run` against qa
   for #256 (CI does not run migrations).
2. **Rotate both API keys** (see todos Security). Mistral: provision an ORG key,
   rebuild `INGESTION_WORKER_ENV`, redeploy, revoke the personal one. Mistral
   OCR is **not** on Bedrock, so there is no task-role escape from the external
   key — the AWS-native path is BDA + caption dedup.
3. **LVC vocabulary drift** — the largest remaining recall lever. Synonym/
   glossary expansion (land-pooling, readjustment, Rail+Property <-> "land
   value capture"); query-side vs embed-time placement undecided.
4. **Answer-mode calibration**: `ANSWER_PRESET.fusionTopK=100` and answer
   thresholds have NEVER been re-derived on cohere. Plus the per-doc-cap A/B
   (#255 added the setting; ans_006 doc-F1 is 28.6).
5. **Tier boundaries (0.30/0.70) not re-derived** — only floor and cap were.
6. **Latency L2**: stream answer synthesis, result cache.
7. Phase C step 10 leftovers: drop the backup tables after soak; consider
   `REINDEX` on the cohere HNSW (two full table rewrites).
8. **Production cutover**: mirror Phase A->D on production (own env-scoped
   secrets; re-embed + re-parse). #256's migration stays a no-op there until
   that happens, by design.
9. Bake-off cleanup: delete BDA project `07aee510a362` + scratch bucket
   `askwri-parse-bakeoff-905418285725`.

---

## KEY GOTCHAS (so the next agent doesn't re-learn)

- **Secret changes are classifier-blocked for the agent.** Rebuild GitHub
  secrets from the live task def (values never printed) and have the USER run
  the script via `! bash <path>`. Redeploy with
  `gh workflow run deploy-qa.yml --ref qa`.
- **Bulk Bedrock embed = batch 24 + `AWS_RETRY_MODE=adaptive` + the
  `us.cohere.embed-v4:0` profile + ONE worker.** Phase D needed no throttle
  intervention with these.
- **Credential footgun:** `search-service/.env.local` carries FAKE MinIO AWS
  keys that load via `load_dotenv(override=False)` and beat the real `~/.aws`
  provider. Comment them out for local Bedrock work, **restore after**.
  Deployed uses the task role (immune).
- **`build_sparse_keyword.py` after ANY bulk re-ingest**, before threshold work.
- **Bulk enqueue is not FIFO**: all ids insert in one transaction so
  `created_at` is identical and claim order is arbitrary. `done` stays flat
  then jumps — that is not a stall.
- **Measurement parity**: `capture_cite_scores.py` sends no `fusion_top_k`, so
  it uses the service default 500 — which now equals `CITE_PRESET.fusionTopK`.
  Evals and users finally measure the same pool. Any OTHER deployed measurement
  via `/api/llamaindex` must pass matching params or it under-reports.
- **A constant can never explain a delta between two measurements** — the
  lesson from the 66.9-vs-83.1 recall gap, which was a params artifact.
- Preserve the `/query` contract exactly. TDD; conventional commits, NO
  Co-Authored-By; `git add <explicit paths>` (never `-A`); re-derive thresholds,
  never hand-tune.
