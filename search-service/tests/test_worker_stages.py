"""Integration tests for worker stages against a scratch database.

Uses the same hermetic pattern as test_worker_queue.py:
  - Create askwri_stages_test scratch DB (distinct name for coexistence)
  - Apply TypeORM migrations via subprocess
  - Point DATABASE_URL at it; reset app.db._pool
  - Never touch the qa database

Skip guard: requires DATABASE_URL (same convention as other DB tests).
"""
import hashlib
import json as json_mod
import os
import shutil
import subprocess
from pathlib import Path

import psycopg
import pytest
from psycopg.types.json import Jsonb

from tests.conftest import _check_db_required

# ---------------------------------------------------------------------------
# Module-level loud-skip guard
# ---------------------------------------------------------------------------
_check_db_required()

pytestmark = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="DATABASE_URL not set — skipping worker stages integration tests",
)

# ---------------------------------------------------------------------------
# Constants — distinct scratch DB name to coexist with askwri_worker_test
# ---------------------------------------------------------------------------
_SUPERDB_URL = "postgresql://askwri:password@localhost:5432/postgres"
_TEST_DB = "askwri_stages_test"
_TEST_DB_URL = f"postgresql://askwri:password@localhost:5432/{_TEST_DB}"
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _reset_app_state(db_url: str) -> None:
    """Point app settings + connection pool at db_url."""
    os.environ["DATABASE_URL"] = db_url
    from app.config import get_settings
    get_settings.cache_clear()
    import app.db as _db
    if _db._pool is not None:
        try:
            _db._pool.close()
        except Exception:
            pass
    _db._pool = None


# ---------------------------------------------------------------------------
# Session fixture: create/drop scratch DB + apply TypeORM schema
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def stages_test_db():
    """Create askwri_stages_test, apply migrations, yield URL, then drop."""
    with psycopg.connect(_SUPERDB_URL, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {_TEST_DB}")
        conn.execute(f"CREATE DATABASE {_TEST_DB}")

    env = {
        **os.environ,
        "DATABASE_URL": _TEST_DB_URL,
        "DATABASE_SSL": "false",
        "DOTENV_CONFIG_PATH": "",
    }
    result = subprocess.run(
        ["npm", "run", "migration:run"],
        cwd=_REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        f"migration:run failed (exit {result.returncode}):\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )

    yield _TEST_DB_URL

    with psycopg.connect(_SUPERDB_URL, autocommit=True) as conn:
        conn.execute(
            f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            f"WHERE datname='{_TEST_DB}' AND pid <> pg_backend_pid()"
        )
        conn.execute(f"DROP DATABASE IF EXISTS {_TEST_DB}")


# ---------------------------------------------------------------------------
# Function-scoped fixture: clean tables + point app at scratch DB each test
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def clean_db(stages_test_db):
    """Truncate tables and reset app state before each test."""
    _reset_app_state(stages_test_db)
    with psycopg.connect(stages_test_db) as conn:
        conn.execute("TRUNCATE audit_log CASCADE")
        conn.execute("TRUNCATE ingestion_jobs CASCADE")
        conn.execute("TRUNCATE documents CASCADE")
        conn.commit()
    yield
    import app.db as _db
    if _db._pool is not None:
        try:
            _db._pool.close()
        except Exception:
            pass
    _db._pool = None
    # Symmetric with setup: don't let monkeypatched env values outlive the test
    from app.config import get_settings
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# --- intake ---
# ---------------------------------------------------------------------------

class TestIntakeSweepLocal:

    def _make_pdf(self, path, content: bytes = b"%PDF-1.4 fake content"):
        path.write_bytes(content)
        return path

    def test_new_file_registers_document_job_audit_and_moves_file(
        self, tmp_path, stages_test_db, monkeypatch
    ):
        """Register new file → documents row (status=draft, content_hash set),
        one queued ingestion_jobs row, audit_log row with result='registered',
        and file moved from intake/ to sibling documents/ dir."""
        intake_dir = tmp_path / "intake"
        intake_dir.mkdir()
        pdf = self._make_pdf(intake_dir / "report.pdf")

        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        from app.config import get_settings
        get_settings.cache_clear()

        from worker.intake_s3 import sweep
        result = sweep()

        assert result is True

        # File moved to sibling documents/ dir
        assert not pdf.exists(), "Original intake file should be moved"
        assert (tmp_path / "documents" / "report.pdf").exists(), "File should appear in documents/"

        with psycopg.connect(stages_test_db) as conn:
            doc = conn.execute(
                "SELECT status, content_hash, external_id FROM documents WHERE external_id = 'report'"
            ).fetchone()
            assert doc is not None, "documents row should exist"
            assert doc[0] == "draft"
            expected_hash = hashlib.sha256(b"%PDF-1.4 fake content").hexdigest()
            assert doc[1] == expected_hash
            doc_id = conn.execute(
                "SELECT id FROM documents WHERE external_id = 'report'"
            ).fetchone()[0]

            job = conn.execute(
                "SELECT status FROM ingestion_jobs WHERE document_id = %s", (doc_id,)
            ).fetchone()
            assert job is not None, "ingestion_jobs row should exist"
            assert job[0] == "queued"

            audit = conn.execute(
                "SELECT after FROM audit_log WHERE action = 'import' AND entity_type = 'documents'"
            ).fetchone()
            assert audit is not None, "audit_log row should exist"
            assert audit[0]["result"] == "registered"
            assert audit[0]["intake"] == "report.pdf"

    def test_same_bytes_second_drop_is_skipped(
        self, tmp_path, stages_test_db, monkeypatch
    ):
        """Same bytes dropped again → _register returns 'duplicate', no second job,
        audit row with result='duplicate_skipped'."""
        content = b"%PDF-1.4 duplicate content bytes"

        # First drop: register via a direct _register call on a live connection
        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(tmp_path / "intake"))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        from app.config import get_settings
        get_settings.cache_clear()

        # Seed the DB with the first file via sweep
        intake_dir = tmp_path / "intake"
        intake_dir.mkdir()
        (intake_dir / "first.pdf").write_bytes(content)

        from worker.intake_s3 import sweep
        sweep()  # registers first.pdf, moves it out

        # Verify one job exists
        with psycopg.connect(stages_test_db) as conn:
            job_count_before = conn.execute("SELECT count(*) FROM ingestion_jobs").fetchone()[0]
        assert job_count_before == 1

        # Second drop: same bytes, different filename
        intake_dir2 = tmp_path / "intake2"
        intake_dir2.mkdir()
        (intake_dir2 / "second.pdf").write_bytes(content)

        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir2))
        get_settings.cache_clear()

        from worker import intake_s3
        result2 = intake_s3.sweep()
        assert result2 is True  # processed (file was present), even if duplicate

        with psycopg.connect(stages_test_db) as conn:
            # Still only one job
            job_count_after = conn.execute("SELECT count(*) FROM ingestion_jobs").fetchone()[0]
            assert job_count_after == 1, "Duplicate content should not create a second job"

            # Audit row for duplicate_skipped
            dup_audit = conn.execute(
                "SELECT after FROM audit_log WHERE after->>'result' = 'duplicate_skipped'"
            ).fetchone()
            assert dup_audit is not None, "audit_log should have duplicate_skipped entry"
            assert dup_audit[0]["intake"] == "second.pdf"

    def test_duplicate_does_not_overwrite_documents_object(
        self, tmp_path, stages_test_db, monkeypatch
    ):
        """A duplicate re-drop is removed from intake WITHOUT copying — an
        existing documents/ object is never clobbered."""
        content = b"%PDF-1.4 original content"
        intake_dir = tmp_path / "intake"
        intake_dir.mkdir()
        (intake_dir / "report.pdf").write_bytes(content)

        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        from app.config import get_settings
        get_settings.cache_clear()

        from worker import intake_s3
        intake_s3.sweep()  # registers report.pdf, copies into documents/

        # Simulate documents/report.pdf having since diverged (sentinel bytes)
        sentinel = b"%PDF-1.4 sentinel must survive"
        (tmp_path / "documents" / "report.pdf").write_bytes(sentinel)

        # Re-drop the SAME original bytes under the same filename
        (intake_dir / "report.pdf").write_bytes(content)
        result = intake_s3.sweep()
        assert result is True

        assert not (intake_dir / "report.pdf").exists(), "duplicate should be removed from intake"
        assert (tmp_path / "documents" / "report.pdf").read_bytes() == sentinel, (
            "duplicate must not overwrite the existing documents/ object"
        )

    def test_crash_before_commit_leaves_resweepable_intake(
        self, tmp_path, stages_test_db, monkeypatch
    ):
        """A crash inside the registration transaction (before commit) rolls
        back the rows and leaves the intake file in place; the next sweep
        processes it normally (copy precedes commit, delete follows it)."""
        intake_dir = tmp_path / "intake"
        intake_dir.mkdir()
        (intake_dir / "report.pdf").write_bytes(b"%PDF-1.4 crash window content")

        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        from app.config import get_settings
        get_settings.cache_clear()

        from worker import intake_s3
        real_register = intake_s3._register

        def crash_after_register(conn, filename, content):
            real_register(conn, filename, content)
            raise RuntimeError("simulated crash before commit")

        monkeypatch.setattr(intake_s3, "_register", crash_after_register)
        # The per-file guard contains the crash (logged, not raised); the file
        # was not successfully processed, so sweep reports no work done.
        assert intake_s3.sweep() is False

        # Intake object survives (delete only happens after commit) ...
        assert (intake_dir / "report.pdf").exists(), "intake file must survive a pre-commit crash"
        # ... and the transaction rolled back: no rows committed
        with psycopg.connect(stages_test_db) as conn:
            assert conn.execute("SELECT count(*) FROM documents").fetchone()[0] == 0
            assert conn.execute("SELECT count(*) FROM ingestion_jobs").fetchone()[0] == 0

        # Next sweep (no crash) processes the file end-to-end
        monkeypatch.setattr(intake_s3, "_register", real_register)
        assert intake_s3.sweep() is True
        assert not (intake_dir / "report.pdf").exists()
        assert (tmp_path / "documents" / "report.pdf").exists()
        with psycopg.connect(stages_test_db) as conn:
            assert conn.execute("SELECT count(*) FROM documents").fetchone()[0] == 1

    def test_poison_file_skipped_good_file_registered(
        self, tmp_path, stages_test_db, monkeypatch
    ):
        """A file whose processing raises is skipped (one log line) and left in
        intake; the remaining files in the same sweep are still registered."""
        intake_dir = tmp_path / "intake"
        intake_dir.mkdir()
        (intake_dir / "a-poison.pdf").write_bytes(b"%PDF-1.4 poison")
        (intake_dir / "b-good.pdf").write_bytes(b"%PDF-1.4 good content")

        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        from app.config import get_settings
        get_settings.cache_clear()

        from worker import intake_s3
        real_register = intake_s3._register

        def poison_register(conn, filename, content):
            if filename == "a-poison.pdf":
                raise RuntimeError("deterministic poison file")
            return real_register(conn, filename, content)

        monkeypatch.setattr(intake_s3, "_register", poison_register)
        result = intake_s3.sweep()
        assert result is True, "the good file was processed"

        # Poison file stays in intake (re-swept next pass); good file moved
        assert (intake_dir / "a-poison.pdf").exists(), "poison file must stay in intake"
        assert not (intake_dir / "b-good.pdf").exists(), "good file must leave intake"
        assert (tmp_path / "documents" / "b-good.pdf").exists()

        with psycopg.connect(stages_test_db) as conn:
            ids = [r[0] for r in conn.execute("SELECT external_id FROM documents").fetchall()]
        assert ids == ["b-good"], f"only the good file should be registered, got {ids}"

    def test_same_filename_different_bytes_reenqueues_existing_doc(
        self, tmp_path, stages_test_db, monkeypatch
    ):
        """Same filename but different bytes → re-enqueues the EXISTING external_id
        document (no new documents row; a new queued job is created if none open,
        or the open job is reused per enqueue idempotency)."""
        intake_dir = tmp_path / "intake"
        intake_dir.mkdir()

        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        from app.config import get_settings
        get_settings.cache_clear()

        # First sweep: register report.pdf with v1 content
        (intake_dir / "report.pdf").write_bytes(b"%PDF-1.4 version one")
        from worker import intake_s3
        intake_s3.sweep()

        # Verify initial state
        with psycopg.connect(stages_test_db) as conn:
            doc_count = conn.execute("SELECT count(*) FROM documents").fetchone()[0]
            assert doc_count == 1
            doc_id_first = conn.execute(
                "SELECT id FROM documents WHERE external_id = 'report'"
            ).fetchone()[0]

        # Mark the existing job done so enqueue idempotency doesn't block a re-enqueue
        with psycopg.connect(stages_test_db) as conn:
            conn.execute("UPDATE ingestion_jobs SET status = 'done' WHERE document_id = %s", (doc_id_first,))
            conn.commit()

        # Second sweep: same filename, different bytes
        (intake_dir / "report.pdf").write_bytes(b"%PDF-1.4 version two different content")
        get_settings.cache_clear()
        intake_s3.sweep()

        with psycopg.connect(stages_test_db) as conn:
            # Still exactly one documents row (no duplicate external_id)
            doc_count_after = conn.execute("SELECT count(*) FROM documents").fetchone()[0]
            assert doc_count_after == 1, "No new documents row should be created for same external_id"

            # content_hash tracks the NEW content (so future dedup compares correctly)
            new_hash = conn.execute(
                "SELECT content_hash FROM documents WHERE id = %s", (doc_id_first,)
            ).fetchone()[0]
            assert new_hash == hashlib.sha256(b"%PDF-1.4 version two different content").hexdigest()

            # A new queued job should now exist (the done job + a new queued one)
            queued_jobs = conn.execute(
                "SELECT count(*) FROM ingestion_jobs WHERE document_id = %s AND status = 'queued'",
                (doc_id_first,),
            ).fetchone()[0]
            assert queued_jobs >= 1, "A new queued job should be enqueued for re-ingestion"


class FakeS3Client:
    """A minimal in-memory S3 client for _sweep_s3 tests (paginated listing +
    object get/copy/delete)."""
    def __init__(self, objects: dict):
        # objects: {key: bytes}
        self.objects = dict(objects)
        self.deleted = []
        self.copied = []

    def list_objects_v2(self, *, Bucket, Prefix, MaxKeys=50, ContinuationToken=None):
        keys = sorted(k for k in self.objects if k.startswith(Prefix))
        # Simple pagination: slice by MaxKeys, use token as start index
        start = int(ContinuationToken) if ContinuationToken else 0
        page = keys[start:start + MaxKeys]
        truncated = start + MaxKeys < len(keys)
        return {
            "Contents": [{"Key": k} for k in page],
            "IsTruncated": truncated,
            "NextContinuationToken": str(start + MaxKeys) if truncated else None,
        }

    def get_object(self, *, Bucket, Key):
        class Body:
            def __init__(self, data): self._d = data
            def read(self): return self._d
        return {"Body": Body(self.objects[Key])}

    def copy_object(self, *, Bucket, Key, CopySource):
        self.objects[Key] = self.objects[CopySource["Key"]]
        self.copied.append(Key)

    def delete_object(self, *, Bucket, Key):
        self.objects.pop(Key, None)
        self.deleted.append(Key)

    exceptions = type("exc", (), {"NoSuchKey": Exception})


class TestIntakeSweepS3:

    def test_pagination_processes_more_than_maxkeys(self, stages_test_db, monkeypatch):
        """_sweep_s3 must paginate (ContinuationToken loop) when the intake prefix
        has more than MaxKeys objects — all 60 PDFs are registered, not just 50
        (NEW-P2-9)."""
        from worker import intake_s3
        # 60 PDFs in intake/ — more than MaxKeys=50
        objs = {f"intake/doc_{i:03d}.pdf": b"%PDF-1.4 " + bytes([i]) for i in range(60)}
        fake = FakeS3Client(objs)
        monkeypatch.setattr(intake_s3, "s3", fake, raising=False)
        # Patch boto3.client to return our fake
        import boto3
        monkeypatch.setattr(boto3, "client", lambda *a, **k: fake)
        monkeypatch.delenv("INTAKE_LOCAL_DIR", raising=False)
        monkeypatch.setenv("DOCUMENTS_S3_BUCKET", "test-bucket")
        from app.config import get_settings
        get_settings.cache_clear()

        result = intake_s3.sweep()
        assert result is True

        with psycopg.connect(stages_test_db) as conn:
            doc_count = conn.execute("SELECT count(*) FROM documents").fetchone()[0]
        assert doc_count == 60, f"all 60 PDFs should be registered (pagination), got {doc_count}"

    def test_non_pdf_objects_deleted_from_intake(self, stages_test_db, monkeypatch):
        """A non-PDF object in intake/ is deleted (not left orphaned) and not
        registered as a document (NEW-P2-9)."""
        from worker import intake_s3
        objs = {
            "intake/report.pdf": b"%PDF-1.4 real content",
            "intake/readme.txt": b"not a pdf",
            "intake/notes.json": b"{}",
        }
        fake = FakeS3Client(objs)
        import boto3
        monkeypatch.setattr(boto3, "client", lambda *a, **k: fake)
        monkeypatch.delenv("INTAKE_LOCAL_DIR", raising=False)
        monkeypatch.setenv("DOCUMENTS_S3_BUCKET", "test-bucket")
        from app.config import get_settings
        get_settings.cache_clear()

        result = intake_s3.sweep()
        assert result is True

        # Non-PDF objects deleted from intake (not orphaned)
        assert "intake/readme.txt" in fake.deleted, "non-PDF .txt should be deleted from intake"
        assert "intake/notes.json" in fake.deleted, "non-PDF .json should be deleted from intake"
        # Only the PDF registered as a document
        with psycopg.connect(stages_test_db) as conn:
            doc_count = conn.execute("SELECT count(*) FROM documents").fetchone()[0]
        assert doc_count == 1, f"only the PDF should register, got {doc_count} docs"


# ---------------------------------------------------------------------------
# --- parse stage ---
# ---------------------------------------------------------------------------

_FIXTURE_PDF = Path(__file__).parent / "fixtures" / "sample.pdf"


def _insert_document(conn, *, external_id="test-doc", s3_key="documents/sample.pdf",
                     title="Test Document", source_metadata=None):
    """Insert a minimal documents row and return its id."""
    row = conn.execute(
        """INSERT INTO documents
               (external_id, s3_key, title, status, content_hash)
           VALUES (%s, %s, %s, 'draft', 'abc123')
           RETURNING id""",
        (external_id, s3_key, title),
    ).fetchone()
    if source_metadata is not None:
        from psycopg.types.json import Jsonb
        conn.execute(
            "UPDATE documents SET source_metadata = %s WHERE id = %s",
            (Jsonb(source_metadata), row[0]),
        )
    conn.commit()
    return row[0]


