"""Integration tests for worker.queue against a scratch database.

Uses the same hermetic pattern as test_migration_script.py:
  - Create askwri_worker_test scratch DB
  - Apply TypeORM migrations via subprocess
  - Point DATABASE_URL at it; reset app.db._pool
  - Never touch the qa database

Skip guard: requires DATABASE_URL (same convention as migration tests).
"""
import os
import subprocess
import time
import uuid

import psycopg
import pytest

from tests.conftest import _check_db_required

# ---------------------------------------------------------------------------
# Module-level loud-skip guard
# ---------------------------------------------------------------------------
_check_db_required()

pytestmark = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="DATABASE_URL not set — skipping worker queue integration tests",
)

# ---------------------------------------------------------------------------
# Constants — distinct scratch DB name to avoid colliding with askwri_test
# ---------------------------------------------------------------------------
_SUPERDB_URL = "postgresql://askwri:password@localhost:5432/postgres"
_TEST_DB = "askwri_worker_test"
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


def _insert_document(conn) -> uuid.UUID:
    """Insert a minimal documents row; returns its id."""
    doc_id = uuid.uuid4()
    conn.execute(
        """INSERT INTO documents (id, external_id, s3_key, status)
           VALUES (%s, %s, %s, 'draft')""",
        (doc_id, f"ext-{doc_id}", f"pdfs/{doc_id}.pdf"),
    )
    return doc_id


