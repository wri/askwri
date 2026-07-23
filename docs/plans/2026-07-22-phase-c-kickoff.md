# Phase C — RDS embed cutover — new-session kickoff (2026-07-22)

Paste the block below into a fresh session.

```
Drive Phase C of the multilingual-v3 workstream: the qa RDS embedding cutover
from text-embedding-3-small to Cohere embed-v4. Work in the worktree
.worktrees/multilingual-v3 (branch is merged; base new work on qa). You OWN
this worktree's git state for this task — a parallel session is running only
read-only local analysis that writes nothing to the git tree here.

FIRST read, in order:
  1. docs/runbooks/qa-deploy-multilingual-v3.md — Phase C is steps 6–10; the
     "Phase B validation — EXECUTED 2026-07-22 (PASS)" block is the current
     deployed state.
  2. docs/plans/2026-07-22-multilingual-v3-todos.md — "Pre-cutover checklist
     (FULL re-embed gate)" and "Re-embed / Bedrock quotas" sections are the
     hard-won gotchas; several boxes are already checked from the local dry run.
  3. docs/plans/2026-07-22-local-cohere-cutover-report.md — the local execution
     log this mirrors on RDS (failure modes + rollback).

CURRENT STATE (verified today):
  - #248 + #249 merged to qa; Phase B deployed and validated. Deployed dense
    lane is STILL text-embedding-3-small via the EMBEDDING_MODEL pin in both
    GitHub secrets SEARCH_SERVICE_ENV and INGESTION_WORKER_ENV. The code
    DEFAULTS to cohere-embed-v4 — the pin is the only thing keeping RDS on
    3-small.
  - Migration 1783454000000 (scoped cohere HNSW index
    idx_chunks_embedding_hnsw_cohere_v4, partial WHERE embedding_model=
    'cohere-embed-v4') is ALREADY APPLIED on RDS (done earlier today). It is
    empty now and fills as you write cohere rows. Verify it exists before
    re-embedding: ./scripts/with-remote-env.sh qa psql -tAc "SELECT indexname
    FROM pg_indexes WHERE tablename='document_chunks' AND indexname LIKE
    '%cohere%';"
  - Dense-lane graceful degradation is LIVE (sparse-only fallback + /health
    dense_lane field), so a transient dense hiccup during cutover degrades
    rather than 500s.
  - RDS is provisioned OUTSIDE this repo's terraform. RDS access = the
    ./scripts/with-remote-env.sh qa <cmd> wrapper (reads DB_* from the ECS
    task def, forces SSL). Your IP must be on the RDS security group and you
    need a live `aws login` (us-east-2, account 905418285725).

PROCEDURE (runbook steps 6–10):
  6. BACK UP VECTORS FIRST (one-way door -> two-way). On RDS:
       ./scripts/with-remote-env.sh qa psql -c "CREATE TABLE
        document_chunks_embedding_backup_20260722 AS SELECT id, embedding,
        embedding_model FROM document_chunks;"
     (~250MB per 30k chunks; drop only after validation. NOTE: a LOCAL backup
     table of the same name exists in the local docker DB — that is a
     different database; make the RDS one too.)
  7. RE-EMBED (ONE process, resumable, commits per batch):
       cd search-service
       # refresh creds IMMEDIATELY before (run is 45–60 min vs ~1h token life)
       aws login --region us-east-2      # or your SSO login
       # CREDENTIAL FOOTGUN: search-service/.env.local carries FAKE MinIO AWS
       # keys, and app/env.py load_dotenv(override=False) lets them WIN unless
       # real creds are already in the shell env. reembed is long, so a static
       # `aws configure export-credentials` snapshot WILL expire mid-run — use
       # the AUTO-REFRESHING login provider instead: comment out / remove
       # AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY from search-service/.env.local
       # for the duration so boto3 falls through to the ~/.aws SSO cache
       # (botocore[crt] is in requirements-dev.txt). reembed skips already-
       # cohere rows, so a mid-run death loses nothing — just rerun.
       # Point DATABASE_URL at RDS for this script (with-remote-env only wraps
       # single commands; for the long script, export the RDS DATABASE_URL the
       # same way the runbook shows, sslmode=require).
       AWS_RETRY_MODE=adaptive AWS_MAX_ATTEMPTS=10 \
       BEDROCK_EMBED_MODEL_ID=us.cohere.embed-v4:0 \
       ./venv/bin/python -m scripts.reembed_cohere --batch-size 24
     - batch 24 + the us.cohere.embed-v4:0 inference profile (300k TPM) is the
       path of record. Batch 96 dies on ThrottlingException. ONE process only —
       parallel workers share the token bucket and triple the throttle rate.
     - The task-role grant covers the profile ARN, but THIS script runs under
       YOUR SSO creds — confirm your SSO principal can bedrock:InvokeModel the
       profile + underlying model (the local canary this session proved it can).
  8. FLIP THE PINS TOGETHER: remove EMBEDDING_MODEL from BOTH GitHub secrets
     SEARCH_SERVICE_ENV and INGESTION_WORKER_ENV (they are the terraform
     TF_VAR_*_secret_env inputs; Phase A ADDED the pin the same way — rebuild
     the secret value minus the EMBEDDING_MODEL line, keep everything else incl.
     the worker's AWS_RETRY_MODE/AWS_MAX_ATTEMPTS/BEDROCK_EMBED_MODEL_ID lines).
     Then redeploy BOTH services (push to qa / rerun the deploy) so they pick up
     cohere at the same time. A worker left pinned silently writes 3-small rows
     into an all-cohere corpus.
  9. RE-VALIDATE THE CITE FLOOR against the RDS-backed service (embed-v4 moves
     it — locally it went 0.08 -> 0.10 -> 0.09). With SEARCH_SERVICE_URL / the
     eval env pointed at deployed qa:
       cd search-service && CITE_LOGIT_FLOOR=0 ./venv/bin/python -m
         scripts.capture_cite_scores   (writes evaluation/results/cite-score-capture.json)
       ./venv/bin/python -m scripts.analyze_cite_scores
     Adjust CITE_LOGIT_FLOOR / tiers in search-service/app/config.py ONLY if the
     macro-F1 peak shifted; then run the full eval battery (npm run eval:cite,
     npm run eval:answer-retrieval, non-english smoke) and record before/after.
     TDD + conventional commit for any config change; new branch off qa (e.g.
     chore/phase-c-rds-cutover) + PR.
 10. AFTER SOAK: write the 3-small partial-index DROP migration (anticipated in
     1783454000000's comment — idx_chunks_embedding_hnsw for embedding_model=
     'text-embedding-3-small' goes empty after the rewrite) via a new TypeORM
     migration (raw SQL, synchronize=false, TDD), and DROP the RDS backup table.
     Also consider REINDEX on the cohere HNSW index (30k-row rewrite bloats it).

VERIFY AT EXIT:
  - RDS: every chunk embedding_model='cohere-embed-v4'
    (./scripts/with-remote-env.sh qa psql -tAc "SELECT embedding_model,
     count(*) FROM document_chunks GROUP BY 1;") — zero 3-small rows.
  - /health (GET https://qa.askwri-app.org/api/llamaindex -> hybrid_service):
    dense_lane.status 'live'; cite query POST returns relevance_tier tiers;
    lane_timings show dense working; total_ms still ~1s.
  - Both GitHub secrets no longer contain EMBEDDING_MODEL; both services
    redeployed; a fresh test ingest writes cohere rows.
  - Eval battery numbers recorded vs the pre-cutover baseline in the runbook.

OPTIONAL BONUS STEP (fold in during step 9, since you're already in config.py +
re-measuring latency): flip `bedrock_rerank_region` in search-service/app/config.py
from "us-west-2" to "us-east-1". Cohere Rerank 3.5 is now live in us-east-1
(ON_DEMAND, ACTIVE — confirmed 2026-07-22 via list-foundation-models); the
service currently calls it cross-continent in us-west-2 from the us-east-2
cluster. This saves ~35–55ms/query (~4–8% of total latency). Config-only:
bedrock_rerank.py derives both client region and modelArn solely from this
setting. IAM already covers it (ecs.tf grants wildcard-region model ARNs +
bedrock:Rerank on *) — no terraform change. Also fix the stale docstring at
bedrock_rerank.py:14-18 (it claims us-west-2/ca-central/eu-central-only). Do NOT
move embed (us-east-1 already optimal). Verify no BEDROCK_RERANK_REGION override
exists (checked 2026-07-22: only a commented example in .env.example). Confirm
the win via debug.stage2_time / EMF rerank_ms before/after.

STANDING RULES: TDD; conventional commits, NO Co-Authored-By; stage files
explicitly (git add <paths>, never -A); preserve the /query request/response
contract (QueryRequest/QueryResponse in search-service/app/main.py) exactly;
every threshold change re-derives via capture_cite_scores + analyze_cite_scores
(don't hand-tune); bulk Bedrock = batch 24 + AWS_RETRY_MODE=adaptive + ONE
worker; ask before any destructive/irreversible step (the vector backup makes
the re-embed a two-way door — do it first). Load the aws-secrets-manager skill
before touching any secret and never print secret values.
```
