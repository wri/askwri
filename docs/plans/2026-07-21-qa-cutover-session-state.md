# QA Cutover — session state (2026-07-21)

Handoff note for resuming PR #240 deployment work in a fresh session.
**The runbooks are authoritative; this file only records what is already
established, what was decided, and what is still open.**

- PR: https://github.com/wri/askwri/pull/240 (draft, `qa-wip-david` → `qa`,
  MERGEABLE/CLEAN, 4/4 checks green as of 2026-07-09 — 12 days stale)
- Primary runbook: `docs/runbooks/qa-push-deploy.md`
- Routed-through runbook: `docs/runbooks/phase0-cutover.md` ("Production cutover", Steps 1–4)

## Decision: this is the FULL first-time cutover, not the short push

`migration:show` against QA RDS on 2026-07-21 returned **seven** pending migrations:

```
[X] 1772038063520 … 1773903541498   (7 applied)
[ ] 1781280000000  ← Phase 0
[ ] 1781290000000  ← Phase 0
[ ] 1781300000000 … 1781340000000   (the 5 from this PR)
```

Per `qa-push-deploy.md:74-77`, `1781280000000`/`1781290000000` being pending means Phase 0
never ran against this instance. So the sequence is
**phase0-cutover.md Steps 1–4 → back to qa-push-deploy.md Step 2 onward**, covering schema +
169-doc corpus migration + sparse backfill.

## STATUS 2026-07-21 end of session: QA is LIVE, admin UI has errors

The cutover is **done and serving traffic**. PR #240 merged (`71d02dc`); `origin/qa` at
`9a1367a`. Verified live on `qa.askwri-app.org`:

| | |
|---|---|
| `/api/health` | healthy |
| `/api/catalog` | `source: postgres`, 168 docs |
| `/query` (cite) | 200, correct results (hydrogen query returns the two expected papers) |
| search-service | `Postgres-backed retrieval ready (168 documents)`, 30436 sparse chunks |
| ingestion worker | running, connected to Postgres, queue idle |
| admin login | works — seeded user, HTTPS login, authenticated API call all verified |

**Two fixes were needed after the first deploy**, both already merged:

- `3cc555c` — the search-service SG had no RDS ingress rule, so it started, failed
  background indexing with a connection timeout, and returned 500 on every query while ECS
  reported the service healthy. Added `rds_from_search_service`.
- `9a1367a` — `scripts/with-remote-env.sh` TLS and shell-quoting fixes.

### NEXT SESSION: admin UI errors

The user reports **errors when performing actions in the admin UI**. Not yet diagnosed —
no error text captured. Start there, with `superpowers:systematic-debugging`.

To gather first:
- The exact error text / failing action from the UI.
- Browser devtools network tab: which request, what status, what response body.
- App logs: `aws logs tail /ecs/askwri-app-qa --region us-east-2 --since 30m --follow`
- Worker logs: `/ecs/askwri-app-qa-ingestion-worker`; search-service:
  `/ecs/askwri-app-qa-search-service`
- DB state: `./scripts/with-remote-env.sh qa psql -c '<query>'`

Known-suspicious areas, none confirmed:
- `docsMissingTitleEn: 33` in corpus-health — expected per migration `1781320000000`, not
  necessarily a fault.
- The admin account is currently `admin`/`admin` on a **publicly reachable** host, with
  withdraw / taxonomy-delete / user-management powers. Rotate.
- `seed-admin.ts` takes the password as argv, so npm echoes it into logs and shell history.
  Worth switching to stdin/env before production.

---

## RESUME HERE (as of 2026-07-21, after Steps 2–4)

**`phase0-cutover.md` Steps 2, 3, 3b and 4 are all DONE** against QA RDS on 2026-07-21.

- **Step 2** — all 7 pending migrations (`1781280000000`–`1781340000000`) executed
  successfully; `migration:show` lists 14/14 applied, none pending.
- **Step 3** — corpus staged from S3 and `scripts.migrate_csv_to_postgres` finished
  `Done: 168 documents, 30436 chunks.` (~37 min, single transaction, row-by-row inserts
  over the WAN from the laptop).
