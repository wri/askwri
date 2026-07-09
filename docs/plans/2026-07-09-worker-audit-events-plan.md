# Worker Audit Events Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the document History panel two worker-driven event types it currently lacks — a `lifecycle` row when the publish stage flips document status (e.g. "system · status → searchable"), and an `update` row when the parse stage's LLM extraction overwrites bibliographic metadata (e.g. "system · updated title, authors …"). No schema, no UI, no API changes; the panel already renders `entity_type='document'` rows.

**Architecture:** Two audit writers in the Python worker (`search-service/worker/stages/`), both `source='system'`, `actor_user_id=NULL` (implicit), `entity_type='document'`, `entity_id=<document id>`, inserted in the **same transaction** as the change they record — mirroring the existing intake-audit pattern in `worker/intake_s3.py`. A single shared best-effort helper (`audit_system_event`) lives in `worker/stages/__init__.py` next to `fetch_document`. Auditing is observability, never a pipeline invariant: a failed audit write is isolated in a SAVEPOINT and swallowed so it can never fail (or poison the transaction of) the stage.

**Tech Stack:** Python 3.12, psycopg 3 (connection pool, native `conn.transaction()` savepoints, `psycopg.types.json.Jsonb`), pytest against a scratch Postgres DB (`askwri_stages_test`). One TypeScript comment touch-up in `src/db/queries/documentHistory.ts`.

**Spec:** `docs/superpowers/specs/2026-07-09-worker-audit-events-design.md` (authoritative). This plan folds in three spec-reviewer advisories, called out inline where they bite.

---

## Context for the implementer

Rules — read before touching code:

