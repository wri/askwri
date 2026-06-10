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
        and exactly one document_texts row remains."""
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