- **Step 3b** — `scripts.build_sparse_keyword`: 30436 vectors in 41 s, vocab 184264,
  avgdl 192.5.
- **Step 4** — verification SQL: `docs=168, searchable=168, texts=168, chunks=30436,
  summary_chunks=168, missing_embeddings=0, tags=18, in_collection=168`; independently
  `missing_sparse=0`, `keyword_vocab=184264`, `keyword_corpus_stats=1`. Chunk spot-check
  returned sane text/title rows.

Restore point remains snapshot `askwri-db1-pre-phase0-20260721` (`available`, 100%, 20 GB,
engine 17.9, created 2026-07-21T20:11:48Z).

**Next: `qa-push-deploy.md` Step 4 (push `qa`).** The three GitHub Actions secrets are now
done (see below); what remains is that PR #240 is still a **draft** with 12-day-old checks.
`qa-push-deploy.md` Steps 2 and 3 are already satisfied by the work above.

## Step 5 release gate — run 2026-07-21: parity FAILED, evals PASSED

Run with three local instances against the S3-staged corpus (168 docs):
`:8002` legacy+memory (baseline), `:8001` postgres+sparse (the QA deploy config),
`:8003` postgres+memory (diagnostic only). The pre-existing `:8000` was left untouched.

### Parity harness — FAILED the gate

`mean top-20 overlap 0.943` (gate ≥ 0.95) and **2 rank-1 mismatches** (gate: none) —
`q7_jakarta_housing`, `q10_urban_finance_since_2020`. Exit 1.

Two candidate causes were tested and **ruled out**:

- **Not the sparse keyword lane.** `:8003` (postgres retrieval + legacy in-memory BM25)
  produced results *identical* to `:8001` — same 0.943, same two mismatches. The divergence
  is in the postgres retrieval path itself, not the keyword lane.
- **Not approximate vector search.** `document_chunks` has `idx_chunks_embedding_hnsw`, so
  ANN top-800 was compared against a forced exact sequential scan at pgvector's default
  `hnsw.ef_search = 40`: **800/800, 100 % recall**. (Probe was an existing chunk embedding,
  which is an easy case — so this is suggestive, not conclusive.)

The individual divergences are small and not clearly regressions:

| Case | What actually differs |
|---|---|
| `q7` rank-1 | Same two docs, order swapped; scores 1.0/0.9952 (legacy) vs 1.0/0.9896 (pg) — a near-tie |
| `q10` rank-1 | `_8997` vs `_8290` — two editions of the *same* report; also a near-tie |
| `q1` (0.67, worst) | Postgres returned a **strict superset** (6 docs vs 4), shared 4 in identical order |
| `q5`, `q9` | Genuine one-for-one swaps at the tail |

**The metric is unstable on this data.** Overlap is `|A∩B| / max(|A|,|B|)`, so returning
*more* results is penalised — and cite-mode result sets here are 4–10 docs, where one extra
doc swings the score 10–15 points. That alone explains the sub-threshold mean.

**Root cause not established.** Remaining suspect: reranker input text differs between the
two paths (score distributions differ markedly — q1 rank-3 scores 0.21 legacy vs 0.47 pg).
Unverified, and retrieval internals are out of scope for this workstream.

### Golden-set evals — PASSED

Same-day legacy baseline generated rather than trusting the heterogeneous historical
reports in `evaluation/results/`.

| Metric | Legacy (`:8002`) | Postgres+sparse (`:8001`) | Delta | Criterion |
|---|---|---|---|---|
| Cite precision | 25.2 % | 25.3 % | **+0.1** | ±1 ✅ |
| Cite recall | 84.8 % | 86.3 % | **+1.5** | — ✅ |
| Cite F1 | 37.8 % | 38.0 % | **+0.2** | ±1 ✅ |
| Cite cases passed | 7/11 | **8/11** | +1 | ✅ |
| Answer chunk strict P/R/F1 | 40.7 / 28.2 / 33.1 | 39.3 / 27.0 / 31.8 | −1.4 / −1.2 / −1.3 | ±2 ✅ |
| Answer chunk adj. P/R/F1 | 55.2 / 38.3 / 45.0 | 52.6 / 36.1 / 42.6 | −2.6 / −2.2 / −2.4 | ±2 ⚠️ marginally out |
| Answer doc-level P/R/F1 | 88.9 / 72.2 / 76.1 | 90.7 / 74.1 / 78.2 | +1.8 / +1.9 / **+2.1** | ±2 ⚠️ out, in the *good* direction |

