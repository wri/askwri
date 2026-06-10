"""Integration tests for worker stages against a scratch database.

Uses the same hermetic pattern as test_worker_queue.py:
  - Create askwri_stages_test scratch DB (distinct name for coexistence)
  - Apply TypeORM migrations via subprocess
  - Point DATABASE_URL at it; reset app.db._pool
  - Never touch the qa database

Skip guard: requires DATABASE_URL (same convention as other DB tests).
"""
import hashlib
import os
import subprocess

import psycopg
import pytest

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
