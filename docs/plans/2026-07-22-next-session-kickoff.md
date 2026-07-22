# Next-Session Kickoff — Multilingual v3 (post-PR-#248 state)

Written at the end of the 2026-07-22 marathon session. Paste the prompt at
the bottom into a fresh session to resume.

## State at handoff (all verified, committed, pushed)

- **Draft PR #248** (`multilingual-v3` → `qa`): rebased on current qa, CI
  green (4/4 incl. Terraform Validate), full evidence in the description.
  Awaiting team review → un-draft → merge. Merge auto-deploys.
- **Phase A secrets: DONE** — `EMBEDDING_MODEL=text-embedding-3-small`
  pinned in repo-level `SEARCH_SERVICE_ENV` + `INGESTION_WORKER_ENV`
  (production shadows untouched). `MISTRAL_API_KEY` deliberately deferred
  to Phase D — must be an ORG key; rotate the personal key afterwards.
  Stale `VOYAGE_API_KEY` secret deleted (revoke on the Voyage side too).
- **All gates passed**: cite tuned (per-doc cap, floor 0.09 —
  P30.6/R83.1/F1 43.2, best recorded); local embed cutover done (corpus
  all cohere-embed-v4); Mistral parse ratified + Phase 1 gate PASS (local
  corpus Mistral-parsed); L0 latency package landed (off-event-loop,
  instrumentation + EMF, botocore timeouts, warmup, embed LRU — repeat
  query 1322→680ms measured).
- **Local machine**: worktree `.worktrees/multilingual-v3` (own venv);
  main checkout's dense retrieval is BROKEN vs the local DB until merge;
  vector rollback table `document_chunks_embedding_backup_20260722` held
  until soak; 2 docs' PDFs missing from local MinIO (todo).

## Ordered next steps

1. Watch PR #248 review → un-draft → merge → **Phase B validation** per
   `docs/runbooks/qa-deploy-multilingual-v3.md` (deployed /health, rerank
   live check, EMF metrics appearing in CloudWatch).
2. **Phase C — RDS embed cutover** (separate event): backup → re-embed
   (batch 24, adaptive, `us.cohere.embed-v4:0` profile, role creds) →
   flip pins in BOTH service secrets → re-derive cite floor on RDS →
   eval battery.
3. **Phase D — Mistral parse flip**: org Mistral key → `PARSE_BACKEND=mistral`
   in worker env → bulk re-ingest (ONE worker, `BEDROCK_EMBED_BATCH_SIZE=24`)
   → language-diff review.
4. Follow-ups by priority: latency L1 (verify Rerank 3.5 in-east) + L2
   (stream answer synthesis — biggest perceived win; frontend track);
   answer-golden-set redo (incl. ans_006 investigation); todos doc for the
   rest (fusion misses, negation queries, missing local PDFs, cleanup of
   BDA project `07aee510a362` + bucket `askwri-parse-bakeoff-905418285725`).

## Key documents (all on the branch)

`2026-07-22-multilingual-v3-todos.md` (running list) ·
`qa-deploy-multilingual-v3.md` (deploy ordering + rollback) ·
`2026-07-22-local-cohere-cutover-report.md` ·
`2026-07-22-parse-bakeoff-phase0-results.md` (incl. Phase 1 gate) ·
`2026-07-22-query-latency-workstream.md` + research reports ·
spec `2026-07-07-multilingual-retrieval-ingestion-design-spec.md` (§7 amended).

## Kickoff prompt

```
Resume the multilingual-v3 workstream. I'm in the worktree
.worktrees/multilingual-v3 (branch multilingual-v3, draft PR #248 → qa).
Read docs/plans/2026-07-22-next-session-kickoff.md first — it has the full
handoff state — then check PR #248's review/merge status and the current
todos doc, and tell me where we are and what's next. Standing rules: TDD,
conventional commits (no Co-Authored-By), stage files explicitly, preserve
the /query contract, every threshold change re-derives via the capture/
analyze scripts, bulk Bedrock jobs use batch 24 + adaptive + ONE worker,
and ask before starting implementation work.
```