Net: the postgres backend trades ~2 points of chunk-level precision for ~2 points of
doc-level accuracy, and is slightly better on cite. No quality regression beyond noise.

Reports: `evaluation/results/eval-report-1784672482197.json` (legacy),
`eval-report-1784672540592.json` (postgres), `answer-retrieval-1784672585888.json` (legacy),
`answer-retrieval-1784672625696.json` (postgres).

### Verdict — parity gate WAIVED by the user, 2026-07-21

The gate as written did not pass. The evidence says the corpus migrated faithfully and
end-to-end quality is unchanged-to-better, so the failure looks like a mis-specified metric
on small result sets rather than a broken migration — but that is a judgement call, not a
result. **The user elected to proceed** on that basis rather than hand the delta to the
retrieval workstream first.

Two follow-ups this leaves open for that workstream:

- The parity metric should not penalise supersets. `|A∩B| / max(|A|,|B|)` on 4–10-doc
  result sets makes the ≥ 0.95 threshold unreachable whenever the candidate returns more
  results. Consider containment (`|A∩B| / |A|`) plus a separate rank-correlation check, and
  treat rank-1 ties (score delta < ~0.02) as matches.
- The unexplained score-distribution shift between the legacy and postgres paths
  (q1 rank-3: 0.21 vs 0.47) is still unaccounted for. Suspected reranker input text
  differences; not investigated.

## GitHub Actions secrets — DONE 2026-07-21, with a scoping fix

All six secrets verified present. **Order mattered and was respected:** production pinned
at 22:03:56–58Z, repo-level updated at 22:04:20–21Z.

### The hazard this avoided

All three secrets are read by **both** `deploy-qa.yml` and `deploy-production.yml`.
`deploy-production.yml`'s Terraform job is scoped to the `production` GitHub Environment
(line 152), which had **zero** environment secrets — so it inherited the repo-level ones.
`deploy-qa.yml` has **no** `environment:` key at all, so QA can only ever read repo-level
secrets. Adding QA's `DATABASE_URL` + `RETRIEVAL_BACKEND=postgres` to the repo-level
`SEARCH_SERVICE_ENV` would therefore have pointed **production's** search-service at the
`qa` database and flipped it to postgres retrieval on its next deploy — before production
has an extension, schema, or corpus. Same class of problem for a shared `SESSION_SECRET`
(a QA-signed session cookie would validate in production).

### Resulting layout

| Secret | Repo-level (= QA) | `production` environment (shadows repo-level) |
|---|---|---|
| `ASKWRI_APP_ENV` | 11 pre-existing keys + **new** `SESSION_SECRET` (fresh 32-byte hex) | 11 keys, reconstructed = unchanged behavior |
| `SEARCH_SERVICE_ENV` | 3 pre-existing keys + **new** `DATABASE_URL` (qa, `?sslmode=require`) + `RETRIEVAL_BACKEND=postgres` | 3 keys only — deliberately **no** `DATABASE_URL`/`RETRIEVAL_BACKEND`, so production stays on the legacy backend |
| `INGESTION_WORKER_ENV` | **new**: `DATABASE_URL` (qa) + `OPENAI_API_KEY` | pinned to `{}` so production cannot inherit QA's |

Pre-existing values were reconstructed from the live ECS task definitions, where this
design already stores them in plaintext. Reusable scripts (they read from task defs at run
time and contain no embedded secrets) are in the session scratchpad:
`pin-production-secrets.sh`, `set-qa-secrets.sh` — the latter aborts unless the former ran.
The generated `SESSION_SECRET` was never displayed or written to disk; nothing needs it by
hand, and existing admin sessions (if any) invalidate on next deploy.

### Follow-ups this created

