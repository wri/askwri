# Worker Audit Events — Design

**Date:** 2026-07-09
**Status:** Approved direction (batch green light); spec authored from the UX-review backlog
**Scope:** Python worker only (`search-service/worker/stages/`). No schema changes, no UI changes — the History panel already renders `entity_type='document'` rows.
**Guiding constraint:** simplicity — the two highest-value events only.

## Problem

The document History panel shows only human/import events because pipeline stages write no audit rows. "When did this become searchable?" and "the AI set this title" are unanswerable for worker-driven changes.

## Design

Two new audit writers, both `source='system'`, `actor_user_id=NULL`, `entity_type='document'`, `entity_id=<document id>`, inserted in the same transaction as the change they record (matching the worker's existing intake-audit pattern in `intake_s3.py`):

1. **Publish stage** (`worker/stages/publish.py`): when the stage sets the document status, insert `action='lifecycle'`, `before={"status": <old>}`, `after={"status": <new>}` — same shape the Node `setDocumentStatus` writes, so the History panel's lifecycle one-liner ("system · status → searchable") renders with zero UI changes.
2. **Parse stage LLM extraction** (`worker/stages/parse.py`): after a successful metadata extraction that wrote at least one field, insert `action='update'`, `before={<field>: <old value>, …}`, `after={<field>: <new value>, …}` for exactly the fields actually overwritten (the stage already computes which fields it wrote for provenance stamping). One row per extraction run, not per field.

Failure of an audit INSERT must not fail the stage (wrap and log, like the intake writer's best-effort pattern) — auditing is an observability feature, not a pipeline invariant.

## Non-goals

- No audit rows for language/summarize/classify/embed internals (summaries are visible via the summaries panel; chunk-level changes are noise at History granularity).
- No backfill of historical events.
- No UI changes.

## Testing

Extend `search-service/tests/test_worker_stages.py`: publish-stage test asserts a lifecycle audit row with correct before/after; parse-extraction test asserts an update row listing only the overwritten fields; a failed-audit-write simulation asserts the stage still succeeds.

## Acceptance

After re-ingesting a document locally, its History panel shows "system · status → searchable" and (when extraction wrote fields) "system · updated title, authors …" entries alongside the human events.
