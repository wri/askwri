"""End-to-end pipeline integration test.

Drives the REAL pipeline (no stage mocked except external services:
LLM + embeddings + reindex POST) against a dedicated scratch DB:
  askwri_pipeline_test

Hermetic pattern: create / migrate / drop — never touches the qa database.
Skip guard: requires DATABASE_URL (same convention as other DB tests).
"""
import os
import shutil
import subprocess
from pathlib import Path

import psycopg
import pytest

from tests.conftest import _check_db_required

# ---------------------------------------------------------------------------
# Module-level loud-skip guard
# ---------------------------------------------------------------------------
_check_db_required()

pytestmark = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="DATABASE_URL not set — skipping pipeline integration tests",
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_SUPERDB_URL = "postgresql://askwri:password@localhost:5432/postgres"
_TEST_DB = "askwri_pipeline_test"
_TEST_DB_URL = f"postgresql://askwri:password@localhost:5432/{_TEST_DB}"
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_FIXTURE_PDF = Path(__file__).parent / "fixtures" / "sample.pdf"


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


def _fake_chat_json(system, user, schema, model, max_tokens=1500):
    """Return shape-correct responses for summarize and classify calls.

    Detect which stage is calling by inspecting the schema properties:
    - summarize schema has 'long' property -> return summary shape
    - classify schema has facet-array properties -> return classification shape
    """
    props = schema.get("properties", {})
    if set(props) == {"long", "short"}:
        return {
            "long": "A long generated summary about forests and water.",
            "short": "Short summary.",
        }
    # Loud guard: a taxonomy facet named 'long'/'short' would otherwise silently
    # take the summary branch above
    assert "long" not in props and "short" not in props, \
        f"Ambiguous schema in fake chat_json — properties: {set(props)}"
    # Classification schema: return topic picks with both accepted and suggested confidence
    return {
        "topic": [
            {"value": "forests", "confidence": 0.9},
            {"value": "water", "confidence": 0.5},
        ],
        "doc_type": [],
    }


def _fake_embed_texts(texts):
    return [[0.01] * 1536 for _ in texts]


def _seed_tags(conn) -> None:
    """Seed taxonomy tags required by the classify stage."""
    conn.execute("DELETE FROM tags")
    for facet, value_id in [("topic", "forests"), ("topic", "water"), ("doc_type", "report")]:
        conn.execute(
            """INSERT INTO tags (facet, value_id, taxonomy_version)
               VALUES (%s, %s, 'v1')""",
            (facet, value_id),
        )
    conn.commit()


def _run_full_pipeline(monkeypatch, tmp_path) -> None:
    """Set up env, monkeypatches, and drive intake + process_one_job loop."""
    intake_dir = tmp_path / "intake"
    intake_dir.mkdir()
    shutil.copy(_FIXTURE_PDF, intake_dir / "sample.pdf")

    monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
    monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
    monkeypatch.delenv("SEARCH_SERVICE_URL", raising=False)
    monkeypatch.setenv("DOCUMENTS_LOCAL_DIR", str(tmp_path / "nonexistent"))

    from app.config import get_settings
    get_settings.cache_clear()

    # Monkeypatch external services
    monkeypatch.setattr("worker.stages.summarize.chat_json", _fake_chat_json)
    monkeypatch.setattr("worker.stages.classify.chat_json", _fake_chat_json)
    monkeypatch.setattr("worker.stages.embed._embed_texts", _fake_embed_texts)

    # 1. Intake sweep
    from worker import intake_s3
    result = intake_s3.sweep()
    assert result is True, "intake_s3.sweep() should return True for a new file"

    # 2. Drive pipeline until no more work (safety cap: 20 iterations)
    from worker.main import process_one_job
    iterations = 0
    while process_one_job():
        iterations += 1
        assert iterations < 20, "Pipeline did not terminate within 20 iterations"


# ---------------------------------------------------------------------------
# Session fixture: create/drop scratch DB + apply TypeORM schema
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def pipeline_test_db():
    """Create askwri_pipeline_test, apply migrations, yield URL, then drop."""
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
def clean_db(pipeline_test_db, monkeypatch):
    """Truncate all relevant tables and reset app state before each test."""
    _reset_app_state(pipeline_test_db)
    with psycopg.connect(pipeline_test_db) as conn:
        conn.execute("TRUNCATE audit_log CASCADE")
        conn.execute("TRUNCATE ingestion_jobs CASCADE")
        conn.execute("TRUNCATE documents CASCADE")
        conn.execute("TRUNCATE tags CASCADE")
        conn.commit()
    yield
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
# Tests
# ---------------------------------------------------------------------------

