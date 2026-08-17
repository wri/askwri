"""reclassify: classify-only re-run queue worker (issue #323).

Tests the FOR UPDATE SKIP LOCKED claim loop, the classify.run(topic_only=True)
call, and the attempts→error retry logic. Uses the same scratch-DB fixture
pattern as test_classify_topic.py.
"""
import os
import subprocess
import uuid as _uuid

import psycopg
import pytest

from tests.conftest import _check_db_required

_check_db_required()

pytestmark = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="DATABASE_URL not set — skipping reclassify integration tests",
)

_SUPERDB_URL = "postgresql://askwri:password@localhost:5432/postgres"
_TEST_DB = "askwri_reclassify_test"
_TEST_DB_URL = f"postgresql://askwri:password@localhost:5432/{_TEST_DB}"
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _reset_app_state(db_url: str) -> None:
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


@pytest.fixture(scope="session")
def reclassify_test_db():
    """Create askwri_reclassify_test, apply migrations, yield URL, then drop."""
    _orig_db_url = os.environ.get("DATABASE_URL")
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

    if _orig_db_url is not None:
        os.environ["DATABASE_URL"] = _orig_db_url
    else:
        os.environ.pop("DATABASE_URL", None)
    from app.config import get_settings
    get_settings.cache_clear()
    import app.db as _db
    if _db._pool is not None:
        try:
            _db._pool.close()
        except Exception:
            pass
        _db._pool = None

    with psycopg.connect(_SUPERDB_URL, autocommit=True) as conn:
        conn.execute(
            f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            f"WHERE datname='{_TEST_DB}' AND pid <> pg_backend_pid()"
        )
        conn.execute(f"DROP DATABASE IF EXISTS {_TEST_DB}")


@pytest.fixture
def clean_db(reclassify_test_db):
    """Truncate tables and reset app state before each test."""
    _reset_app_state(reclassify_test_db)
    with psycopg.connect(reclassify_test_db) as conn:
        conn.execute("TRUNCATE audit_log CASCADE")
        conn.execute("TRUNCATE reclassify_jobs CASCADE")
        conn.execute("TRUNCATE document_tags CASCADE")
        conn.execute("TRUNCATE tag_aliases CASCADE")
        conn.execute("TRUNCATE tag_embeddings CASCADE")
        conn.execute("TRUNCATE tags CASCADE")
        conn.execute("TRUNCATE document_summaries CASCADE")
        conn.execute("TRUNCATE document_texts CASCADE")
        conn.execute("TRUNCATE documents CASCADE")
        conn.commit()
    yield reclassify_test_db
    import app.db as _db
    if _db._pool is not None:
        try:
            _db._pool.close()
        except Exception:
            pass
        _db._pool = None
    from app.config import get_settings
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _insert_document(conn, *, external_id="reclassify-doc", title="Test Doc"):
    """Insert a minimal document; return doc id."""
    from psycopg.types.json import Jsonb
    row = conn.execute(
        """INSERT INTO documents (external_id, s3_key, title, status, content_hash, language, languages, metadata_source)
           VALUES (%s, %s, %s, 'ready', 'abc123', 'en', ARRAY['en'], %s)
           RETURNING id""",
        (external_id, f"documents/{external_id}.pdf", title, Jsonb({})),
    ).fetchone()
    return row[0]


def _insert_reclassify_job(conn, document_id, scope_tag_id=None):
    """Insert a queued reclassify_job; return (id, document_id, scope_tag_id)."""
    row = conn.execute(
        """INSERT INTO reclassify_jobs (document_id, scope_tag_id, status)
           VALUES (%s, %s, 'queued') RETURNING id, document_id, scope_tag_id""",
        (document_id, scope_tag_id),
    ).fetchone()
    return row


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestClaimJob:
    """claim_job: FOR UPDATE SKIP LOCKED — two claims on one row, first wins."""

    def test_first_claim_wins_second_returns_none(self, clean_db):
        from worker.stages.reclassify import claim_job

        conn = psycopg.connect(clean_db)
        try:
            doc_id = _insert_document(conn, external_id="claim1")
            job = _insert_reclassify_job(conn, doc_id)
            conn.commit()

            # First claim gets the row
            claimed = claim_job(conn)
            assert claimed is not None
            assert claimed[0] == job[0]  # id
            assert claimed[1] == doc_id  # document_id

            # Second claim on the same connection (row is now 'running') → None
            claimed2 = claim_job(conn)
            assert claimed2 is None
        finally:
            conn.close()

    def test_claim_returns_none_when_queue_empty(self, clean_db):
        from worker.stages.reclassify import claim_job

        with psycopg.connect(clean_db) as conn:
            result = claim_job(conn)
            assert result is None


