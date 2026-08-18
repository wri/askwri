# Issue #323 Review Remediation Design

**Date:** 2026-08-17
**Branch:** `feature/topic-taxonomy-323`
**Base feature design:** `docs/superpowers/specs/2026-08-17-issue-323-topic-taxonomy-design.md`
**Review:** `docs/superpowers/reviews/2026-08-17-issue-323-review-history.md`

## Goal

Resolve every actionable correctness, cost-control, integration, UI, testing,
and operational issue found by the fresh whole-branch review of PR #337 while
preserving the feature's ownership boundaries and leaving `/query` unchanged.

The remediation covers the review's Important findings and concrete Minor
defects. It does not absorb the pre-existing `DATABASE_URL` environment leak or
base-branch pool-teardown hang. Intentional behavior that is already sound,
such as retaining a completed job's attempt history and the
`classify_topic_only` setting, remains unchanged.

## Constraints and invariants

- The app owns `tags`, `tag_aliases`, `reclassify_jobs`, and app-initiated
  `audit_log` writes.
- The Python worker exclusively owns `tag_embeddings` rows and may write only
  `source='llm'` rows in `document_tags`.
- Human and external document-tag assignments are never overwritten or
  deleted by automatic classification or merge conflict handling.
- Taxonomy management remains scoped to `facet='topic'` and
  `taxonomy_version='v1'`.
- `/query`, including `QueryRequest` and `QueryResponse`, remains unchanged.
- Every cost-bearing action is explicit and happens only after user
  confirmation.
- Tests must not delete or modify database rows they did not create.
- Production behavior changes follow test-first red-green-refactor cycles.

## Considered approaches

### 1. Minimal blocker patch

Patch the current functions in place: add a GET estimate route, a few merge
guards, and the missing tests. This is the smallest diff, but it leaves the
global audit writer, autocommit enqueue loop, and split transaction boundaries
in place. Those shared causes would continue producing partial state.

### 2. Cohesive repair using the existing schema — selected

Keep `run_id` on `reclassify_jobs` as the run model, but introduce
transaction-aware query helpers and explicit estimate/enqueue/retry contracts.
Use set-based SQL and the existing tables to make business mutations, queue
rows, and audits atomic. This fixes the root causes without another migration
or a second run abstraction.

### 3. Add a `reclassify_runs` table

Model runs as first-class rows with status, estimate, audit state, and child
jobs. This offers the cleanest long-term run lifecycle, but it adds migration,
entity, and backfill complexity that is unnecessary for the current feature.

## Transaction and audit architecture

`writeAudit(entry, manager?)` will accept an optional `EntityManager`. Domain
functions that mutate state will always pass their active transaction manager.
The default global manager remains available for existing callers outside this
feature.

The following units commit or roll back together:

- topic creation plus aliases plus `tag_create` audit;
- topic update plus aliases plus `tag_update` audit;
- guarded deletion plus `tag_delete` audit;
- merge, document assignment consolidation, alias transfer, child reparenting,
  scoped queue insertion, and audits;
- CSV taxonomy changes, final parent resolution, optional queue insertion, and
  audits;
- missing-embedding flag updates plus `tag_embeddings_rebuild` audit;
- reclassification enqueue/retry plus their audit entries.

Queue creation changes from one insert per document to a single
`INSERT ... SELECT ... ON CONFLICT DO NOTHING RETURNING` statement. The
returned rows determine the exact count and estimated cost.

## Topic integrity and merge semantics

Create and update validate that any non-null parent exists in the v1 topic
taxonomy. Create returns the declared camel-case `valueId` shape.

Merge requires both source and target to be v1 topics and rejects self-merge,
missing tags, and merging an ancestor into its descendant. It copies source
aliases to the target with `ON CONFLICT DO NOTHING`.

Document assignments are consolidated before the source tag is deleted:

- a protected human/external target beats an LLM source;
- a protected human/external source replaces an LLM target;
- when both assignments have equal protection, the existing target wins;
- a non-conflicting source assignment moves to the target.

Only documents actually affected by the merge are eligible for the automatic
scoped reclassification enqueue.

## CSV import behavior

The import endpoint remains a topic-taxonomy endpoint. Rows with another facet
are reported as conflicts rather than creating records invisible to the topic
UI.

Dry-run duplicate detection uses sets instead of repeated array scans. Apply
uses three phases inside one transaction:

1. insert new tags and apply label/description/alias updates without parents;
2. build the final label-to-ID map after all additions and renames;
3. resolve every requested parent for both added and updated rows, validate the
   parent, run the cycle guard, and apply the relationship.

Any unresolved parent or cycle throws a typed import-conflict error and rolls
back the transaction. The route maps only that error class to 409; unexpected
database, audit, or queue failures use the normal 500 response.

If `reclassify=true`, affected document IDs are deduplicated and inserted as
one run inside the same transaction. The response remains
`{ok:true, applied}`.

