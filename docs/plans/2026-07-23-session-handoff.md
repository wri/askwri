# Multilingual v3 — Session Handoff (2026-07-23)

Pick-up doc for a fresh agent. Companion planning notes:
`docs/runbooks/qa-deploy-multilingual-v3.md` (Phase A-D runbook + Phase C execution log),
`docs/plans/2026-07-22-multilingual-v3-todos.md` (running todos),
`docs/plans/2026-07-22-phase-c-kickoff.md` (Phase C procedure, historical).

Work happens in worktree `.worktrees/multilingual-v3`. RDS access:
`./scripts/with-remote-env.sh qa <cmd>` (reads DB creds from the qa ECS task
def, forces SSL; needs a live `aws login` + your IP on the RDS SG, us-east-2,
acct 905418285725). AWS creds use the auto-refreshing `login` provider.

---

## CURRENT STATE (verified 2026-07-23)

**qa (RDS `qa` on askwri-db1):** 168 docs, 30,435 chunks, **100% `cohere-embed-v4`**
(zero `text-embedding-3-small`). Parse layer: **8 docs Mistral, 160 pypdf**, 0 `/gid`
glyph garbage. Deployed search-service on cohere dense + Cohere Rerank 3.5 **us-east-1**;
cite floor **0.09**; total query latency ~1s.

**local (docker `qa` on localhost:5432):** 172 docs, ~28.2k chunks, **171/172 Mistral**,
all cohere. This is the Phase-1 full-Mistral corpus.

**Deployed worker** (`askwri-app-qa-ingestion-worker`): `PARSE_BACKEND=mistral` +
`MISTRAL_API_KEY` (**personal key — rotation debt**) + `BEDROCK_EMBED_BATCH_SIZE=24` +
`AWS_RETRY_MODE=adaptive`/`AWS_MAX_ATTEMPTS=10`/`BEDROCK_EMBED_MODEL_ID=us.cohere.embed-v4:0`.
So **all NEW qa ingests parse via Mistral**; the existing 160 pypdf docs stay pypdf until re-ingested.

**GitHub secrets (repo-level; qa uses these, production has its own env-scoped copies that
were NOT touched):** `SEARCH_SERVICE_ENV` (5 keys, no EMBEDDING_MODEL),
`INGESTION_WORKER_ENV` (8 keys incl. the Mistral + bulk-embed vars).

**RDS backup tables (rollback; keep until validated):**
- `document_chunks_embedding_backup_20260722` (30,435 rows — pre-cohere vectors)
- `document_texts_glyph_backup_20260723` (8) + `document_chunks_glyph_backup_20260723` (1736)

**Branches / PRs:**
- #248, #249 merged (multilingual-v3 + reingest --ids).
- #251 MERGED — Phase C provenance + rerank region flip (us-east-1).
- #252 MERGED — glyph-fix docs.
- **#253 OPEN** — `CITE_PRESET.fusionTopK 200->500` (branch `fix/cite-fusion-topk-cohere`). **Merge decision pending.**
- **#250 OPEN** — `fix(eval): chunk-precision double-count + q11 golden-set contradiction` (someone else's; relevant to golden-set cleanup).

---

## WHAT HAPPENED THIS SESSION

**Phase C — RDS embed cutover (DONE, deployed).**
1. Backed up RDS vectors -> re-embedded all 30,435 chunks to cohere-embed-v4 (batch 24 +
   `us.cohere.embed-v4:0` profile; an auto-resume loop absorbed 2 ThrottlingExceptions —
   even the 300k-TPM bucket throttles, so per-batch-commit resumability is essential).
2. Flipped the `EMBEDDING_MODEL` pin out of both secrets + added worker bulk-embed vars;
   redeployed both services (run 29968575474). Kept cite floor 0.09.