class TestParseStage:

    def test_parse_writes_document_texts_and_flips_status(
        self, tmp_path, stages_test_db, monkeypatch
    ):
        """Parse a real PDF → document_texts row with char_count > 0,
        non-empty page_boundaries, and document status = 'processing'."""
        intake_dir = tmp_path / "intake"
        intake_dir.mkdir()
        docs_dir = tmp_path / "documents"
        docs_dir.mkdir()
        shutil.copy(_FIXTURE_PDF, docs_dir / "sample.pdf")

        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        from app.config import get_settings
        get_settings.cache_clear()

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, s3_key="documents/sample.pdf")

        from worker.stages.parse import run
        result = run(doc_id)
        assert result is None

        with psycopg.connect(stages_test_db) as conn:
            row = conn.execute(
                "SELECT full_text, page_boundaries, char_count FROM document_texts WHERE document_id = %s",
                (doc_id,),
            ).fetchone()
            assert row is not None, "document_texts row should exist"
            full_text, page_boundaries, char_count = row
            assert char_count > 0, "char_count must be positive"
            assert "World Resources Institute" in full_text, "extracted text should match fixture content"
            assert len(page_boundaries) > 0, "page_boundaries must be non-empty"

            status = conn.execute(
                "SELECT status FROM documents WHERE id = %s", (doc_id,)
            ).fetchone()[0]
            assert status == "processing"

    def test_parse_upsert_no_duplicate_key(
        self, tmp_path, stages_test_db, monkeypatch
    ):
        """Running parse twice on the same document upserts — no duplicate-key error
        and exactly one document_texts row remains. Since the parse cache landed
        the second run takes the cache-hit branch, but the document_texts write
        happens on every path, so this still exercises the ON CONFLICT clause.
        The re-PARSE case is covered by TestParseCache's miss tests."""
        intake_dir = tmp_path / "intake"
        intake_dir.mkdir()
        docs_dir = tmp_path / "documents"
        docs_dir.mkdir()
        shutil.copy(_FIXTURE_PDF, docs_dir / "sample.pdf")

        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        from app.config import get_settings
        get_settings.cache_clear()

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, s3_key="documents/sample.pdf")

        from worker.stages.parse import run
        run(doc_id)
        run(doc_id)  # second run — must not raise

        with psycopg.connect(stages_test_db) as conn:
            count = conn.execute(
                "SELECT count(*) FROM document_texts WHERE document_id = %s", (doc_id,)
            ).fetchone()[0]
            assert count == 1, "Exactly one document_texts row should exist after two runs"

    def test_parse_no_file_no_summary_returns_needs_review(
        self, tmp_path, stages_test_db, monkeypatch
    ):
        """Document with no accessible file and no summary in source_metadata
        → run returns 'needs_review' and document status = 'needs_review'."""
        intake_dir = tmp_path / "intake"
        intake_dir.mkdir()
        # No file placed in documents/ dir

        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        # Block the legacy fallback path too (defaults to /tmp/askWRI_docs,
        # which may contain real files on a dev machine)
        monkeypatch.setenv("DOCUMENTS_LOCAL_DIR", str(tmp_path / "nonexistent"))
        from app.config import get_settings
        get_settings.cache_clear()

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(
                conn,
                s3_key="documents/missing.pdf",
                source_metadata={},
            )

        from worker.stages.parse import run
        result = run(doc_id)
        assert result == "needs_review"

        with psycopg.connect(stages_test_db) as conn:
            status = conn.execute(
                "SELECT status FROM documents WHERE id = %s", (doc_id,)
            ).fetchone()[0]
            assert status == "needs_review"

    def test_parse_needs_review_does_not_overwrite_withdrawn(
        self, tmp_path, stages_test_db, monkeypatch
    ):
        """A withdrawn document with no file and no summary must STAY withdrawn —
        the two needs_review writes in parse are guarded by status <> 'withdrawn'
        (N-W4). The stage returns 'needs_review' (job routes to review) but the
        document status is unchanged."""
        intake_dir = tmp_path / "intake"
        intake_dir.mkdir()
        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        monkeypatch.setenv("DOCUMENTS_LOCAL_DIR", str(tmp_path / "nonexistent"))
        from app.config import get_settings
        get_settings.cache_clear()

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(
                conn, s3_key="documents/missing.pdf", source_metadata={},
            )
            conn.execute("UPDATE documents SET status='withdrawn' WHERE id=%s", (doc_id,))
            conn.commit()

        from worker.stages.parse import run
        result = run(doc_id)
        assert result == "needs_review"

        with psycopg.connect(stages_test_db) as conn:
            status = conn.execute(
                "SELECT status FROM documents WHERE id = %s", (doc_id,)
            ).fetchone()[0]
        assert status == "withdrawn", (
            f"a withdrawn doc must not be flipped to needs_review by parse, got {status!r}"
        )


class TestParseCache:
    """Issue #310 follow-up (Fix 1): an unchanged PDF parsed by an unchanged
    backend must not be re-OCR'd. Validity = same bytes + same parser, recorded
    in document_texts.parsed_content_hash / parse_backend / parse_model."""

    def _setup_pdf(self, tmp_path, monkeypatch, backend="pypdf"):
        intake_dir = tmp_path / "intake"
        intake_dir.mkdir()
        docs_dir = tmp_path / "documents"
        docs_dir.mkdir()
        shutil.copy(_FIXTURE_PDF, docs_dir / "sample.pdf")
        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        monkeypatch.setenv("PARSE_BACKEND", backend)
        monkeypatch.delenv("FORCE_REPARSE", raising=False)
        from app.config import get_settings
        get_settings.cache_clear()

    def _count_llm(self, monkeypatch, calls):
        """Count metadata-extraction calls; return all-null fields so nothing
        downstream of the extraction changes."""
        def fake(system, user, schema, model, max_tokens=1500):
            calls.append(user)
            return {f: None for f in schema["properties"]}
        monkeypatch.setattr("worker.llm.chat_json", fake)

    def _forbid_parse(self, monkeypatch):
        """Sentinel: any call to the parser (or the byte loader that feeds it)
        on a cache hit is the bug this fix exists to prevent."""
        def boom(*a, **k):
            raise AssertionError("parse cache hit must not re-parse the PDF")
        monkeypatch.setattr("worker.stages.parse._parse_pdf", boom)
        monkeypatch.setattr("worker.stages.parse._load_pdf_bytes", boom)

    def _stamps(self, db, doc_id):
        with psycopg.connect(db) as conn:
            return conn.execute(
                """SELECT parsed_content_hash, parse_backend, parse_model, full_text
                   FROM document_texts WHERE document_id = %s""",
                (doc_id,),
            ).fetchone()

    def test_fresh_parse_writes_cache_stamps(self, tmp_path, stages_test_db, monkeypatch):
        """(d) A first parse stamps the document's content_hash and the parser
        identity. pypdf has no model, so parse_model is '' — the empty string,
        not NULL, so a NULL stamp keeps meaning 'never cached'."""
        self._setup_pdf(tmp_path, monkeypatch)
        self._count_llm(monkeypatch, [])

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, s3_key="documents/sample.pdf")

        from worker.stages.parse import run
        assert run(doc_id) is None

        parsed_hash, backend, model, _ = self._stamps(stages_test_db, doc_id)
        assert parsed_hash == "abc123", f"expected the document's content_hash, got {parsed_hash!r}"
        assert backend == "pypdf"
        assert model == ""

    def test_cache_hit_skips_parse_and_reuses_text(self, tmp_path, stages_test_db, monkeypatch):
        """(a) Second run with unchanged bytes + parser: no download, no OCR,
        stored text reused — and the metadata-extraction LLM call STILL runs,
        which is what lets a prompt campaign re-run the cheap stages."""
        self._setup_pdf(tmp_path, monkeypatch)
        llm_calls = []
        self._count_llm(monkeypatch, llm_calls)

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, s3_key="documents/sample.pdf")

        from worker.stages.parse import run
        assert run(doc_id) is None
        first_text = self._stamps(stages_test_db, doc_id)[3]
        assert len(llm_calls) == 1

        self._forbid_parse(monkeypatch)
        assert run(doc_id) is None, "cache hit must complete the stage normally"

        parsed_hash, backend, model, text = self._stamps(stages_test_db, doc_id)
        assert text == first_text, "cache hit must reuse the stored text verbatim"
        assert (parsed_hash, backend, model) == ("abc123", "pypdf", ""), "stamps must survive a cache hit"
        assert len(llm_calls) == 2, (
            f"metadata extraction must still run on a cache hit, got {len(llm_calls)} calls"
        )
        with psycopg.connect(stages_test_db) as conn:
            status = conn.execute("SELECT status FROM documents WHERE id=%s", (doc_id,)).fetchone()[0]
        assert status == "processing", "the cache-hit path must still do the processing bookkeeping"

    def test_cache_miss_on_changed_bytes(self, tmp_path, stages_test_db, monkeypatch):
        """(b) A version replacement re-stamps documents.content_hash at intake;
        the stored text is then stale and must be re-parsed."""
        self._setup_pdf(tmp_path, monkeypatch)
        self._count_llm(monkeypatch, [])

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, s3_key="documents/sample.pdf")

        from worker.stages.parse import run
        assert run(doc_id) is None

        with psycopg.connect(stages_test_db) as conn:
            conn.execute("UPDATE documents SET content_hash='different' WHERE id=%s", (doc_id,))
            conn.commit()

        parsed = []
        from worker.stages.parse import _parse_pdf as real_parse
        monkeypatch.setattr("worker.stages.parse._parse_pdf",
                            lambda c: (parsed.append(1), real_parse(c))[1])
        assert run(doc_id) is None
        assert parsed == [1], "changed content_hash must miss the cache"
        assert self._stamps(stages_test_db, doc_id)[0] == "different", "re-parse re-stamps the new hash"

    def test_cache_miss_on_backend_change(self, tmp_path, stages_test_db, monkeypatch):
        """(b) A backend flip (pypdf<->mistral) invalidates stored text even
        though the bytes are unchanged — the two parsers produce different text."""
        self._setup_pdf(tmp_path, monkeypatch)
        self._count_llm(monkeypatch, [])

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, s3_key="documents/sample.pdf")

        from worker.stages.parse import run
        assert run(doc_id) is None

        monkeypatch.setenv("PARSE_BACKEND", "mistral")
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        from app.config import get_settings
        get_settings.cache_clear()

        monkeypatch.setattr("worker.stages.parse._parse_pdf_mistral",
                            lambda content: ("OCR text from mistral", [{"page": 1, "end_pos": 21}]))
        assert run(doc_id) is None

        parsed_hash, backend, model, text = self._stamps(stages_test_db, doc_id)
        assert text == "OCR text from mistral", "backend flip must re-parse, not reuse pypdf text"
        assert (backend, model) == ("mistral", "mistral-ocr-latest"), (
            f"stamps must record the new parser, got {backend!r}/{model!r}"
        )
        assert parsed_hash == "abc123"

    def test_cache_miss_on_model_change(self, tmp_path, stages_test_db, monkeypatch):
        """(b) Same backend, upgraded OCR model → miss (new model, new text)."""
        self._setup_pdf(tmp_path, monkeypatch, backend="mistral")
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        monkeypatch.setenv("MISTRAL_OCR_MODEL", "mistral-ocr-2505")
        from app.config import get_settings
        get_settings.cache_clear()
        self._count_llm(monkeypatch, [])
        monkeypatch.setattr("worker.stages.parse._parse_pdf_mistral",
                            lambda content: ("v1 text", [{"page": 1, "end_pos": 7}]))

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, s3_key="documents/sample.pdf")

        from worker.stages.parse import run
        assert run(doc_id) is None
        assert self._stamps(stages_test_db, doc_id)[2] == "mistral-ocr-2505"

        monkeypatch.setenv("MISTRAL_OCR_MODEL", "mistral-ocr-2510")
        get_settings.cache_clear()
        monkeypatch.setattr("worker.stages.parse._parse_pdf_mistral",
                            lambda content: ("v2 text", [{"page": 1, "end_pos": 7}]))
        assert run(doc_id) is None

        _, _, model, text = self._stamps(stages_test_db, doc_id)
        assert (model, text) == ("mistral-ocr-2510", "v2 text"), "an OCR model upgrade must re-parse"

    def test_null_stamps_always_miss(self, tmp_path, stages_test_db, monkeypatch):
        """(b) Every pre-migration row has NULL stamps — that is what makes the
        migration behavior-neutral. A NULL stamp must never match."""
        self._setup_pdf(tmp_path, monkeypatch)
        self._count_llm(monkeypatch, [])

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, s3_key="documents/sample.pdf")
            conn.execute(
                """INSERT INTO document_texts (document_id, full_text, page_boundaries, char_count)
                   VALUES (%s, 'stale pre-migration text', '[]'::jsonb, 24)""",
                (doc_id,),
            )
            conn.commit()

        from worker.stages.parse import run
        assert run(doc_id) is None

        parsed_hash, backend, _, text = self._stamps(stages_test_db, doc_id)
        assert text != "stale pre-migration text", "an unstamped row must be re-parsed"
        assert (parsed_hash, backend) == ("abc123", "pypdf")

    def test_null_content_hash_misses(self, tmp_path, stages_test_db, monkeypatch):
        """(b) CSV-era documents carry no content_hash: nothing to compare, so
        the cache can never claim their text is current."""
        self._setup_pdf(tmp_path, monkeypatch)
        self._count_llm(monkeypatch, [])

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, s3_key="documents/sample.pdf")

        from worker.stages.parse import run
        assert run(doc_id) is None

        with psycopg.connect(stages_test_db) as conn:
            conn.execute("UPDATE documents SET content_hash=NULL WHERE id=%s", (doc_id,))
            conn.commit()

        parsed = []
        from worker.stages.parse import _parse_pdf as real_parse
        monkeypatch.setattr("worker.stages.parse._parse_pdf",
                            lambda c: (parsed.append(1), real_parse(c))[1])
        assert run(doc_id) is None
        assert parsed == [1], "a NULL content_hash must miss the cache"

    def test_shrunk_parse_is_tagged_and_never_cache_hits(self, tmp_path, stages_test_db, monkeypatch):
        """A downsampled OCR submission is NOT the same product as a full-resolution
        one, but content_hash (the ORIGINAL bytes) and the model id are identical
        for both. The stamp is tagged so the two are distinguishable, and because
        the read path compares against the untagged identity, a shrunk row never
        hits — raising the cap and re-ingesting really does re-OCR at full
        resolution instead of serving downsampled text forever."""
        self._setup_pdf(tmp_path, monkeypatch, backend="mistral")
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        from app.config import get_settings
        get_settings.cache_clear()
        self._count_llm(monkeypatch, [])

        import worker.stages.parse as parse
        # Any file counts as oversized, so run() takes the shrink-tagged path.
        monkeypatch.setattr(parse, "MISTRAL_MAX_BYTES", 10)
        ocr_calls = []
        monkeypatch.setattr(parse, "_parse_pdf_mistral",
                            lambda c: (ocr_calls.append(1), ("shrunk OCR text", [{"page": 1, "end_pos": 15}]))[1])

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, s3_key="documents/sample.pdf")

        from worker.stages.parse import run
        assert run(doc_id) is None

        parsed_hash, backend, model, _ = self._stamps(stages_test_db, doc_id)
        assert (parsed_hash, backend) == ("abc123", "mistral")
        assert model == "mistral-ocr-latest" + parse.SHRINK_POLICY_TAG, (
            f"a shrunk parse must carry the policy tag, got {model!r}"
        )
        assert len(ocr_calls) == 1

        # Second run: same bytes, same backend/model — but the tag means miss.
        assert run(doc_id) is None
        assert len(ocr_calls) == 2, (
            "a shrunk row must NOT serve from cache; it re-OCRs until the "
            "oversize situation changes"
        )

    def test_summary_fallback_writes_no_stamps(self, tmp_path, stages_test_db, monkeypatch):
        """A document with no retrievable PDF falls back to title+summary text.
        That text was never parsed from bytes, so it must be stamped NULL —
        stamping it would let the cache serve non-PDF text as OCR output. This
        path is also the one that CLEARS stamps left by an earlier parse, so the
        row is seeded with stale ones (a MATCHING stamp would legitimately be
        served from cache and never reach the fallback)."""
        intake_dir = tmp_path / "intake"
        intake_dir.mkdir()
        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        monkeypatch.setenv("DOCUMENTS_LOCAL_DIR", str(tmp_path / "nonexistent"))
        monkeypatch.setenv("PARSE_BACKEND", "pypdf")
        monkeypatch.delenv("FORCE_REPARSE", raising=False)
        from app.config import get_settings
        get_settings.cache_clear()

        llm_calls = []
        self._count_llm(monkeypatch, llm_calls)

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(
                conn, s3_key="documents/missing.pdf",
                source_metadata={"summary": "A CSV-era summary standing in for the text."},
            )
            # Stale stamps from a run against different bytes -> cache miss.
            conn.execute(
                """INSERT INTO document_texts
                       (document_id, full_text, page_boundaries, char_count,
                        parsed_content_hash, parse_backend, parse_model)
                   VALUES (%s, 'old parsed text', '[{"page": 1, "end_pos": 15}]'::jsonb, 15,
                           'stale-hash', 'pypdf', '')""",
                (doc_id,),
            )
            conn.commit()

        from worker.stages.parse import run
        assert run(doc_id) is None

        with psycopg.connect(stages_test_db) as conn:
            parsed_hash, backend, model, text, boundaries = conn.execute(
                """SELECT parsed_content_hash, parse_backend, parse_model, full_text, page_boundaries
                   FROM document_texts WHERE document_id = %s""",
                (doc_id,),
            ).fetchone()
        assert "A CSV-era summary" in text, "the fallback text should have replaced the parsed text"
        assert (parsed_hash, backend, model) == (None, None, None), (
            f"fallback text must carry no cache stamps, got {parsed_hash!r}/{backend!r}/{model!r}"
        )
        assert boundaries == [], "the fallback emits no page boundaries"
        assert llm_calls == [], "no PDF text, so no metadata extraction call"

    def test_force_reparse_bypasses_the_cache(self, tmp_path, stages_test_db, monkeypatch):
        """(c) The escape hatch for a deliberate re-OCR (e.g. an OCR quality
        regression under an unchanged model id)."""
        self._setup_pdf(tmp_path, monkeypatch)
        self._count_llm(monkeypatch, [])

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, s3_key="documents/sample.pdf")

        from worker.stages.parse import run
        assert run(doc_id) is None

        monkeypatch.setenv("FORCE_REPARSE", "true")
        from app.config import get_settings
        get_settings.cache_clear()

        parsed = []
        from worker.stages.parse import _parse_pdf as real_parse
        monkeypatch.setattr("worker.stages.parse._parse_pdf",
                            lambda c: (parsed.append(1), real_parse(c))[1])
        assert run(doc_id) is None
        assert parsed == [1], "FORCE_REPARSE=true must re-parse despite matching stamps"
        assert self._stamps(stages_test_db, doc_id)[0] == "abc123", "a forced re-parse still stamps"