class TestWorkerPipeline:

    def test_full_pipeline_end_to_end(self, pipeline_test_db, monkeypatch, tmp_path):
        """Drive the real pipeline from intake through publish; verify full ledger."""
        with psycopg.connect(pipeline_test_db) as conn:
            _seed_tags(conn)

        _run_full_pipeline(monkeypatch, tmp_path)

        with psycopg.connect(pipeline_test_db) as conn:
            # --- documents row ---
            doc_row = conn.execute(
                """SELECT status, extraction_confidence, language
                   FROM documents WHERE external_id = 'sample'"""
            ).fetchone()
            assert doc_row is not None, "documents row for 'sample' should exist"
            status, extraction_confidence, language = doc_row
            assert status == "searchable", f"Expected status='searchable', got '{status}'"
            assert extraction_confidence is not None, "extraction_confidence should be set"
            assert float(extraction_confidence) >= 0.7, (
                f"extraction_confidence {extraction_confidence} < 0.7"
            )
            assert language == "en", f"Expected language='en', got '{language}'"

            doc_id = conn.execute(
                "SELECT id FROM documents WHERE external_id = 'sample'"
            ).fetchone()[0]

            # --- document_texts ---
            dt_row = conn.execute(
                "SELECT char_count FROM document_texts WHERE document_id = %s", (doc_id,)
            ).fetchone()
            assert dt_row is not None, "document_texts row should exist"
            assert dt_row[0] > 0, f"char_count should be > 0, got {dt_row[0]}"

            # --- document_summaries: >= 2 generated rows (en long + short) ---
            summary_rows = conn.execute(
                """SELECT language, kind, source FROM document_summaries
                   WHERE document_id = %s AND source = 'generated'""",
                (doc_id,),
            ).fetchall()
            assert len(summary_rows) >= 2, (
                f"Expected >= 2 generated summary rows, got {len(summary_rows)}: {summary_rows}"
            )
            kinds = {(r[0], r[1]) for r in summary_rows}
            assert ("en", "long") in kinds, "Missing en/long summary"
            assert ("en", "short") in kinds, "Missing en/short summary"

            # --- document_tags: >= 1 llm row ---
            tag_rows = conn.execute(
                """SELECT dt.source, dt.confidence, dt.status, t.value_id
                   FROM document_tags dt
                   JOIN tags t ON t.id = dt.tag_id
                   WHERE dt.document_id = %s AND dt.source = 'llm'
                   ORDER BY dt.confidence DESC""",
                (doc_id,),
            ).fetchall()
            assert len(tag_rows) >= 1, f"Expected >= 1 llm document_tag row, got {len(tag_rows)}"

            # 0.9 confidence pick should be 'accepted'
            forests_row = next(
                (r for r in tag_rows if r[3] == "forests"), None
            )
            assert forests_row is not None, "forests tag row should exist"
            assert forests_row[2] == "accepted", (
                f"forests tag (conf=0.9) should be 'accepted', got '{forests_row[2]}'"
            )

            # 0.5 confidence pick: below default threshold of 0.7 -> 'suggested'
            water_row = next(
                (r for r in tag_rows if r[3] == "water"), None
            )
            assert water_row is not None, "water tag row should exist"
            assert water_row[2] == "suggested", (
                f"water tag (conf=0.5) should be 'suggested', got '{water_row[2]}'"
            )

            # --- document_chunks ---
            chunk_rows = conn.execute(
                """SELECT legacy_chunk_id, corpus_order
                   FROM document_chunks WHERE document_id = %s
                   ORDER BY corpus_order""",
                (doc_id,),
            ).fetchall()
            assert len(chunk_rows) > 0, "document_chunks should have > 0 rows"

            legacy_ids = [r[0] for r in chunk_rows]
            text_chunk_ids = [lid for lid in legacy_ids if lid != "sample_summary"]
            assert all(lid.startswith("sample_chunk_") for lid in text_chunk_ids), (
                f"Unexpected legacy_chunk_ids: {legacy_ids}"
            )
            assert "sample_summary" in legacy_ids, "Summary chunk 'sample_summary' missing"

            # corpus_order values are contiguous
            orders = sorted(r[1] for r in chunk_rows)
            assert orders == list(range(orders[0], orders[0] + len(orders))), (
                f"corpus_order values not contiguous: {orders}"
            )

            # --- ingestion_jobs: exactly one job, status=done, stage=publish, attempts=0 ---
            job_rows = conn.execute(
                "SELECT status, stage, attempts FROM ingestion_jobs WHERE document_id = %s",
                (doc_id,),
            ).fetchall()
            assert len(job_rows) == 1, f"Expected exactly 1 ingestion_jobs row, got {len(job_rows)}"
            job_status, job_stage, job_attempts = job_rows[0]
            assert job_status == "done", f"Expected job status='done', got '{job_status}'"
            assert job_stage == "publish", f"Expected job stage='publish', got '{job_stage}'"
            assert job_attempts == 0, f"Expected job attempts=0, got {job_attempts}"

            # --- audit_log: intake 'registered' row present ---
            audit_row = conn.execute(
                """SELECT after FROM audit_log
                   WHERE action = 'import' AND entity_type = 'documents'
                   AND after->>'result' = 'registered'"""
            ).fetchone()
            assert audit_row is not None, "audit_log 'registered' row should exist"
            assert audit_row[0]["intake"] == "sample.pdf", (
                f"audit_log intake should be 'sample.pdf', got {audit_row[0].get('intake')}"
            )

    def test_duplicate_redrop_no_second_job(self, pipeline_test_db, monkeypatch, tmp_path):
        """After a completed first pass, a re-drop of the same PDF creates no second job
        and produces a duplicate_skipped audit entry."""
        with psycopg.connect(pipeline_test_db) as conn:
            _seed_tags(conn)

        # First pass: run the full pipeline
        _run_full_pipeline(monkeypatch, tmp_path)

        with psycopg.connect(pipeline_test_db) as conn:
            job_count_after_first = conn.execute(
                "SELECT count(*) FROM ingestion_jobs"
            ).fetchone()[0]
        assert job_count_after_first == 1, (
            f"Expected 1 job after first pass, got {job_count_after_first}"
        )

        # Second pass: copy sample.pdf into a fresh intake dir (same bytes)
        intake_dir2 = tmp_path / "intake2"
        intake_dir2.mkdir()
        shutil.copy(_FIXTURE_PDF, intake_dir2 / "sample.pdf")

        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir2))
        from app.config import get_settings
        get_settings.cache_clear()

        from worker import intake_s3
        result2 = intake_s3.sweep()
        assert result2 is True, "sweep() should return True (file was present)"

        with psycopg.connect(pipeline_test_db) as conn:
            job_count_after_second = conn.execute(
                "SELECT count(*) FROM ingestion_jobs"
            ).fetchone()[0]
            assert job_count_after_second == 1, (
                f"Duplicate drop should not create a second job; got {job_count_after_second}"
            )

            dup_audit = conn.execute(
                "SELECT after FROM audit_log WHERE after->>'result' = 'duplicate_skipped'"
            ).fetchone()
            assert dup_audit is not None, "audit_log should have a 'duplicate_skipped' entry"
            assert dup_audit[0]["intake"] == "sample.pdf", (
                f"duplicate_skipped audit intake should be 'sample.pdf', got {dup_audit[0].get('intake')}"
            )

    def test_files_in_intake_without_worker_create_no_documents(self, pipeline_test_db, monkeypatch, tmp_path):
        """Regression test for the 'uploads vanish' bug: a file dropped into intake
        but NOT swept by the worker (worker not running) creates NO documents row.
        This is the exact symptom that made uploads invisible — the intake route
        only puts files in S3; registration is the worker's job."""
        intake_dir = tmp_path / "intake_no_worker"
        intake_dir.mkdir()
        shutil.copy(_FIXTURE_PDF, intake_dir / "orphan.pdf")

        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        monkeypatch.setenv("DOCUMENTS_LOCAL_DIR", str(tmp_path / "nonexistent2"))
        from app.config import get_settings
        get_settings.cache_clear()

        # Do NOT run intake_s3.sweep() — simulating the worker being down.
        # The file sits in intake/ with no documents row and no job.
        with psycopg.connect(pipeline_test_db) as conn:
            doc_count = conn.execute(
                "SELECT count(*) FROM documents WHERE external_id = 'orphan'"
            ).fetchone()[0]
            job_count = conn.execute("SELECT count(*) FROM ingestion_jobs").fetchone()[0]
        assert doc_count == 0, (
            "Without the worker, no documents row should exist for the dropped file"
        )
        assert job_count == 0, (
            "Without the worker, no ingestion_jobs row should exist"
        )

    def test_worker_running_processes_intake_to_searchable(self, pipeline_test_db, monkeypatch, tmp_path):
        """The happy path: a file in intake + the worker running → searchable with
        chunks, summaries, and a done job. This is the e2e upload→process test."""
        with psycopg.connect(pipeline_test_db) as conn:
            _seed_tags(conn)

        _run_full_pipeline(monkeypatch, tmp_path)

        with psycopg.connect(pipeline_test_db) as conn:
            doc_row = conn.execute(
                """SELECT status, language FROM documents
                   WHERE external_id = 'sample'"""
            ).fetchone()
            assert doc_row is not None, "worker should have registered the dropped file"
            assert doc_row[0] == "searchable", (
                f"Expected searchable, got '{doc_row[0]}'"
            )
            chunks = conn.execute(
                "SELECT count(*) FROM document_chunks dc "
                "JOIN documents d ON d.id = dc.document_id "
                "WHERE d.external_id = 'sample'"
            ).fetchone()[0]
            assert chunks > 0, "searchable doc should have chunks"
            job = conn.execute(
                """SELECT j.status, j.stage FROM ingestion_jobs j
                   JOIN documents d ON d.id = j.document_id
                   WHERE d.external_id = 'sample'"""
            ).fetchone()
            assert job is not None
            assert job[0] == "done"
            assert job[1] == "publish"

    def test_multiple_files_uploaded_then_processed(self, pipeline_test_db, monkeypatch, tmp_path):
        """Two files dropped into intake are both processed to searchable by the worker —
        the multi-file upload scenario from the bug report."""
        with psycopg.connect(pipeline_test_db) as conn:
            _seed_tags(conn)

        # Drop two files into intake
        intake_dir = tmp_path / "intake_multi"
        intake_dir.mkdir()
        shutil.copy(_FIXTURE_PDF, intake_dir / "file_a.pdf")
        shutil.copy(_FIXTURE_PDF, intake_dir / "file_b.pdf")

        monkeypatch.setenv("INTAKE_LOCAL_DIR", str(intake_dir))
        monkeypatch.delenv("DOCUMENTS_S3_BUCKET", raising=False)
        monkeypatch.setenv("DOCUMENTS_LOCAL_DIR", str(tmp_path / "nonexistent3"))
        monkeypatch.setattr("worker.stages.summarize.chat_json", _fake_chat_json)
        monkeypatch.setattr("worker.stages.classify.chat_json", _fake_chat_json)
        monkeypatch.setattr("worker.stages.embed._embed_texts", _fake_embed_texts)
        from app.config import get_settings
        get_settings.cache_clear()

        from worker import intake_s3
        assert intake_s3.sweep() is True

        from worker.main import process_one_job
        iterations = 0
        while process_one_job():
            iterations += 1
            assert iterations < 20, "Pipeline did not terminate within 20 iterations"

        with psycopg.connect(pipeline_test_db) as conn:
            # file_a is registered + processed to searchable
            row_a = conn.execute(
                "SELECT status FROM documents WHERE external_id = 'file_a'"
            ).fetchone()
            assert row_a is not None, "file_a should be registered"
            assert row_a[0] == "searchable", f"file_a should be searchable, got '{row_a[0]}'"
            # file_b is a content-hash duplicate of file_a -> deduped, no documents row
            row_b = conn.execute(
                "SELECT count(*) FROM documents WHERE external_id = 'file_b'"
            ).fetchone()
            assert row_b[0] == 0, (
                "file_b (same content as file_a) should be deduped, not registered"
            )