class TestProcessOneReclassify:
    """process_one_reclassify: claim → classify.run(topic_only=True) → done."""

    def test_marks_done_on_success(self, clean_db, monkeypatch):
        """A queued job is claimed, classify.run is called with topic_only=True,
        and the job status becomes 'done'."""
        import worker.stages.reclassify as reclassify_mod

        with psycopg.connect(clean_db) as conn:
            doc_id = _insert_document(conn, external_id="ok1")
            job = _insert_reclassify_job(conn, doc_id)
            conn.commit()

        # Stub classify.run to record the topic_only kwarg and succeed
        call_args = {}

        def fake_classify_run(document_id, topic_only=False):
            call_args["document_id"] = document_id
            call_args["topic_only"] = topic_only
            return None

        monkeypatch.setattr(reclassify_mod, "classify_run", fake_classify_run)

        result = reclassify_mod.process_one_reclassify()
        assert result is True, "process_one_reclassify should return True when work was done"

        # classify.run was called with topic_only=True
        assert call_args["topic_only"] is True, "classify.run must be called with topic_only=True"
        assert call_args["document_id"] == doc_id

        # Job is now 'done'
        with psycopg.connect(clean_db) as conn:
            status = conn.execute(
                "SELECT status FROM reclassify_jobs WHERE id = %s", (job[0],)
            ).fetchone()
            assert status[0] == "done"

    def test_requeues_on_first_failure(self, clean_db, monkeypatch):
        """First failure: attempts goes 0→1, status back to 'queued' (not error yet)."""
        import worker.stages.reclassify as reclassify_mod

        with psycopg.connect(clean_db) as conn:
            doc_id = _insert_document(conn, external_id="fail1")
            job = _insert_reclassify_job(conn, doc_id)
            conn.commit()

        call_count = [0]

        def always_fails(document_id, topic_only=False):
            call_count[0] += 1
            raise RuntimeError("LLM timeout")

        monkeypatch.setattr(reclassify_mod, "classify_run", always_fails)

        result = reclassify_mod.process_one_reclassify()
        assert result is True, "work was done (attempted + failed, but work happened)"

        with psycopg.connect(clean_db) as conn:
            row = conn.execute(
                "SELECT status, attempts FROM reclassify_jobs WHERE id = %s", (job[0],)
            ).fetchone()
            assert row[0] == "queued", f"first failure should requeue, got {row[0]}"
            assert row[1] == 1, f"attempts should be 1 after first failure, got {row[1]}"

    def test_marks_error_after_max_attempts(self, clean_db, monkeypatch):
        """After MAX_ATTEMPTS (2) failures, status becomes 'error' with the message."""
        import worker.stages.reclassify as reclassify_mod

        with psycopg.connect(clean_db) as conn:
            doc_id = _insert_document(conn, external_id="fail2")
            job = _insert_reclassify_job(conn, doc_id)
            # Pre-set attempts to 1 (one failure already happened)
            conn.execute(
                "UPDATE reclassify_jobs SET attempts = 1 WHERE id = %s", (job[0],)
            )
            conn.commit()

        def always_fails(document_id, topic_only=False):
            raise RuntimeError("persistent LLM failure")

        monkeypatch.setattr(reclassify_mod, "classify_run", always_fails)

        result = reclassify_mod.process_one_reclassify()
        assert result is True

        with psycopg.connect(clean_db) as conn:
            row = conn.execute(
                "SELECT status, attempts, error FROM reclassify_jobs WHERE id = %s", (job[0],)
            ).fetchone()
            assert row[0] == "error", f"after MAX_ATTEMPTS, status should be 'error', got {row[0]}"
            assert row[1] == 2, f"attempts should be 2, got {row[1]}"
            assert row[2] is not None, "error message should be recorded"
            assert "persistent LLM failure" in row[2]

    def test_returns_false_when_queue_empty(self, clean_db, monkeypatch):
        """No queued jobs → process_one_reclassify returns False (no work done)."""
        import worker.stages.reclassify as reclassify_mod

        result = reclassify_mod.process_one_reclassify()
        assert result is False, "should return False when no jobs to process"