class TestBatchOcrTargetSelection:
    """scripts/batch_ocr.py selects the documents it will pay to OCR. Its
    predicate is asserted here against REAL Postgres, because the hermetic unit
    tests can only substring-match the SQL: swapping LEFT JOIN for JOIN — which
    would silently drop the single biggest miss class, documents with no
    document_texts row at all — passes every string assertion."""

    MODEL = "mistral-ocr-latest"

    def _targets(self, db):
        from scripts.batch_ocr import select_targets
        with psycopg.connect(db) as conn:
            return {t["external_id"] for t in select_targets(conn, self.MODEL, backend="mistral")}

    def _doc(self, conn, external_id):
        """Insert a document with a UNIQUE content_hash (the documents table has
        a unique partial index on it, so the shared helper's fixed hash collides)."""
        doc_id = _insert_document(conn, external_id=external_id,
                                  s3_key=f"documents/{external_id}.pdf")
        conn.execute("UPDATE documents SET content_hash=%s WHERE id=%s",
                     (f"hash-{external_id}", doc_id))
        conn.commit()
        return doc_id

    def _stamp(self, conn, doc_id, *, hash_=None, backend="mistral", model=MODEL):
        conn.execute(
            """INSERT INTO document_texts (document_id, full_text, page_boundaries,
                   char_count, parsed_content_hash, parse_backend, parse_model)
               VALUES (%s, 'stored text', '[{"page": 1, "end_pos": 11}]'::jsonb, 11, %s, %s, %s)
               ON CONFLICT (document_id) DO UPDATE
               SET parsed_content_hash = EXCLUDED.parsed_content_hash,
                   parse_backend = EXCLUDED.parse_backend,
                   parse_model = EXCLUDED.parse_model""",
            (doc_id, hash_, backend, model))

    def test_selects_exactly_the_documents_that_would_miss_the_cache(self, stages_test_db):
        with psycopg.connect(stages_test_db) as conn:
            self._doc(conn, "no-text")
            current = self._doc(conn, "current")
            stale_hash = self._doc(conn, "stale-hash")
            other_backend = self._doc(conn, "other-backend")
            other_model = self._doc(conn, "other-model")
            withdrawn = self._doc(conn, "withdrawn")
            no_hash = self._doc(conn, "no-hash")

            self._stamp(conn, current, hash_="hash-current")
            self._stamp(conn, stale_hash, hash_="a-previous-version")
            self._stamp(conn, other_backend, hash_="hash-other-backend", backend="pypdf")
            self._stamp(conn, other_model, hash_="hash-other-model", model="mistral-ocr-2505")
            self._stamp(conn, withdrawn, hash_="hash-withdrawn")
            conn.execute("UPDATE documents SET status='withdrawn' WHERE id=%s", (withdrawn,))
            conn.execute("UPDATE documents SET content_hash=NULL WHERE id=%s", (no_hash,))
            conn.commit()

        selected = self._targets(stages_test_db)

        # no-text has no document_texts row at all — the LEFT JOIN case, and the
        # largest class in a fresh corpus import.
        assert "no-text" in selected
        assert "stale-hash" in selected, "changed bytes must be re-OCR'd"
        assert "other-backend" in selected and "other-model" in selected
        assert "current" not in selected, "a current stamp must NOT be paid for again"
        assert "withdrawn" not in selected, "withdrawn documents are never re-OCR'd"
        assert "no-hash" not in selected, "nothing to compare bytes against"

    def test_shrunk_documents_are_selected_but_skipped_before_upload(self, stages_test_db):
        """A +gs300 row never cache-hits, so SQL correctly sees it as a miss —
        but batching it would be wasted spend, since the follow-up pipeline pass
        re-OCRs it anyway. The size check in the execute path is what drops it."""
        from worker.stages.parse import SHRINK_POLICY_TAG
        with psycopg.connect(stages_test_db) as conn:
            shrunk = self._doc(conn, "shrunk")
            self._stamp(conn, shrunk, hash_="hash-shrunk",
                        model=self.MODEL + SHRINK_POLICY_TAG)
            conn.commit()

        assert "shrunk" in self._targets(stages_test_db)


class FakeMistralBatchAPI:
    """A stand-in for the whole Mistral surface scripts/batch_ocr.py --execute
    touches, wired to the shapes the live probe returned on 2026-08-05.

    Records every call so the test can assert on the sequence, and fails loudly
    on any URL the script is not supposed to hit.
    """

    def __init__(self, pages_by_custom_id, job_statuses=("QUEUED", "SUCCESS")):
        self.pages_by_custom_id = pages_by_custom_id
        self.job_statuses = list(job_statuses)
        self.uploaded_pdfs = {}    # file id -> bytes
        self.batch_jsonl = None
        self.deleted = []
        self.job_payload = None
        self._n = 0

    def install(self, monkeypatch):
        monkeypatch.setattr("requests.post", self.post)
        monkeypatch.setattr("requests.get", self.get)
        monkeypatch.setattr("requests.delete", self.delete)
        return self

    def _resp(self, payload, text=None):
        class _R:
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self_inner):
                return payload

        r = _R()
        if text is not None:
            r.text = text
        return r

    def post(self, url, headers=None, files=None, data=None, json=None, timeout=None):
        if url.endswith("/v1/files"):
            purpose = data["purpose"]
            content = files["file"][1]
            if purpose == "ocr":
                self._n += 1
                fid = f"pdf-{self._n}"
                self.uploaded_pdfs[fid] = content
                return self._resp({"id": fid})
            if purpose == "batch":
                self.batch_jsonl = content
                return self._resp({"id": "batchfile-1"})
            raise AssertionError(f"unexpected purpose {purpose}")
        if url.endswith("/v1/batch/jobs"):
            self.job_payload = json
            return self._resp({"id": "job-1", "status": "QUEUED"})
        raise AssertionError(f"unexpected POST {url}")

    def get(self, url, headers=None, params=None, timeout=None):
        if url.endswith("/url"):
            fid = url.split("/v1/files/")[1].split("/")[0]
            return self._resp({"url": f"https://signed.invalid/{fid}?sig=x"})
        if "/v1/batch/jobs/" in url:
            status = self.job_statuses.pop(0) if len(self.job_statuses) > 1 \
                else self.job_statuses[0]
            return self._resp({"id": "job-1", "status": status,
                               "succeeded_requests": len(self.pages_by_custom_id),
                               "failed_requests": 0, "output_file": "out-1"})
        if url.endswith("/v1/files/out-1/content"):
            lines = [json_mod.dumps({"custom_id": cid, "error": None,
                                     "response": {"status_code": 200,
                                                  "body": {"pages": pages}}})
                     for cid, pages in self.pages_by_custom_id.items()]
            return self._resp({}, text="\n".join(lines))
        raise AssertionError(f"unexpected GET {url}")

    def delete(self, url, headers=None, timeout=None):
        self.deleted.append(url.rsplit("/", 1)[-1])
        return self._resp({})


class TestBatchOcrEndToEnd:
    """Drives scripts/batch_ocr.py --execute all the way through against a real
    scratch database with the Mistral API mocked.

    This is the path that a live run would take and that nothing else exercises:
    select -> upload -> sign -> submit -> poll -> fetch -> write -> enqueue. The
    final assertion is the one the whole design rests on — that the document the
    script stored is then a parse-cache HIT, so the pipeline pass it enqueues
    does not pay for OCR a second time.
    """

    def test_execute_writes_text_enqueues_and_leaves_a_cache_hit(
        self, tmp_path, stages_test_db, monkeypatch
    ):
        from scripts import batch_ocr

        intake_dir = tmp_path / "intake"
        intake_dir.mkdir()
        docs_dir = tmp_path / "documents"
        docs_dir.mkdir()
        shutil.copy(_FIXTURE_PDF, docs_dir / "batch-doc.pdf")

        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        monkeypatch.setenv("PARSE_BACKEND", "mistral")
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        monkeypatch.delenv("FORCE_REPARSE", raising=False)
        from app.config import get_settings
        get_settings.cache_clear()

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, external_id="batch-doc",
                                      s3_key="documents/batch-doc.pdf")

        pages = [{"index": 0, "markdown": "# Batched Report\n\nFirst page body."},
                 {"index": 1, "markdown": "Second page body."}]
        fake = FakeMistralBatchAPI({"batch-doc": pages}).install(monkeypatch)

        written = batch_ocr.run(execute=True, poll_interval=0)

        assert written == 1, "the document should have been stored"

        # --- the API conversation looked the way the live probe did ---
        assert len(fake.uploaded_pdfs) == 1, "one PDF uploaded"
        assert list(fake.uploaded_pdfs.values())[0][:4] == b"%PDF", "the real file was uploaded"
        assert fake.job_payload["endpoint"] == "/v1/ocr"
        assert fake.job_payload["input_files"] == ["batchfile-1"]
        entry = json_mod.loads(fake.batch_jsonl.decode().strip())
        assert entry["custom_id"] == "batch-doc"
        assert entry["body"]["document"]["document_url"].startswith("https://signed.invalid/")
        assert fake.deleted == ["pdf-1"], "the uploaded copy is cleaned up after the job"

        # --- the database got the text, the stamps, and a queued job ---
        with psycopg.connect(stages_test_db) as conn:
            text, boundaries, stamp_hash, backend, model = conn.execute(
                """SELECT full_text, page_boundaries, parsed_content_hash,
                          parse_backend, parse_model
                   FROM document_texts WHERE document_id = %s""", (doc_id,)).fetchone()
            jobs = conn.execute(
                "SELECT count(*) FROM ingestion_jobs WHERE document_id = %s AND status = 'queued'",
                (doc_id,)).fetchone()[0]
        assert text == "# Batched Report\n\nFirst page body.\n\nSecond page body."
        assert [b["page"] for b in boundaries] == [1, 2]
        assert (stamp_hash, backend, model) == ("abc123", "mistral", "mistral-ocr-latest")
        assert jobs == 1, "the document must be enqueued for the rest of the pipeline"

        # --- THE POINT: the pipeline pass it enqueued does no OCR ---
        import worker.stages.parse as parse_mod

        def boom(*a, **k):
            raise AssertionError("the enqueued pass must hit the parse cache, not re-OCR")

        monkeypatch.setattr(parse_mod, "_parse_pdf", boom)
        monkeypatch.setattr(parse_mod, "_load_pdf_bytes", boom)
        monkeypatch.setattr("worker.llm.chat_json",
                            lambda system, user, schema, model, max_tokens=1500: {
                                f: None for f in schema["properties"]})

        assert parse_mod.run(doc_id) is None
        with psycopg.connect(stages_test_db) as conn:
            after = conn.execute(
                "SELECT full_text FROM document_texts WHERE document_id = %s",
                (doc_id,)).fetchone()[0]
        assert after == text, "the cached batch text survives the pipeline pass intact"

    def test_execute_collects_partial_results_from_a_timed_out_job(
        self, tmp_path, stages_test_db, monkeypatch
    ):
        """A TIMEOUT_EXCEEDED job has already produced and billed some pages.
        Discarding them means paying twice, so they are collected anyway."""
        from scripts import batch_ocr

        intake_dir = tmp_path / "intake"
        intake_dir.mkdir()
        docs_dir = tmp_path / "documents"
        docs_dir.mkdir()
        shutil.copy(_FIXTURE_PDF, docs_dir / "partial.pdf")

        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        monkeypatch.setenv("PARSE_BACKEND", "mistral")
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        from app.config import get_settings
        get_settings.cache_clear()

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, external_id="partial",
                                      s3_key="documents/partial.pdf")

        fake = FakeMistralBatchAPI(
            {"partial": [{"index": 0, "markdown": "Recovered text"}]},
            job_statuses=("TIMEOUT_EXCEEDED",),
        ).install(monkeypatch)

        written = batch_ocr.run(execute=True, poll_interval=0)

        assert written == 1, "partial results must be collected, not thrown away"
        assert fake.deleted == ["pdf-1"], "uploads are cleaned up even on a failed job"
        with psycopg.connect(stages_test_db) as conn:
            text = conn.execute(
                "SELECT full_text FROM document_texts WHERE document_id = %s",
                (doc_id,)).fetchone()[0]
        assert text == "Recovered text"


class TestParseTitleAndAuthors:
    """Issue #303: parse extracts title and title_en as two separate fields, and
    transliterates author names, all in its one existing metadata call."""

    def _setup_pdf(self, tmp_path, monkeypatch):
        """Point the loader at a real fixture PDF on disk (local intake lane)."""
        intake_dir = tmp_path / "intake"
        intake_dir.mkdir()
        docs_dir = tmp_path / "documents"
        docs_dir.mkdir()
        shutil.copy(_FIXTURE_PDF, docs_dir / "sample.pdf")
        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        from app.config import get_settings
        get_settings.cache_clear()

    def _fake_llm(self, monkeypatch, calls, **fields):
        """Patch worker.llm.chat_json — parse imports it inside the function, so
        the module attribute is what the call resolves against."""
        payload = {f: None for f in ("title", "title_en", "authors", "doi",
                                     "year_published", "article_type",
                                     "wri_primary_office")}
        payload.update(fields)

        def fake(system, user, schema, model, max_tokens=1500):
            calls.append({"system": system, "schema": set(schema["properties"])})
            return dict(payload)

        monkeypatch.setattr("worker.llm.chat_json", fake)

    def test_bilingual_cover_keeps_native_title_and_english_title_apart(
        self, tmp_path, stages_test_db, monkeypatch
    ):
        """The reported bug: a cover carrying both a Chinese and an English title
        used to land concatenated in BOTH columns. title must now hold the native
        title alone and title_en the English one, each marked 'llm'."""
        self._setup_pdf(tmp_path, monkeypatch)
        calls = []
        self._fake_llm(
            monkeypatch, calls,
            title="中国交通运输低碳发展",
            title_en="Low-Carbon Development of Transport in China",
            authors=[
                {"family_name": "Xue", "given_names": "Lulu", "organization_name": None},
                {"family_name": "Liu", "given_names": "Daizong", "organization_name": None},
            ],
        )

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, s3_key="documents/sample.pdf")

        from worker.stages.parse import run
        assert run(doc_id) is None

        assert len(calls) == 1, f"expected one extraction call, got {len(calls)}"
        assert "title_en" in calls[0]["schema"], "title_en must be in the extraction schema"

        with psycopg.connect(stages_test_db) as conn:
            title, title_en, authors, ms = conn.execute(
                """SELECT title, title_en, authors, metadata_source
                   FROM documents WHERE id=%s""",
                (doc_id,),
            ).fetchone()

        assert title == "中国交通运输低碳发展"
        assert title_en == "Low-Carbon Development of Transport in China"
        assert title_en != title, "title_en must not repeat the native title"
        assert "中国交通运输低碳发展" not in title_en, (
            f"the native title must not be concatenated into title_en; got {title_en!r}"
        )
        assert authors == "Xue, Lulu; Liu, Daizong"
        assert ms["title"] == "llm" and ms["title_en"] == "llm"

    def test_authors_prompt_requires_latin_transliteration(self):
        """The transliteration is prompt-driven, so the contract lives in the
        prompt: assert it actually asks for Latin-script author names."""
        from worker.stages.parse import _extract_metadata_llm

        captured = {}

        def fake(system, user, schema, model, max_tokens=1500):
            captured["system"] = system
            return {f: None for f in schema["properties"]}

        import worker.llm
        original = worker.llm.chat_json
        worker.llm.chat_json = fake
        try:
            _extract_metadata_llm("some text", "test-model")
        finally:
            worker.llm.chat_json = original

        system = captured["system"]
        assert "transliterate" in system.lower(), "prompt must ask for transliterated authors"
        assert "Latin" in system, "prompt must name the target script"
        assert "family_name" in system and "given_names" in system
        assert "primary language" in system, "prompt must ask for a single-language title"

    def test_human_edited_title_en_not_overwritten_by_parse(
        self, tmp_path, stages_test_db, monkeypatch
    ):
        """title_en rides the same provenance guard as every other extracted
        field: a 'human' value survives re-extraction untouched."""
        self._setup_pdf(tmp_path, monkeypatch)
        self._fake_llm(monkeypatch, [], title="中文标题", title_en="Machine English Title")

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, s3_key="documents/sample.pdf")
            conn.execute(
                """UPDATE documents
                   SET title_en = 'Curated English Title',
                       metadata_source = '{"title_en": "human"}'::jsonb
                   WHERE id = %s""",
                (doc_id,),
            )
            conn.commit()

        from worker.stages.parse import run
        run(doc_id)

        with psycopg.connect(stages_test_db) as conn:
            title_en, prov = conn.execute(
                "SELECT title_en, metadata_source->>'title_en' FROM documents WHERE id=%s",
                (doc_id,),
            ).fetchone()
        assert title_en == "Curated English Title"
        assert prov == "human"

    def test_llm_title_en_refreshed_on_reingest(
        self, tmp_path, stages_test_db, monkeypatch
    ):
        """Parse now owns the title/title_en pair, so it is parse that keeps them
        from drifting: a stale 'llm' title_en is replaced on re-ingest. (This
        assertion used to live on the summarize stage.)"""
        self._setup_pdf(tmp_path, monkeypatch)
        self._fake_llm(monkeypatch, [], title="新的中文标题", title_en="Fresh English Title")

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, s3_key="documents/sample.pdf")
            conn.execute(
                """UPDATE documents
                   SET title_en = 'Stale English Title',
                       metadata_source = '{"title_en": "llm"}'::jsonb
                   WHERE id = %s""",
                (doc_id,),
            )
            conn.commit()

        from worker.stages.parse import run
        run(doc_id)

        with psycopg.connect(stages_test_db) as conn:
            title, title_en, prov = conn.execute(
                """SELECT title, title_en, metadata_source->>'title_en'
                   FROM documents WHERE id=%s""",
                (doc_id,),
            ).fetchone()
        assert title == "新的中文标题"
        assert title_en == "Fresh English Title", "a stale llm title_en must be refreshed"
        assert prov == "llm"


