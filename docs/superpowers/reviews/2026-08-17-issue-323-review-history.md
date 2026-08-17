# Review History — Issue #323 (Topic Taxonomy Management + Auto-Tagging)

- **Branch:** `feature/topic-taxonomy-323` (base `qa` @ `653470e`)
- **Spec:** `docs/superpowers/specs/2026-08-17-issue-323-topic-taxonomy-design.md`
- **Plan:** `docs/superpowers/plans/2026-08-17-issue-323-topic-taxonomy.md`
- **SDD ledger (gitignored, in worktree only):** `.superpowers/sdd/2026-08-17-issue-323-topic-taxonomy/progress.md`
- **Status:** All 19 plan tasks complete; every task passed a task-scoped review (11 needed 1 fix round, 8 clean on first pass); a final whole-branch review returned **APPROVE FOR MERGE**; one post-review fix landed (audit gap) and was re-reviewed clean.

This doc exists so a fresh-session reviewer can see what was already found + ruled, without re-deriving it. Re-triage the deferred minors as you see fit.

## The 4 cross-cutting invariants (all verified ✅ by the final review)

1. **`tag_embeddings` two-writer boundary** — no app-tier TypeORM entity for `tag_embeddings`; no app-tier code writes to it (only a read-only `NOT EXISTS` existence check in `embeddings/rebuild/route.ts:22`). All row I/O is python (psycopg raw SQL) in `search-service/worker/stages/embed_tags.py` + `classify.py`. The migration creates the table; the worker owns the rows.
2. **`/query` contract untouched** — `search-service/app/main.py` is NOT in the branch diff. No tag fields added to `QueryRequest`/`QueryResponse`. (Retrieval integration is a future workstream; this branch only builds the taxonomy + auto-tagging.)
3. **`source='human'`/`'external'` precedence** — `classify.py` builds a `protected` set (SELECT tag_id WHERE source IN ('human','external')) and skips those; both topic + non-topic paths use `INSERT ... ON CONFLICT (document_id, tag_id) DO NOTHING`. Two-layer defense; human/external rows are never overwritten.
4. **Atomic CSV import** — `applyTopicsImport` calls `importTopicsDiff` first; if conflicts > 0 it throws BEFORE opening the transaction. All mutations are transaction-wrapped; the import route maps the throw to 409. No partial apply. Forward-reference parent (child before parent in CSV) handled via a second-pass parent-set inside the tx.

## Notable decisions + spec corrections made during implementation

- **Cycle CTE (spec §7.1 was buggy)** — the spec's ancestor-walk CTE was missing `WITH RECURSIVE` and had the join reversed. Code is correct (`WITH RECURSIVE ancestors AS ... JOIN ancestors a ON t.id = a.parent_tag_id` — walks UP from the proposed parent; if the edited tag appears as an ancestor, it's a cycle). Spec was updated to match.
- **`run_id` added to `reclassify_jobs`** (beyond spec §4.4) — the status panel groups jobs by run; spec §6.4 shows per-run "203 docs — $0.17" which requires it. Added in Task 1.
- **`classify.run(document_id, topic_only=False)`** — Task 11 (reclassify) calls with `topic_only=True` to skip non-topic facets. Default False preserves ingest callers.
- **Reclassify API contract** — `POST /api/admin/topics/reclassify` enqueues AND returns `{enqueued, estCost, runId}` in one call (no separate estimate endpoint). The brainstorm mockup showed cost BEFORE enqueue, but the API can't support that without a separate endpoint. The UI shows cost after enqueue-then-acknowledge. Known spec/API gap, not a defect.
- **AuditAction union widened** — added `tag_create`, `tag_update`, `tag_delete`, `tag_merge` (Tasks 3-4) and `tag_import`, `reclassify_enqueue`, `tag_embeddings_rebuild` (final fix). `applyTopicsImport` + `enqueueReclassify` now write audit (guarded by `if (identity)`).
- **WCAG AA contrast** — the brainstorm mockup's amber `#b7791f` fails AA (3.50:1 on `#fffaf0`); replaced with `#7c3a00` (8.20:1) across `TopicTaxonomyManager.tsx`. The contrast test (`admin-contrast.test.ts`) scans `src/app/admin` for the failing amber.
- **Build type-check** — `TopicTaxonomyManager.tsx` originally used `<Box as='button' disabled={...}>` (Chakra's polymorphic Box type doesn't expose `disabled`); `next build --webpack` failed type-check. Fixed by using native `<button className="admin-btn">` (the existing `tags/page.tsx` pattern; `.admin-btn` in `globals.css` handles `:hover`/`:disabled`).

