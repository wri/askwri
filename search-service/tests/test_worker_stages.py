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

def _insert_document_with_lang(conn, *, external_id, language, languages, title="Test Title"):
    """Insert a documents row with language/languages set; return id."""
    row = conn.execute(
        """INSERT INTO documents
               (external_id, s3_key, title, status, content_hash, language, languages)
           VALUES (%s, %s, %s, 'draft', 'abc123', %s, %s)
           RETURNING id""",
        (external_id, f"documents/{external_id}.pdf", title, language, languages),
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
            calls.append({"system": system, "user": user, "model": model, "n": n})
            return {"long": f"Long summary call {n}.", "short": f"Short {n}."}

        return fake

    def test_zh_document_produces_four_rows_and_title_en(
        self, stages_test_db, monkeypatch
    ):
        """zh document → 4 summary rows (zh long/short + en long/short),
        all source='generated'; title_en set; exactly 2 LLM calls."""
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

        assert len(calls) == 2, f"Expected 2 LLM calls, got {len(calls)}"

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

            title_en = conn.execute(
                "SELECT title_en FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()[0]
            assert title_en is not None, "title_en should be set for non-English document"

    def test_en_document_produces_two_rows_no_title_en(
        self, stages_test_db, monkeypatch
    ):
        """en document → 2 rows (en long/short); 1 LLM call; title_en untouched (NULL)."""
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
            assert title_en is None, "title_en should remain NULL for English document"

    def test_idempotent_rerun_no_extra_rows_no_extra_calls(
        self, stages_test_db, monkeypatch
    ):
        """Running summarize twice → same row count; second run makes 0 LLM calls."""
        calls = []
        monkeypatch.setattr("worker.stages.summarize.chat_json", self._make_fake_llm(calls))

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_document_with_lang(
                conn, external_id="idem-doc", language="en", languages=["en"], title="Idempotent"
            )
            _insert_document_text(conn, doc_id, text="Some text for idempotency check.")

        from worker.stages.summarize import run
        run(doc_id)
        first_call_count = len(calls)

        run(doc_id)
        second_call_count = len(calls) - first_call_count

        assert second_call_count == 0, f"Second run should make 0 LLM calls, got {second_call_count}"

        with psycopg.connect(stages_test_db) as conn:
            count = conn.execute(
                "SELECT count(*) FROM document_summaries WHERE document_id=%s", (doc_id,)
            ).fetchone()[0]
            assert count == 2, f"Should still have exactly 2 rows after two runs, got {count}"

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


class TestPublishStage:

    def test_high_density_doc_becomes_searchable(self, stages_test_db, monkeypatch):
        """High-quality en doc → status='searchable', extraction_confidence >= 0.7, returns None.

        Arithmetic:
          char_count=1000, pages=2 → chars/page=500
          density = min(500/200, 1.0) = 1.0
          language 'en' ∈ SUPPORTED → 0.3
          chunks present → 0.3
          score = 0.4*1.0 + 0.3 + 0.3 = 1.0 >= 0.7 → searchable
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
        assert row[0] == "searchable", f"Expected 'searchable', got '{row[0]}'"
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
        """A withdrawn document is never flipped back to searchable by publish:
        the status UPDATE matches 0 rows, publishing is skipped, stage returns None."""
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

    def test_reindex_failure_does_not_fail_stage(self, stages_test_db, monkeypatch):
        """/reindex POST failure (closed port) does not raise; stage still returns None and searchable.

        Arithmetic (same as high-density test):
          char_count=1000, pages=2 → score=1.0 >= 0.7 → searchable
        """
        monkeypatch.setenv("SEARCH_SERVICE_URL", "http://127.0.0.1:1")

        with psycopg.connect(stages_test_db) as conn:
            doc_id = _insert_publish_document(conn, external_id="pub-reindex", language="en")
            _insert_document_texts_for_publish(conn, doc_id, char_count=1000, pages=2)
            _insert_chunk_for_publish(conn, doc_id, external_id="pub-reindex")

        from worker.stages.publish import run
        result = run(doc_id)
        assert result is None

        with psycopg.connect(stages_test_db) as conn:
            status = conn.execute(
                "SELECT status FROM documents WHERE id=%s", (doc_id,)
            ).fetchone()[0]
        assert status == "searchable", f"Expected 'searchable' despite /reindex failure, got '{status}'"
