# Production Release Runbook — standing checklist

**Scope:** every intentional production release. Created 2026-09-10 during the first
full reconciliation since the 2026-08-07 cutover — the 2026-08-25 and 2026-09-02
production deploys were *accidents* (PRs #360 and #395 merged to `main` believing it
was inert), not releases, and shipped code whose migrations were never run against
the production DB.

**The two invariants this file exists to protect:**

1. A release is **`qa` → `production` branch via PR**. Pushing (or merging anything
   to) `main` ALSO deploys production, ungated — see the trap in CLAUDE.md. Never
   target `main`.
2. The deploy workflow runs **no migrations and no data backfills**. Every schema or
   data step is manual, in the order below. The pending list is *discovered at
   release time* (§2) — the snapshot in §6 is a convenience, not the source of truth.

---

## 1. Reconcile branches — `qa` must be the superset

```bash
git fetch origin
git log --oneline origin/qa..origin/main        # expect EMPTY
git log --oneline origin/qa..origin/production  # expect EMPTY
git diff --shortstat origin/main origin/qa      # the content delta this release ships
```

If either log is non-empty, merge the stray branch into `qa` via PR first (the
2026-09-02 accident was cleaned up this way by PR #400). Releasing from a `qa` that
is a strict superset means nothing deployed is ever lost.

## 2. Discover pending ops items — run this EVERY release

Do not trust §6. This is the contract; it regenerates the list in ~2 minutes:

```bash
# 1. Authoritative pending-migration list against the prod DB (read-only):
./scripts/with-remote-env.sh production npm run typeorm -- migration:show \
  -d src/db/migration-data-source.ts

# 2. One-off data/repair scripts added since the last release:
git diff --name-only origin/main..origin/qa -- scripts/

# 3. Terraform deltas — qa-only flags stay qa-only; check worker env needs:
git diff origin/main..origin/qa -- terraform/environments/

# 4. Dependency changes (image rebuild handles these; no manual step — verify only):
git diff --stat origin/main..origin/qa -- search-service/requirements.in package.json

# 5. Workflow/secret deltas (new GitHub secret = preflight blocker):
git diff --stat origin/main..origin/qa -- .github/

# 6. Follow-ups the plans recorded for themselves (repo convention):
git diff --name-only origin/main..origin/qa -- docs/superpowers/plans/ | \
  xargs grep -l -i "with-remote-env.sh production" 2>/dev/null
```

Read each new script's docblock — the repo convention is that one-off scripts
document their own per-environment invocations (e.g. `scripts/repair-author-formats.ts`).

## 3. Order of operations

**Quiet window.** Announce the release; steps 1–2 touch the prod DB while the old
code keeps serving.

1. **Migrate prod RDS first** — services come up against an already-prepared schema:

   ```bash
   ./scripts/with-remote-env.sh production npm run migration:run
   ```

   Migrations so far have been additive (new tables/columns/indexes); the
   currently-serving code does not read them, so the old-code-on-new-schema window
   is safe. If a migration is ever destructive, stop and follow its plan doc's
   ordering instead.

2. **Run any data backfills the new code needs, after migrations.** Known one:
   the trigram did-you-mean vocabulary (required by `search-service/app/spell_suggest.py`,
   which the migration `SearchVocab` creates the table for):

   ```bash
   cd search-service && \
   ./scripts/with-remote-env.sh production \
     env -C search-service ./venv/bin/python -m scripts.build_search_vocab
   ```

   (Delete-then-insert, idempotent, reads `DATABASE_URL` only. Re-run any time.)

3. **The release itself:** PR `qa` → `production`, merge, watch:

   ```bash
   gh pr create --base production --head qa --title "Release <date>: <headline>" && \
   gh run watch   # deploy-production.yml: test → build → terraform → ECS → wait stable
   ```

4. **Post-release data repairs** (discovered in §2; every write is audited). Known
   standing one — author name formats (issue #411; dry-run by default, idempotent
   by shape):

   ```bash
   ./scripts/with-remote-env.sh production npm run repair:author-formats           # dry run — review
   ./scripts/with-remote-env.sh production npm run repair:author-formats -- --apply
   ```

5. **Verify:**
   - Public: `curl https://www.askwri-app.org/api/health` → `"status":"healthy"`.
   - Search-service (not on the ALB — ECS exec needs the session-manager plugin
     installed locally; it was missing 2026-09-10):

     ```bash
     TASK=$(aws ecs list-tasks --cluster askwri-app-production-cluster \
       --service-name askwri-app-production-search-service --query 'taskArns[0]' --output text)
     aws ecs execute-command --cluster askwri-app-production-cluster --task "$TASK" \
       --container askwri-app-production-search-service --interactive \
       --command "curl -s http://localhost:8000/health"
     ```

     Expect `"status":"healthy"`, `"keyword_backend":"sparse"`, `"retrieval_backend":"postgres"`,
     then a `/query` smoke from the same session.
   - Worker: `aws logs tail /ecs/askwri-app-production-ingestion-worker --follow` —
     after the taxonomy migrations first run, expect one bounded wave of
     `needs_reembed` tag-embedding sweeps (Bedrock spend, one-time).
   - Audit trail: post-release repairs must land rows
     (`SELECT count(*) FROM audit_log WHERE action='<repair action>';`), and the
     repair's own dry run must re-plan to 0.

6. **Clear §6** in the same PR that closes the release, or immediately after. The
   snapshot is allowed to be stale between releases; the procedure above is what
   must stay true.

## 4. Known qa-only deviations — do not "helpfully" sync these

| Deviation | Where | Why prod differs |
|---|---|---|
| `QUERY_UNDERSTANDING_LLM_ENABLED=true` | `qa.tfvars` | P3 LLM sidecar, eval-gated on qa; prod stays deterministic-first |
| `EXPANSION_FACETS=["topic","geography"]` | `qa.tfvars` | geo lane needs tag embeddings backfilled (qa-only, #351); flag off ⇒ no backfill needed on prod |
| translation pairs | flag off everywhere | sweep → review queue → eval gate before enabling anywhere |
| `TAG_*` worker values | code defaults | defaults (20 / 4 / poll-first) equal the runbook-recommended rollout values — production.tfvars needs nothing |

## 5. Rollback

Per `docs/runbooks/qa-push-deploy.md` Step 8: re-point the ECR `:latest` tag at the
previous commit SHA and force-new-deployment, or `git revert` + push (which
redeploys through the pipeline). `migration:revert` reverts one migration per
invocation and some data fixes are one-way — read the migration's `down` before
relying on it.

---

## 6. Snapshot — pending as of 2026-09-10 (next release must cover; then CLEAR)

> Between releases this section is maintained on the **open production-release
> runbook PR** so the pending list stays visible in the repo's PR list — update it
> (on that branch) whenever qa work lands with production follow-ups, and clear it
> in the release that discharges the items.

**Prod state verified 2026-09-10:** serving `main@7c91ffe` (the 09-02 accidental
build) — healthy (`/api/health` OK, 3/3 ECS services stable), but with latent gaps
below. `qa` ⊇ `main` and `qa` ⊇ `production` (both logs empty); delta 173 files.

1. **4 pending migrations on the prod DB** (shipped as files by the accidental
   deploys, never applied): `1786579200000` document_relations (inert until the
   translation-pairs flag), `1787160000000` TopicTaxonomy (tags columns + indexes
   + topics), `1787251200000` GeographyFacet (~191 continent/country tags,
   `needs_reembed=true` → one bounded worker embedding wave), `1787480000000`
   SearchVocab (`pg_trgm` + `search_vocab`).
2. **`build_search_vocab` backfill** — did-you-mean has been silently dead on prod
   since 09-02 (`spell_suggest.py` is failure-soft; the table does not exist).
3. **`repair:author-formats`** dry-run → `--apply` on prod (qa applied 2026-09-10:
   30 docs; prod `audit_log` count for `author_format_repair` is 0 today — that
   count is the "done?" probe).
4. **No** GitHub-secret changes, **no** production.tfvars changes, **no** migrations
   beyond the four above.