# ---------------------------------------------------------------------------
# --- language stage ---
# ---------------------------------------------------------------------------

_EN_TEXT = (
    "The World Resources Institute publishes reports on climate change and "
    "sustainable development. Their research covers forests, water, food, and "
    "energy systems around the globe. Policy makers and businesses use WRI data "
    "to guide environmental decisions."
)

_ES_TEXT = (
    "El Instituto de Recursos Mundiales publica informes sobre el cambio "
    "climático y el desarrollo sostenible. Su investigación abarca bosques, "
    "agua, alimentos y sistemas energéticos en todo el mundo. Los responsables "
    "políticos y las empresas utilizan los datos del WRI para orientar las "
    "decisiones medioambientales."
)

_ZH_SIMPLIFIED_TEXT = (
    "世界资源研究所发布有关气候变化和可持续发展的报告。"
    "他们的研究涵盖全球的森林、水资源、粮食和能源系统。"
    "政策制定者和企业使用世界资源研究所的数据来指导环境决策。"
    "这些研究为全球可持续发展提供了重要的科学依据。"
)

_ZH_TRADITIONAL_TEXT = (
    "臺灣是一個美麗的島嶼，位於亞洲東部。這裡有豐富的自然景觀和文化遺產。"
    "臺灣人民勤奮努力，創造了經濟奇蹟。教育和科技是臺灣發展的重要支柱。"
    "許多國際企業選擇在臺灣設立研發中心。"
)

_PT_TEXT = (
    "O Instituto de Recursos Mundiais publica relatórios sobre mudanças "
    "climáticas e desenvolvimento sustentável. Sua pesquisa abrange florestas, "
    "água, alimentos e sistemas de energia em todo o mundo. Formuladores de "
    "políticas e empresas usam dados do WRI para orientar decisões ambientais."
)

_DE_TEXT = (
    "Das World Resources Institute veröffentlicht Berichte über den Klimawandel "
    "und nachhaltige Entwicklung. Ihre Forschung umfasst Wälder, Wasser, "
    "Lebensmittel und Energiesysteme auf der ganzen Welt. Politische "
    "Entscheidungsträger und Unternehmen nutzen WRI-Daten für Umweltentscheidungen."
)


class TestDetectUnit:
    """Unit tests for worker.stages.language.detect — no DB required."""

    def test_english_text(self):
        from worker.stages.language import detect
        assert detect(_EN_TEXT) == "en"

    def test_spanish_text(self):
        from worker.stages.language import detect
        assert detect(_ES_TEXT) == "es"

    def test_chinese_simplified_maps_to_zh(self):
        """langdetect returns 'zh-cn' for Simplified; startswith branch maps it to 'zh'."""
        from worker.stages.language import detect
        assert detect(_ZH_SIMPLIFIED_TEXT) == "zh"

    def test_portuguese_text(self):
        from worker.stages.language import detect
        assert detect(_PT_TEXT) == "pt"

    def test_chinese_traditional_maps_to_zh(self):
        """langdetect returns 'zh-tw' for Traditional; startswith branch maps it to 'zh'."""
        from worker.stages.language import detect
        assert detect(_ZH_TRADITIONAL_TEXT) == "zh"

    def test_determinism(self):
        """Calling detect twice on the same text returns the same code."""
        from worker.stages.language import detect
        first = detect(_EN_TEXT)
        second = detect(_EN_TEXT)
        assert first == second

    def test_bilingual_english_cover_does_not_mask_zh_body(self):
        """WRI zh/es/pt reports carry English cover/title/abstract pages; a
        head-only sample detects 'en' and a full re-ingest would corrupt
        documents.language (found 2026-07-22 during the Phase 1 pilot —
        4 of 9 non-EN fixture docs flipped, under BOTH parsers)."""
        from worker.stages.language import detect
        cover = _EN_TEXT * 30          # ~7.8k chars of English front matter
        body = _ZH_SIMPLIFIED_TEXT * 120
        assert detect(cover + body) == "zh"

    def test_bilingual_english_cover_does_not_mask_es_body(self):
        from worker.stages.language import detect
        cover = _EN_TEXT * 30
        body = _ES_TEXT * 60
        assert detect(cover + body) == "es"

    def test_interleaved_zh_en_detects_zh_by_cjk_fraction(self):
        """zh papers with English covers AND English reference/table sections
        can lose the window vote [en, zh, en] because langdetect calls
        35%-CJK mixed windows 'en' (found 2026-07-22: docs 1665/5424 flipped
        zh->en). Character evidence beats langdetect: substantial CJK
        fraction across the samples means zh."""
        from worker.stages.language import detect
        mixed = _EN_TEXT + _ZH_SIMPLIFIED_TEXT  # ~35% CJK, like a real page
        doc = (mixed * 40) + (_EN_TEXT * 20)    # en-heavy tail (references)
        assert detect(doc) == "zh"

    def test_english_doc_mentioning_china_stays_en(self):
        """A few CJK terms in an English doc must not trip the zh gate."""
        from worker.stages.language import detect
        doc = (_EN_TEXT * 40) + "北京 上海 " + (_EN_TEXT * 40)
        assert detect(doc) == "en"

    def test_unsupported_language_falls_back_to_en(self):
        """German (not in SUPPORTED) falls back to 'en'."""
        from worker.stages.language import detect
        assert detect(_DE_TEXT) == "en"


class TestLanguageStageWrite:

    def test_language_stage_writes_language_columns(self, stages_test_db):
        """language stage reads document_texts.full_text, detects 'en',
        and writes documents.language = 'en', documents.languages = ['en']."""
        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(conn, external_id="lang-test-doc")
            conn.execute(
                """INSERT INTO document_texts (document_id, full_text, char_count, page_boundaries)
                   VALUES (%s, %s, %s, %s)""",
                (doc_id, _EN_TEXT, len(_EN_TEXT), []),
            )
            conn.commit()

        from worker.stages.language import run
        result = run(doc_id)
        assert result is None

        with psycopg.connect(stages_test_db) as conn:
            row = conn.execute(
                "SELECT language, languages FROM documents WHERE id = %s", (doc_id,)
            ).fetchone()
            assert row is not None
            language, languages = row
            assert language == "en"
            assert languages == ["en"]

    def test_language_stage_merges_existing_languages_never_shrinks(self, stages_test_db):
        """A doc with languages=['en','es'] re-ingested and language detection returns 'en'
        must MERGE (never shrink) — 'es' is preserved (design §7.4: detect the set
        present; a re-ingest must not drop a language)."""
        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document_with_lang(
                conn, external_id="merge-lang-doc",
                language="en", languages=["en", "es"], title="Merge Doc",
            )
            conn.execute(
                """INSERT INTO document_texts (document_id, full_text, char_count, page_boundaries)
                   VALUES (%s, %s, %s, %s)""",
                (doc_id, _EN_TEXT, len(_EN_TEXT), []),
            )
            conn.commit()

        from worker.stages.language import run
        result = run(doc_id)
        assert result is None

        with psycopg.connect(stages_test_db) as conn:
            row = conn.execute(
                "SELECT language, languages FROM documents WHERE id = %s", (doc_id,)
            ).fetchone()
            assert row is not None
            language, languages = row
            assert language == "en", f"primary language should be 'en', got {language!r}"
            assert set(languages) == {"en", "es"}, (
                f"languages[] must preserve 'es' (merge, never shrink); got {languages!r}"
            )

    def test_language_stage_adds_newly_detected_language(self, stages_test_db):
        """A doc with languages=['en'] whose detected language is 'es' should
        merge 'es' in (primary becomes 'es', array keeps 'en')."""
        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document_with_lang(
                conn, external_id="add-lang-doc",
                language="en", languages=["en"], title="Add Lang Doc",
            )
            conn.execute(
                """INSERT INTO document_texts (document_id, full_text, char_count, page_boundaries)
                   VALUES (%s, %s, %s, %s)""",
                (doc_id, _ES_TEXT, len(_ES_TEXT), []),
            )
            conn.commit()

        from worker.stages.language import run
        run(doc_id)

        with psycopg.connect(stages_test_db) as conn:
            row = conn.execute(
                "SELECT language, languages FROM documents WHERE id = %s", (doc_id,)
            ).fetchone()
            assert row is not None
            language, languages = row
            assert language == "es"
            assert set(languages) == {"en", "es"}, (
                f"existing 'en' must be preserved when 'es' is detected; got {languages!r}"
            )


# ---------------------------------------------------------------------------
# --- summarize stage ---
# ---------------------------------------------------------------------------

def _insert_document_with_lang(conn, *, external_id, language, languages, title="Test Title",
                               metadata_source=None, title_en=None):
    """Insert a documents row with language/languages set; return id."""
    row = conn.execute(
        """INSERT INTO documents
               (external_id, s3_key, title, title_en, status, content_hash, language, languages, metadata_source)
           VALUES (%s, %s, %s, %s, 'draft', 'abc123', %s, %s, %s)
           RETURNING id""",
        (external_id, f"documents/{external_id}.pdf", title, title_en, language, languages,
         Jsonb(metadata_source or {})),
    ).fetchone()
    conn.commit()
    return row[0]


def _insert_document_text(conn, document_id, text="Sample document text."):
    conn.execute(
        """INSERT INTO document_texts (document_id, full_text, char_count, page_boundaries)
           VALUES (%s, %s, %s, %s)""",
        (document_id, text, len(text), []),
    )
    conn.commit()


