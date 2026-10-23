# Cite-facet "regression" investigation — 2026-10-08

Branch: `fix/cite-mode-facets` (worktree). All repo reads read-only; probes in /tmp.

## 1. Verdict — what changed, when, and why

**Nothing changed. On every channel this repo can see, production has never had
the facet feature switched on — not before, not now. QA has it on, and it works
end to end today (verified in a real browser, not just the API).**

The "regression" story ("facets worked on prod, then stopped") has zero support
in any artifact reachable without AWS credentials:

- `terraform/environments/production.tfvars` has **never** contained a
  `QUERY_*` variable. The file itself was created 2026-08-25 in commit
  `42bc550` (PR #360) already without them, and no commit since touched the
  flags there (`git log --all -S "QUERY_UNDERSTANDING_ENABLED" -- terraform/`).
- The `production` GitHub Environment secret `SEARCH_SERVICE_ENV` — the only
  other channel that can inject env vars into prod's search-service task
  definition — has `updated_at = 2026-08-07T22:41:28Z` (creation, at the
  cutover). The understanding feature did not exist until 2026-08-19, and the
  secret has never been updated since. Secret-based drift is ruled out.
- Production's deploy history (GitHub Actions, `deploy-production.yml`) shows
  every image that ever ran there. None could serve facets:

  | Deploy | Image | Facet capability |
  |---|---|---|
  | 2026-08-07 | `c1af292` | feature did not exist yet |
  | 2026-08-25 (accidental, PR #360) | `42bc550` | code present, flag dark |
  | 2026-09-02 (accidental, main) | `7c91ffe` | **downgrade** to pre-feature code |
  | 2026-09-19 (release) | `666c518` | code present, flag dark |
  | 2026-10-07 (release, PR #443) | `6f1d815` | code present, flag dark |

- The 2026-09-19 release record (`docs/runbooks/production-release-2026-09-19.md`
  §19) states it as a measured fact at the time: *"prod's task definition
  carries no `QUERY_*` variable"* — so there was no drift then either.
- Flag-off is not an accident or a leftover: it is the documented product
  decision (`production-release.md` §11: *"query-understanding lane is
  eval-gated on qa; prod stays deterministic-first"*).

The one mechanism that could still make the operator right is **manual ECS
task-definition drift**: someone registering a task-def revision with
`QUERY_UNDERSTANDING_ENABLED=true` by hand (console/CLI), which works until the
next `terraform apply` wipes it (any deploy: 09-02, 09-19, or 10-07). That is
invisible to git, to GitHub, and to the runbook, and I could not check it —
AWS session expired. This remains the **only** open hypothesis; it is testable
in minutes with the CloudWatch calls in §4.

The other live possibility, which fits every piece of evidence with no
exceptions: the operator saw facets on **QA** (they have worked there since
~2026-08-22 and still do — browser-verified today) and is testing **prod**
now. One question to the operator settles it: which URL, and roughly when.

## 2. Evidence, command by command

### Live QA — works today, end to end

- `POST https://qa.askwri-app.org/api/llamaindex {"query":"freight
  decarbonization since 2022","mode":"cite"}` → HTTP 200;
  `query_understanding` present with hard facet `year_min=2022` (parser) plus
  an LLM `suggest` facet; `debug.facets_hard = 1`, `understanding_ms = 30`;
  18 docs of which 14 have year ≥ 2022 (prod's same query returns 2021 docs).
- Language and range facets also fire: `"reports in spanish about freight"` →
  `language=es` (3 docs); `"freight documents from 2019 to 2021"` →
  `year_min=2019, year_max=2021` (4 docs); `"coal plants in China since 2020"`
  → `year_min=2020`.
- **Real browser** (Playwright, `chromium`, script in /tmp):
  `https://qa.askwri-app.org/results?q=freight+decarbonization+since+2022` →
  status 200; DOM contains `Showing:` and a chip button
  `Remove 2022–present filter`; interpretation-line text:
  `"Showing:\n2022–present\n✕"`. Screenshot: `/tmp/qa-results.png`.
  This closes the parent's gap #1: the QA UI renders chips today.

### Live prod — current image, textbook flag-off

- Same query → HTTP 200, `query_understanding: null`; 18 docs **including
  2021** (no filter applied).
- Explicit facets are silently ignored:
  `{"facets":[{"facet":"year_min","value":"2025"}]}` → 10 docs, not all ≥ 2025.
  Legacy `min_year: 2025` **does** filter (1 doc, year 2025) — through the
  separate Stage 2.5 path. This is exactly what the code predicts: everything
  facet-shaped sits behind `if understanding is not None:`
  (`search-service/app/main.py:1469`, applied at Stage 1.6 `main.py:1687-1697`),
  and the legacy year path runs only when understanding is None
  (`main.py:1768-1775`). `understanding_active()` =
  `settings.query_understanding_enabled AND request.expansion`
  (`understanding.py:54-60`); my probes sent no `expansion`, and the request
  default is `True` (`main.py:174`), so the deciding input is the setting —
  which is off.
- **Prod is not a stale image.** Dated by behavior probes:
  - `POST {"query":"x","bogus":1}` → `400 Unknown request field(s): bogus` —
    the gateway allowlist (`22612a8`, 2026-09-03) is live on both envs.
  - `GET /api/mcp` → 401 with the shared-key message — the MCP surface
    (`9fcf12d`, 2026-10-01, shipped by the #443 release) is live on prod.
  - Prod's `debug` block carries the understanding-era keys
    (`facets_hard`, `matched_tags_count`, `understanding_ms`, `suggestions`,
    `lanes_degraded`, `abstention` — `main.py:2004-2012`) as `null`, i.e. the
    deployed search-service contains the feature code with the flag off.
    Prod's search-service is therefore ≥ the 2026-09-19 release vintage, not
    the 09-02 downgrade.
- Both envs: `debug.service_version = "2.0.0"` (static string, not a date
  signal).

### Git / GitHub archaeology

- `git log --all -S "QUERY_UNDERSTANDING_ENABLED" -- terraform/` → only qa-side
  commits: `a9aa4c9`/`6899707` (2026-08-22, "QA ONLY. production.tfvars
  unchanged"), `50ed6ce`/`76765ec` (2026-08-25, EXPANSION_FACETS qa-only),
  `8570fbf` (P3 LLM flag, qa gate). Nothing ever adds or removes flags on
  production. No reverts touching the feature since 2026-09-19
  (`git log --all --since=2026-09-19 --grep=revert -i` → empty).
- `git show 42bc550 -- terraform/environments/production.tfvars` → the file is
  **new** in that commit (the 2026-08-25 accidental prod deploy), created
  without `QUERY_*`.
- `gh api repos/wri/askwri/environments/production/secrets` →
  `SEARCH_SERVICE_ENV` `updated_at 2026-08-07T22:41:28Z` (never changed since
  creation; feature did not exist until 2026-08-19).
- `gh run list --workflow=deploy-production.yml` → deploy history as tabled in
  §1; all `success`.
- Search-service delta of the 2026-10-07 release itself
  (`git log 666c518..6f1d815 -- search-service/`): one dependabot deps bump
  (`bc00ed7`) only. The release changed no behavior; it cannot have broken or
  fixed anything facet-related.
- The `expansion` request default has never been flipped to False anywhere
  (`git log --all -S "expansion: bool = False"` → empty), so no client-side
  "stopped asking for understanding" regression exists either.
- Wrong-surface check: no `facet_counts` ever existed
  (`git log --all -S facet_counts` → empty); no removed filter/Refine panel in
  results history; the MCP search tool (`src/lib/mcp/search-tool.ts`) only
  maps `year_from` → legacy `min_year` (line 89) and carries no facet surface.
  The InterpretationLine is, and always was, the only chip surface; its recent
  "multiple languages" edit (`0032714`, 2026-10-07) only moved
  `LANGUAGE_NAMES` into `src/app/utils/utils.tsx:177` — benign, and QA renders
  fine.

### Corrections to the parent's evidence-gap list

- **The prod-DB tunnel in `~/.pi/agent/AGENTS.md` does not reach AskWRI.**
  `ssh -f -N prod-db` + `psql -p 15433 -d youtube_backlog_optimizer` connects
  to a **different product's** RDS (tables: `channels`, `brand_profiles`,
  `audience_profiles`, …; no `documents`/`tags`/`document_chunks`; only
  databases `postgres`, `rdsadmin`, `youtube_backlog_optimizer`). AskWRI's
  prod DB is reachable only via `./scripts/with-remote-env.sh production`,
  which needs a live AWS session (expired: `aws sts get-caller-identity` →
  "session has expired, aws login").
- `cite_mode_query_logs` could not have answered "when did facets stop" even
  with DB access: the entity (`src/db/entities/CiteModeQueryLogs.entity.ts`)
  stores only `query` + `top_ten_results`, and **no code in the app writes to
  `/api/cite-mode-query-logs` at all** (the routes exist; grep for callers →
  none). It is a dead surface, not a history.

## 3. Minimal fix — and cost to undo

First, decide the intent. There are two different "fixes":

**(a) If the intended end state is "prod serves facets"** — this is a product
decision, not a bug fix, and the repo records the opposite decision (§11,
"prod stays deterministic-first"). If the operator overrides it, the minimal
change is one block, mirroring `qa.tfvars:72-86`:

`terraform/environments/production.tfvars:58` — add to
`search_service_environment_variables`:

```hcl
  "QUERY_UNDERSTANDING_ENABLED"      = "true"
  "QUERY_EXPANSION_LANES_ENABLED"    = "true"
  "QUERY_UNDERSTANDING_LLM_ENABLED"  = "true"
  "EXPANSION_FACETS"                 = "[\"topic\",\"geography\"]"
  "DEEP_RESCUE_MAX"                  = "10"
```

then merge to `production` per the release runbook. Data prerequisites were
discharged at the 2026-09-19 release and survive in the prod DB
(`search_vocab` built — release Step 19; `tag_embeddings` complete — Gate 4),
but re-verify Gate 4 (`tags … not exists (select 1 from tag_embeddings …)`
must return 0) before the deploy, and re-run `build_search_vocab` after any
corpus change since.

Undo cost: delete the five lines and redeploy — one deploy cycle (~15 min),
no data, no schema, no migration; the feature is read-only over the data it
consumes. (The `a9aa4c9` commit message already records this: "Revert = remove
these vars + redeploy.")

**(b) If the intent is only to explain the operator's symptom** — no code
change is warranted; nothing regressed. What is owed is the AWS check in §4
to confirm or kill the drift hypothesis, and the one-question check of where
the operator actually saw chips.

## 4. Still unverified — and exactly what I need for it

`aws login --region us-east-2` re-auth. Then, in order of decisiveness:

1. **CloudWatch metric — settles "did prod EVER serve facets, and when did it
   stop" with timestamps.** Every `/query` emits EMF metrics to namespace
   `AskWRI/Query`, and `facets_hard`/`understanding_ms` are emitted **only**
   when understanding ran (`main.py:1356-1361`, `2004-2006`):

   ```bash
   aws cloudwatch get-metric-statistics --namespace AskWRI/Query \
     --metric-name facets_hard --dimensions Name=mode,Value=cite \
     --start-time 2026-08-01T00:00:00Z --end-time 2026-10-08T00:00:00Z \
     --period 3600 --statistics Sum --region us-east-2
   ```

   Any non-zero datapoint = prod served facets at that hour; the last non-zero
   timestamp = the minute the "regression" happened. If it is zero throughout,
   the drift hypothesis is dead and the operator saw QA.

2. Task-definition revision history (proves/disproves manual drift directly):

   ```bash
   aws ecs list-task-definitions --family-prefix askwri-app-production-search-service --sort DESC --region us-east-2
   # then, per revision:
   aws ecs describe-task-definition --task-definition <rev> --region us-east-2 \
     --query 'taskDefinition.containerDefinitions[0].environment[?starts_with(name,`QUERY_`)]'
   ```

3. Service deploy events (catches circuit-breaker rollbacks the runbook warns
   about): `aws ecs describe-services --cluster askwri-app-production-cluster
   --services askwri-app-production-search-service --region us-east-2`.

4. Boot + facet logs:
   `aws logs tail /ecs/askwri-app-production-search-service --since 90d --region us-east-2`
   and grep for `Stage 1.6 (Facet Filters)` (`main.py:1697` — logged only when
   understanding is active).

5. Read-only terraform state (S3 backend) for the search-service task
   definition, to confirm config matches state.

AWS-free, and just as decisive for the human side: ask the operator **which
URL** showed chips (qa vs www) and **when**. QA has served chips since
2026-08-22 and still does today.

## 5. Other broken / suspicious things found along the way

1. **`~/.pi/agent/AGENTS.md` points at the wrong production database.** Its
   "prod data is reachable" recipe (`prod-db` tunnel, port 15433,
   `youtube_backlog_optimizer`) lands on another product's RDS. Following it
   for AskWRI questions silently queries unrelated data, and the referenced
   `docs/analysis/` index does not exist in this repo. This needs correcting
   before the next agent session trusts it.
2. **The 2026-10-07 production release (PR #443) left no record.**
   `production-release.md` still says "Last executed: 2026-09-19"; there is no
   `production-release-2026-10-07.md`; nothing in the repo shows the §7 gates,
   the mirror, the worker repoint (§8, the known pinning trap), or provenance
   rows for it. Either it skipped runbook steps or the record is owed.
3. **`cite_mode_query_logs` / `answer_mode_query_logs` are write-orphans**:
   API routes exist (`/api/cite-mode-query-logs`, etc.) but no client or
   script ever POSTs to them. Per-request history of what users searched —
   which would have answered "when did facets last appear for a real user" —
   was therefore never being recorded, on either environment.
4. The 2026-09-02 accidental deploy ran main@`7c91ffe`, which **downgraded**
   prod's search-service to pre-feature code for 17 days (until 2026-09-19).
   It is worth remembering that prod has already silently served materially
   different vintages across that window — it strengthens the case for the
   runbook's standing item to make `/health` carry build identity.