- **The scoping is backwards and should be fixed properly.** Because `deploy-qa.yml` has no
  `environment:`, repo-level had to become "QA" and the environment-scoped secrets had to
  become "production". The clean fix is a `qa` GitHub Environment plus a one-line
  `environment: qa` addition to `deploy-qa.yml`, after which repo-level can be retired.
- **Production's pinned `INGESTION_WORKER_ENV = {}`** means that if `deploy-production.yml`
  runs after PR #240 merges, Terraform creates the ingestion-worker task family there and it
  crash-loops on the missing `DATABASE_URL`. That is the intended signal: production still
  needs its own full cutover.
- `ADMIN_API_TOKEN` was deliberately **not** created. Nothing in the deployed path consumes
  it — the worker only calls the search-service's unauthenticated `/reindex`
  (`worker/stages/publish.py:68`), so `docs/document-management.md:309`'s claim that the
  worker uses that token is stale. P2-46 flags it as a full-admin, no-expiry, plaintext
  credential. Add it only when a script actually needs it.

### The corpus is 168 documents, not 169

Both runbooks say to expect 169; the real deduped corpus is **168**. The extra entry in the
repo's stale `search-service/data/documents.csv`,
`2021_mexico-frontrunners-creating-safe-affordable-and_6429.pdf`, is byte-identical
(SHA-256 `8a40f219e611104ae50d7aee2f5957f6b26b1a7986385fbedc609d21caf64bb7`) to
`2021_mexico-frontrunners-adapting-to-climate-change-in_8904.pdf`. It does not exist in
S3 at all, and migration `1781320000000`'s unique partial index on `documents.content_hash`
would reject it anyway. **Update the runbooks' expected counts to 168.**

### Staging directory

Corpus and cache were synced to `/Users/gutelius/askwri-stage/{docs,cache}` (2.2 GB total)
and passed via `DOCUMENTS_LOCAL_DIR` / `CACHE_DIR`. Deliberately **not** `/tmp/askWRI_docs`,
which is a symlink into `search-service/data` — syncing there would have polluted the repo.
Safe to delete after cutover. Note the S3 text cache did not hit (all 168 PDFs were
re-parsed locally, ~7 min); the node cache did hit (30436 chunks).

Shell env does not persist between commands; the wrappers used were
`qa-env.sh` (TypeORM: task-def password lookup + URL-encode + `DATABASE_SSL=true`),
`qa-py.sh` (search-service modules: adds `?sslmode=require`, `DOCUMENTS_LOCAL_DIR`,
`CACHE_DIR`), and `qa-psql.sh` (psql with `PGSSLMODE=require`). Recreate from the snippet
below if needed.

Shell setup a new session needs — none of it persists:

```bash
cd /Users/gutelius/Documents/GitHub/askwrimvp
export PATH="$HOME/.local/bin:$PATH"        # the 2.36.4 CLI, not Homebrew's 2.34.4
export PGHOST=askwri-db1.cty8g4ssygz9.us-east-2.rds.amazonaws.com
export PGPASSWORD=$(aws ecs describe-task-definition --task-definition askwri-app-qa \
  --region us-east-2 \
  --query "taskDefinition.containerDefinitions[1].environment[?name=='DB_PASSWORD'].value | [0]" \
  --output text)
export PGENC=$(python3 -c 'import os,urllib.parse;print(urllib.parse.quote(os.environ["PGPASSWORD"],safe=""))')
export DATABASE_URL="postgresql://askwri:$PGENC@$PGHOST:5432/qa"
export DATABASE_SSL=true                     # MUST — .env.local sets false, which kills TLS
export DATABASE_SSL_REJECT_UNAUTHORIZED=false
```

Verify before use: `python3 -c 'import os,urllib.parse as u;print(repr(u.urlparse(os.environ["DATABASE_URL"]).hostname))'`
should print the hostname with no `\n`. Re-add your current IP to `sg-0575d778d3c2efb0c` if
psql hangs (see gotchas). `aws login --region us-east-2` if the 12-hour SSO session expired.

The three GitHub Actions secrets (see preflight table) were **resolved on 2026-07-21** —
details in the "GitHub Actions secrets" section above.