CSV export treats carriage returns as quote-requiring characters. The UI checks
`res.ok` before constructing a downloadable blob.

## Reclassification API and cost control

`/api/admin/topics/reclassify` has three explicit contracts:

- `GET ?scope=all` or `GET ?tagId=<uuid>` returns
  `{ok:true, eligible, estCost}` and never mutates state.
- `POST {scope:'all'}` or `POST {tagId:<uuid>}` enqueues and returns the existing
  `{ok:true, enqueued, estCost, runId}` shape.
- `POST {retryRunId:<uuid>}` resets only error jobs from that run to queued,
  clears their errors, resets attempts, audits the retry, and returns the same
  result shape with that run ID.

Malformed JSON, missing discriminators, mixed discriminators, invalid UUIDs,
and unknown properties return 400. No request defaults to the full corpus.

Status includes bounded per-document error details for recent runs: document
ID, external ID/title where available, attempts, and error message. This data
drives the expanded error UI and run-scoped retry.

The UI requests an estimate when opening the confirmation modal. Cancel has no
side effect. Start performs the POST, shows the returned actual enqueue count
and cost, and opens status polling only after success.

## Worker ordering, classification, and run lifecycle

Each worker tick runs missing/stale tag embedding maintenance before claiming
reclassification work. A failed embedding sweep remains isolated, but a
topic-only reclassification with zero candidate embeddings raises a retryable
error instead of being marked done. Normal ingestion retains the designed
skip-topic/continue-other-facets behavior.

Topic classification becomes corrective:

1. retrieve candidates and obtain the LLM selection;
2. normalize confidence and deduplicate at most five selected topic IDs;
3. delete stale `source='llm'` topic assignments not selected;
4. upsert selected LLM assignments, refreshing confidence, status, and model;
5. never update or delete human/external assignments.

The JSON schema declares `maxItems: 5`, and code also truncates after
deduplication. Candidate logs include tag ID, label, and cosine distance/score.
Prompt candidate formatting is cleaned up, and the unused non-topic helper
parameter is removed.

`tag_reclassify_concurrency` controls a bounded thread pool that processes up
to that many independently claimed jobs per tick. `SKIP LOCKED` remains the
database arbiter across threads and worker replicas.

Claims return `run_id`. After a job reaches a terminal state, the worker takes
a run-scoped transaction advisory lock and checks whether the run has any open
jobs. The last terminal transition writes one system `reclassify_run` audit row
containing total, done, error, and estimated cost. The lock plus existence check
prevents duplicate completion audits.

## Admin UI completion

The topic toolbar gains:

- New topic, opening a create form for label, description, aliases, and parent;
- Rebuild embeddings, calling the existing endpoint and reporting queued count;
- parent-state, document-count, and re-embedding filters;
- existing import, export, reclassify, and status controls.

The edit parent picker excludes the current tag and all descendants. Rows show
descriptions even when aliases are present. `doc_type` receives a human-readable
label in the legacy facet UI. Dialogs and drawers close on Escape when not busy.

The reclassification panel renders each failed document and retries only the
expanded run. UI tests assert exact methods, URLs, query parameters, and JSON
bodies for every cost-bearing action.

## Test strategy

### TypeScript/Jest

- Route tests cover estimate versus enqueue, malformed-body 400s, exact scoped
  bodies, retry bodies, import 409 versus unexpected 500, rebuild, and create.
- UI tests prove opening/canceling confirmation does not POST, Start does POST,
  scoped requests retain `tagId`, retry sends only `retryRunId`, import Apply
  preserves `?reclassify=true`, create/rebuild controls work, filters work, and
  export refuses error bodies.
- DB tests cover parent taxonomy validation, merge cycle rejection, alias
  transfer, source precedence, renamed-parent import resolution, rollback on
  audit/enqueue failure where injectable, set-based enqueue idempotence, scoped
  retry, and audit rows.
- DB fixtures capture prior values and delete only rows created by the test.
  Audit queries use `audit_log.at`.

### Python/pytest

- Classification tests prove stale LLM deletion, selected-row refresh,
  top-five enforcement, protected-row preservation, and zero-candidate retry
  behavior.
- Worker tests prove embed-before-claim ordering, configured batch concurrency,
  run ID propagation, targeted retry behavior, and a single completion audit.
- Existing DB-gated tests continue using isolated scratch databases.

### Verification

Run focused suites after each red-green cycle, then the complete Jest, Python,
lint, format-check, type/build, and DB-enabled suites available locally. Do not
run the currently unsafe DB tests against a shared database before their cleanup
has been repaired.

## Operational documentation

Add the five topic-classification settings to the relevant environment examples
and document the worker's embed-before-reclassify ordering, cost-bearing admin
actions, retry semantics, and rollout checks in the deployment/document
management runbook.

## Non-goals

- No retrieval integration or `/query` contract change.
- No parallel taxonomy versions.
- No new `reclassify_runs` table.
- No unrelated remediation of the pre-existing environment leak or pool
  teardown hang.