- **Python side: match the existing worker style.** Raw SQL through `conn.execute`, `psycopg.types.json.Jsonb` for jsonb params, `# noqa: BLE001` on broad best-effort excepts (see `intake_s3.py` and `publish.py` for the house style). No ORM, no new abstractions beyond the one shared helper.
- **Run the Python tests with:** `cd search-service && ./venv/bin/python -m pytest tests/test_worker_stages.py -v`. These are DB-backed and self-skip unless `DATABASE_URL` is set and a local Postgres (`postgresql://askwri:password@localhost:5432`) is reachable — the session fixture creates/drops the `askwri_stages_test` scratch DB and applies TypeORM migrations via `npm run migration:run`. Scope to one class while iterating with `-k`, e.g. `-k TestPublishStage`.
- **NEVER add `Co-Authored-By` trailers to commits.**
- **The Node-side change is a comment only** — the stale note in `src/db/queries/documentHistory.ts` claims Python writers use only the plural `'documents'` entity_type. The new writers use singular `'document'` (already in the query's `IN ('document', 'documents', 'document_summary')` list, so no query change is needed). It rides along in Task 3.
- **DRY / YAGNI:** one helper, two call sites, minimal-diff restructuring. Do not refactor the extraction loop beyond what's specified. Commit after each task.

### Out of scope (do NOT touch)

- **The pypdf embedded-metadata fallback** in `parse.py` (~lines 166–193, the `if not full_text.strip():` no-extractable-text branch that calls `_extract_pdf_metadata`). It is a separate, rarely-hit last-resort path with its own duplicated title/authors UPDATEs. **Do not add audit writes there.** Auditing it is explicitly out of scope; leave that block byte-for-byte unchanged.
- Language / summarize / classify / embed internals (spec Non-goals). No audit rows for those stages.
- Backfill of historical events. UI changes. The `/query` contract.

### Reference: current relevant code

- `worker/stages/__init__.py` — `fetch_document(conn, document_id)` returns a dict including `status`. The helper will be added here.
- `worker/stages/publish.py` — two guarded status UPDATEs (`needs_review` at ~L43–45, `searchable` at ~L51–53), each already followed by an `if cur.rowcount == 0: … return None` withdrawn-skip path, all inside one `with get_pool().connection() as conn:` block. `doc["status"]` (the old status) is already in scope from `fetch_document`.
- `worker/stages/parse.py` — the LLM extraction loop (~L211–227) fires **two** UPDATEs per field: the column-value UPDATE, then the provenance-stamp UPDATE, both guarded `WHERE metadata_source->>'{field}' IS NULL OR = 'llm'`. `_EXTRACT_FIELDS = ["title","authors","doi","year_published","article_type","wri_primary_office"]`.
- `worker/intake_s3.py` — the `INSERT INTO audit_log (source, action, entity_type, entity_id, after) VALUES ('system', …)` pattern to copy.
- `src/db/queries/documentsAdmin.ts` (~L288–298) — the Node `lifecycle` writer whose shape we mirror exactly: `action='lifecycle'`, `entity_type='document'`, `before={status: from}`, `after={status: to}`.
- Tests: `search-service/tests/test_worker_stages.py` — `TestPublishStage` (helpers `_insert_publish_document`, `_insert_document_texts_for_publish`, `_insert_chunk_for_publish` at ~L1989) and `TestParseLLMExtraction` (helpers `_setup_doc`, `_mock_parse`, constants `_FAKE_TEXT`/`_FAKE_EXTRACTION` at ~L2164). The `clean_db` autouse fixture TRUNCATEs `audit_log`, `ingestion_jobs`, `documents` before each test.

---

## Task 1 — Publish lifecycle audit (+ shared helper)

Add the shared `audit_system_event` helper, then have the publish stage emit a `lifecycle` row on each status flip it actually performs (guarded on the UPDATE's rowcount so the withdrawn-skip path stays silent). **Tests first.**

### 1a — Write the failing tests

- [ ] Add these four tests to `class TestPublishStage` in `search-service/tests/test_worker_stages.py`:

```python
    def test_searchable_flip_writes_lifecycle_audit(self, stages_test_db, monkeypatch):
        """Publishing a high-density doc to 'searchable' emits one system lifecycle
        audit row: entity_type='document', source='system', actor NULL,
        before={status:'processing'}, after={status:'searchable'}."""
        monkeypatch.delenv("SEARCH_SERVICE_URL", raising=False)

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_publish_document(conn, external_id="pub-audit-ok", language="en")
            _insert_document_texts_for_publish(conn, doc_id, char_count=1000, pages=2)
            _insert_chunk_for_publish(conn, doc_id, external_id="pub-audit-ok")

        from worker.stages.publish import run
        assert run(doc_id) is None

        with psycopg.connect(stages_test_db) as conn:
            rows = conn.execute(
                "SELECT source, actor_user_id, before, after FROM audit_log "
                "WHERE action='lifecycle' AND entity_type='document' AND entity_id=%s",
                (doc_id,),
            ).fetchall()
        assert len(rows) == 1, f"expected exactly one lifecycle row, got {rows}"
        source, actor, before, after = rows[0]
        assert source == "system"
        assert actor is None
        assert before == {"status": "processing"}
        assert after == {"status": "searchable"}

    def test_needs_review_flip_writes_lifecycle_audit(self, stages_test_db, monkeypatch):
        """A sparse doc flipped to 'needs_review' also emits a lifecycle row
        (before=processing, after=needs_review)."""
        monkeypatch.delenv("SEARCH_SERVICE_URL", raising=False)

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_publish_document(conn, external_id="pub-audit-nr", language="en")
            _insert_document_texts_for_publish(conn, doc_id, char_count=50, pages=1)

        from worker.stages.publish import run
        assert run(doc_id) == "needs_review"

        with psycopg.connect(stages_test_db) as conn:
            row = conn.execute(
                "SELECT before, after FROM audit_log "
                "WHERE action='lifecycle' AND entity_type='document' AND entity_id=%s",
                (doc_id,),
            ).fetchone()
        assert row is not None, "needs_review flip should emit a lifecycle row"
        assert row[0] == {"status": "processing"}
        assert row[1] == {"status": "needs_review"}

    def test_withdrawn_skip_emits_no_lifecycle_audit(self, stages_test_db, monkeypatch):
        """The withdrawn-skip path (status UPDATE matches 0 rows) must emit NO
        lifecycle audit row — no false 'became searchable' event for a takedown."""
        monkeypatch.delenv("SEARCH_SERVICE_URL", raising=False)

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_publish_document(conn, external_id="pub-audit-wd", language="en")
            _insert_document_texts_for_publish(conn, doc_id, char_count=1000, pages=2)
            _insert_chunk_for_publish(conn, doc_id, external_id="pub-audit-wd")
            conn.execute("UPDATE documents SET status='withdrawn' WHERE id=%s", (doc_id,))
            conn.commit()

        from worker.stages.publish import run
        assert run(doc_id) is None

        with psycopg.connect(stages_test_db) as conn:
            n = conn.execute(
                "SELECT count(*) FROM audit_log WHERE action='lifecycle' AND entity_id=%s",
                (doc_id,),
            ).fetchone()[0]
        assert n == 0, f"withdrawn-skip path must emit no lifecycle row, got {n}"

    def test_failed_audit_write_does_not_fail_publish(self, stages_test_db, monkeypatch):
        """A failed audit write is swallowed: the stage still flips to searchable
        and returns None (auditing is observability, not a pipeline invariant)."""
        monkeypatch.delenv("SEARCH_SERVICE_URL", raising=False)
        # Force the helper's insert to blow up by breaking jsonb adaptation.
        def _boom(*a, **k):
            raise RuntimeError("simulated audit serialize failure")
        monkeypatch.setattr("worker.stages.Jsonb", _boom)

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_publish_document(conn, external_id="pub-audit-fail", language="en")
            _insert_document_texts_for_publish(conn, doc_id, char_count=1000, pages=2)
            _insert_chunk_for_publish(conn, doc_id, external_id="pub-audit-fail")

        from worker.stages.publish import run
        assert run(doc_id) is None  # must not raise

        with psycopg.connect(stages_test_db) as conn:
            status = conn.execute(
                "SELECT status FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()[0]
            n = conn.execute(
                "SELECT count(*) FROM audit_log WHERE action='lifecycle' AND entity_id=%s",
                (doc_id,),
            ).fetchone()[0]
        assert status == "searchable", "status flip must succeed despite audit failure"
        assert n == 0, "the failed audit write left no row"
```

- [ ] Run the new tests — they must FAIL (helper + call sites don't exist yet):

```
cd search-service && ./venv/bin/python -m pytest tests/test_worker_stages.py -v -k TestPublishStage
```

Expected: the four new tests error/fail (`AttributeError: worker.stages has no attribute 'Jsonb'` on the failed-write test; the others fail asserting a lifecycle row that isn't written). The five pre-existing `TestPublishStage` tests still PASS.

### 1b — Add the shared helper

- [ ] In `search-service/worker/stages/__init__.py`, add imports at the top and the helper below `fetch_document`:

```python
"""Pipeline stage registry. STAGE_ORDER is the contract with worker.queue."""
import logging
from typing import Callable, Dict

from psycopg.types.json import Jsonb

logger = logging.getLogger(__name__)
```

```python
def audit_system_event(conn, document_id, action, before, after):
    """Best-effort 'system' audit row for a worker-driven document change.

    Mirrors the Node writers (source='system', actor_user_id NULL,
    entity_type='document', entity_id=<doc id>) so the History panel renders
    it with zero UI changes. Wrapped in a SAVEPOINT so a failed insert rolls
    back to the savepoint WITHOUT poisoning the stage's outer transaction, and
    swallowed + logged so auditing is observability, never a pipeline invariant.
    """
    try:
        with conn.transaction():
            conn.execute(
                """INSERT INTO audit_log (source, action, entity_type, entity_id, before, after)
                   VALUES ('system', %s, 'document', %s, %s, %s)""",
                (action, document_id, Jsonb(before), Jsonb(after)),
            )
    except Exception:  # noqa: BLE001 — auditing is observability, not a pipeline invariant
        logger.warning(
            "audit_system_event(%s, %s) failed (non-fatal)", action, document_id, exc_info=True
        )
```

Note: the `with conn.transaction():` nested block issues a real SAVEPOINT on the pooled connection; on exception it releases/rolls back to that savepoint so the stage's later statements (and its final commit) stay valid. The failed-write test injects failure by monkeypatching `worker.stages.Jsonb` to raise — which trips the `except` before any bad SQL runs, exercising the swallow path.

### 1c — Wire up the publish stage

- [ ] In `search-service/worker/stages/publish.py`, extend the import and add an `audit_system_event` call after each successful (rowcount > 0) status flip. Change the import line:

```python
from worker.stages import audit_system_event, fetch_document, stage
```

- [ ] In the `needs_review` branch, insert the audit call after the rowcount guard (the old status is `doc["status"]`):

```python
            cur = conn.execute(
                """UPDATE documents SET status='needs_review', extraction_confidence=%s,
                   updated_at=now() WHERE id=%s AND status <> 'withdrawn'""", (score, document_id))
            if cur.rowcount == 0:
                logger.info(f"{doc['external_id']}: withdrawn — needs_review skipped")
                return None  # job ends 'done', not parked in review for a withdrawn doc (NEW-P2-4)
            audit_system_event(conn, document_id, "lifecycle",
                               {"status": doc["status"]}, {"status": "needs_review"})
            logger.warning(f"{doc['external_id']}: confidence {score} -> needs_review")
            return "needs_review"
```

- [ ] In the `searchable` branch, likewise:

```python
        cur = conn.execute(
            """UPDATE documents SET status='searchable', extraction_confidence=%s,
               updated_at=now() WHERE id=%s AND status <> 'withdrawn'""", (score, document_id))
        if cur.rowcount == 0:
            logger.info(f"{doc['external_id']}: withdrawn — publishing skipped")
            return None
        audit_system_event(conn, document_id, "lifecycle",
                           {"status": doc["status"]}, {"status": "searchable"})
        logger.info(f"{doc['external_id']}: searchable (confidence {score})")
```

Both call sites sit inside the existing `with get_pool().connection() as conn:` block, so the audit row commits atomically with the status change. Guarding on `rowcount > 0` (the `if cur.rowcount == 0: return None` early-returns already do this) is what keeps the withdrawn-skip path silent.

### 1d — Green + commit

- [ ] Run and confirm the whole publish class is green:

```
cd search-service && ./venv/bin/python -m pytest tests/test_worker_stages.py -v -k TestPublishStage
```

Expected: `9 passed` (5 pre-existing + 4 new), no failures.

- [ ] Commit:

```
git add search-service/worker/stages/__init__.py search-service/worker/stages/publish.py search-service/tests/test_worker_stages.py
git commit -m "feat(worker): audit system lifecycle events on publish status flips"
```

---

## Task 2 — Parse extraction audit (loop restructuring)

Emit one `action='update'` audit row per extraction run listing only the fields the guard **actually overwrote AND changed**. This is a restructuring, not a bare INSERT. **Tests first.**

Two spec-reviewer advisories drive the restructuring:

- **Advisory 1 — two UPDATEs per field.** The loop fires the column-value UPDATE first, then the provenance-stamp UPDATE. **The collect decision keys off the VALUE update's `rowcount`** (the first statement), not the stamp. A provenance-rejected field (`external`/`human`) yields `rowcount == 0` on the value UPDATE and must NOT appear in history.
- **Advisory 2 — rowcount==1 also fires on a no-op re-ingest.** When the fresh LLM value equals the current column value, the guarded UPDATE still matches the row (`rowcount == 1`). Filter `old != new` when building the audit list so a re-ingest that changed nothing emits no noisy before==after row.

To get old values, add a single pre-loop SELECT of the six columns.

### 2a — Write the failing tests

- [ ] Add these four tests to `class TestParseLLMExtraction` in `search-service/tests/test_worker_stages.py`:

```python
    def test_extraction_writes_update_audit_of_overwritten_fields(self, stages_test_db, monkeypatch):
        """Fresh ingest: LLM fills all six fields → one system 'update' audit row
        whose before/after list exactly the overwritten fields with old→new values."""
        self._mock_parse(monkeypatch)
        import worker.llm as _llm
        monkeypatch.setattr(_llm, "chat_json", lambda **kw: dict(self._FAKE_EXTRACTION))

        doc_id = self._setup_doc(stages_test_db, metadata_source={}, title="old-slug")

        from worker.stages.parse import run
        run(doc_id)

        with psycopg.connect(stages_test_db) as conn:
            rows = conn.execute(
                "SELECT source, actor_user_id, before, after FROM audit_log "
                "WHERE action='update' AND entity_type='document' AND entity_id=%s",
                (doc_id,),
            ).fetchall()
        assert len(rows) == 1, f"expected exactly one update row, got {rows}"
        source, actor, before, after = rows[0]
        assert source == "system"
        assert actor is None
        # 'title' old value is the seeded slug; all six were None/slug before.
        assert before["title"] == "old-slug"
        assert after == self._FAKE_EXTRACTION
        assert set(before) == set(after) == set(self._FAKE_EXTRACTION)

    def test_provenance_protected_field_absent_from_audit(self, stages_test_db, monkeypatch):
        """A field the provenance guard rejects (title='external') must NOT appear
        in the update row's before/after — never 'system · updated title' for a
        human/CSV-owned field. Other, genuinely-overwritten fields still appear."""
        self._mock_parse(monkeypatch)
        import worker.llm as _llm
        monkeypatch.setattr(_llm, "chat_json", lambda **kw: dict(self._FAKE_EXTRACTION))

        doc_id = self._setup_doc(
            stages_test_db, metadata_source={"title": "external"}, title="My CSV Title",
        )

        from worker.stages.parse import run
        run(doc_id)

        with psycopg.connect(stages_test_db) as conn:
            row = conn.execute(
                "SELECT before, after FROM audit_log "
                "WHERE action='update' AND entity_id=%s", (doc_id,),
            ).fetchone()
        assert row is not None, "other fields were overwritten, so an update row exists"
        before, after = row
        assert "title" not in before, "protected title must be absent from before"
        assert "title" not in after, "protected title must be absent from after"
        assert after.get("doi") == self._FAKE_EXTRACTION["doi"], "unprotected fields still audited"

    def test_noop_reingest_emits_no_update_audit(self, stages_test_db, monkeypatch):
        """Re-ingest where every fresh LLM value equals the current column value:
        the guarded UPDATE still matches (rowcount==1), but old==new for all fields
        → the change list is empty → NO update audit row (before==after noise filter)."""
        self._mock_parse(monkeypatch)
        import worker.llm as _llm
        monkeypatch.setattr(_llm, "chat_json", lambda **kw: dict(self._FAKE_EXTRACTION))

        # Seed the doc so every column already holds the exact value the LLM returns,
        # with 'llm' provenance so the guard permits (a no-op) overwrite.
        doc_id = self._setup_doc(
            stages_test_db,
            metadata_source={f: "llm" for f in _EXTRACT_FIELDS_FOR_TEST},
            title=self._FAKE_EXTRACTION["title"],
        )
        with psycopg.connect(stages_test_db) as conn:
            conn.execute(
                """UPDATE documents SET authors=%s, doi=%s, year_published=%s,
                       article_type=%s, wri_primary_office=%s WHERE id=%s""",
                (self._FAKE_EXTRACTION["authors"], self._FAKE_EXTRACTION["doi"],
                 self._FAKE_EXTRACTION["year_published"], self._FAKE_EXTRACTION["article_type"],
                 self._FAKE_EXTRACTION["wri_primary_office"], doc_id),
            )
            conn.commit()

        from worker.stages.parse import run
        run(doc_id)

        with psycopg.connect(stages_test_db) as conn:
            n = conn.execute(
                "SELECT count(*) FROM audit_log WHERE action='update' AND entity_id=%s",
                (doc_id,),
            ).fetchone()[0]
        assert n == 0, f"a no-op re-ingest (old==new) must emit no update row, got {n}"

    def test_failed_audit_write_does_not_fail_parse(self, stages_test_db, monkeypatch):
        """A failed audit write is swallowed: extraction still lands in the columns
        and the stage advances to 'processing' and returns None."""
        self._mock_parse(monkeypatch)
        import worker.llm as _llm
        monkeypatch.setattr(_llm, "chat_json", lambda **kw: dict(self._FAKE_EXTRACTION))
        def _boom(*a, **k):
            raise RuntimeError("simulated audit serialize failure")
        monkeypatch.setattr("worker.stages.Jsonb", _boom)

        doc_id = self._setup_doc(stages_test_db, metadata_source={}, title="old-slug")

        from worker.stages.parse import run
        assert run(doc_id) is None  # must not raise

        with psycopg.connect(stages_test_db) as conn:
            title, status = conn.execute(
                "SELECT title, status FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()
            n = conn.execute(
                "SELECT count(*) FROM audit_log WHERE action='update' AND entity_id=%s",
                (doc_id,),
            ).fetchone()[0]
        assert title == self._FAKE_EXTRACTION["title"], "extraction still wrote the column"
        assert status == "processing", "stage advanced normally despite audit failure"
        assert n == 0, "the failed audit write left no row"
```

- [ ] Add the small module-level constant the no-op test references, near the top of the test file (or reuse the parse module's list). Put this once, above `TestParseLLMExtraction`:

```python
_EXTRACT_FIELDS_FOR_TEST = [
    "title", "authors", "doi", "year_published", "article_type", "wri_primary_office"
]
```

(Note: `parse.py`'s `_mock_parse` patches `_parse_pdf` to return `_FAKE_TEXT`, which contains no DOI, so the regex-DOI override does not fire and `meta["doi"]` stays the LLM value — the no-op seeding above is exact.)

- [ ] Run — the new tests must FAIL (no update row is written yet):

```
cd search-service && ./venv/bin/python -m pytest tests/test_worker_stages.py -v -k TestParseLLMExtraction
```

Expected: the four new tests fail asserting a missing/incorrect update row; the four pre-existing `TestParseLLMExtraction` tests still PASS.

### 2b — Restructure the extraction loop

- [ ] In `search-service/worker/stages/parse.py`, extend the import:

```python
from worker.stages import audit_system_event, fetch_document, stage
```

- [ ] Replace the extraction loop (current ~L211–227, the `for field in _EXTRACT_FIELDS:` block and the `if meta.get("title"):` log line that follows) with the restructured version below. **Do not touch** the pypdf `if not full_text.strip():` fallback block above it, nor the DOI regex / `_extract_metadata_llm` call just above the loop.

```python
                # Capture current values BEFORE overwriting so the audit records a
                # genuine before/after (advisory 2: filter no-op re-ingests).
                old_row = conn.execute(
                    "SELECT title, authors, doi, year_published, article_type, wri_primary_office "
                    "FROM documents WHERE id=%s", (document_id,),
                ).fetchone()
                old_values = dict(zip(_EXTRACT_FIELDS, old_row))

                changes = []  # (field, old, new) — fields the guard actually overwrote AND changed
                for field in _EXTRACT_FIELDS:
                    value = meta.get(field)
                    if value is None:
                        continue
                    # Overwrite the column value only if provenance is NULL or 'llm'.
                    # Advisory 1: the collect decision keys off THIS statement's rowcount.
                    cur = conn.execute(
                        f"""UPDATE documents SET {field} = %s
                            WHERE id = %s AND (metadata_source->>'{field}' IS NULL OR metadata_source->>'{field}' = 'llm')""",
                        (value, document_id),
                    )
                    # Record provenance as 'llm' ONLY for fields we actually overwrote
                    # (same guard — don't clobber 'external'/'human' provenance).
                    conn.execute(
                        f"""UPDATE documents SET metadata_source = metadata_source || jsonb_build_object('{field}', 'llm')
                            WHERE id = %s AND (metadata_source->>'{field}' IS NULL OR metadata_source->>'{field}' = 'llm')""",
                        (document_id,),
                    )
                    # Audit only genuinely-overwritten fields: rowcount==1 (guard passed)
                    # AND old != new (advisory 2: drop before==after no-op re-ingests).
                    if cur.rowcount == 1 and old_values[field] != value:
                        changes.append((field, old_values[field], value))

                if changes:
                    audit_system_event(
                        conn, document_id, "update",
                        {field: old for field, old, _ in changes},
                        {field: new for field, _, new in changes},
                    )

                if meta.get("title"):
                    logger.info(f"{doc['external_id']}: LLM extracted title='{str(meta['title'])[:80]}'")
```

The provenance-stamp UPDATE stays unconditional (same guard, so it no-ops harmlessly when the value UPDATE did) — this preserves the existing two-UPDATE behavior exactly; only the audit collection is new. The whole loop remains inside the `try:` / `except Exception:` best-effort wrapper and the `with get_pool().connection() as conn:` block, so the audit row commits atomically with the metadata writes.

### 2c — Green + commit

- [ ] Run and confirm the parse-extraction class is green:

```
cd search-service && ./venv/bin/python -m pytest tests/test_worker_stages.py -v -k TestParseLLMExtraction
```

Expected: `8 passed` (4 pre-existing + 4 new), no failures.

- [ ] Commit:

```
git add search-service/worker/stages/parse.py search-service/tests/test_worker_stages.py
git commit -m "feat(worker): audit LLM metadata overwrites in parse extraction"
```

---

## Task 3 — Housekeeping comment + full-suite verification

Fix the stale Node comment, then verify both the full Python worker-stages suite and the Node DB tests are green.

### 3a — Update the stale comment

- [ ] In `src/db/queries/documentHistory.ts`, replace the stale note (currently: `// Python writers use entity_type='documents' (plural) — both spellings are matched.`) with:

```
// Python writers use both entity_type='documents' (plural — bulk intake in
// worker/intake_s3.py) and 'document' (singular — worker lifecycle/update
// audits from publish + parse stages); the SCOPE IN list matches all spellings.
```

No query change — `'document'` is already in the `IN ('document', 'documents', 'document_summary')` list.

### 3b — Verify

- [ ] Full Python worker-stages suite:

```
cd search-service && ./venv/bin/python -m pytest tests/test_worker_stages.py -v
```

Expected: all tests pass, including the 8 new ones (`… passed`, 0 failed). Watch that no pre-existing publish/parse test regressed.

- [ ] Node DB sanity (the History query and lifecycle rendering are exercised by `document-history.db.test`):

```
npm run test:db
```

Expected: the `db.test` suites pass (green). The comment-only change cannot alter behavior; this is a regression sanity check that the History query still resolves worker `'document'` rows.

### 3c — Commit

- [ ] Commit:

```
git add src/db/queries/documentHistory.ts
git commit -m "docs(history): note worker writers use singular 'document' entity_type"
```

---

## Done when

- Publish emits a `lifecycle` audit row on each real status flip (searchable, needs_review); the withdrawn-skip path emits none.
- Parse emits one `update` audit row per extraction run listing only genuinely-overwritten, genuinely-changed fields; provenance-protected fields and no-op re-ingests are excluded.
- A failed audit write never fails (or poisons the transaction of) either stage.
- The `documentHistory.ts` comment reflects both entity_type spellings.
- `pytest tests/test_worker_stages.py` and `npm run test:db` are green.
- Manual acceptance (optional, per spec): re-ingesting a document locally shows "system · status → searchable" and (when extraction wrote fields) "system · updated title, authors …" in its History panel.