3. Folded in the rerank region flip us-west-2 -> us-east-1 (#251, run 29970241143):
   measured rerank stage2 **610ms -> 560ms** (~50ms), total ~1055 -> ~994ms.

**Phase D-lite — glyph repair (DONE, deployed).**
- Discovered deployed RDS was pypdf all along (Mistral had only ever run locally). 8 docs
  had `/gid` glyph garbage. Configured the worker for Mistral (run 29976819358) and
  targeted-re-ingested the 8 (`reingest_all --ids`): now 0 `/gid`, clean Mistral markdown,
  cohere chunks, searchable. This also flipped the deployed worker to Mistral for all future ingests.

**Recall gap — ROOT-CAUSED (the big finding).**
- Deployed "cite recall 66.9 vs local 83.1" was a **measurement artifact**, NOT a
  regression. The eval harness sends no `fusion_top_k` (-> service default **500**); the
  production proxy uses `CITE_PRESET.fusionTopK=200`. **Evals measured a pool users never get.**
- 0 of 70 golden expected docs are missing from the qa corpus — the gap is 100% retrieval.
- The 200 cap was tuned for text-embedding-3-small (old comment "0.6% loss vs 500" true then);
  cohere-embed-v4 spreads expected docs into the 200-500 fused band, so 200 now costs ~15pp.
- Deployed sweep (denseTopK=500): recall **66.9@200 -> 78.9@300 -> 82.3@400/500 -> 83.1@700**;
  **rerank latency FLAT** (rerank capped at `rerank_candidates=100` regardless of fusion depth).
- Fix = #253: `fusionTopK 200->500` (matches eval default; satisfies `rerankTopN>=fusionTopK`;
  real-user recall 66.9 -> 82.3, +15.4pp, ~0 latency).
- A subagent fanout diagnosed the misses **at the wrong operating point (fusion 200 -> 23 misses);
  at 500 it is 13.** Its category split (of the 23): 12 genuinely-relevant, 8 weak-labels, 3 negation.
  Real retrieval lane = **LVC vocabulary drift**; WRR series-membership = metadata-facet; rest = golden-set artifacts.

**META-LESSON:** any deployed measurement via `/api/llamaindex` MUST match the eval harness
params (`fusion_top_k`=500, denseTopK/sparseTopK) or it under-reports. A constant (golden-set
artifacts) can NEVER explain a delta between two measurements.

---

## WHAT'S LEFT (prioritized)

0. **Decide + merge #253** (fusion_top_k fix). It's a +15pp win on today's corpus and safe;
   recommend merging now, then re-confirm post-reparse.
1. **Full Phase D re-parse of the ~160 pypdf docs on qa** — the agreed **prerequisite** for any
   retrieval/latency tuning (calibrate on the FINAL corpus, not one about to change under you).
   - Approach: **re-parse on qa, do NOT copy local rows.** (Local shares ZERO document IDs with
     qa — different UUIDs; only 157/168 match by URL — AND local sparse vectors index into
     local's `keyword_vocab`, so copying would break qa's sparse lane. Copy = fragile + still
     forces a downstream rebuild.)
   - Procedure: back up `document_texts` + `document_chunks` for the pypdf docs -> `reingest_all`
     the pypdf docs (select where `full_text NOT LIKE '%![%](%'` and status<>'withdrawn') ->
     deployed Mistral worker re-parses from S3 -> re-chunk -> re-embed -> rebuild sparse against
     qa vocab -> monitor `ingestion_jobs` -> verify uniform Mistral (md-images count == doc count).
   - Cost: ~1-3 hrs on ONE worker, throttle-prone, personal Mistral key (API cost + rate),
     in-place text mutation. Expect chunk count to drop ~9%.
