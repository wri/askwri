# Production Phase 0 cutover — plan

Written 2026-07-21, immediately after completing the equivalent QA cutover (PR #240).
**The runbooks remain authoritative** (`docs/runbooks/phase0-cutover.md`,
`docs/runbooks/qa-push-deploy.md`); this plan records what production needs *in addition*,
and every place the QA run proved the runbooks wrong.

Companion document: `docs/plans/2026-07-21-qa-cutover-session-state.md` (what actually
happened in QA, with evidence).

---

## Do these three things before you start

Everything else in this plan is procedure. These are the decisions that change the outcome,
and all three should be settled before the cutover is scheduled — not during it.

1. **Run the corpus migration from inside the VPC, not from a laptop.** In QA it took ~37
   minutes, almost entirely network round-trips: `migrate_csv_to_postgres` inserts
   `document_chunks` row by row inside a single transaction, so wall-clock tracks latency,
   not database throughput. Production shares a `db.t4g.small` with live traffic, so that
   window is the main risk in this plan — and running from an EC2/ECS host in the VPC
   collapses it without changing a line of code. This also answers the QA session's open
   question about where deploy-day migrations should run from. Detail in §3.
2. **Do not re-run the Step 5 parity gate as written.** It failed in QA (0.943 against a
   0.95 threshold) for reasons we diagnosed as metric-related, not data-related, and it was
   waived. Re-running a known mis-specified test against production produces no new
   information while creating pressure to waive it again. Either fix the metric first
   (containment instead of `|A∩B| / max(|A|,|B|)`; treat rank-1 near-ties as matches) or
   rely on the eval suites, which passed. Detail in §8.
3. **Add protection rules to the `production` GitHub Environment first.** It currently has
   **none** — no required reviewers, no deployment branch policy — and
   `deploy-production.yml` fires on any push to `main` or `production`. Right now the only
   thing preventing an accidental production deploy is branch hygiene, and post-merge that
   deploy would create a crash-looping ingestion worker. A required reviewer costs nothing
   and removes the whole class of accident. Detail in §0.

---

## 0. What makes production different from QA

| | QA | Production |
|---|---|---|
| Database | `qa` on `askwri-db1` | `production` on **the same instance** |
| `vector` extension | installed 2026-07-21 | **not installed** — per-database, needs redoing |
| Live traffic | none | **yes** — this is the real difference |
| Deploy trigger | push to `qa` (the repo default branch) | push to `main` **or** `production` |
| Environment protection | none | **none** — no required reviewers, no branch policy |
| Deploy secrets | repo-level | `production` environment-scoped (pinned 2026-07-21) |

Two facts deserve emphasis before anything else:

1. **`askwri-db1` is a single `db.t4g.small` hosting both databases.** The QA corpus
   migration ran ~37 minutes at sustained write load. Doing this against the instance that
   serves production is the main risk in this whole plan — not the schema change.
2. **Nothing gates a production deploy.** The `production` GitHub Environment has zero
   protection rules, so a push to `main` or `production` deploys immediately. Treat branch
   hygiene as the safety mechanism, because nothing else is — or better, fix it:

   ```bash
   gh api -X PUT repos/wri/askwri/environments/production \
     -F 'reviewers[][type]=User' -F 'reviewers[][id]=<user-id>'
   ```

   Note this is *more* dangerous immediately after PR #240 merges than before: Terraform
   will then create the ingestion-worker task family, and with `INGESTION_WORKER_ENV`
   pinned to `{}` (see §2c) it boots without a `DATABASE_URL` and crash-loops.

---

## 1. Sequencing — why this order

The QA run established the dependency chain the hard way:

```
CREATE EXTENSION vector        (needs rds_superuser — NOT the app role)
  → migrations                 (1781280000000 fails on line 7 without it)
    → corpus migration         (needs the schema)
      → sparse backfill        (needs the chunks)
        → secrets updated      (search-service refuses to boot in sparse mode without it)
          → deploy             (flips RETRIEVAL_BACKEND=postgres)
```

Deploying before the backfill gives you a crash-looping search-service:
`KEYWORD_BACKEND=sparse` is the default and **refuses to start** if `document_chunks.sparse`
is unpopulated. `qa-push-deploy.md` Step 5 documents the `KEYWORD_BACKEND=memory` fallback
if you need to deploy first and backfill later.

---

## 2. Preflight

### 2a. The `vector` extension — the known blocker

`CREATE EXTENSION` is per-database, so QA's fix did nothing for production. Confirmed on
2026-07-21: `vector` is **not a trusted extension**, and
`pg_has_role('askwri','rds_superuser','member')` is **false** — so migration
`1781280000000` will fail on its first statement when run as `askwri`.

Someone with the RDS **master** credential (user `postgres`) must run, against the
`production` database only:

```sql
CREATE EXTENSION vector;
CREATE EXTENSION "uuid-ossp";   -- trusted; harmless to include
```

`MasterUserSecret` is `null` — the instance does not use managed rotation, so the password
is **not** retrievable through the AWS API. Two routes:

- Ask the owner: `wri:owner=kinshuk.govil@wri.org` (that is how the QA blocker was resolved).
- Self-service: policy simulation confirms `AWSReservedSSO_DataLabUser` may call
  `rds:ModifyDBInstance`, so the master password can be reset with
  `aws rds modify-db-instance --db-instance-identifier askwri-db1 --region us-east-2 \
   --master-user-password '<new>' --apply-immediately`.
  Effective immediately, no reboot, and it does **not** disrupt the apps (they connect as
  `askwri`) — but it is a shared credential on an instance that serves production.
  **Prefer asking first.**

Verify after: `SELECT extname, extversion FROM pg_extension;` should show `vector 0.8.1`.

### 2b. Confirm which migrations production already has

Do not assume it matches QA. Run against the `production` database:

```bash
npm run typeorm -- migration:show -d src/db/migration-data-source.ts
```

If `1781280000000` / `1781290000000` are pending, this is a first-time Phase 0 cutover
(as QA was). Expect 7 pending in that case.

### 2c. Update the production environment secrets

They were pinned on 2026-07-21 to production's *current* values specifically so that QA's
changes could not leak. At cutover they must be updated — this is a required step, not
cleanup:

| Secret (env-scoped) | Currently pinned to | Must become |
|---|---|---|
| `SEARCH_SERVICE_ENV` | 3 keys, no DB config | add `DATABASE_URL` (**production** DB, `?sslmode=require`) + `RETRIEVAL_BACKEND=postgres` |
| `ASKWRI_APP_ENV` | 11 keys | add `SESSION_SECRET` — **generate a new one; do not reuse QA's**, or a QA-signed session cookie would be valid in production |
| `INGESTION_WORKER_ENV` | `{}` | `DATABASE_URL` (production) + `OPENAI_API_KEY` |

Set with `gh secret set <NAME> --repo wri/askwri --env production`. Reusable scripts from
the QA run are in that session's scratchpad; they read current values straight from the ECS
task definitions and never echo them.

**Leaving `INGESTION_WORKER_ENV` at `{}` means the worker crash-loops** once Terraform
creates its task family. That is deliberate — it is the signal that this step was skipped.

### 2d. Snapshot

```bash
aws rds create-db-snapshot --db-instance-identifier askwri-db1 \
  --db-snapshot-identifier askwri-db1-pre-phase0-prod-<YYYYMMDD> --region us-east-2
```

Wait for `Status=available` before proceeding. Note this snapshots the **whole instance**,
both databases — which is also your QA rollback point, so coordinate.

### 2e. Network access

RDS SG `sg-0575d778d3c2efb0c` allows 5432 from three hardcoded `/32`s plus whatever was
added. A laptop IP that is not on the list produces a **silent TCP timeout, not a refusal**.
These CIDR rules are not Terraform-managed (`security_groups.tf:118-128` covers only
SG-to-SG), so adding one causes no drift.

---

## 3. Execution

Run in a genuine quiet window. Migration `1781300000000` **deletes** duplicate open
`ingestion_jobs` rows before creating its partial unique index, and `1781320000000`–
`1781340000000` rewrite `documents` / `document_summaries` rows.

```bash
export DATABASE_SSL=true                     # .env.local sets false, which kills TLS entirely
export DATABASE_SSL_REJECT_UNAUTHORIZED=false
export DATABASE_URL="postgresql://askwri:<urlencoded-pw>@askwri-db1.cty8g4ssygz9.us-east-2.rds.amazonaws.com:5432/production?sslmode=require"

npm run migration:run                        # expect 7 × "has been executed successfully"

aws s3 sync s3://askwri-data/documents <staging>/docs  --no-progress
aws s3 sync s3://askwri-data/cache     <staging>/cache --no-progress

cd search-service
DOCUMENTS_LOCAL_DIR=<staging>/docs CACHE_DIR=<staging>/cache \
  ./venv/bin/python -m scripts.migrate_csv_to_postgres    # expect "Done: 168 documents, 30436 chunks."
./venv/bin/python -m scripts.build_sparse_keyword         # ~41 s
```

Then `phase0-cutover.md` Step 4 verification SQL. **Expect 168, not 169** (see §5).

### Consider running the corpus migration from inside the VPC

In QA this took ~37 minutes from a laptop, because `migrate_csv_to_postgres` inserts
`document_chunks` **row by row** in a single transaction — so wall-clock is dominated by
network round-trip latency, not by the database. From an EC2/ECS host in the VPC it should
be dramatically faster, which directly shrinks the window of write contention with live
production traffic. This is the single highest-value change to make before the production
run, and it is also the answer to the QA session's open question about where migrations
should run from.

Everything rolls back cleanly if it fails: it is one transaction.

---

## 4. Deploy

Push to `main` or `production` triggers `deploy-production.yml`. It applies Terraform (which
creates the ingestion-worker task family for the first time) and updates the ECS services.
Search-service boots in seconds in postgres mode — no CSV/PDF parsing, no OpenAI calls at
startup.

Post-deploy verification: `qa-push-deploy.md` Step 7. Admin seeding: Step 6.

---

## 5. Corrections to the runbooks — apply these before following them

Found during the QA run; both runbooks are wrong on the first point.

1. **The corpus is 168 documents, not 169.** `phase0-cutover.md` Step 4 and the
   `migrate_csv_to_postgres` expectation both say 169. The 169th entry in the repo's stale
   `search-service/data/documents.csv`,
   `2021_mexico-frontrunners-creating-safe-affordable-and_6429.pdf`, is byte-identical
   (SHA-256 `8a40f219…`) to `2021_mexico-frontrunners-adapting-to-climate-change-in_8904.pdf`,
   is absent from S3, and would be rejected by `1781320000000`'s unique index on
   `documents.content_hash` regardless. Expect `docs=168, texts=168, chunks=30436,
   missing_embeddings=0`.
2. **`qa-push-deploy.md` Step 1a understates the work.** It says "verify" the
   search-service secret has `DATABASE_URL` / `RETRIEVAL_BACKEND`; in reality both were
   absent and had to be created, as did the entire `INGESTION_WORKER_ENV`.
3. **Neither runbook mentions that all three secrets are shared between the QA and
   production workflows.** This is the sharpest edge in the whole process — see §6.
4. **The S3 text cache did not hit** in QA; all 168 PDFs were re-parsed locally (~7 min).
   Budget for it. The node cache did hit.

---

## 6. The secret-scoping hazard (read before touching any secret)

`deploy-qa.yml` has **no** `environment:` key, so QA can only ever read repo-level secrets.
`deploy-production.yml`'s Terraform job is scoped to the `production` environment, which
had **no** environment secrets and therefore inherited the repo-level ones. Consequence:
before the 2026-07-21 fix, putting a QA `DATABASE_URL` in the repo-level
`SEARCH_SERVICE_ENV` would have pointed **production's** search-service at the `qa`
database on its next deploy.

Current state — repo-level = QA, `production` environment = production (pinned):

| Secret | Repo-level | `production` env |
|---|---|---|
| `ASKWRI_APP_ENV` | 11 keys + QA `SESSION_SECRET` | 11 keys |
| `SEARCH_SERVICE_ENV` | 3 keys + QA `DATABASE_URL` + `RETRIEVAL_BACKEND=postgres` | 3 keys |
| `INGESTION_WORKER_ENV` | QA `DATABASE_URL` + `OPENAI_API_KEY` | `{}` |

**This is backwards and should be fixed properly**: add a `qa` GitHub Environment and
`environment: qa` to `deploy-qa.yml`, move QA's values there, then retire the repo-level
copies. Until that happens, the pinning above is load-bearing — do not delete the
production environment secrets.

---

## 7. Rollback

Per-step rollback is in `qa-push-deploy.md` Step 8. Instance-level: restore the §2d
snapshot — but that restores **both** databases, so it is not a production-only undo.

The corpus migration and sparse backfill are each a single transaction, so a failure
mid-run leaves no partial state. Migrations roll back individually with
`npm run migration:revert`, newest first.

---

## 8. Open questions

- **Should the parity gate be run for production at all?** It failed in QA (0.943 vs the
  0.95 threshold) for reasons that look metric-related rather than data-related, and was
  waived. Running it against production repeats a test we already know is mis-specified for
  small result sets. Recommendation: fix the metric first (containment instead of
  `max(|A|,|B|)`; treat near-ties as rank-1 matches), or rely on the eval suites, which
  passed.
- **The unexplained score-distribution shift** between the legacy and postgres retrieval
  paths (q1 rank-3 scored 0.21 legacy vs 0.47 postgres) is still unaccounted for. Suspected
  reranker input differences. Owned by the retrieval workstream, not this one.
- **Plaintext secrets in task definitions.** `OPENAI_API_KEY` and `DB_PASSWORD` sit in
  plaintext in the ECS task definitions by design (SSM Parameter Store was deferred).
  Production is the right place to stop deferring that.
- **Who runs the production cutover, and from where?** See §3 on running it inside the VPC.
