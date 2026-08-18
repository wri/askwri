"""reclassify: classify-only re-run queue worker (issue #323).

Tests the FOR UPDATE SKIP LOCKED claim loop, the classify.run(topic_only=True)
call, and the attempts→error retry logic. Uses a UUID-suffixed scratch DB.
"""
import os
import subprocess
import threading
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
_TEST_DB = f"askwri_reclassify_{_uuid.uuid4().hex[:12]}"
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
    """Create a uniquely named scratch DB, apply migrations, then drop it."""
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
           VALUES (%s, %s, %s, 'ready', %s, 'en', ARRAY['en'], %s)
           RETURNING id""",
        (
            external_id,
            f"documents/{external_id}.pdf",
            title,
            f"hash-{external_id}",
            Jsonb({}),
        ),
    ).fetchone()
    return row[0]


def _insert_reclassify_job(conn, document_id, scope_tag_id=None, run_id=None):
    """Insert a queued job; return its four-column worker claim shape."""
    run_id = run_id or _uuid.uuid4()
    row = conn.execute(
        """INSERT INTO reclassify_jobs
               (document_id, scope_tag_id, run_id, status)
           VALUES (%s, %s, %s, 'queued')
           RETURNING id, document_id, scope_tag_id, run_id""",
        (document_id, scope_tag_id, run_id),
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
            assert claimed == job
            assert claimed[3] == job[3]  # run_id is propagated to the worker

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
            audit = conn.execute(
                """SELECT source, entity_type, entity_id, after
                   FROM audit_log
                   WHERE action='reclassify_run' AND entity_id=%s""",
                (job[3],),
            ).fetchone()
            assert audit == (
                "system",
                "reclassify_run",
                job[3],
                {
                    "runId": str(job[3]),
                    "total": 1,
                    "done": 1,
                    "error": 0,
                    "estCost": 0.0008,
                },
            )

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
            audit_count = conn.execute(
                """SELECT count(*) FROM audit_log
                   WHERE action='reclassify_run' AND entity_id=%s""",
                (job[3],),
            ).fetchone()[0]
            assert audit_count == 0, "a retryable failure is not a terminal run"

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
            audit = conn.execute(
                """SELECT after FROM audit_log
                   WHERE action='reclassify_run' AND entity_id=%s""",
                (job[3],),
            ).fetchone()
            assert audit == (
                {
                    "runId": str(job[3]),
                    "total": 1,
                    "done": 0,
                    "error": 1,
                    "estCost": 0.0008,
                },
            )

    def test_returns_false_when_queue_empty(self, clean_db, monkeypatch):
        """No queued jobs → process_one_reclassify returns False (no work done)."""
        import worker.stages.reclassify as reclassify_mod

        result = reclassify_mod.process_one_reclassify()
        assert result is False, "should return False when no jobs to process"


class TestProcessReclassifyBatch:

    def test_uses_exact_bounded_concurrency(self, monkeypatch):
        """Three requested slots execute three claims with at most three active."""
        import worker.stages.reclassify as reclassify_mod

        barrier = threading.Barrier(3)
        lock = threading.Lock()
        active = 0
        max_active = 0
        calls = 0

        def fake_process_one():
            nonlocal active, max_active, calls
            with lock:
                active += 1
                calls += 1
                max_active = max(max_active, active)
            barrier.wait(timeout=2)
            with lock:
                active -= 1
            return True

        monkeypatch.setattr(reclassify_mod, "process_one_reclassify", fake_process_one)

        worked = reclassify_mod.process_reclassify_batch(3)

        assert worked == 3
        assert calls == 3
        assert max_active == 3

    def test_concurrent_final_jobs_emit_one_completion_audit(
        self, clean_db, monkeypatch
    ):
        """The final terminal transition wins one run-scoped completion audit."""
        import worker.stages.reclassify as reclassify_mod

        run_id = _uuid.uuid4()
        with psycopg.connect(clean_db) as conn:
            first_doc = _insert_document(conn, external_id="concurrent-audit-1")
            second_doc = _insert_document(conn, external_id="concurrent-audit-2")
            _insert_reclassify_job(conn, first_doc, run_id=run_id)
            _insert_reclassify_job(conn, second_doc, run_id=run_id)
            conn.commit()

        both_claimed = threading.Barrier(2)

        def synchronized_classify(document_id, topic_only=False):
            assert topic_only is True
            both_claimed.wait(timeout=2)

        monkeypatch.setattr(reclassify_mod, "classify_run", synchronized_classify)

        assert reclassify_mod.process_reclassify_batch(2) == 2

        with psycopg.connect(clean_db) as conn:
            statuses = conn.execute(
                """SELECT status, count(*) FROM reclassify_jobs
                   WHERE run_id=%s GROUP BY status""",
                (run_id,),
            ).fetchall()
            audits = conn.execute(
                """SELECT after FROM audit_log
                   WHERE action='reclassify_run' AND entity_id=%s""",
                (run_id,),
            ).fetchall()

        assert statuses == [("done", 2)]
        assert audits == [
            (
                {
                    "runId": str(run_id),
                    "total": 2,
                    "done": 2,
                    "error": 0,
                    "estCost": 0.0016,
                },
            )
        ]


# ---------------------------------------------------------------------------
# Task 12: worker/main.py poll-loop ordering + embed sweep tick
# ---------------------------------------------------------------------------

class TestPollLoopOrdering:
    """run_tick maintains embeddings before bounded reclassification claims."""

    def test_reclassify_polled_before_ingest(self, clean_db, monkeypatch):
        """With reclassify_poll_first=True, a queued reclassify job is processed
        BEFORE any ingest job. Asserts via call-order recording."""
        import worker.main as main_mod

        call_order: list[str] = []

        def fake_embed_sweep():
            call_order.append("embed")

        def fake_reclassify_batch(concurrency):
            call_order.append(f"reclassify:{concurrency}")
            return 1  # did work → tick returns early

        def legacy_reclassify():
            call_order.append("legacy-reclassify")
            return True

        def fake_intake_sweep():
            call_order.append("intake")
            return False

        def fake_process_one_job():
            call_order.append("ingest_job")
            return False

        monkeypatch.setattr(main_mod, "_embed_sweep_tick", fake_embed_sweep)
        monkeypatch.setattr(
            main_mod, "process_reclassify_batch", fake_reclassify_batch, raising=False
        )
        monkeypatch.setattr(
            main_mod, "process_one_reclassify", legacy_reclassify, raising=False
        )
        monkeypatch.setattr(main_mod.intake_s3, "sweep", fake_intake_sweep)
        monkeypatch.setattr(main_mod, "process_one_job", fake_process_one_job)

        # reclassify_poll_first defaults True in config, but set explicitly
        monkeypatch.setattr(main_mod.get_settings(), "reclassify_poll_first", True)
        monkeypatch.setattr(main_mod.get_settings(), "tag_reclassify_concurrency", 3)

        result = main_mod.run_tick()
        assert result is True, "run_tick should return True when reclassify did work"
        assert call_order == ["embed", "reclassify:3"]
        assert "ingest_job" not in call_order, (
            "ingest job should not be polled when reclassify did work (early return)"
        )

    def test_ingest_polled_when_reclassify_empty(self, clean_db, monkeypatch):
        """When reclassify_poll_first=True but no reclassify jobs, the tick
        falls through to intake + ingest."""
        import worker.main as main_mod

        call_order: list[str] = []

        def fake_embed_sweep():
            call_order.append("embed")

        def fake_reclassify_batch(concurrency):
            call_order.append(f"reclassify:{concurrency}")
            return 0  # no work

        def legacy_reclassify():
            call_order.append("legacy-reclassify")
            return False

        def fake_intake_sweep():
            call_order.append("intake")
            return False

        def fake_process_one_job():
            call_order.append("ingest_job")
            return False

        monkeypatch.setattr(main_mod, "_embed_sweep_tick", fake_embed_sweep)
        monkeypatch.setattr(
            main_mod, "process_reclassify_batch", fake_reclassify_batch, raising=False
        )
        monkeypatch.setattr(
            main_mod, "process_one_reclassify", legacy_reclassify, raising=False
        )
        monkeypatch.setattr(main_mod.intake_s3, "sweep", fake_intake_sweep)
        monkeypatch.setattr(main_mod, "process_one_job", fake_process_one_job)
        monkeypatch.setattr(main_mod.get_settings(), "reclassify_poll_first", True)

        result = main_mod.run_tick()
        assert result is False
        expected_concurrency = main_mod.get_settings().tag_reclassify_concurrency
        assert call_order == [
            "embed",
            f"reclassify:{expected_concurrency}",
            "intake",
            "ingest_job",
        ]

    def test_reclassify_skipped_when_poll_first_false(self, clean_db, monkeypatch):
        """When reclassify_poll_first=False, reclassify is NOT polled."""
        import worker.main as main_mod

        call_order: list[str] = []

        def fake_embed_sweep():
            call_order.append("embed")

        def fake_reclassify_batch(concurrency):
            call_order.append("reclassify")
            return 1

        def legacy_reclassify():
            call_order.append("legacy-reclassify")
            return True

        def fake_intake_sweep():
            call_order.append("intake")
            return False

        def fake_process_one_job():
            call_order.append("ingest_job")
            return False

        monkeypatch.setattr(main_mod, "_embed_sweep_tick", fake_embed_sweep)
        monkeypatch.setattr(
            main_mod, "process_reclassify_batch", fake_reclassify_batch, raising=False
        )
        monkeypatch.setattr(
            main_mod, "process_one_reclassify", legacy_reclassify, raising=False
        )
        monkeypatch.setattr(main_mod.intake_s3, "sweep", fake_intake_sweep)
        monkeypatch.setattr(main_mod, "process_one_job", fake_process_one_job)
        monkeypatch.setattr(main_mod.get_settings(), "reclassify_poll_first", False)

        result = main_mod.run_tick()
        assert result is False
        assert "reclassify" not in call_order, (
            "reclassify should not be polled when reclassify_poll_first=False"
        )
        assert "legacy-reclassify" not in call_order
        assert call_order == ["embed", "intake", "ingest_job"]


class TestEmbedSweepTick:
    """The embed sweep tick runs sweep_pending + build_all_embeddings each tick,
    clearing needs_reembed flags and creating tag_embeddings rows."""

    def test_sweep_clears_needs_reembed_and_creates_embedding(self, clean_db, monkeypatch):
        """A topic tag with needs_reembed=true gets embedded (embed_one stubbed),
        flag cleared, and a tag_embeddings row created."""
        import worker.main as main_mod

        # Stub embed_one to avoid a real Bedrock call
        monkeypatch.setattr(
            "worker.stages.embed_tags.embed_one",
            lambda text: [0.1] * 1536,
        )

        with psycopg.connect(clean_db) as conn:
            # Insert a topic tag with needs_reembed=true
            row = conn.execute(
                """INSERT INTO tags (facet, value_id, taxonomy_version, needs_reembed)
                   VALUES ('topic', '__sweep_test__', 'v1', true)
                   RETURNING id""",
            ).fetchone()
            tag_id = row[0]
            conn.commit()

        # Run the embed sweep tick directly
        main_mod._embed_sweep_tick()

        with psycopg.connect(clean_db) as conn:
            tag_row = conn.execute(
                "SELECT needs_reembed FROM tags WHERE id = %s", (tag_id,)
            ).fetchone()
            assert tag_row[0] is False, (
                f"needs_reembed should be cleared after sweep, got {tag_row[0]}"
            )

            emb_row = conn.execute(
                """SELECT embedding_model, dimension FROM tag_embeddings
                   WHERE tag_id = %s""",
                (tag_id,),
            ).fetchone()
            assert emb_row is not None, "tag_embeddings row should be created"
            assert emb_row[0] == "cohere-embed-v4"
            assert emb_row[1] == 1536

    def test_sweep_failure_does_not_abort_tick(self, clean_db, monkeypatch):
        """If embed_one (Bedrock) fails, the sweep logs + continues; the tick
        still completes (returns to the caller, does not raise)."""
        import worker.main as main_mod

        def boom(text):
            raise RuntimeError("Bedrock unavailable")

        monkeypatch.setattr("worker.stages.embed_tags.embed_one", boom)

        with psycopg.connect(clean_db) as conn:
            conn.execute(
                """INSERT INTO tags (facet, value_id, taxonomy_version, needs_reembed)
                   VALUES ('topic', '__sweep_fail__', 'v1', true)""",
            )
            conn.commit()

        # Must not raise
        main_mod._embed_sweep_tick()

        # Tag still has needs_reembed=true (sweep failed, flag NOT cleared)
        with psycopg.connect(clean_db) as conn:
            row = conn.execute(
                "SELECT needs_reembed FROM tags WHERE value_id = '__sweep_fail__'"
            ).fetchone()
            assert row[0] is True, (
                "needs_reembed should remain true when Bedrock fails"
            )
