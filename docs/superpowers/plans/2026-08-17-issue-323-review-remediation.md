# Issue #323 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PR #337 safe to merge by fixing every actionable finding from the fresh whole-branch review.

**Architecture:** Keep the existing taxonomy and reclassification schema, but move all app mutations behind transaction-aware helpers, split reclassification estimation from enqueue, and make worker classification corrective. Complete the missing admin controls and verify exact cost-bearing contracts with test-first coverage.

**Tech Stack:** Next.js 16 App Router, React, TypeScript, TypeORM 0.3, PostgreSQL/pgvector, Jest/Testing Library, Python 3.12+, psycopg, pytest.

**Spec:** `docs/superpowers/specs/2026-08-17-issue-323-review-remediation-design.md`

## Global Constraints

- Preserve the app/worker `tag_embeddings` ownership boundary.
- Preserve human/external `document_tags` assignments.
- Keep taxonomy operations scoped to topic/v1.
- Do not change `search-service/app/main.py` or the `/query` contract.
- Use failing behavioral tests before each production change.
- Never run unsafe DB cleanup against a shared database.
- Use `apply_patch` for source edits.

---

### Task 1: Transaction-aware audit and topic validation

**Files:**
- Modify: `src/db/queries/audit.ts`
- Modify: `src/db/queries/topicsAdmin.ts`
- Test: `src/__tests__/admin-topics.db.test.ts`

**Interfaces:**
- Produces: `writeAudit(entry: AuditEntry, manager?: EntityManager): Promise<void>`
- Produces: topic/v1 parent validation used by create, update, merge, and import.
- Preserves: existing route response shapes.

- [ ] **Step 1: Add failing DB tests**

Add cases proving create/update reject a non-topic or non-v1 parent, create
returns `valueId`, and an audit insert uses the same transaction as its topic
mutation. Scope every fixture and cleanup query to the test's generated IDs and
actor.

```ts
expect(await createTopic({ valueId: child, parentTagId: programId }, admin))
  .toEqual({ error: 'parent must be a v1 topic' })
expect(created).toMatchObject({ valueId: label })
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run the DB file against an isolated scratch database. Expected failures are the
snake-case create result, accepted invalid parent, and non-transactional audit.

- [ ] **Step 3: Implement transaction-aware audit and validation**

```ts
export async function writeAudit(
  entry: AuditEntry,
  manager: EntityManager = AppDataSource.manager,
): Promise<void> {
  await manager.getRepository(AuditLog).insert({
    actorUserId: entry.actorUserId,
    source: entry.source,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
  })
}
```

Pass `em` from every transactional taxonomy mutation. Add one helper that
selects a parent only when `facet='topic' AND taxonomy_version='v1'`. Alias the
create return as `value_id AS "valueId"`.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the DB test names added in Step 1, then the full admin-topics DB file.

- [ ] **Step 5: Commit the task**

```bash
git add src/db/queries/audit.ts src/db/queries/topicsAdmin.ts src/__tests__/admin-topics.db.test.ts
git commit -m "fix: make taxonomy audits transactional"
```

### Task 2: Merge and CSV integrity

**Files:**
- Modify: `src/db/queries/topicsAdmin.ts`
- Modify: `src/app/api/admin/topics/import/route.ts`
- Modify: `src/app/api/admin/topics/[id]/merge/route.ts`
- Test: `src/__tests__/admin-topics.db.test.ts`
- Test: `src/__tests__/admin-topics-routes.test.ts`

**Interfaces:**
- Produces: `TopicsImportConflictError` for genuine 409 conditions.
- Produces: merge result containing moved/enqueued counts while keeping the HTTP response compatible.
- Consumes: transaction-aware `writeAudit` from Task 1.

- [ ] **Step 1: Add failing merge tests**

Cover cross-facet source rejection, ancestor-to-descendant rejection, alias
transfer, and assignment precedence for human/external versus LLM conflicts.

```ts
expect(await mergeTags(descendantId, ancestorId, admin))
  .toEqual({ error: 'cannot merge a topic into its descendant' })