## Environment already established

- AWS CLI v2.36.4 at `~/.local/bin/aws` (shadows Homebrew's 2.34.4, which lacks
  `agent-toolkit`). PATH exported in `~/.bash_profile` and `~/.zshrc`.
- Authenticated via `aws login` (SSO). Account `905418285725`, role `DataLabUser`,
  identity `David.Gutelius@wriconsultant.org`. **Session lasts 12 hours** — re-run
  `aws login --region us-east-2` when it expires.
- Region `us-east-2`, matching `terraform/environments/qa.backend.hcl:4`.
- AWS Agent Toolkit installed: 16 skills in `~/.claude/skills`, MCP server in `~/.claude.json`.
  (Codex MCP registration failed — irrelevant to Claude Code.)
- Verified reachable: `askwri-app-qa-cluster`, `askwri-app-production-cluster`,
  RDS `askwri-db1` (Postgres 17.9, available, publicly accessible).

## Preflight status (qa-push-deploy.md Step 1)

| Check | Status |
|---|---|
| 1a `INGESTION_WORKER_ENV` | ~~Missing — must create.~~ **RESOLVED 2026-07-21.** No ingestion-worker ECS task family existed at all; the worker is entirely new infrastructure in this PR. |
| 1a `ASKWRI_APP_ENV` → `SESSION_SECRET` | ~~Missing~~ **RESOLVED 2026-07-21.** Was absent from QA app task env (rev 124); required for `/admin`. |
| 1a `SEARCH_SERVICE_ENV` → `DATABASE_URL`, `RETRIEVAL_BACKEND=postgres` | ~~Both missing~~ **RESOLVED 2026-07-21.** Were absent from search-service task env (rev 132, 13 vars). More work than the runbook's "verify" implies — and required production-scoped shadowing, see above. |
| 1b `vector` extension ≥ 0.7.0 | **PASS — 0.8.1 available.** `installed_version` is empty (not yet created in the `qa` database), which is fine: `1781280000000-Migration.ts:7-8` runs `CREATE EXTENSION IF NOT EXISTS vector` / `"uuid-ossp"`. Still worth confirming the `askwri` role has `rds_superuser` membership, which RDS requires for `CREATE EXTENSION`. |
| 1c migrations pending | **Answered — see above.** |

A missing GitHub secret decodes to `{}` (`try(jsondecode(...), {})`), so the deploy
**succeeds** with the task silently booting without those vars. Verify before pushing.

## ~~BLOCKER~~ RESOLVED 2026-07-21: `vector` extension installed in `qa`

Master credential obtained from the owner; `CREATE EXTENSION vector` + `uuid-ossp` run
against the `qa` database. `pg_extension` now shows `vector 0.8.1`, `uuid-ossp 1.1`.
Migration `1781280000000` is unblocked and its `IF NOT EXISTS` is now a no-op.
**Production still needs this same one-time step before its own cutover.**
Original diagnosis retained below for the production run.

### Original diagnosis

Confirmed on 2026-07-21 against QA RDS:

```
name      | version | trusted | superuser
uuid-ossp | 1.1     | t       | t
vector    | 0.8.1   | f       | t          ← not trusted
```

`pg_has_role('askwri','rds_superuser','member')` → **`f`**. Because `vector` is not a
trusted extension, only an `rds_superuser` member can create it — so migration
`1781280000000` fails on its first statement (`CREATE EXTENSION IF NOT EXISTS vector`,
line 7) when run as `askwri`. `uuid-ossp` is trusted and would have been fine.

**Resolution:** someone with the RDS master credential must run this once against the `qa`
database, after which the migration's `IF NOT EXISTS` makes it a no-op and everything else
proceeds as `askwri`:

```sql
CREATE EXTENSION vector;
```