# ---------------------------------------------------------------------------
# Session fixture: create/drop scratch DB + apply TypeORM schema
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def worker_test_db():
    """Create askwri_worker_test, apply migrations, yield URL, then drop."""
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
def clean_db(worker_test_db, monkeypatch):
    """Truncate ingestion_jobs and documents before each test."""
    _reset_app_state(worker_test_db)
    with psycopg.connect(worker_test_db) as conn:
        conn.execute("TRUNCATE ingestion_jobs CASCADE")
        conn.execute("TRUNCATE documents CASCADE")
        conn.commit()
    yield
    # Restore pool so other test modules aren't affected
    import app.db as _db
    if _db._pool is not None:
        try:
            _db._pool.close()
        except Exception:
            pass
    _db._pool = None


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestWorkerQueue:

    def test_enqueue_is_idempotent_while_open(self, worker_test_db):
        """Enqueue twice while open → one row; after mark_done → second row allowed."""
        from worker import queue

        with psycopg.connect(worker_test_db) as conn:
            doc_id = _insert_document(conn)
            conn.commit()

        with psycopg.connect(worker_test_db) as conn:
            job_id_1 = queue.enqueue(conn, doc_id)
            conn.commit()

        with psycopg.connect(worker_test_db) as conn:
            job_id_2 = queue.enqueue(conn, doc_id)
            conn.commit()

        assert job_id_1 == job_id_2, "Second enqueue should return existing job id"

        with psycopg.connect(worker_test_db) as conn:
            count = conn.execute("SELECT count(*) FROM ingestion_jobs").fetchone()[0]
        assert count == 1

        # After marking done, a new enqueue should create a second row
        # (mark_done requires status='running', so claim first)
        assert queue.claim_job() is not None
        queue.mark_done(job_id_1, "publish")

        with psycopg.connect(worker_test_db) as conn:
            job_id_3 = queue.enqueue(conn, doc_id)
            conn.commit()

        assert job_id_3 != job_id_1, "After done, enqueue should create a new job"
        with psycopg.connect(worker_test_db) as conn:
            count = conn.execute("SELECT count(*) FROM ingestion_jobs").fetchone()[0]
        assert count == 2

    def test_claim_sets_running_and_skips_locked(self, worker_test_db):
        """Claim sets status=running on oldest job; second claim gets second job."""
        from worker import queue

        # Insert two documents and enqueue using SEPARATE connections so they
        # get distinct created_at timestamps.
        with psycopg.connect(worker_test_db) as conn:
            doc_id_1 = _insert_document(conn)
            conn.commit()

        with psycopg.connect(worker_test_db) as conn:
            queue.enqueue(conn, doc_id_1)
            conn.commit()

        # Small sleep to ensure distinct created_at ordering
        time.sleep(0.05)

        with psycopg.connect(worker_test_db) as conn:
            doc_id_2 = _insert_document(conn)
            conn.commit()

        with psycopg.connect(worker_test_db) as conn:
            queue.enqueue(conn, doc_id_2)
            conn.commit()

        # First claim
        claimed_1 = queue.claim_job()
        assert claimed_1 is not None
        job_id_c1, doc_c1, stage_c1, attempts_c1 = claimed_1

        with psycopg.connect(worker_test_db) as conn:
            row = conn.execute(
                "SELECT status FROM ingestion_jobs WHERE id = %s", (job_id_c1,)
            ).fetchone()
        assert row[0] == "running"

        # Second claim gets the other job
        claimed_2 = queue.claim_job()
        assert claimed_2 is not None
        job_id_c2, doc_c2, stage_c2, attempts_c2 = claimed_2
        assert job_id_c2 != job_id_c1

        # No more claimable jobs
        claimed_3 = queue.claim_job()
        assert claimed_3 is None

    def test_full_stage_walk(self, worker_test_db):
        """Advance through all stages; final mark_done sets status=done."""
        from worker import queue
        from worker.stages import STAGE_ORDER

        with psycopg.connect(worker_test_db) as conn:
            doc_id = _insert_document(conn)
            queue.enqueue(conn, doc_id)
            conn.commit()

        claimed = queue.claim_job()
        assert claimed is not None
        job_id, _, stage, _ = claimed

        # Walk through each stage
        for i, stage_name in enumerate(STAGE_ORDER):
            # The claimed job should be running; next_stage from last completed
            current_next = queue.next_stage(stage)
            assert current_next == stage_name

            if stage_name == STAGE_ORDER[-1]:
                queue.mark_done(job_id, stage_name)
            else:
                queue.advance(job_id, stage_name)
                # Re-claim for next stage
                claimed = queue.claim_job()
                assert claimed is not None, f"Failed to claim after stage {stage_name}"
                job_id, _, stage, _ = claimed

        with psycopg.connect(worker_test_db) as conn:
            row = conn.execute(
                "SELECT status, stage FROM ingestion_jobs WHERE id = %s", (job_id,)
            ).fetchone()
        assert row[0] == "done"
        assert row[1] == STAGE_ORDER[-1]

    def test_retry_then_error(self, worker_test_db):
        """mark_failed increments attempts; at max_attempts transitions to error."""
        from worker import queue

        with psycopg.connect(worker_test_db) as conn:
            doc_id = _insert_document(conn)
            queue.enqueue(conn, doc_id)
            conn.commit()

        claimed = queue.claim_job()
        assert claimed is not None
        job_id, _, stage, attempts = claimed
        assert attempts == 0

        # First failure: attempts becomes 1, still queued (max=3)
        queue.mark_failed(job_id, "parse", "err1", attempts=0, max_attempts=3)
        with psycopg.connect(worker_test_db) as conn:
            row = conn.execute(
                "SELECT status, attempts FROM ingestion_jobs WHERE id = %s", (job_id,)
            ).fetchone()
        assert row[0] == "queued"
        assert row[1] == 1

        # Claim again (it's queued again), fail a second time
        claimed = queue.claim_job()
        assert claimed is not None
        job_id2, _, stage2, attempts2 = claimed
        assert job_id2 == job_id
        assert attempts2 == 1

        queue.mark_failed(job_id, "parse", "err2", attempts=1, max_attempts=3)
        with psycopg.connect(worker_test_db) as conn:
            row = conn.execute(
                "SELECT status, attempts FROM ingestion_jobs WHERE id = %s", (job_id,)
            ).fetchone()
        assert row[0] == "queued"
        assert row[1] == 2

        # Third failure: new_attempts=3 >= max_attempts=3 → status=error
        claimed = queue.claim_job()
        assert claimed is not None
        queue.mark_failed(job_id, "parse", "err3", attempts=2, max_attempts=3)
        with psycopg.connect(worker_test_db) as conn:
            row = conn.execute(
                "SELECT status, attempts FROM ingestion_jobs WHERE id = %s", (job_id,)
            ).fetchone()
        assert row[0] == "error"
        assert row[1] == 3

    def test_needs_review_not_claimable(self, worker_test_db):
        """A job in needs_review status must not be claimable."""
        from worker import queue

        with psycopg.connect(worker_test_db) as conn:
            doc_id = _insert_document(conn)
            queue.enqueue(conn, doc_id)
            conn.commit()

        claimed = queue.claim_job()
        assert claimed is not None
        job_id, _, _, _ = claimed

        queue.mark_needs_review(job_id, "classify")

        with psycopg.connect(worker_test_db) as conn:
            row = conn.execute(
                "SELECT status FROM ingestion_jobs WHERE id = %s", (job_id,)
            ).fetchone()
        assert row[0] == "needs_review"

        # No queued jobs remain → claim returns None
        result = queue.claim_job()
        assert result is None

    def test_needs_review_does_not_block_reenqueue(self, worker_test_db):
        """A parked needs_review job must NOT block a fresh enqueue
        (re-ingest of fixed content)."""
        from worker import queue

        with psycopg.connect(worker_test_db) as conn:
            doc_id = _insert_document(conn)
            job_id_1 = queue.enqueue(conn, doc_id)
            conn.commit()

        claimed = queue.claim_job()
        assert claimed is not None
        queue.mark_needs_review(job_id_1, "publish")

        with psycopg.connect(worker_test_db) as conn:
            job_id_2 = queue.enqueue(conn, doc_id)
            conn.commit()

        assert job_id_2 != job_id_1, "needs_review job should not block a new enqueue"
        with psycopg.connect(worker_test_db) as conn:
            queued = conn.execute(
                "SELECT count(*) FROM ingestion_jobs WHERE document_id = %s AND status = 'queued'",
                (doc_id,),
            ).fetchone()[0]
        assert queued == 1

    def test_reap_stale_jobs_requeues_old_running(self, worker_test_db):
        """A 'running' job whose updated_at is older than the cutoff is
        requeued; a fresh running job is left alone."""
        from worker import queue

        with psycopg.connect(worker_test_db) as conn:
            doc_id_stale = _insert_document(conn)
            stale_job_id = queue.enqueue(conn, doc_id_stale)
            doc_id_fresh = _insert_document(conn)
            fresh_job_id = queue.enqueue(conn, doc_id_fresh)
            conn.execute(
                """UPDATE ingestion_jobs SET status = 'running',
                   updated_at = now() - interval '30 minutes' WHERE id = %s""",
                (stale_job_id,),
            )
            conn.execute(
                "UPDATE ingestion_jobs SET status = 'running' WHERE id = %s",
                (fresh_job_id,),
            )
            conn.commit()

        with psycopg.connect(worker_test_db) as conn:
            reclaimed = queue.reap_stale_jobs(conn, max_age_minutes=15)
            conn.commit()

        assert reclaimed == [stale_job_id]

        with psycopg.connect(worker_test_db) as conn:
            stale_status = conn.execute(
                "SELECT status FROM ingestion_jobs WHERE id = %s", (stale_job_id,)
            ).fetchone()[0]
            fresh_status = conn.execute(
                "SELECT status FROM ingestion_jobs WHERE id = %s", (fresh_job_id,)
            ).fetchone()[0]
        assert stale_status == "queued", "stale running job should be requeued"
        assert fresh_status == "running", "fresh running job should be untouched"

    def test_done_job_not_resurrected_by_late_writes(self, worker_test_db):
        """By-id transitions require status='running': a reaped-and-superseded
        worker's late advance/mark_failed/mark_needs_review/mark_done must not
        flip a finished job backward."""
        from worker import queue

        with psycopg.connect(worker_test_db) as conn:
            doc_id = _insert_document(conn)
            job_id = queue.enqueue(conn, doc_id)
            conn.commit()

        assert queue.claim_job() is not None
        queue.mark_done(job_id, "publish")

        # Late writes from the original (reaped) worker are all discarded
        queue.advance(job_id, "embed")
        queue.mark_failed(job_id, "embed", "late failure", attempts=0, max_attempts=3)
        queue.mark_needs_review(job_id, "classify")
        queue.mark_done(job_id, "embed")

        with psycopg.connect(worker_test_db) as conn:
            row = conn.execute(
                "SELECT status, stage, attempts, error FROM ingestion_jobs WHERE id = %s",
                (job_id,),
            ).fetchone()
        assert row[0] == "done", "late writes must not change a done job's status"
        assert row[1] == "publish", "late writes must not change a done job's stage"
        assert row[2] == 0, "late mark_failed must not increment attempts"
        assert row[3] is None, "late mark_failed must not record an error"

        # And the done job is not claimable again
        assert queue.claim_job() is None

    def test_withdrawn_document_job_skipped_without_running_stages(self, worker_test_db):
        """process_one_job on a withdrawn document marks the job done without
        running any stage; the document stays withdrawn."""
        from worker import queue
        from worker.main import process_one_job

        with psycopg.connect(worker_test_db) as conn:
            doc_id = _insert_document(conn)
            job_id = queue.enqueue(conn, doc_id)
            conn.execute(
                "UPDATE documents SET status = 'withdrawn' WHERE id = %s", (doc_id,)
            )
            conn.commit()

        worked = process_one_job()
        assert worked is True

        with psycopg.connect(worker_test_db) as conn:
            job_status = conn.execute(
                "SELECT status FROM ingestion_jobs WHERE id = %s", (job_id,)
            ).fetchone()[0]
            doc_status = conn.execute(
                "SELECT status FROM documents WHERE id = %s", (doc_id,)
            ).fetchone()[0]
        assert job_status == "done", "job must not be left stuck"
        assert doc_status == "withdrawn", "document must stay withdrawn"

        # Nothing left to claim
        assert queue.claim_job() is None