expect(targetAssignment.source).toBe('human')
expect(targetAliases).toContain(sourceAlias)
```

- [ ] **Step 2: Run merge tests and confirm RED**

Expected failures: merge succeeds across invalid relationships, aliases vanish,
or a protected source assignment is lost.

- [ ] **Step 3: Implement guarded merge**

Lock and validate source/target inside one transaction. Consolidate assignments
with `INSERT ... SELECT ... ON CONFLICT DO UPDATE` whose update predicate only
promotes a protected source over an LLM target. Copy aliases, reparent children,
insert affected-document reclassification jobs, audit, and delete the source in
the same transaction. Remove the route's second enqueue call.

- [ ] **Step 4: Add failing CSV tests**

Cover an existing parent renamed and referenced in the same CSV, non-topic
facets, unresolved final parents, cycle rollback, audit/enqueue rollback, and
the route mapping only typed conflicts to 409.

```ts
await applyTopicsImport(renameParentAndChildRows, false, admin)
expect(await parentOf(childId)).toBe(parentId)
expect(unexpectedFailure.status).toBe(500)
```

- [ ] **Step 5: Run CSV tests and confirm RED**

Expected failures: the renamed-parent relationship is absent and infrastructure
errors are returned as 409.

- [ ] **Step 6: Implement final-pass CSV resolution**

Apply label/description/aliases first, build the final label map, then set every
parent with validation and the cycle guard. Reject non-topic facets. Move import
audit and optional set-based queue insertion inside the transaction. Throw
`TopicsImportConflictError` only for user-correctable conflicts.

- [ ] **Step 7: Fix CSV escaping and verify GREEN**

Change the quote test to `/[,"\r\n]/`. Run merge, CSV, route, and export tests.

- [ ] **Step 8: Commit the task**

```bash
git add src/db/queries/topicsAdmin.ts src/app/api/admin/topics/import/route.ts src/app/api/admin/topics/[id]/merge/route.ts src/__tests__/admin-topics.db.test.ts src/__tests__/admin-topics-routes.test.ts
git commit -m "fix: preserve taxonomy integrity across merge and import"
```

### Task 3: Safe reclassification API and queue lifecycle

**Files:**
- Modify: `src/db/queries/audit.ts`
- Modify: `src/db/queries/topicsAdmin.ts`
- Modify: `src/app/api/admin/topics/reclassify/route.ts`
- Modify: `src/app/api/admin/topics/reclassify/status/route.ts`
- Modify: `src/app/api/admin/topics/embeddings/rebuild/route.ts`
- Test: `src/__tests__/admin-topics.db.test.ts`
- Test: `src/__tests__/admin-topics-routes.test.ts`

**Interfaces:**
- Produces: `estimateReclassify(scope)` returning `{eligible, estCost}`.
- Produces: transactional `enqueueReclassify(scope, identity, manager?)`.
- Produces: `retryReclassifyRun(runId, identity)` targeting error rows only.
- Produces: status run entries with bounded `errors[]` details.

- [ ] **Step 1: Add failing route-contract tests**

Test GET estimate, explicit all/scoped POST, run retry, malformed/mixed/empty
bodies returning 400, and exact `{enqueued, estCost, runId}` responses.

```ts
expect(await POST(jsonRequest({}))).toHaveStatus(400)
expect(enqueueMock).not.toHaveBeenCalled()
expect(retryMock).toHaveBeenCalledWith(runId, identity)
```

- [ ] **Step 2: Run route tests and confirm RED**

The empty-body case must expose the current full-corpus default.

- [ ] **Step 3: Add failing DB queue tests**

Cover set-based idempotent enqueue, no partial rows when audit fails, retrying
only errors from one run, attempts/error reset, status error details, and atomic
embedding rebuild audit.

- [ ] **Step 4: Run DB tests and confirm RED**

The current insert loop, global audit writer, and absent retry helper must fail.

- [ ] **Step 5: Implement explicit API and transactional query helpers**

Parse one of these exact shapes:

```ts
type EnqueueRequest = { scope: 'all' } | { tagId: string }
type RetryRequest = { retryRunId: string }
```

GET validates query parameters and only counts eligible rows. POST rejects every
ambiguous body. Enqueue/retry/rebuild use transactions and audit within them.
Status returns error detail objects joined to documents.

- [ ] **Step 6: Run focused and complete app tests**

Confirm the new contract tests and existing route response tests pass.

- [ ] **Step 7: Commit the task**

```bash
git add src/db/queries/audit.ts src/db/queries/topicsAdmin.ts src/app/api/admin/topics/reclassify src/app/api/admin/topics/embeddings/rebuild/route.ts src/__tests__/admin-topics.db.test.ts src/__tests__/admin-topics-routes.test.ts
git commit -m "fix: separate reclassify estimates from queue mutations"
```

### Task 4: Corrective classification and worker ordering

**Files:**
- Modify: `search-service/worker/stages/classify.py`
- Modify: `search-service/worker/stages/reclassify.py`
- Modify: `search-service/worker/main.py`
- Test: `search-service/tests/test_classify_topic.py`
- Test: `search-service/tests/test_reclassify.py`
- Test: `search-service/tests/test_worker_pipeline.py`
- Test: `search-service/tests/test_worker_stages.py`

**Interfaces:**
- Produces: topic classification that replaces only LLM-owned topic rows.
- Produces: `process_reclassify_batch(concurrency: int) -> int`.
- Produces: claims containing `(job_id, document_id, scope_tag_id, run_id)`.

- [ ] **Step 1: Add failing classification tests**

Test stale LLM deletion, selected-row confidence/model refresh, protected-row
preservation, duplicate/top-five truncation, schema `maxItems`, useful candidate
logs, and topic-only zero-candidate failure.

```py
assert stale_llm_row is None
assert refreshed.confidence == pytest.approx(0.91)
assert protected.source == "human"
```

- [ ] **Step 2: Run classification tests and confirm RED**

The stale and refresh assertions must fail against current `DO NOTHING` logic.

- [ ] **Step 3: Implement corrective topic replacement**

After a successful LLM call, deduplicate at most five picks, delete stale LLM
topic rows, and upsert selected LLM rows with a conflict update guarded by
`document_tags.source='llm'`. Raise on zero candidates only for topic-only
reclassification. Add candidate ID/label/distance logging and clean prompt/helper
formatting.

- [ ] **Step 4: Add failing worker lifecycle tests**

Test embed maintenance before claim, configured batch concurrency, run ID
propagation, retry/error terminal transitions, and exactly one `reclassify_run`
audit after the final job terminates.

- [ ] **Step 5: Run worker tests and confirm RED**

Current order and three-column claim should fail these assertions.

- [ ] **Step 6: Implement worker ordering, batching, and audit**

Run `_embed_sweep_tick()` first. Use a bounded `ThreadPoolExecutor` to call
`process_one_reclassify` up to `tag_reclassify_concurrency` times. Return
`run_id` from claims. Under a transaction advisory lock, have the final terminal
job insert one system audit containing total/done/error/cost.

- [ ] **Step 7: Run Python focused and full suites**

Run the four modified files, then `./venv/bin/python -m pytest tests/ -q`.

- [ ] **Step 8: Commit the task**

```bash
git add search-service/worker search-service/tests
git commit -m "fix: make topic reclassification corrective and observable"
```

### Task 5: Complete and harden the admin UI

**Files:**
- Modify: `src/app/admin/topics/components/TopicTaxonomyManager.tsx`
- Modify: `src/app/admin/tags/page.tsx`
- Test: `src/__tests__/topic-taxonomy-ui.test.tsx`
- Test: `src/__tests__/admin-tags-page.test.tsx`

**Interfaces:**
- Consumes: GET estimate and explicit POST/retry contracts from Task 3.
- Produces: create, rebuild, filter, confirmation, detailed-error, and safe-export UI behavior.

- [ ] **Step 1: Add failing cost-control UI tests**

Prove opening and canceling a reclassify modal performs GET only, Start performs
one exact POST, scoped Start sends `{tagId}`, retry sends `{retryRunId}`, and a
401 redirects.

```ts
expect(postCalls).toHaveLength(0)
fireEvent.click(screen.getByRole('button', { name: 'Start' }))
expect(JSON.parse(postCalls[0].body)).toEqual({ scope: 'all' })
```

- [ ] **Step 2: Run the tests and confirm RED**

Opening the current modal must fail because it already POSTs.

- [ ] **Step 3: Implement estimate-then-confirm and targeted retry**

GET on modal open, POST only on Start, show actual enqueue result, render
document-level errors, and POST `{retryRunId}` from Retry.

- [ ] **Step 4: Add failing management-control tests**

Cover New topic POST and close/flash, Rebuild embeddings POST, parent/document
count/re-embed filters, descendant exclusion, description plus aliases,
successful import Apply with exact `?reclassify=true`, export error handling,
and Escape close behavior.

- [ ] **Step 5: Run management tests and confirm RED**

Each missing control or behavior should fail for its intended reason.

- [ ] **Step 6: Implement missing controls and polish**

Add the create form, rebuild action, filters, descendant-safe parent options,
safe export, description rendering, Escape hook, and `Doc type` label. Remove
shorthand/non-shorthand font conflicts touched by these controls.

- [ ] **Step 7: Run UI suites and confirm GREEN without new warnings**

Run both UI test files and fix `act` handling for the touched observer path.

- [ ] **Step 8: Commit the task**

```bash
git add src/app/admin/topics/components/TopicTaxonomyManager.tsx src/app/admin/tags/page.tsx src/__tests__/topic-taxonomy-ui.test.tsx src/__tests__/admin-tags-page.test.tsx
git commit -m "fix: complete taxonomy management and cost confirmation UI"
```

### Task 6: Test isolation and operational documentation

**Files:**
- Modify: `src/__tests__/admin-topics.db.test.ts`
- Modify: `src/__tests__/admin-topics-routes.test.ts`
- Modify: `.env.example`
- Modify: `search-service/.env.example`
- Modify: `docs/document-management.md`
- Modify: relevant deployment runbook identified by `CLAUDE.md`

**Interfaces:**
- Produces: tests safe for a non-empty database and documented worker settings.

- [ ] **Step 1: Repair DB test ownership**

Replace `created_at` with `at`, use unique actors/run IDs/labels, save and restore
pre-existing flags, and delete only test-owned jobs and audits. Remove global
all-scope cleanup.

- [ ] **Step 2: Run DB suites against a scratch database**

Create/use only a named test database, apply migrations there, run the DB tests,
then remove that scratch database. Do not point tests at a shared QA database.

- [ ] **Step 3: Document settings and stage order**

Document exact environment keys:

```text
TAG_CANDIDATE_TOP_N
TAG_RECLASSIFY_CONCURRENCY
TAG_EMBED_BATCH_SIZE
CLASSIFY_TOPIC_ONLY
RECLASSIFY_POLL_FIRST
```

Explain embed-before-claim order, GET estimate/POST confirmation, targeted
retry, cost/audit behavior, and rollout verification.

- [ ] **Step 4: Run format and documentation checks**

Run Prettier check on changed Markdown/TypeScript and Python formatting/lint
tools already configured by the repository.

- [ ] **Step 5: Commit the task**

```bash
git add src/__tests__ .env.example search-service/.env.example docs
git commit -m "test: isolate taxonomy fixtures and document worker rollout"
```

### Task 7: Whole-branch verification and fresh review

**Files:**
- Verify all files changed by Tasks 1–6.

**Interfaces:**
- Produces: evidence that the remediated branch satisfies the approved design.

- [ ] **Step 1: Run app verification**

```bash
npm test -- --runInBand
npm run lint
npm run format:check
npx tsc --noEmit
npx next build --webpack
```

- [ ] **Step 2: Run Python verification**

```bash
cd search-service
./venv/bin/python -m pytest tests/ -q
```

- [ ] **Step 3: Run isolated DB verification**

Run TypeScript and Python DB suites against scratch databases only. Record
pass/skip counts and any environment-limited checks.

- [ ] **Step 4: Re-check invariants and diff hygiene**

Confirm no app write to `tag_embeddings`, no `search-service/app/main.py` diff,
all protected-source SQL guards remain, imports are atomic, and
`git diff --check` is clean.

- [ ] **Step 5: Request a fresh whole-change code review**

Dispatch one isolated reviewer against `65d2b55..HEAD`, address every valid
Critical/Important finding test-first, and repeat verification after edits.

- [ ] **Step 6: Commit any review follow-ups**

```bash
git add -A
git commit -m "fix: address issue 323 remediation review"
```