Master username is `postgres`. `MasterUserSecret` is `null` — the instance does **not** use
Secrets Manager managed rotation, so the password is not retrievable via the AWS API. It
must come from whoever provisioned the instance (it is outside this repo's Terraform), or be
reset with `aws rds modify-db-instance --master-user-password` (takes effect immediately, no
reboot required — but coordinate first, since anything else using that credential breaks).

Production will need the same one-time step before its own cutover.

**Who to ask:** the instance is tagged `wri:project=askwri`, `wri:owner=kinshuk.govil@wri.org`.

**Self-service fallback:** `IAMDatabaseAuthenticationEnabled` is `false`, so SSO grants no
database identity — but policy simulation shows `AWSReservedSSO_DataLabUser` is *allowed*
`rds:ModifyDBInstance`, `rds:CreateDBSnapshot`, and `rds:RebootDBInstance` on this instance.
So the master password can be reset without waiting on anyone:

```bash
aws rds modify-db-instance --db-instance-identifier askwri-db1 --region us-east-2 \
  --master-user-password '<new>' --apply-immediately
```

Effective immediately, no reboot, no downtime for the apps (they connect as `askwri`).
Prefer asking the owner first — they may already have the password, which avoids rotating a
shared credential on an instance that also serves production.

**One instance, both environments.** `askwri-db1` is a single `db.t4g.small` hosting both the
`qa` and `production` databases (`production.tfvars:32` points at the same host with
`DB_NAME=production`); `pg_database` confirms only `qa`, `production`, `postgres`, `rdsadmin`.
Implications:

- `CREATE EXTENSION` is per-database, so the QA fix does not touch production — and
  production genuinely needs its own.
- Resetting the `postgres` master password would **not** break the running apps (both connect
  as `askwri`), only anything using `postgres` directly. Coordinate with the owner anyway.
- The migration and sparse backfill will contend for CPU/IO with live production traffic on a
  shared t4g.small. The runbook's "quiet window" is not optional here.

## Gotchas discovered the hard way

- **`.env.local:9` sets `DATABASE_SSL=false`**, and `src/db/migration-data-source.ts:44-50`
  reads it to disable TLS entirely, overriding `sslmode` in the URL. Always
  `export DATABASE_SSL=true` when targeting RDS.
- **RDS security group `sg-0575d778d3c2efb0c` allows 5432 from three hardcoded `/32`s.**
  A laptop IP not on the list produces a silent TCP timeout, not a refusal. Added
  `108.238.94.6/32` on 2026-07-21. IP is dynamic — expect to re-add. These CIDR rules are
  **not** Terraform-managed (`security_groups.tf:118-128` covers only SG-to-SG), so no drift.
- Don't paste long `export DATABASE_URL=...` lines — they wrap and inject `\n` into the
  hostname. Build from short `PGHOST`/`PGENC` vars instead.
- Claude Code's permission classifier blocks credential reads and infra writes
  (Keychain writes, `chmod` on dotfiles, extracting `DB_PASSWORD`, SG changes).
  Those steps must be run by the user directly.

## Next actions, in order

1. ~~`CREATE EXTENSION vector` in `qa`~~ — **DONE 2026-07-21.**
2. **1a**: create/update the three GitHub Actions secrets.
3. ~~**Snapshot QA RDS** before Step 2~~ — **DONE**, `askwri-db1-pre-phase0-20260721`.
4. ~~`phase0-cutover.md` Step 2 (migrations)~~ — **DONE 2026-07-21**, 7/7 successful.
5. ~~`phase0-cutover.md` Steps 3 / 3b / 4~~ — **DONE 2026-07-21**, all verified.
6. ~~**Create the three GitHub Actions secrets**~~ — **DONE 2026-07-21**, all six verified
   (repo-level = QA, `production` environment pinned). See the section above.
7. Mark PR #240 ready for review, re-run the stale CI checks, merge, then
   `qa-push-deploy.md` Step 4 (push `qa`) onward.
8. **Security follow-up, unrelated to the cutover:** the QA search-service task definition
   (`askwri-app-qa-search-service`) carries a plaintext `OPENAI_API_KEY` in its
   `environment` block. Move to Secrets Manager and rotate.

## Open questions

- Should deploy-day migrations run from a laptop (current runbook assumption, requires
  ephemeral `/32` SG entries) or from inside the VPC?
- PR checks are 12 days old; consider re-running CI before merge.
- PR is a **draft** — must be marked ready before it can merge.