class TestSummarizeStage:

    def _make_fake_llm(self, calls: list):
        """Return a fake chat_json that records calls and returns canned responses."""
        call_index = {"n": 0}

        def fake(system, user, schema, model, max_tokens=1500):
            n = call_index["n"]
            call_index["n"] += 1
            props = set((schema.get("properties") or {}).keys())
            calls.append({"system": system, "user": user, "model": model, "n": n, "schema": props})
            # Title-translation call (summarize._translate_title) vs summary call.
            if props == {"title_en"}:
                return {"title_en": f"English title {n}"}
            return {"long": f"Long summary call {n}.", "short": f"Short {n}."}

        return fake

    def test_zh_document_produces_four_rows_and_translated_title_en(
        self, stages_test_db, monkeypatch
    ):
        """zh document → 4 summary rows (zh long/short + en long/short),
        all source='generated'; title_en is a translation (not the native title);
        3 LLM calls (2 summaries + 1 title translation); provenance = 'llm'."""
        calls = []
        monkeypatch.setattr("worker.stages.summarize.chat_json", self._make_fake_llm(calls))

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document_with_lang(
                conn, external_id="zh-doc", language="zh", languages=["zh"], title="中文标题"
            )
            _insert_document_text(conn, doc_id, text="中文内容。")

        from worker.stages.summarize import run
        result = run(doc_id)
        assert result is None

        # 2 summary calls (en + zh) + 1 title-translation call.
        assert len(calls) == 3, f"Expected 3 LLM calls, got {len(calls)}"
        title_calls = [c for c in calls if c["schema"] == {"title_en"}]
        assert len(title_calls) == 1, "expected exactly one title-translation call"

        with psycopg.connect(stages_test_db) as conn:
            rows = conn.execute(
                "SELECT language, kind, source FROM document_summaries WHERE document_id=%s ORDER BY language, kind",
                (doc_id,),
            ).fetchall()
            assert len(rows) == 4, f"Expected 4 summary rows, got {len(rows)}: {rows}"
            for lang, kind, source in rows:
                assert source == "generated", f"Expected source='generated', got '{source}'"
            langs_kinds = {(r[0], r[1]) for r in rows}
            assert langs_kinds == {("en", "long"), ("en", "short"), ("zh", "long"), ("zh", "short")}

            title_en, prov = conn.execute(
                "SELECT title_en, metadata_source->>'title_en' FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()
            assert title_en.startswith("English title"), (
                f"title_en should be the LLM translation, not the native title; got {title_en!r}"
            )
            assert title_en != "中文标题", "title_en must not be the untranslated native title"
            assert prov == "llm", f"title_en provenance should be 'llm', got {prov!r}"

    def test_en_document_produces_two_rows_and_title_en(
        self, stages_test_db, monkeypatch
    ):
        """en document → 2 rows (en long/short); 1 LLM call; title_en set to title
        (design §6: title_en always populated — NEW-P2-8 fixed the non-EN-only gap)."""
        calls = []
        monkeypatch.setattr("worker.stages.summarize.chat_json", self._make_fake_llm(calls))

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document_with_lang(
                conn, external_id="en-doc", language="en", languages=["en"], title="English Title"
            )
            _insert_document_text(conn, doc_id, text="English document content.")

        from worker.stages.summarize import run
        result = run(doc_id)
        assert result is None

        assert len(calls) == 1, f"Expected 1 LLM call, got {len(calls)}"

        with psycopg.connect(stages_test_db) as conn:
            rows = conn.execute(
                "SELECT language, kind, source FROM document_summaries WHERE document_id=%s",
                (doc_id,),
            ).fetchall()
            assert len(rows) == 2, f"Expected 2 summary rows, got {len(rows)}"
            langs_kinds = {(r[0], r[1]) for r in rows}
            assert langs_kinds == {("en", "long"), ("en", "short")}

            title_en = conn.execute(
                "SELECT title_en FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()[0]
            assert title_en == "English Title", (
                f"title_en should be set to title for English documents too, got {title_en!r}"
            )

    def test_title_en_human_edit_not_overwritten(self, stages_test_db, monkeypatch):
        """A human-edited title_en (metadata_source.title_en='human') is protected:
        summarize never overwrites it and makes no translation call."""
        calls = []
        monkeypatch.setattr("worker.stages.summarize.chat_json", self._make_fake_llm(calls))

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document_with_lang(
                conn, external_id="zh-human", language="zh", languages=["zh"],
                title="中文标题", title_en="Curated English Title",
                metadata_source={"title_en": "human"},
            )
            _insert_document_text(conn, doc_id, text="中文内容。")

        from worker.stages.summarize import run
        run(doc_id)

        assert [c for c in calls if c["schema"] == {"title_en"}] == [], \
            "protected title_en must not trigger a translation call"
        with psycopg.connect(stages_test_db) as conn:
            title_en, prov = conn.execute(
                "SELECT title_en, metadata_source->>'title_en' FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()
        assert title_en == "Curated English Title"
        assert prov == "human"

    def test_title_en_external_provenance_not_overwritten(self, stages_test_db, monkeypatch):
        """A CSV-imported title_en (metadata_source.title_en='external') is protected."""
        calls = []
        monkeypatch.setattr("worker.stages.summarize.chat_json", self._make_fake_llm(calls))

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document_with_lang(
                conn, external_id="es-external", language="es", languages=["es"],
                title="Título en español", title_en="CSV English Title",
                metadata_source={"title_en": "external"},
            )
            _insert_document_text(conn, doc_id, text="Contenido en español.")

        from worker.stages.summarize import run
        run(doc_id)

        assert [c for c in calls if c["schema"] == {"title_en"}] == [], \
            "external title_en must not trigger a translation call"
        with psycopg.connect(stages_test_db) as conn:
            title_en = conn.execute(
                "SELECT title_en FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()[0]
        assert title_en == "CSV English Title"

    def test_populated_title_en_is_left_to_parse(self, stages_test_db, monkeypatch):
        """Issue #303 moved ownership of the title/title_en pair to parse, which
        extracts both from the PDF in one call and refreshes both on re-ingest.
        Summarize is the fallback for documents parse could not reach, so a
        title_en that is already populated must not trigger a translation — that
        call would overwrite the document's own English title with a machine
        translation of the native one. (Refresh-on-re-ingest is now asserted by
        TestParseTitleAndAuthors.test_llm_title_en_refreshed_on_reingest.)"""
        calls = []
        monkeypatch.setattr("worker.stages.summarize.chat_json", self._make_fake_llm(calls))

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document_with_lang(
                conn, external_id="zh-parsed", language="zh", languages=["zh"],
                title="中文标题", title_en="Title From The Cover Page",
                metadata_source={"title_en": "llm"},
            )
            _insert_document_text(conn, doc_id, text="中文内容。")

        from worker.stages.summarize import run
        run(doc_id)

        assert [c for c in calls if c["schema"] == {"title_en"}] == [], \
            "a title_en parse already extracted must not be re-translated"
        with psycopg.connect(stages_test_db) as conn:
            title_en, prov = conn.execute(
                "SELECT title_en, metadata_source->>'title_en' FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()
        assert title_en == "Title From The Cover Page"
        assert prov == "llm"

    def test_blank_title_en_still_translated_as_fallback(self, stages_test_db, monkeypatch):
        """A whitespace-only title_en counts as absent: a row that carried an empty
        string must still get a translation rather than be mistaken for a value
        parse supplied."""
        calls = []
        monkeypatch.setattr("worker.stages.summarize.chat_json", self._make_fake_llm(calls))

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document_with_lang(
                conn, external_id="zh-blank", language="zh", languages=["zh"],
                title="中文标题", title_en="   ",
            )
            _insert_document_text(conn, doc_id, text="中文内容。")

        from worker.stages.summarize import run
        run(doc_id)

        assert any(c["schema"] == {"title_en"} for c in calls), \
            "a blank title_en must fall back to translation"
        with psycopg.connect(stages_test_db) as conn:
            title_en = conn.execute(
                "SELECT title_en FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()[0]
        assert title_en.startswith("English title")

    def test_rerun_regenerates_generated_summaries(
        self, stages_test_db, monkeypatch
    ):
        """Re-running summarize on a doc with source='generated' summaries REGENERATES
        them (delete + re-insert) so a re-ingest with new content refreshes the
        summaries (NEW-P1-A: stale summaries). Row count is stable; the LLM is called
        again on the second run; the text reflects the new generation."""
        calls = []
        monkeypatch.setattr("worker.stages.summarize.chat_json", self._make_fake_llm(calls))

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document_with_lang(
                conn, external_id="rerun-doc", language="en", languages=["en"], title="Rerun"
            )
            _insert_document_text(conn, doc_id, text="Some text for rerun check.")

        from worker.stages.summarize import run
        run(doc_id)
        first_call_count = len(calls)
        assert first_call_count == 1

        with psycopg.connect(stages_test_db) as conn:
            first_texts = {
                (r[0], r[1]): r[2] for r in conn.execute(
                    "SELECT language, kind, text FROM document_summaries WHERE document_id=%s",
                    (doc_id,),
                ).fetchall()
            }

        # Second run — must regenerate the generated summaries
        run(doc_id)
        second_call_count = len(calls) - first_call_count
        assert second_call_count == 1, (
            f"Second run should regenerate generated summaries (1 LLM call), got {second_call_count}"
        )

        with psycopg.connect(stages_test_db) as conn:
            count = conn.execute(
                "SELECT count(*) FROM document_summaries WHERE document_id=%s", (doc_id,)
            ).fetchone()[0]
            assert count == 2, f"Should still have exactly 2 rows after two runs, got {count}"
            second_texts = {
                (r[0], r[1]): r[2] for r in conn.execute(
                    "SELECT language, kind, text FROM document_summaries WHERE document_id=%s",
                    (doc_id,),
                ).fetchall()
            }
        # The regenerated text differs from the first generation (call counter advances)
        assert first_texts[("en", "long")] != second_texts[("en", "long")], (
            "re-run should regenerate the long summary text (not keep the stale one)"
        )

    def test_generates_native_when_slot_empty_post_relabel(
        self, stages_test_db, monkeypatch
    ):
        """After the migration relabels mislabeled summaries → en, a zh doc has
        en summaries but NO zh summaries. The summarize stage must GENERATE the
        native (zh) long+short so each language has a retrieval handle (design §7.5
        native+English; #6). 1 LLM call for zh (en already exists)."""
        calls = []
        monkeypatch.setattr("worker.stages.summarize.chat_json", self._make_fake_llm(calls))

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document_with_lang(
                conn, external_id="post-relabel-zh", language="zh", languages=["zh"],
                title="中文标题",
            )
            _insert_document_text(conn, doc_id, text="中文文档内容。")
            # Simulate post-relabel state: en summaries exist (relabel target), zh empty
            conn.execute(
                """INSERT INTO document_summaries (document_id, language, kind, text, source)
                   VALUES (%s, 'en', 'long', 'English long summary from CSV.', 'external'),
                          (%s, 'en', 'short', 'English short.', 'external')""",
                (doc_id, doc_id),
            )
            conn.commit()

        from worker.stages.summarize import run
        result = run(doc_id)
        assert result is None

        # 1 summary LLM call for zh (en is external → preserved, not regenerated).
        # (A separate title-translation call also runs for the zh title_en.)
        summary_calls = [c for c in calls if c["schema"] == {"long", "short"}]
        assert len(summary_calls) == 1, f"Expected 1 zh summary call, got {len(summary_calls)}"

        with psycopg.connect(stages_test_db) as conn:
            rows = conn.execute(
                "SELECT language, kind, source FROM document_summaries WHERE document_id=%s ORDER BY language, kind",
                (doc_id,),
            ).fetchall()
            langs_kinds = {(r[0], r[1]) for r in rows}
            assert {("zh", "long"), ("zh", "short")} <= langs_kinds, (
                f"native zh summaries must be generated; got {langs_kinds}"
            )
            zh_rows = [r for r in rows if r[0] == "zh"]
            for r in zh_rows:
                assert r[2] == "generated", f"zh summaries should be source='generated', got {r[2]}"
            en_rows = [r for r in rows if r[0] == "en"]
            for r in en_rows:
                assert r[2] == "external", f"en summaries should stay 'external', got {r[2]}"

    def test_preexisting_external_rows_preserved(
        self, stages_test_db, monkeypatch
    ):
        """Pre-existing 'external' rows preserved: 0 LLM calls, source stays 'external'."""
        calls = []
        monkeypatch.setattr("worker.stages.summarize.chat_json", self._make_fake_llm(calls))

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document_with_lang(
                conn, external_id="ext-doc", language="en", languages=["en"], title="External"
            )
            _insert_document_text(conn, doc_id, text="Document with externally supplied summaries.")
            # Insert pre-existing external summaries
            conn.execute(
                """INSERT INTO document_summaries (document_id, language, kind, text, source)
                   VALUES (%s, 'en', 'long', 'Original long summary.', 'external'),
                          (%s, 'en', 'short', 'Original short.', 'external')""",
                (doc_id, doc_id),
            )
            conn.commit()

        from worker.stages.summarize import run
        result = run(doc_id)
        assert result is None

        assert len(calls) == 0, f"Expected 0 LLM calls when external rows cover all targets, got {len(calls)}"

        with psycopg.connect(stages_test_db) as conn:
            rows = conn.execute(
                "SELECT language, kind, source, text FROM document_summaries WHERE document_id=%s ORDER BY kind",
                (doc_id,),
            ).fetchall()
            assert len(rows) == 2, f"Should still have exactly 2 rows, got {len(rows)}"
            for lang, kind, source, text in rows:
                assert source == "external", f"Source should remain 'external', got '{source}'"
            texts = {r[3] for r in rows}
            assert "Original long summary." in texts
            assert "Original short." in texts


# ---------------------------------------------------------------------------
# --- classify stage ---
# ---------------------------------------------------------------------------

def _seed_tags(conn):
    """Insert taxonomy rows for classify tests; return {(facet, value_id): tag_id}."""
    tag_map = {}
    for facet, value_id in [("topic", "forests"), ("topic", "water"), ("doc_type", "report")]:
        tag_id = conn.execute(
            """INSERT INTO tags (facet, value_id, taxonomy_version)
               VALUES (%s, %s, 'v1')
               ON CONFLICT (facet, value_id, taxonomy_version) DO UPDATE SET facet=EXCLUDED.facet
               RETURNING id""",
            (facet, value_id),
        ).fetchone()[0]
        tag_map[(facet, value_id)] = tag_id
    conn.commit()
    return tag_map


class TestClassifyStage:

    def _make_fake_llm(self, calls: list, response: dict):
        """Return a fake chat_json that records calls and returns a fixed response."""
        def fake(system, user, schema, model, max_tokens=1500):
            calls.append({"system": system, "user": user, "model": model})
            return response
        return fake

    def test_accepted_and_suggested_rows_written(self, stages_test_db, monkeypatch):
        """Mock returns confidence 0.9 (accepted) and 0.4 (suggested); both rows written
        with correct status, source='llm', confidence stored. Also verifies summary
        basis selection (en/long summary row is used)."""
        calls = []
        canned = {
            "topic": [
                {"value": "forests", "confidence": 0.9},
                {"value": "water", "confidence": 0.4},
            ],
            "doc_type": [],
        }
        monkeypatch.setattr("worker.stages.classify.chat_json", self._make_fake_llm(calls, canned))

        with psycopg.connect(stages_test_db) as conn:
            conn.execute("DELETE FROM tags")
            conn.commit()
            tag_map = _seed_tags(conn)
            doc_id = _insert_document_with_lang(
                conn, external_id="classify-doc1", language="en", languages=["en"],
                title="Forest and Water Report"
            )
            _insert_document_text(conn, doc_id, text="Full text about forests and water.")
            # Insert an en/long summary so basis selection uses it
            conn.execute(
                """INSERT INTO document_summaries (document_id, language, kind, text, source)
                   VALUES (%s, 'en', 'long', 'Summary about forests and water resources.', 'generated')""",
                (doc_id,),
            )
            conn.commit()

        from worker.stages.classify import run
        result = run(doc_id)
        assert result is None
        assert len(calls) == 1, f"Expected 1 LLM call, got {len(calls)}"

        with psycopg.connect(stages_test_db) as conn:
            rows = conn.execute(
                """SELECT tag_id, source, confidence, status
                   FROM document_tags WHERE document_id=%s ORDER BY confidence DESC""",
                (doc_id,),
            ).fetchall()
            assert len(rows) == 2, f"Expected 2 document_tags rows, got {len(rows)}"

            forests_tag = tag_map[("topic", "forests")]
            water_tag = tag_map[("topic", "water")]
            row_map = {r[0]: r for r in rows}

            assert forests_tag in row_map, "forests tag should be present"
            assert water_tag in row_map, "water tag should be present"

            forests_row = row_map[forests_tag]
            assert forests_row[1] == "llm"
            assert abs(float(forests_row[2]) - 0.9) < 0.001
            assert forests_row[3] == "accepted"

            water_row = row_map[water_tag]
            assert water_row[1] == "llm"
            assert abs(float(water_row[2]) - 0.4) < 0.001
            assert water_row[3] == "suggested"

    def test_human_external_rows_not_overwritten(self, stages_test_db, monkeypatch):
        """Pre-existing human-sourced tag row is not modified when LLM returns same
        facet/value with high confidence."""
        calls = []
        canned = {
            "topic": [{"value": "forests", "confidence": 0.95}],
            "doc_type": [],
        }
        monkeypatch.setattr("worker.stages.classify.chat_json", self._make_fake_llm(calls, canned))

        with psycopg.connect(stages_test_db) as conn:
            conn.execute("DELETE FROM tags")
            conn.commit()
            tag_map = _seed_tags(conn)
            doc_id = _insert_document_with_lang(
                conn, external_id="classify-doc2", language="en", languages=["en"],
                title="Protected Tags Doc"
            )
            _insert_document_text(conn, doc_id, text="Content about forests.")
            # Pre-insert human tag for forests
            forests_tag = tag_map[("topic", "forests")]
            conn.execute(
                """INSERT INTO document_tags (document_id, tag_id, source, confidence, model_version, status)
                   VALUES (%s, %s, 'human', 0.99, 'manual', 'accepted')""",
                (doc_id, forests_tag),
            )
            conn.commit()

        from worker.stages.classify import run
        run(doc_id)

        with psycopg.connect(stages_test_db) as conn:
            row = conn.execute(
                "SELECT source, confidence, model_version FROM document_tags WHERE document_id=%s AND tag_id=%s",
                (doc_id, forests_tag),
            ).fetchone()
            assert row is not None
            assert row[0] == "human", f"source should remain 'human', got '{row[0]}'"
            assert abs(float(row[1]) - 0.99) < 0.001, "confidence should remain 0.99"
            assert row[2] == "manual", "model_version should remain 'manual'"

    def test_empty_taxonomy_returns_none_no_llm_call(self, stages_test_db, monkeypatch):
        """No tags rows → run returns None, makes 0 LLM calls, writes nothing."""
        calls = []
        monkeypatch.setattr("worker.stages.classify.chat_json",
                            self._make_fake_llm(calls, {}))

        with psycopg.connect(stages_test_db) as conn:
            conn.execute("DELETE FROM tags")
            conn.commit()
            doc_id = _insert_document_with_lang(
                conn, external_id="classify-doc3", language="en", languages=["en"],
                title="No Taxonomy Doc"
            )
            _insert_document_text(conn, doc_id, text="Some content.")
            conn.commit()

        from worker.stages.classify import run
        result = run(doc_id)
        assert result is None
        assert len(calls) == 0, f"Expected 0 LLM calls with empty taxonomy, got {len(calls)}"

        with psycopg.connect(stages_test_db) as conn:
            count = conn.execute(
                "SELECT count(*) FROM document_tags WHERE document_id=%s", (doc_id,)
            ).fetchone()[0]
            assert count == 0, "No document_tags rows should be written with empty taxonomy"

    def test_out_of_vocab_value_ignored(self, stages_test_db, monkeypatch):
        """LLM returns a value not in the taxonomy → ignored, no row written."""
        calls = []
        canned = {
            "topic": [{"value": "unicorns", "confidence": 0.95}],
            "doc_type": [],
        }
        monkeypatch.setattr("worker.stages.classify.chat_json", self._make_fake_llm(calls, canned))

        with psycopg.connect(stages_test_db) as conn:
            conn.execute("DELETE FROM tags")
            conn.commit()
            _seed_tags(conn)
            doc_id = _insert_document_with_lang(
                conn, external_id="classify-doc4", language="en", languages=["en"],
                title="OOV Test Doc"
            )
            _insert_document_text(conn, doc_id, text="Content about mythical creatures.")
            conn.commit()

        from worker.stages.classify import run
        result = run(doc_id)
        assert result is None

        with psycopg.connect(stages_test_db) as conn:
            count = conn.execute(
                "SELECT count(*) FROM document_tags WHERE document_id=%s", (doc_id,)
            ).fetchone()[0]
            assert count == 0, "Out-of-vocab value should produce no document_tags row"


# ---------------------------------------------------------------------------
# --- embed stage ---
# ---------------------------------------------------------------------------

# Long English text — enough distinct sentences to force multiple chunks at 400 chars
_EMBED_LONG_TEXT = (
    "Climate change poses one of the greatest challenges to sustainable development worldwide. "
    "Rising global temperatures are disrupting weather patterns and increasing the frequency of extreme events. "
    "Sea level rise threatens coastal communities and critical infrastructure around the world. "
    "Deforestation and land use change are major contributors to greenhouse gas emissions globally. "
    "Renewable energy transitions offer pathways to decarbonize electricity systems at scale. "
    "Water scarcity is intensifying as glaciers recede and precipitation patterns shift dramatically. "
    "Food systems must adapt to changing growing conditions and more frequent droughts and floods. "
    "Biodiversity loss accelerates as habitats are destroyed by human activity and climate stress. "
    "Urban heat islands amplify temperature extremes in densely populated metropolitan areas. "
    "International climate agreements require ambitious national commitments to limit warming to 1.5 degrees. "
    "Carbon pricing mechanisms can drive emissions reductions across industrial and energy sectors. "
    "Nature-based solutions such as wetland restoration provide co-benefits for climate and communities. "
    "Ocean acidification from excess carbon dioxide threatens coral reefs and marine ecosystems worldwide. "
    "Adaptation finance must flow to vulnerable nations that bear disproportionate climate impacts today. "
    "Clean cooking solutions reduce household air pollution and improve health outcomes across the globe. "
    "Soil carbon sequestration through regenerative agriculture offers scalable mitigation potential now. "
    "Energy efficiency improvements in buildings and industry can cut emissions significantly at low cost. "
    "Just transitions protect workers in fossil fuel industries as economies shift to clean energy systems. "
    "Climate risk disclosure frameworks help investors and companies assess physical and transition risks. "
    "Indigenous land stewardship practices offer proven models for sustainable forest and water management. "
)

_ZH_TRADITIONAL_EMBED_TEXT = (
    "環境保護是當今世界最重要的議題之一，各國政府和國際組織正在積極尋求解決方案。"
    "氣候變遷導致全球氣溫上升，極端天氣事件的頻率和強度也隨之增加，威脅著人類社會。"
    "森林砍伐和土地利用變化是溫室氣體排放的主要來源，需要立即採取行動加以遏制。"
    "可再生能源的發展為脫碳化提供了可行的途徑，太陽能和風能技術的成本已大幅下降。"
    "水資源短缺問題日益嚴峻，冰川退縮和降水模式變化對農業和飲用水供應造成威脅。"
    "生物多樣性喪失的速度令人擔憂，棲息地破壞和氣候壓力共同加速了物種滅絕的進程。"
    "城市熱島效應在人口密集的大都市地區進一步加劇了氣溫極端值，影響居民健康。"
    "國際氣候協議要求各國提出雄心勃勃的國家承諾，以將全球暖化限制在攝氏一點五度內。"
    "碳定價機制可以推動工業和能源部門的減排，是實現淨零目標的重要政策工具之一。"
    "基於自然的解決方案，如濕地恢復和植樹造林，為氣候和社區提供了多重協同效益。"
) * 3  # repeat to ensure sufficient length

# Spanish body text for the English-handle tests. Deliberately free of any word
# that stems to 'inequ'/'unequ' so those tokens can only arrive via injection.
_ES_EMBED_TEXT = (
    "El transporte urbano segregado limita el acceso al empleo formal en las periferias. "
    "Las ciudades latinoamericanas enfrentan retos crecientes de movilidad y vivienda asequible. "
    "La expansion sin planificacion incrementa los costos de infraestructura para los municipios. "
    "Los sistemas de autobuses de transito rapido han demostrado beneficios ambientales claros. "
    "El financiamiento climatico debe llegar a los barrios mas vulnerables de la region. "
    "La calidad del aire mejora cuando se reducen los viajes en vehiculos particulares. "
    "Los espacios verdes urbanos mitigan el efecto de isla de calor en zonas densas. "
    "La gobernanza metropolitana requiere coordinacion entre municipios vecinos y el estado. "
    "El acceso al agua potable sigue siendo desigual entre distritos ricos y pobres. "
    "Las politicas de suelo pueden orientar el crecimiento hacia corredores bien servidos. "
) * 3


def _sparse_dims(sparse_text):
    """{token_id} from a sparsevec text value '{i:w,i:w}/dim'.

    sparsevec indices are 1-based and equal the keyword_vocab token_id (see
    app/sparse_keyword.py). Parsed, never substring-matched — '17' is a
    substring of '170'. Mirrors tests/test_build_sparse_script.py.
    """
    body = sparse_text.split("}")[0].lstrip("{")
    return {int(pair.split(":")[0]) for pair in body.split(",") if pair}


def _insert_embed_document(conn, *, external_id, language="en", languages=None,
                            title="Embed Test Doc", source_metadata=None):
    """Insert a documents row suitable for embed stage tests; return id."""
    from psycopg.types.json import Jsonb
    if languages is None:
        languages = [language]
    row = conn.execute(
        """INSERT INTO documents
               (external_id, s3_key, title, status, content_hash, language, languages)
           VALUES (%s, %s, %s, 'processing', 'embed_hash_123', %s, %s)
           RETURNING id""",
        (external_id, f"documents/{external_id}.pdf", title, language, languages),
    ).fetchone()
    if source_metadata is not None:
        conn.execute(
            "UPDATE documents SET source_metadata = %s WHERE id = %s",
            (Jsonb(source_metadata), row[0]),
        )
    conn.commit()
    return row[0]


class TestEmbedStage:

    @pytest.fixture(autouse=True)
    def _legacy_embedding_model(self, monkeypatch):
        """These tests cover the LEGACY dense path (text-embedding-3-small);
        the stage is model-aware since v3 B1 and defaults to cohere-embed-v4.
        The Bedrock path is covered by TestEmbedStageCohere. The bm25s sparse
        machinery is identical on both paths (v3: sparse unchanged)."""
        monkeypatch.setenv("EMBEDDING_MODEL", "text-embedding-3-small")
        from app.config import get_settings
        get_settings.cache_clear()
        yield
        get_settings.cache_clear()

    def test_basic_chunks_written_with_correct_ids_and_corpus_order(
        self, stages_test_db, monkeypatch
    ):
        """Basic en doc: chunk rows exist with legacy ids, summary chunk, corpus_order
        contiguous starting above a pre-existing max of 99."""
        embed_calls = []

        def fake_embed(texts):
            embed_calls.append(texts)
            return [[0.01] * 1536 for _ in texts]

        monkeypatch.setattr("worker.stages.embed._embed_texts", fake_embed)

        page_boundaries = [
            {"page": 1, "end_pos": len(_EMBED_LONG_TEXT) // 2},
            {"page": 2, "end_pos": len(_EMBED_LONG_TEXT)},
        ]

        from psycopg.types.json import Jsonb
        zero_vec = "[" + ",".join(["0.0"] * 1536) + "]"

        with psycopg.connect(stages_test_db) as conn:
            # Seed frozen corpus stats so the embed stage writes sparse vectors
            conn.execute(
                """INSERT INTO keyword_corpus_stats (id, n_chunks, avgdl, k1, b, sparse_dim)
                   VALUES (1, 100, 250.0, 1.5, 0.75, 1000000)
                   ON CONFLICT (id) DO NOTHING"""
            )
            # Insert a dummy document to hold the sentinel corpus_order=99
            sentinel_doc_id = conn.execute(
                """INSERT INTO documents
                       (external_id, s3_key, title, status, content_hash, language, languages)
                   VALUES ('sentinel-doc', 'documents/sentinel.pdf', 'Sentinel', 'processing',
                           'sentinel_hash', 'en', '{en}')
                   RETURNING id"""
            ).fetchone()[0]
            conn.execute(
                f"""INSERT INTO document_chunks
                       (document_id, legacy_chunk_id, chunk_index, unit_type, page, text,
                        language, node_metadata, embedding, embedding_model, dimension, corpus_order)
                   VALUES (%s, 'sentinel_chunk_0', 0, 'text', 1, 'sentinel text',
                           'en', '{{}}', '{zero_vec}'::vector(1536), 'text-embedding-3-small', 1536, 99)""",
                (sentinel_doc_id,),
            )
            doc_id = _insert_embed_document(
                conn, external_id="embed-basic-doc", language="en",
            )
            conn.execute(
                """INSERT INTO document_texts (document_id, full_text, char_count, page_boundaries)
                   VALUES (%s, %s, %s, %s)""",
                (doc_id, _EMBED_LONG_TEXT, len(_EMBED_LONG_TEXT), Jsonb(page_boundaries)),
            )
            conn.execute(
                """INSERT INTO document_summaries (document_id, language, kind, text, source)
                   VALUES (%s, 'en', 'long', 'A long summary of the document.', 'generated')""",
                (doc_id,),
            )
            conn.commit()

        from worker.stages.embed import run
        result = run(doc_id)
        assert result is None

        with psycopg.connect(stages_test_db) as conn:
            rows = conn.execute(
                """SELECT legacy_chunk_id, chunk_index, unit_type, corpus_order
                   FROM document_chunks WHERE document_id=%s ORDER BY corpus_order""",
                (doc_id,),
            ).fetchall()

        assert len(rows) >= 2, f"Expected at least 2 chunk rows, got {len(rows)}"

        legacy_ids = [r[0] for r in rows]
        # Text chunks follow the pattern external_id_chunk_N
        text_chunks = [lid for lid in legacy_ids if lid != "embed-basic-doc_summary"]
        assert all(lid.startswith("embed-basic-doc_chunk_") for lid in text_chunks), \
            f"Unexpected legacy_chunk_ids: {legacy_ids}"
        assert "embed-basic-doc_summary" in legacy_ids, "Summary chunk missing"

        # Summary row properties
        summary_row = next(r for r in rows if r[0] == "embed-basic-doc_summary")
        assert summary_row[1] == -1, "Summary chunk_index should be -1"
        assert summary_row[2] == "summary", "Summary unit_type should be 'summary'"

        # corpus_order starts above 99 (the sentinel)
        min_order = min(r[3] for r in rows)
        assert min_order >= 100, f"corpus_order should start at 100+, got min={min_order}"

        # corpus_order values are contiguous
        orders = sorted(r[3] for r in rows)
        assert orders == list(range(orders[0], orders[0] + len(orders))), \
            f"corpus_order values not contiguous: {orders}"

        assert len(embed_calls) == 1, "Expected exactly one _embed_texts call"

        # sparse keyword lane: every chunk row gets an impact vector computed
        # under frozen corpus stats; new tokens are upserted into keyword_vocab
        with psycopg.connect(stages_test_db) as conn:
            sparse_rows = conn.execute(
                "SELECT legacy_chunk_id, sparse FROM document_chunks WHERE document_id = %s",
                (doc_id,),
            ).fetchall()
            assert all(s is not None for _, s in sparse_rows)
            vocab_n = conn.execute("SELECT count(*) FROM keyword_vocab").fetchone()[0]
        assert vocab_n > 0

    def test_node_metadata_parity_with_migration(
        self, stages_test_db, monkeypatch
    ):
        """Worker node_metadata must match what the Phase-0 migration's
        indexing.build_nodes would produce (R3): title from Publication Title
        (not Article Title), full authors (not truncated to 100), file_path from
        the CSV file_path (not the s3_key)."""
        def fake_embed(texts):
            return [[0.01] * 1536 for _ in texts]
        monkeypatch.setattr("worker.stages.embed._embed_texts", fake_embed)

        from psycopg.types.json import Jsonb
        zero_vec = "[" + ",".join(["0.0"] * 1536) + "]"
        page_boundaries = [{"page": 1, "end_pos": len(_EMBED_LONG_TEXT)}]
        full_authors = "Author One; Author Two; Author Three With A Very Long Name That Exceeds One Hundred Characters Easily When You Include All The Semicolons And Commas"
        src_meta = {
            "file_path": "2021_real-report_1054.pdf",  # CSV bare file_path (no documents/ prefix)
            "metadata": {
                "Article Title": "Article Title Value",
                "Publication Title": "Publication Title Value",
                "All authors": full_authors,
                "YEAR published": "2021",
                "URL": "https://example.org/report",
                "Sub-tag": "Transport decarbonization",
            },
        }

        with psycopg.connect(stages_test_db) as conn:
            conn.execute(
                """INSERT INTO keyword_corpus_stats (id, n_chunks, avgdl, k1, b, sparse_dim)
                   VALUES (1, 100, 250.0, 1.5, 0.75, 1000000)
                   ON CONFLICT (id) DO NOTHING"""
            )
            # documents.title is set to the Article Title (as the migration does),
            # but node_metadata.title must come from Publication Title.
            doc_id = _insert_embed_document(
                conn, external_id="parity-doc", language="en",
                title="Article Title Value", source_metadata=src_meta,
            )
            conn.execute(
                """INSERT INTO document_texts (document_id, full_text, char_count, page_boundaries)
                   VALUES (%s, %s, %s, %s)""",
                (doc_id, _EMBED_LONG_TEXT, len(_EMBED_LONG_TEXT), Jsonb(page_boundaries)),
            )
            conn.execute(
                """INSERT INTO document_summaries (document_id, language, kind, text, source)
                   VALUES (%s, 'en', 'long', 'Summary for parity test.', 'generated')""",
                (doc_id,),
            )
            conn.commit()

        from worker.stages.embed import run
        result = run(doc_id)
        assert result is None

        with psycopg.connect(stages_test_db) as conn:
            rows = conn.execute(
                "SELECT legacy_chunk_id, node_metadata FROM document_chunks WHERE document_id=%s ORDER BY corpus_order",
                (doc_id,),
            ).fetchall()
        assert len(rows) > 0
        for legacy_id, meta in rows:
            meta = meta if isinstance(meta, dict) else __import__("json").loads(meta)
            # title must be Publication Title (migration source), not Article Title
            assert meta["title"] == "Publication Title Value", (
                f"{legacy_id}: title should be Publication Title, got {meta.get('title')!r}"
            )
            # authors must be FULL (migration restores full in per-chunk update), not truncated to 100
            assert meta["authors"] == full_authors, (
                f"{legacy_id}: authors should be full ({len(full_authors)} chars), got {len(meta.get('authors', ''))} chars"
            )
            # file_path must be the CSV file_path (bare), not the s3_key (documents/ prefix)
            assert meta["file_path"] == "2021_real-report_1054.pdf", (
                f"{legacy_id}: file_path should be the CSV bare name, got {meta.get('file_path')!r}"
            )

    def test_zh_page_attribution_not_drifted_by_opencc(
        self, stages_test_db, monkeypatch
    ):
        """R4: when OpenCC t2s changes text length, the embed stage must recompute
        page boundaries on the Simplified text so chunk page numbers stay correct.
        We simulate a length-changing conversion (Traditional 2 chars → Simplified 1)
        to prove the recompute logic, since real t2s is mostly length-preserving."""
        def fake_embed(texts):
            return [[0.01] * 1536 for _ in texts]
        monkeypatch.setattr("worker.stages.embed._embed_texts", fake_embed)

        from psycopg.types.json import Jsonb

        # Traditional text where every '電腦' (2 chars) collapses to '电' (1 char)
        # under our simulated converter. Original is long enough to produce multiple
        # chunks at 400/80 so page 3 content lands in its own chunk.
        page1 = '電腦電腦電腦電腦電腦' * 50   # 500 chars Traditional → 250 after convert
        page2 = 'B' * 500                  # 500 chars, unchanged
        page3 = 'C' * 500                  # 500 chars, unchanged
        full_text = page1 + '\n\n' + page2 + '\n\n' + page3
        boundaries = [
            {"page": 1, "end_pos": len(page1)},
            {"page": 2, "end_pos": len(page1) + 2 + len(page2)},
            {"page": 3, "end_pos": len(full_text)},
        ]

        with psycopg.connect(stages_test_db) as conn:
            conn.execute(
                """INSERT INTO keyword_corpus_stats (id, n_chunks, avgdl, k1, b, sparse_dim)
                   VALUES (1, 100, 250.0, 1.5, 0.75, 1000000)
                   ON CONFLICT (id) DO NOTHING"""
            )
            doc_id = _insert_embed_document(
                conn, external_id="zh-drift-doc", language="zh", languages=["zh"],
                title="頁面測試",
            )
            conn.execute(
                """INSERT INTO document_texts (document_id, full_text, char_count, page_boundaries)
                   VALUES (%s, %s, %s, %s)""",
                (doc_id, full_text, len(full_text), Jsonb(boundaries)),
            )
            conn.execute(
                """INSERT INTO document_summaries (document_id, language, kind, text, source)
                   VALUES (%s, 'zh', 'long', '摘要', 'generated')""",
                (doc_id,),
            )
            conn.commit()

        # Monkeypatch OpenCC to simulate a length-changing t2s: 電腦→电 (2→1)
        import worker.stages.embed as embed_mod
        real_opencc = embed_mod.OpenCC if hasattr(embed_mod, 'OpenCC') else None
        class FakeCC:
            def __init__(self, *a, **k): pass
            def convert(self, text):
                return text.replace('電腦', '电')
        # Patch the OpenCC import inside the run() function's zh branch
        import opencc as real_opencc_mod
        monkeypatch.setattr(real_opencc_mod, 'OpenCC', FakeCC)

        from worker.stages.embed import run
        result = run(doc_id)
        assert result is None

        with psycopg.connect(stages_test_db) as conn:
            rows = conn.execute(
                "SELECT text, page FROM document_chunks WHERE document_id=%s AND unit_type='text' ORDER BY corpus_order",
                (doc_id,),
            ).fetchall()
        assert len(rows) > 0, "expected text chunks"
        for chunk_text, page in rows:
            assert page in (1, 2, 3), f"chunk page {page} out of range (1-3) — drift"
            # A chunk that is purely page-3 content (CCCCC) must map to page 3,
            # proving the boundary recompute kept page 3 reachable.
            if chunk_text.strip('C') == '' and chunk_text.strip():
                assert page == 3, f"page3-only chunk mapped to page {page} — OpenCC drift"
        # The recompute must have produced a chunk that lands on page 3
        assert any(p == 3 for _, p in rows), "no chunk landed on page 3 — recompute failed"

    def test_rerun_replaces_chunks_corpus_order_increases(
        self, stages_test_db, monkeypatch
    ):
        """Run embed twice → same chunk count, corpus_order max increases on second run.

        A pinned document (anchor_doc) holds corpus_order=500 and is never deleted,
        so the global max is always anchored above the first run's values.
        """
        def fake_embed(texts):
            return [[0.01] * 1536 for _ in texts]

        monkeypatch.setattr("worker.stages.embed._embed_texts", fake_embed)

        from psycopg.types.json import Jsonb
        zero_vec = "[" + ",".join(["0.0"] * 1536) + "]"
        page_boundaries = [{"page": 1, "end_pos": len(_EMBED_LONG_TEXT)}]

        with psycopg.connect(stages_test_db) as conn:
            # Anchor doc: holds a chunk at corpus_order=500 so second run appends above it
            anchor_doc_id = conn.execute(
                """INSERT INTO documents
                       (external_id, s3_key, title, status, content_hash, language, languages)
                   VALUES ('anchor-doc', 'documents/anchor.pdf', 'Anchor', 'processing',
                           'anchor_hash_456', 'en', '{en}')
                   RETURNING id"""
            ).fetchone()[0]
            conn.execute(
                f"""INSERT INTO document_chunks
                       (document_id, legacy_chunk_id, chunk_index, unit_type, page, text,
                        language, node_metadata, embedding, embedding_model, dimension, corpus_order)
                   VALUES (%s, 'anchor_chunk_0', 0, 'text', 1, 'anchor text',
                           'en', '{{}}', '{zero_vec}'::vector(1536), 'text-embedding-3-small', 1536, 500)""",
                (anchor_doc_id,),
            )
            doc_id = _insert_embed_document(conn, external_id="embed-rerun-doc", language="en")
            conn.execute(
                """INSERT INTO document_texts (document_id, full_text, char_count, page_boundaries)
                   VALUES (%s, %s, %s, %s)""",
                (doc_id, _EMBED_LONG_TEXT, len(_EMBED_LONG_TEXT), Jsonb(page_boundaries)),
            )
            conn.execute(
                """INSERT INTO document_summaries (document_id, language, kind, text, source)
                   VALUES (%s, 'en', 'long', 'Summary for rerun test.', 'generated')""",
                (doc_id,),
            )
            conn.commit()

        from worker.stages.embed import run

        run(doc_id)

        with psycopg.connect(stages_test_db) as conn:
            count_after_first = conn.execute(
                "SELECT count(*) FROM document_chunks WHERE document_id=%s", (doc_id,)
            ).fetchone()[0]
            max_order_after_first = conn.execute(
                "SELECT MAX(corpus_order) FROM document_chunks WHERE document_id=%s", (doc_id,)
            ).fetchone()[0]
            # Simulate another document accumulating chunks after first run, pushing global max up
            conn.execute(
                f"""INSERT INTO document_chunks
                       (document_id, legacy_chunk_id, chunk_index, unit_type, page, text,
                        language, node_metadata, embedding, embedding_model, dimension, corpus_order)
                   VALUES (%s, 'anchor_chunk_1', 1, 'text', 1, 'extra anchor text',
                           'en', '{{}}', '{zero_vec}'::vector(1536), 'text-embedding-3-small', 1536, 999)""",
                (anchor_doc_id,),
            )
            conn.commit()

        run(doc_id)

        with psycopg.connect(stages_test_db) as conn:
            count_after_second = conn.execute(
                "SELECT count(*) FROM document_chunks WHERE document_id=%s", (doc_id,)
            ).fetchone()[0]
            max_order_after_second = conn.execute(
                "SELECT MAX(corpus_order) FROM document_chunks WHERE document_id=%s", (doc_id,)
            ).fetchone()[0]
            # No orphan rows with old corpus_order values for this doc
            total_chunks = conn.execute(
                "SELECT count(*) FROM document_chunks WHERE document_id=%s", (doc_id,)
            ).fetchone()[0]
            stale_rows = conn.execute(
                "SELECT count(*) FROM document_chunks WHERE document_id=%s AND corpus_order <= %s",
                (doc_id, max_order_after_first),
            ).fetchone()[0]

        assert stale_rows == 0, \
            f"All first-run rows should be deleted on rerun ({stale_rows} stale rows remain)"
        assert count_after_second == count_after_first, \
            f"Chunk count should be stable: first={count_after_first} second={count_after_second}"
        assert max_order_after_second > max_order_after_first, \
            f"corpus_order max should increase on rerun: first={max_order_after_first} second={max_order_after_second}"
        assert total_chunks == count_after_first, "No orphan chunks should remain"

    def test_rerun_does_not_burn_vocab_identity(self, stages_test_db, monkeypatch):
        """Two consecutive embed runs of the same doc must not increase
        max(token_id), and must not advance the identity sequence at all:
        only genuinely-missing tokens are proposed for INSERT (anti-join), so
        a rerun proposes zero rows. The sentinel insert proves the sequence
        did not silently burn values on the second run."""
        def fake_embed(texts):
            return [[0.01] * 1536 for _ in texts]

        monkeypatch.setattr("worker.stages.embed._embed_texts", fake_embed)

        from psycopg.types.json import Jsonb
        page_boundaries = [{"page": 1, "end_pos": len(_EMBED_LONG_TEXT)}]

        with psycopg.connect(stages_test_db) as conn:
            conn.execute(
                """INSERT INTO keyword_corpus_stats (id, n_chunks, avgdl, k1, b, sparse_dim)
                   VALUES (1, 100, 250.0, 1.5, 0.75, 1000000)
                   ON CONFLICT (id) DO NOTHING"""
            )
            doc_id = _insert_embed_document(
                conn, external_id="embed-identity-doc", language="en",
            )
            conn.execute(
                """INSERT INTO document_texts (document_id, full_text, char_count, page_boundaries)
                   VALUES (%s, %s, %s, %s)""",
                (doc_id, _EMBED_LONG_TEXT, len(_EMBED_LONG_TEXT), Jsonb(page_boundaries)),
            )
            conn.execute(
                """INSERT INTO document_summaries (document_id, language, kind, text, source)
                   VALUES (%s, 'en', 'long', 'Summary for identity test.', 'generated')""",
                (doc_id,),
            )
            conn.commit()

        from worker.stages.embed import run

        run(doc_id)
        with psycopg.connect(stages_test_db) as conn:
            vocab_first = dict(
                conn.execute("SELECT token, token_id FROM keyword_vocab").fetchall()
            )
        max_first = max(vocab_first.values())

        run(doc_id)
        with psycopg.connect(stages_test_db) as conn:
            vocab_second = dict(
                conn.execute("SELECT token, token_id FROM keyword_vocab").fetchall()
            )
            # Sentinel: next identity value reveals whether the rerun burned ids
            sentinel_id = conn.execute(
                """INSERT INTO keyword_vocab (token, df, idf)
                   VALUES ('zzz_identity_sentinel', 1, 1.0) RETURNING token_id"""
            ).fetchone()[0]
            conn.commit()

        assert vocab_second == vocab_first, "rerun must not change token_ids"
        assert max(vocab_second.values()) == max_first, \
            "rerun must not increase max(token_id)"
        assert sentinel_id == max_first + 1, (
            f"identity sequence advanced from {max_first} to {sentinel_id - 1} "
            "without inserting rows — the rerun burned identity values"
        )

    def test_zh_normalization_simplified_in_chunks_traditional_in_document_texts(
        self, stages_test_db, monkeypatch
    ):
        """zh doc: chunk text contains Simplified forms; document_texts.full_text unchanged."""
        def fake_embed(texts):
            return [[0.01] * 1536 for _ in texts]

        monkeypatch.setattr("worker.stages.embed._embed_texts", fake_embed)

        from psycopg.types.json import Jsonb
        page_boundaries = [{"page": 1, "end_pos": len(_ZH_TRADITIONAL_EMBED_TEXT)}]

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_embed_document(
                conn, external_id="embed-zh-doc", language="zh", languages=["zh"],
                title="環境報告",
            )
            conn.execute(
                """INSERT INTO document_texts (document_id, full_text, char_count, page_boundaries)
                   VALUES (%s, %s, %s, %s)""",
                (doc_id, _ZH_TRADITIONAL_EMBED_TEXT, len(_ZH_TRADITIONAL_EMBED_TEXT), Jsonb(page_boundaries)),
            )
            conn.execute(
                """INSERT INTO document_summaries (document_id, language, kind, text, source)
                   VALUES (%s, 'zh', 'long', '環境保護摘要', 'generated')""",
                (doc_id,),
            )
            conn.commit()

        from worker.stages.embed import run
        result = run(doc_id)
        assert result is None

        with psycopg.connect(stages_test_db) as conn:
            text_chunk_texts = conn.execute(
                "SELECT text FROM document_chunks WHERE document_id=%s AND unit_type='text'", (doc_id,)
            ).fetchall()
            summary_chunk_text = conn.execute(
                "SELECT text FROM document_chunks WHERE document_id=%s AND unit_type='summary'", (doc_id,)
            ).fetchone()[0]
            stored_full_text = conn.execute(
                "SELECT full_text FROM document_texts WHERE document_id=%s", (doc_id,)
            ).fetchone()[0]

        # Summary node text is also normalized (the summary string, not the raw title)
        assert "环境保护摘要" in summary_chunk_text, \
            "Summary chunk text should be OpenCC-normalized to Simplified"
        assert "環境保護摘要" not in summary_chunk_text, \
            "Traditional summary text should NOT appear in the summary chunk"

        assert len(text_chunk_texts) > 0, "No text chunks written for zh document"

        all_text_chunk = " ".join(r[0] for r in text_chunk_texts)

        # Simplified forms must appear in indexed text chunks (from OpenCC t2s conversion)
        assert "环境保护" in all_text_chunk, \
            "Simplified '环境保护' should appear in text chunk text (OpenCC t2s)"
        assert "气候变迁" in all_text_chunk, \
            "Simplified '气候变迁' should appear in text chunk text (OpenCC t2s)"

        # Traditional forms must NOT appear in text chunk content
        assert "環境保護" not in all_text_chunk, \
            "Traditional '環境保護' should NOT appear in text chunk text"
        assert "氣候變遷" not in all_text_chunk, \
            "Traditional '氣候變遷' should NOT appear in text chunk text"

        # Original document_texts.full_text must be unchanged (still Traditional)
        assert "環境保護" in stored_full_text, \
            "Traditional form should be preserved in document_texts.full_text"
        assert "氣候變遷" in stored_full_text, \
            "Traditional form should be preserved in document_texts.full_text"

    def test_withdrawn_doc_chunks_not_rewritten(
        self, stages_test_db, monkeypatch
    ):
        """A withdrawn document's chunks must NOT be deleted/rewritten by the
        embed stage (NEW-P2-5: embed has no withdrawn guard today). The stage
        returns None and the pre-existing chunk text survives untouched."""
        def fake_embed(texts):
            return [[0.01] * 1536 for _ in texts]

        monkeypatch.setattr("worker.stages.embed._embed_texts", fake_embed)

        from psycopg.types.json import Jsonb
        zero_vec = "[" + ",".join(["0.0"] * 1536) + "]"
        page_boundaries = [{"page": 1, "end_pos": len(_EMBED_LONG_TEXT)}]

        with psycopg.connect(stages_test_db) as conn:
            conn.execute(
                """INSERT INTO keyword_corpus_stats (id, n_chunks, avgdl, k1, b, sparse_dim)
                   VALUES (1, 100, 250.0, 1.5, 0.75, 1000000)
                   ON CONFLICT (id) DO NOTHING"""
            )
            doc_id = _insert_embed_document(
                conn, external_id="embed-withdrawn-doc", language="en",
            )
            conn.execute("UPDATE documents SET status='withdrawn' WHERE id=%s", (doc_id,))
            conn.execute(
                """INSERT INTO document_texts (document_id, full_text, char_count, page_boundaries)
                   VALUES (%s, %s, %s, %s)""",
                (doc_id, _EMBED_LONG_TEXT, len(_EMBED_LONG_TEXT), Jsonb(page_boundaries)),
            )
            conn.execute(
                """INSERT INTO document_summaries (document_id, language, kind, text, source)
                   VALUES (%s, 'en', 'long', 'Summary for withdrawn test.', 'generated')""",
                (doc_id,),
            )
            # Pre-existing chunk that must survive
            conn.execute(
                f"""INSERT INTO document_chunks
                       (document_id, legacy_chunk_id, chunk_index, unit_type, page, text,
                        language, node_metadata, embedding, embedding_model, dimension, corpus_order)
                   VALUES (%s, 'embed-withdrawn-doc_chunk_0', 0, 'text', 1, 'PRE-EXISTING CHUNK TEXT',
                           'en', '{{}}', '{zero_vec}'::vector(1536), 'text-embedding-3-small', 1536, 1)""",
                (doc_id,),
            )
            conn.commit()

        from worker.stages.embed import run
        result = run(doc_id)
        assert result is None

        with psycopg.connect(stages_test_db) as conn:
            rows = conn.execute(
                "SELECT text FROM document_chunks WHERE document_id=%s", (doc_id,)
            ).fetchall()
        assert len(rows) == 1, (
            f"withdrawn doc's chunks should not be deleted+rewritten; got {len(rows)} rows"
        )
        assert rows[0][0] == "PRE-EXISTING CHUNK TEXT", (
            f"pre-existing chunk must survive untouched; got {rows[0][0]!r}"
        )

    def test_embed_injects_en_handles_sparse_only(self, stages_test_db, monkeypatch):
        """Flag on: sparse vectors carry title_en tokens; the DENSE content strings
        and stored chunk text do NOT (spec 2026-07-26 §3.2 divergence callout).

        Also pins the flag-off inverse: no injected weights at all, and dense
        content is byte-identical across the two runs (dense is invariant to
        the flag, so turning it on can never force a re-embed).
        """
        dense_runs = []

        def fake_embed(texts):
            dense_runs.append(list(texts))
            return [[0.01] * 1536 for _ in texts]

        monkeypatch.setattr("worker.stages.embed._embed_texts", fake_embed)

        from psycopg.types.json import Jsonb
        page_boundaries = [{"page": 1, "end_pos": len(_ES_EMBED_TEXT)}]

        with psycopg.connect(stages_test_db) as conn:
            conn.execute(
                """INSERT INTO keyword_corpus_stats (id, n_chunks, avgdl, k1, b, sparse_dim)
                   VALUES (1, 100, 250.0, 1.5, 0.75, 1000000)
                   ON CONFLICT (id) DO NOTHING"""
            )
            doc_id = _insert_embed_document(
                conn, external_id="embed-es-handle-doc", language="es",
                languages=["es"], title="Índice de Desigualdad",
            )
            conn.execute(
                "UPDATE documents SET title_en = %s WHERE id = %s",
                ("Urban Inequality Index", doc_id),
            )
            conn.execute(
                """INSERT INTO document_texts (document_id, full_text, char_count, page_boundaries)
                   VALUES (%s, %s, %s, %s)""",
                (doc_id, _ES_EMBED_TEXT, len(_ES_EMBED_TEXT), Jsonb(page_boundaries)),
            )
            # Native summary drives the summary chunk; the curated en/long row is
            # the handle source injected into that chunk only.
            conn.execute(
                """INSERT INTO document_summaries (document_id, language, kind, text, source)
                   VALUES (%s, 'es', 'long', 'Resumen del indice de desigualdad urbana.', 'generated'),
                          (%s, 'en', 'long', 'Measures unequal access to services.', 'external')""",
                (doc_id, doc_id),
            )
            conn.commit()

        from app.config import get_settings
        from worker.stages.embed import run

        # --- Baseline: flag OFF (default) ---
        get_settings.cache_clear()
        assert run(doc_id) is None
        with psycopg.connect(stages_test_db) as conn:
            off_vectors = dict(
                conn.execute(
                    "SELECT legacy_chunk_id, sparse::text FROM document_chunks "
                    "WHERE document_id=%s",
                    (doc_id,),
                ).fetchall()
            )
            off_vocab = dict(
                conn.execute(
                    "SELECT token, token_id FROM keyword_vocab "
                    "WHERE token IN ('inequ', 'unequ')"
                ).fetchall()
            )
        for token_id in off_vocab.values():
            for chunk_id, sparse_text in off_vectors.items():
                assert token_id not in _sparse_dims(sparse_text), (
                    f"flag off must inject nothing, but {chunk_id} carries a handle token"
                )

        # --- Flag ON ---
        monkeypatch.setenv("SPARSE_EN_HANDLES", "true")
        get_settings.cache_clear()
        assert run(doc_id) is None

        assert len(dense_runs) == 2, f"expected one dense call per run, got {len(dense_runs)}"
        # Dense NEVER sees the handle...
        assert all("Urban Inequality Index" not in t for t in dense_runs[1]), (
            "handle text leaked into the dense embedding content string"
        )
        assert all("unequal access" not in t for t in dense_runs[1])
        # ...and is byte-identical to the flag-off run (no re-embed forced).
        assert dense_runs[1] == dense_runs[0], (
            "dense content must be invariant to SPARSE_EN_HANDLES"
        )

        with psycopg.connect(stages_test_db) as conn:
            # Stored chunk text unchanged.
            assert conn.execute(
                "SELECT count(*) FROM document_chunks WHERE document_id=%s AND text ILIKE %s",
                (doc_id, "%urban inequality%"),
            ).fetchone()[0] == 0, "handle text leaked into document_chunks.text"
            # node_metadata unchanged.
            assert conn.execute(
                "SELECT count(*) FROM document_chunks WHERE document_id=%s "
                "AND node_metadata::text ILIKE %s",
                (doc_id, "%urban inequality%"),
            ).fetchone()[0] == 0, "handle text leaked into node_metadata"
            on_rows = conn.execute(
                "SELECT legacy_chunk_id, chunk_index, sparse::text FROM document_chunks "
                "WHERE document_id=%s",
                (doc_id,),
            ).fetchall()
            vocab = dict(
                conn.execute(
                    "SELECT token, token_id FROM keyword_vocab "
                    "WHERE token IN ('inequ', 'unequ')"
                ).fetchall()
            )

        assert "inequ" in vocab, "title_en tokens must reach the vocab"
        assert "unequ" in vocab, "the English long summary must reach the vocab"
        assert len(on_rows) >= 2

        summary_rows = [r for r in on_rows if r[1] == -1]
        text_rows = [r for r in on_rows if r[1] != -1]
        assert len(summary_rows) == 1 and text_rows

        for chunk_id, _, sparse_text in on_rows:
            assert vocab["inequ"] in _sparse_dims(sparse_text), (
                f"title_en must be weighted into every chunk; missing from {chunk_id}"
            )
        assert vocab["unequ"] in _sparse_dims(summary_rows[0][2]), (
            "the English long summary must be weighted into the summary chunk"
        )
        for chunk_id, _, sparse_text in text_rows:
            assert vocab["unequ"] not in _sparse_dims(sparse_text), (
                f"the English long summary belongs to the summary chunk only; {chunk_id} has it"
            )


class TestEmbedStageCohere:
    """v3 B1: with EMBEDDING_MODEL=cohere-embed-v4 (the default) the embed
    stage encodes dense via Bedrock and writes embedding_model=
    'cohere-embed-v4'/dimension=1536. The English bm25s sparse machinery
    (keyword_vocab upserts + impact vectors) runs UNCHANGED — v3 keeps the
    sparse lane as-is."""

    @pytest.fixture(autouse=True)
    def _cohere_embedding_model(self, monkeypatch):
        monkeypatch.setenv("EMBEDDING_MODEL", "cohere-embed-v4")
        from app.config import get_settings
        get_settings.cache_clear()
        yield
        get_settings.cache_clear()

    def test_cohere_rows_written_with_bm25_sparse_intact(
        self, stages_test_db, monkeypatch
    ):
        bedrock_calls = []

        def fake_bedrock_embed(texts):
            bedrock_calls.append(list(texts))
            return [[0.02] * 1536 for _ in texts]

        monkeypatch.setattr(
            "worker.stages.embed._embed_texts_bedrock", fake_bedrock_embed
        )

        from psycopg.types.json import Jsonb
        page_boundaries = [{"page": 1, "end_pos": len(_EMBED_LONG_TEXT)}]

        with psycopg.connect(stages_test_db) as conn:
            conn.execute(
                """INSERT INTO keyword_corpus_stats (id, n_chunks, avgdl, k1, b, sparse_dim)
                   VALUES (1, 100, 250.0, 1.5, 0.75, 1000000)
                   ON CONFLICT (id) DO NOTHING"""
            )
            doc_id = _insert_embed_document(
                conn, external_id="embed-cohere-doc", language="en",
            )
            conn.execute(
                """INSERT INTO document_texts (document_id, full_text, char_count, page_boundaries)
                   VALUES (%s, %s, %s, %s)""",
                (doc_id, _EMBED_LONG_TEXT, len(_EMBED_LONG_TEXT), Jsonb(page_boundaries)),
            )
            conn.execute(
                """INSERT INTO document_summaries (document_id, language, kind, text, source)
                   VALUES (%s, 'en', 'long', 'A long summary of the document.', 'generated')""",
                (doc_id,),
            )
            conn.commit()

        from worker.stages.embed import run
        assert run(doc_id) is None

        with psycopg.connect(stages_test_db) as conn:
            rows = conn.execute(
                """SELECT legacy_chunk_id, embedding_model, dimension,
                          sparse::text, vector_dims(embedding::vector(1536))
                   FROM document_chunks WHERE document_id=%s""",
                (doc_id,),
            ).fetchall()
            vocab_n = conn.execute("SELECT count(*) FROM keyword_vocab").fetchone()[0]

        assert len(rows) >= 2
        assert all(r[1] == "cohere-embed-v4" for r in rows), f"models: {[r[1] for r in rows]}"
        assert all(r[2] == 1536 for r in rows)
        assert all(r[4] == 1536 for r in rows)
        # sparse lane UNCHANGED: bm25 impact vectors (/1000000) + vocab upserts
        assert all(r[3] is not None and r[3].endswith("/1000000") for r in rows)
        assert vocab_n > 0, "bm25 keyword_vocab machinery must still run (v3: sparse unchanged)"
        assert len(bedrock_calls) == 1, "Expected exactly one Bedrock embed call"


# ---------------------------------------------------------------------------
# --- publish stage ---
# ---------------------------------------------------------------------------

def _insert_publish_document(conn, *, external_id, language="en"):
    """Insert a documents row suitable for publish stage tests; return id."""
    row = conn.execute(
        """INSERT INTO documents
               (external_id, s3_key, title, status, content_hash, language, languages)
           VALUES (%s, %s, %s, 'processing', 'pub_hash_abc', %s, %s)
           RETURNING id""",
        (external_id, f"documents/{external_id}.pdf", f"Pub Test {external_id}",
         language, [language]),
    ).fetchone()
    conn.commit()
    return row[0]


def _insert_document_texts_for_publish(conn, document_id, *, char_count, pages):
    """Insert document_texts with page_boundaries of length `pages`."""
    from psycopg.types.json import Jsonb
    boundaries = [{"page": i + 1, "end_pos": char_count} for i in range(pages)]
    conn.execute(
        """INSERT INTO document_texts (document_id, full_text, char_count, page_boundaries)
           VALUES (%s, %s, %s, %s)""",
        (document_id, "x" * char_count, char_count, Jsonb(boundaries)),
    )
    conn.commit()


def _insert_chunk_for_publish(conn, document_id, *, external_id):
    """Insert one document_chunks row using the zero-vector SQL pattern."""
    zero_vec = "[" + ",".join(["0.0"] * 1536) + "]"
    conn.execute(
        f"""INSERT INTO document_chunks
               (document_id, legacy_chunk_id, chunk_index, unit_type, page, text,
                language, node_metadata, embedding, embedding_model, dimension, corpus_order)
           VALUES (%s, %s, 0, 'text', 1, 'chunk text',
                   'en', '{{}}', '{zero_vec}'::vector(1536), 'text-embedding-3-small', 1536, 1)""",
        (document_id, f"{external_id}_chunk_0"),
    )
    conn.commit()


def _insert_running_job_for_publish(conn, document_id, *, prior_status=None):
    """Insert the open running job publish reads prior_status from."""
    conn.execute(
        """INSERT INTO ingestion_jobs (document_id, stage, status, prior_status)
           VALUES (%s, 'embed', 'running', %s)""",
        (document_id, prior_status),
    )
    conn.commit()


class TestPublishStage:

    def test_high_density_doc_parks_at_needs_review(self, stages_test_db, monkeypatch):
        """Even a high-quality doc is parked at needs_review (never auto-published,
        issue #310); confidence is recorded and the job ends 'done' (returns None).

        Arithmetic:
          char_count=1000, pages=2 → chars/page=500
          density = min(500/200, 1.0) = 1.0
          language 'en' ∈ SUPPORTED → 0.3
          chunks present → 0.3
          score = 0.4*1.0 + 0.3 + 0.3 = 1.0 >= 0.7 → job done, doc awaits review
        """
        monkeypatch.delenv("SEARCH_SERVICE_URL", raising=False)

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_publish_document(conn, external_id="pub-high", language="en")
            _insert_document_texts_for_publish(conn, doc_id, char_count=1000, pages=2)
            _insert_chunk_for_publish(conn, doc_id, external_id="pub-high")

        from worker.stages.publish import run
        result = run(doc_id)
        assert result is None

        with psycopg.connect(stages_test_db) as conn:
            row = conn.execute(
                "SELECT status, extraction_confidence FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()
        assert row[0] == "needs_review", f"Expected 'needs_review', got '{row[0]}'"
        assert float(row[1]) >= 0.7, f"Expected confidence >= 0.7, got {row[1]}"

    def test_sparse_doc_becomes_needs_review(self, stages_test_db, monkeypatch):
        """Low-quality doc (low density, no chunks) → status='needs_review', returns 'needs_review'.

        Arithmetic:
          char_count=50, pages=1 → chars/page=50
          density = min(50/200, 1.0) = 0.25
          language 'en' ∈ SUPPORTED → 0.3
          NO chunks → 0.0
          score = 0.4*0.25 + 0.3 + 0.0 = 0.1 + 0.3 = 0.4 < 0.7 → needs_review
        """
        monkeypatch.delenv("SEARCH_SERVICE_URL", raising=False)

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_publish_document(conn, external_id="pub-sparse", language="en")
            _insert_document_texts_for_publish(conn, doc_id, char_count=50, pages=1)
            # No chunks inserted — 0.0 weight from chunk component

        from worker.stages.publish import run
        result = run(doc_id)
        assert result == "needs_review"

        with psycopg.connect(stages_test_db) as conn:
            row = conn.execute(
                "SELECT status, extraction_confidence FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()
        assert row[0] == "needs_review", f"Expected 'needs_review', got '{row[0]}'"
        assert row[1] is not None, "extraction_confidence should be recorded"
        assert float(row[1]) < 0.7, f"Expected confidence < 0.7, got {row[1]}"

    def test_withdrawn_doc_not_resurrected(self, stages_test_db, monkeypatch):
        """A withdrawn document is never flipped to needs_review by publish:
        the status UPDATE matches 0 rows, the stage skips and returns None."""
        monkeypatch.delenv("SEARCH_SERVICE_URL", raising=False)

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_publish_document(conn, external_id="pub-withdrawn", language="en")
            _insert_document_texts_for_publish(conn, doc_id, char_count=1000, pages=2)
            _insert_chunk_for_publish(conn, doc_id, external_id="pub-withdrawn")
            conn.execute("UPDATE documents SET status='withdrawn' WHERE id=%s", (doc_id,))
            conn.commit()

        from worker.stages.publish import run
        result = run(doc_id)
        assert result is None

        with psycopg.connect(stages_test_db) as conn:
            status = conn.execute(
                "SELECT status FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()[0]
        assert status == "withdrawn", f"Withdrawn doc must stay withdrawn, got '{status}'"

    def test_fresh_ingest_parks_and_never_calls_reindex(self, stages_test_db, monkeypatch):
        """A fresh ingest (no prior_status) parks at needs_review and must not
        touch SEARCH_SERVICE_URL — pointing it at a closed port proves no
        /reindex call is attempted on the park path (the admin promote route
        owns reindexing for first-time publication)."""
        monkeypatch.setenv("SEARCH_SERVICE_URL", "http://127.0.0.1:1")

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_publish_document(conn, external_id="pub-reindex", language="en")
            _insert_document_texts_for_publish(conn, doc_id, char_count=1000, pages=2)
            _insert_chunk_for_publish(conn, doc_id, external_id="pub-reindex")
            _insert_running_job_for_publish(conn, doc_id, prior_status="draft")

        from worker.stages.publish import run
        result = run(doc_id)
        assert result is None

        with psycopg.connect(stages_test_db) as conn:
            status = conn.execute(
                "SELECT status FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()[0]
        assert status == "needs_review", f"Expected 'needs_review', got '{status}'"

    def test_reingest_restores_previously_searchable(self, stages_test_db, monkeypatch):
        """Re-ingest of a promoted doc: prior_status='searchable' + clean parse
        → restored to searchable (not unpublished), job ends done. The /reindex
        refresh points at a closed port to prove a failure there is tolerated
        (best-effort, same contract as the old auto-publish path)."""
        monkeypatch.setenv("SEARCH_SERVICE_URL", "http://127.0.0.1:1")

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_publish_document(conn, external_id="pub-restore", language="en")
            _insert_document_texts_for_publish(conn, doc_id, char_count=1000, pages=2)
            _insert_chunk_for_publish(conn, doc_id, external_id="pub-restore")
            _insert_running_job_for_publish(conn, doc_id, prior_status="searchable")
            # Parse flipped the doc to 'processing' mid-pipeline.
            conn.execute("UPDATE documents SET status='processing' WHERE id=%s", (doc_id,))
            conn.commit()

        from worker.stages.publish import run
        result = run(doc_id)
        assert result is None

        with psycopg.connect(stages_test_db) as conn:
            row = conn.execute(
                "SELECT status, extraction_confidence FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()
        assert row[0] == "searchable", f"Expected restored 'searchable', got '{row[0]}'"
        assert float(row[1]) >= 0.7

    def test_degraded_reingest_parks_previously_searchable(self, stages_test_db, monkeypatch):
        """Re-ingest of a promoted doc whose re-parse is now LOW quality: the
        restore is refused — doc parks at needs_review and the job parks too,
        so a human sees the regression before the doc goes back up.

        Arithmetic (sparse case): char_count=50, pages=1, no chunks → 0.4 < 0.7.
        """
        monkeypatch.delenv("SEARCH_SERVICE_URL", raising=False)

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_publish_document(conn, external_id="pub-restore-low", language="en")
            _insert_document_texts_for_publish(conn, doc_id, char_count=50, pages=1)
            _insert_running_job_for_publish(conn, doc_id, prior_status="searchable")

        from worker.stages.publish import run
        result = run(doc_id)
        assert result == "needs_review"

        with psycopg.connect(stages_test_db) as conn:
            status = conn.execute(
                "SELECT status FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()[0]
        assert status == "needs_review", f"Expected 'needs_review', got '{status}'"

    def test_low_confidence_withdrawn_doc_returns_none_not_needs_review(
        self, stages_test_db, monkeypatch
    ):
        """A withdrawn doc with low confidence: the guarded UPDATE no-ops (status
        stays withdrawn), so publish must return None (not 'needs_review') — so the
        job ends 'done' (NEW-P2-4), not parked in the review queue for a withdrawn doc.

        Arithmetic (same as sparse test): char_count=50, pages=1, no chunks → score=0.4 < 0.7.
        """
        monkeypatch.delenv("SEARCH_SERVICE_URL", raising=False)

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_publish_document(conn, external_id="pub-withdrawn-low", language="en")
            _insert_document_texts_for_publish(conn, doc_id, char_count=50, pages=1)
            # No chunks → 0.0 chunk weight → low score
            conn.execute("UPDATE documents SET status='withdrawn' WHERE id=%s", (doc_id,))
            conn.commit()

        from worker.stages.publish import run
        result = run(doc_id)
        assert result is None, (
            f"withdrawn doc with low confidence should return None (not 'needs_review'), got {result!r}"
        )

        with psycopg.connect(stages_test_db) as conn:
            status = conn.execute(
                "SELECT status FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()[0]
        assert status == "withdrawn", f"withdrawn doc must stay withdrawn, got {status!r}"

    def test_high_confidence_flip_writes_lifecycle_audit(self, stages_test_db, monkeypatch):
        """Parking a high-density doc at 'needs_review' emits one system lifecycle
        audit row: entity_type='document', source='system', actor NULL,
        before={status:'processing'}, after={status:'needs_review'}."""
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
        assert after == {"status": "needs_review"}

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
        """A failed audit write is swallowed: the stage still flips to needs_review
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
        assert status == "needs_review", "status flip must succeed despite audit failure"
        assert n == 0, "the failed audit write left no row"

    def test_server_side_audit_failure_recovers_savepoint(self, stages_test_db):
        """A genuine Postgres error inside the helper (NOT NULL violation on
        audit_log.action via action=None) aborts only the SAVEPOINT: a write made
        earlier in the same outer transaction survives, a write made after still
        works, and the outer commit lands both — the transaction is not poisoned."""
        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_publish_document(conn, external_id="pub-audit-sp", language="en")

        from worker.stages import audit_system_event

        with psycopg.connect(stages_test_db) as conn:
            # Statement 1 implicitly opens the outer transaction (autocommit off),
            # so the helper's conn.transaction() issues a real SAVEPOINT.
            conn.execute("UPDATE documents SET title='before-audit' WHERE id=%s", (doc_id,))
            # action=None violates audit_log.action NOT NULL server-side; the
            # aborted subtransaction must be rolled back to the savepoint.
            audit_system_event(conn, doc_id, None, {}, {})  # must not raise
            # The outer transaction must still accept statements...
            conn.execute("UPDATE documents SET language='fr' WHERE id=%s", (doc_id,))
            conn.commit()  # ...and commit cleanly.

        with psycopg.connect(stages_test_db) as conn:
            title, language = conn.execute(
                "SELECT title, language FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()
            n = conn.execute(
                "SELECT count(*) FROM audit_log WHERE entity_id=%s", (doc_id,)
            ).fetchone()[0]
        assert title == "before-audit", "pre-audit write must survive the savepoint rollback"
        assert language == "fr", "post-audit write on the same connection must commit"
        assert n == 0, "the failed audit insert left no row"


_EXTRACT_FIELDS_FOR_TEST = [
    "title", "authors", "doi", "year_published", "article_type", "wri_primary_office"
]


class TestParseLLMExtraction:
    """Tests for the LLM metadata extraction in the parse stage.
    Mocks _load_pdf_bytes, _parse_pdf, and chat_json so tests are hermetic
    (no S3, no OpenAI, no real PDFs)."""

    _FAKE_TEXT = (
        "WORKING PAPER  |  Version 1.0  |  October 2025  |  1\n\n"
        "Who's Driving This Bus? A Culturally and Legally Informed Approach\n\n"
        "By Jane Doe; John Smith\n\nBody text follows here."
    )
    _FAKE_EXTRACTION = {
        "title": "Who's Driving This Bus? A Culturally and Legally Informed Approach",
        "authors": "Doe, Jane; Smith, John",
        "doi": "10.46830/writn.25.00114",
        "year_published": 2025,
        "article_type": "Working Paper",
        "wri_primary_office": "WRI United States",
    }
    _FAKE_AUTHOR_PARTS = [
        {"family_name": "Doe", "given_names": "Jane", "organization_name": None},
        {"family_name": "Smith", "given_names": "John", "organization_name": None},
    ]

    def _fake_llm_response(self):
        return {**self._FAKE_EXTRACTION, "authors": list(self._FAKE_AUTHOR_PARTS)}

    def _setup_doc(self, stages_test_db, metadata_source=None, title=None, authors=None):
        """Insert a doc with the given metadata_source and return its id."""
        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document(
                conn,
                external_id=f"extract-test-{os.getpid()}",
                s3_key="documents/extract-test.pdf",
                title=title or "extract-test",
            )
            if metadata_source is not None:
                from psycopg.types.json import Jsonb
                conn.execute(
                    "UPDATE documents SET metadata_source = %s WHERE id = %s",
                    (Jsonb(metadata_source), doc_id),
                )
            if authors is not None:
                conn.execute(
                    "UPDATE documents SET authors = %s WHERE id = %s",
                    (authors, doc_id),
                )
            conn.commit()
        return doc_id

    def _mock_parse(self, monkeypatch):
        """Mock _load_pdf_bytes to return fake bytes, _parse_pdf to return fake text."""
        from worker.stages import parse as _parse
        monkeypatch.setattr(_parse, "_load_pdf_bytes", lambda doc: b"%PDF-1.5 fake")
        monkeypatch.setattr(_parse, "_parse_pdf", lambda content: (self._FAKE_TEXT, []))

    def test_fresh_ingest_fills_all_fields_sets_llm_provenance(self, stages_test_db, monkeypatch):
        """(a) Fresh worker ingest: metadata_source={} → LLM fills all fields, provenance='llm'."""
        self._mock_parse(monkeypatch)
        import worker.llm as _llm
        monkeypatch.setattr(_llm, "chat_json", lambda **kw: self._fake_llm_response())

        doc_id = self._setup_doc(stages_test_db, metadata_source={})

        from worker.stages.parse import run
        run(doc_id)

        with psycopg.connect(stages_test_db) as conn:
            row = conn.execute(
                "SELECT title, authors, doi, year_published, article_type, wri_primary_office, metadata_source "
                "FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()
        assert row[0] == self._FAKE_EXTRACTION["title"]
        assert row[1] == self._FAKE_EXTRACTION["authors"]
        assert row[2] == self._FAKE_EXTRACTION["doi"]
        assert row[3] == 2025
        assert row[4] == "Working Paper"
        assert row[5] == "WRI United States"
        import json
        ms = row[6]
        for f in ["title", "authors", "doi", "year_published", "article_type", "wri_primary_office"]:
            assert ms.get(f) == "llm", f"{f} should be 'llm', got {ms.get(f)!r}"

    def test_reingest_does_not_overwrite_external_title(self, stages_test_db, monkeypatch):
        """(b) CSV-imported title (metadata_source={title:'external'}) → re-ingest does NOT overwrite."""
        self._mock_parse(monkeypatch)
        import worker.llm as _llm
        monkeypatch.setattr(_llm, "chat_json", lambda **kw: self._fake_llm_response())

        doc_id = self._setup_doc(
            stages_test_db,
            metadata_source={"title": "external", "authors": "external"},
            title="My CSV Title",
            authors="Original Author",
        )

        from worker.stages.parse import run
        run(doc_id)

        with psycopg.connect(stages_test_db) as conn:
            row = conn.execute("SELECT title, authors, metadata_source FROM documents WHERE id=%s", (doc_id,)).fetchone()
        # Title NOT overwritten (provenance 'external')
        assert row[0] == "My CSV Title"
        # Authors NOT overwritten (provenance 'external')
        assert row[1] == "Original Author"
        # metadata_source unchanged for external fields
        ms = row[2]
        assert ms["title"] == "external"
        assert ms["authors"] == "external"
        # But fields with no provenance (doi, year_published, etc.) WERE filled + set to llm
        assert ms.get("doi") == "llm"
        assert ms.get("year_published") == "llm"

    def test_reingest_does_not_overwrite_human_authors(self, stages_test_db, monkeypatch):
        """Human-owned authors remain unchanged when the parse model re-ingests metadata."""
        self._mock_parse(monkeypatch)
        import worker.llm as _llm
        monkeypatch.setattr(_llm, "chat_json", lambda **kw: self._fake_llm_response())

        doc_id = self._setup_doc(
            stages_test_db,
            metadata_source={"authors": "human"},
            authors="Human Curated Author",
        )

        from worker.stages.parse import run
        run(doc_id)

        with psycopg.connect(stages_test_db) as conn:
            authors, metadata_source = conn.execute(
                "SELECT authors, metadata_source FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()
        assert authors == "Human Curated Author"
        assert metadata_source["authors"] == "human"

    def test_reingest_overwrites_prior_llm_title_and_authors(self, stages_test_db, monkeypatch):
        """Prior LLM title and authors refresh with normalized model metadata and audit changes."""
        self._mock_parse(monkeypatch)
        import worker.llm as _llm
        monkeypatch.setattr(_llm, "chat_json", lambda **kw: self._fake_llm_response())

        doc_id = self._setup_doc(
            stages_test_db,
            metadata_source={"title": "llm", "authors": "llm"},
            title="Old LLM Title (wrong)",
            authors="Old LLM Author",
        )

        from worker.stages.parse import run
        run(doc_id)

        with psycopg.connect(stages_test_db) as conn:
            row = conn.execute("SELECT title, authors, metadata_source FROM documents WHERE id=%s", (doc_id,)).fetchone()
            audit_row = conn.execute(
                "SELECT before, after FROM audit_log "
                "WHERE action='update' AND entity_type='document' AND entity_id=%s",
                (doc_id,),
            ).fetchone()
        assert audit_row is not None
        before, after = audit_row
        # Title and authors refresh because their provenance was 'llm'.
        assert row[0] == self._FAKE_EXTRACTION["title"]
        assert row[1] == "Doe, Jane; Smith, John"
        assert row[2]["title"] == "llm"
        assert row[2]["authors"] == "llm"
        assert before["authors"] == "Old LLM Author"
        assert after["authors"] == "Doe, Jane; Smith, John"

    def test_chat_json_failure_does_not_crash_stage(self, stages_test_db, monkeypatch):
        """(d) chat_json raises → stage continues, no crash, metadata columns unchanged."""
        self._mock_parse(monkeypatch)
        import worker.llm as _llm
        monkeypatch.setattr(_llm, "chat_json", lambda **kw: (_ for _ in ()).throw(RuntimeError("LLM down")))

        doc_id = self._setup_doc(stages_test_db, metadata_source={}, title="original-slug")

        from worker.stages.parse import run
        result = run(doc_id)  # must not raise

        assert result is None  # stage succeeded (extraction is best-effort)
        with psycopg.connect(stages_test_db) as conn:
            row = conn.execute("SELECT title, status FROM documents WHERE id=%s", (doc_id,)).fetchone()
        assert row[0] == "original-slug"  # title unchanged
        assert row[1] == "processing"  # status advanced normally

    def test_extraction_writes_update_audit_of_overwritten_fields(self, stages_test_db, monkeypatch):
        """Fresh ingest: LLM fills all six fields → one system 'update' audit row
        whose before/after list exactly the overwritten fields with old→new values."""
        self._mock_parse(monkeypatch)
        import worker.llm as _llm
        monkeypatch.setattr(_llm, "chat_json", lambda **kw: self._fake_llm_response())

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
        monkeypatch.setattr(_llm, "chat_json", lambda **kw: self._fake_llm_response())

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
        monkeypatch.setattr(_llm, "chat_json", lambda **kw: self._fake_llm_response())

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
        monkeypatch.setattr(_llm, "chat_json", lambda **kw: self._fake_llm_response())
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
