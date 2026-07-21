# Worker Audit Events — Design

**Date:** 2026-07-09
**Status:** Approved direction (batch green light); spec authored from the UX-review backlog
**Scope:** Python worker only (`search-service/worker/stages/`). No schema changes, no UI changes — the History panel already renders `entity_type='document'` rows.
**Guiding constraint:** simplicity — the two highest-value events only.

## Problem

The document History panel shows only human/import events because pipeline stages write no audit rows. "When did this become searchable?" and "the AI set this title" are unanswerable for worker-driven changes.

## Design

Two new audit writers, both `source='system'`, `actor_user_id=NULL`, `entity_type='document'`, `entity_id=<document id>`, inserted in the same transaction as the change they record (matching the worker's existing intake-audit pattern in `intake_s3.py`):

1. **Publish stage** (`worker/stages/publish.py`): when the stage sets the document status, insert `action='lifecycle'`, `before={"status": <old>}`, `after={"status": <new>}` — same shape the Node `setDocumentStatus` writes, so the History panel's lifecycle one-liner ("system · status → searchable") renders with zero UI changes. **Guard the INSERT on the UPDATE's `rowcount > 0`** — the withdrawn-skip path deliberately matches no row and must not emit a false lifecycle event. Old status is already available (`doc["status"]` from `fetch_document`); both UPDATE sites sit inside the existing connection block, so the audit lands in the same transaction.
2. **Parse stage LLM extraction** (`worker/stages/parse.py`): **this requires restructuring, not just an INSERT** — the current extraction loop fires provenance-guarded UPDATEs (`WHERE metadata_source->>'field' IS NULL OR = 'llm'`) without checking whether a row actually changed, and `fetch_document` loads old values only for `title`. The change: capture old values for all six extracted fields (extend the pre-extraction SELECT or use `UPDATE … RETURNING`), and collect `(field, old, new)` ONLY for statements where `cur.rowcount == 1` (a provenance-rejected field must NOT appear in history — e.g. never "system · updated title" when the human-edited title was skipped). Then insert one `action='update'` row per extraction run with `before`/`after` built from the collected list; skip the insert when the list is empty.

Failure of an audit INSERT must not fail the stage (wrap and log, like the intake writer's best-effort pattern) — auditing is an observability feature, not a pipeline invariant.

Housekeeping: update the stale comment in `src/db/queries/documentHistory.ts` that says Python writers use only the plural `'documents'` entity_type — these new writers use singular `'document'` (already matched by the query's IN list).

## Non-goals

- No audit rows for language/summarize/classify/embed internals (summaries are visible via the summaries panel; chunk-level changes are noise at History granularity).
- No backfill of historical events.
- No UI changes.

## Testing

Extend `search-service/tests/test_worker_stages.py`: publish-stage test asserts a lifecycle audit row with correct before/after AND that the withdrawn-skip path emits none; parse-extraction tests assert (a) an update row listing only genuinely-overwritten fields with correct before/after values, and (b) NO row (and no field entry) for a provenance-protected field the guard rejected; a failed-audit-write simulation asserts the stage still succeeds.

## Acceptance

After re-ingesting a document locally, its History panel shows "system · status → searchable" and (when extraction wrote fields) "system · updated title, authors …" entries alongside the human events.