2. **Re-derive floor + re-confirm `fusion_top_k`** on the all-Mistral corpus (local floor moved
   0.10->0.09 with Mistral, so tuning is parse-sensitive). Use `capture_cite_scores` +
   `analyze_cite_scores` (needs a service with `CITE_LOGIT_FLOOR=0` — a local service pointed at
   RDS, since the deployed floor can't be zeroed).
3. **Retrieval quality lanes** (post-uniform-corpus): (a) LVC vocabulary-drift synonym/glossary
   expansion (land-pooling/readjustment/Rail+Property <-> "land value capture"); (b) series/
   collection metadata facet for enumeration queries (WRR case studies).
4. **Latency L2** (frontend track): stream answer synthesis, result cache. L0 done; L1 partly done (rerank region).
5. **Phase C step 10** (post-soak): 3-small partial-index DROP migration (TypeORM raw SQL,
   synchronize=false, TDD); drop the 3 backup tables; consider REINDEX on the cohere HNSW (30k-row rewrite bloat).
6. **Rotation debt:** swap the personal Mistral key for an ORG/team key + revoke the personal one.
7. **Production cutover:** mirror Phase A->C on production (its OWN env-scoped secrets; re-embed production RDS).
8. **Bake-off cleanup:** delete BDA project `07aee510a362` + scratch bucket `askwri-parse-bakeoff-905418285725`.
9. **FULL DOCUMENTATION REVIEW after Phase D completes** (explicit ask 2026-07-23): reconcile
   the runbook, todos, document-management.md, CLAUDE.md, and this handoff against the final
   all-Mistral / all-cohere / us-east-1-rerank / fusion-500 reality; retire stale/interim notes.

---

## OPEN QUESTIONS (emerged this session)

- **Corpus completeness:** qa has 168 docs vs local's 172 (157 URL-matched; 11 qa docs lack a
  URL). Do the missing ~4 belong on qa before freezing the corpus for tuning? (They do NOT
  affect the golden set — 0 expected docs missing.)
- **fusion_top_k 500 vs 700:** 700 gains +0.8pp (one borderline doc) but violates
  `rerankTopN >= fusionTopK` unless rerankTopN is also raised. Revisit after re-parse.
- **Answer-mode preset:** does `ANSWER_PRESET.fusionTopK=100` carry the same stale
  3-small-era calibration? Re-derive answer-mode fusion/floor on cohere too.
- **Does re-parse move floor/fusion_top_k materially?** Local floor moved 0.10->0.09 with Mistral;
  re-validate both on the all-Mistral qa corpus.
- **Candidate diversification** (per-doc cap=2, 100 slots ~= 50 docs) is calibrated for ~170 docs;
  revisit `rerank_candidates` + cap at larger corpus scale (existing todo).
- **LVC drift fix placement:** query-side synonym expansion vs embed-time — which?
- **Metadata features vs golden-set rescope** for q9 (WRR membership), q10 (date "since 2020"),
  q11 (negation) — retrieval doesn't claim these; build features or rescope the set? (see #250)
- **Answer golden set is flawed** (ans_002 0% chunk-level every run; ans_008 >100% precision) — redo.
- **ans_006 regression** under embed-v4 (85.8->75.6 doc-F1 locally) — fold into answer-set redo.

---

## KEY GOTCHAS / MECHANISMS (so the next agent doesn't re-learn)

- **Secret changes are classifier-blocked for the agent.** Rebuild GitHub secrets from the live
  task def (values never printed) and have the USER run the script via `! bash <path>`. Redeploy
  with `gh workflow run deploy-qa.yml --ref qa` (the sanctioned force-deploy; docs-only pushes skip it).
- **Bulk Bedrock embed = batch 24 + AWS_RETRY_MODE=adaptive + the `us.cohere.embed-v4:0` profile
  + ONE worker + an auto-resume loop.** Throttling is expected even on the 300k bucket.
- **Credential footgun:** `search-service/.env.local` carries FAKE MinIO AWS keys; for local
  scripts that need real Bedrock, comment them out so boto3 uses the `~/.aws` login provider
  (restore after). Deployed uses the task role (immune).
- **Measurement parity:** replay golden queries through `/api/llamaindex` with
  `denseTopK/sparseTopK` AND `fusion_top_k=500` to match the eval harness. The stock
  `npm run eval:cite` hits `/query` directly, which deployed qa does NOT expose publicly.
- Preserve the `/query` request/response contract exactly. TDD; conventional commits, NO Co-Authored-By;
  `git add <explicit paths>` (never -A); every threshold change re-derived via capture/analyze (don't hand-tune).