## Deferred Minor findings (triaged as acceptable; re-triage as you see fit)

All ~30 are cosmetic, test-ergonomics, or pre-existing — none load-bearing. Grouped by theme:

### Test coverage gaps (logic tested at the query layer, not the UI)
- Task 15: no tests for re-parent / delete-unused UI paths (brief mandated only select+merge-modal tests).
- Task 16: no test clicks Apply or mocks a 409 (brief mandated only disabled-on-conflict test). Apply-with-reclassify wiring (`?reclassify=true`) unverified by test.
- Task 17: scoped-flow POST body, 401 redirect, error expansion, retry button not asserted. "Calls POST" test checks count, not `JSON.parse(init.body)`. Sloppy fetch mock in "opens confirm modal" test (`(url as any).method` always undefined).
- Task 14: save test doesn't assert flash/drawer-close.

### Cosmetic / UX polish
- Task 18: `doc_type` tab label renders "Doc_type" not "Doc type" (naive capitalize preserves underscore; fix via label map).
- Task 13: description hidden when a tag has aliases (row shows `aliased: …` and drops description; loses info). Search matches description but description isn't always visible.
- Task 14: no Escape key handler (brief didn't mandate; Cancel/overlay/✕ close). Parent combobox doesn't exclude descendants (backend CTE catches cycles; brief only mandated self-exclusion).
- Task 17: button label "Re-classify all" vs brief "Re-classify… (all)" (semantically equivalent).
- Task 10: `candidate_lines` formatting has a stray leading `"; "` in the prompt (cosmetic; LLM still sees label+description).

### Dead code / minor inconsistencies
- Task 10: dead `tag_ids` param to `_classify_other_facets` (run never reads it).
- Task 10: `settings.classify_topic_only` global toggle beyond the brief (harmless, defaults False; ops knob).
- Task 9: `build_all_embeddings` has `taxonomy_version='v1'` filter but `sweep_pending` doesn't (inconsistent; harmless under current v1-only data).
- Task 5: `runId` `let`-declared before try — if enqueue throws pre-assignment, finally DELETE runs with undefined (no pollution, no regression).
- Task 16: `csvDiff` type duplicated (inline + interface; DRY nit).

### Performance / robustness (plan-mandated or negligible)
- Task 5: scoped docId query lacks `DISTINCT` (ON CONFLICT handles dups, wasted work). Per-doc INSERT loop in enqueueReclassify is N round-trips (plan-mandated per brief).
- Task 9: no per-tag error isolation in `sweep_pending`/`build_all_embeddings` (one Bedrock failure aborts batch; brief didn't mandate resilience).
- Task 11: `SKIP LOCKED` test uses 1 conn not 2 (proves status-transition, not cross-session locking; SQL correct). `_mark_done` doesn't reset attempts on success (requeue-then-succeed carries non-zero attempts; likely fine).
- Task 12: `_embed_sweep_tick` logs full traceback every tick on sustained Bedrock outage (plan-mandated; broad except matches existing pattern).
- Task 6: `\r` not in CSV escape regex (bare `\r` lost on round-trip; rare). `dup.includes()` O(n²) for large CSVs (Set would be cleaner).

### Test hygiene / pre-existing
- Task 1: schema-test regex asserts partial-index predicate but not `UNIQUE` (could tighten).
- Task 7: route-test afterAll `DELETE ... OR scope_tag_id IS NULL` could delete pre-existing 'all'-scope jobs (test never invokes reclassify; clause unnecessary). Import route accepts text/csv AND JSON `{csv}` (dual content-type).
- Task 8: new test_config test doesn't reset `lru_cache` between calls (existing tests follow same pattern; suite green).
- **Pre-existing (NOT introduced):** `test_pg_store.py` × `test_worker_stages.py` isolation flakiness — `test_worker_stages.py:49` mutates `os.environ["DATABASE_URL"]` without restoring; `test_pg_store.py` has a pool-teardown hang. Confirmed fails identically on the clean `qa` base (`653470e`). 2 Python test failures in the full suite are this, not the branch.

## How to do a thorough fresh-eyes review (suggested)

1. Read the spec + this doc (the invariants + the deferred minors above).
2. Review the whole-branch diff: `git diff 653470e..feature/topic-taxonomy-323` (34 commits, 39 files, +7901/-316).
3. Focus on the 4 cross-cutting invariants (re-verify each) + any integration seam the per-task reviews couldn't see.
4. Re-triage the deferred minors: which should actually be fixed before merge vs. acceptable.
5. The `requesting-code-review` skill (superpowers) is the right tool for dispatching a fresh reviewer subagent with no inherited context.
