"""classify: retrieve-then-classify for the topic facet; enum for others.

Uses the same scratch-DB pattern as test_embed_tags.py: a session-scoped
fixture creates askwri_classify_test, applies TypeORM migrations, and drops
it after. embed_one and chat_json are monkeypatched so tests are hermetic.
"""
import os
import subprocess

import psycopg
import pytest

from tests.conftest import _check_db_required

_check_db_required()

pytestmark = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="DATABASE_URL not set — skipping classify topic integration tests",
)

_SUPERDB_URL = "postgresql://askwri:password@localhost:5432/postgres"
_TEST_DB = "askwri_classify_test"
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
def classify_test_db():
    """Create askwri_classify_test, apply migrations, yield URL, then drop."""
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
def clean_db(classify_test_db):
    """Truncate tables and reset app state before each test."""
    _reset_app_state(classify_test_db)
    with psycopg.connect(classify_test_db) as conn:
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
    yield classify_test_db
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

def _make_topic_tag(conn, label, description=None, aliases=None):
    """Insert a topic tag + optional aliases; return the tag id."""
    row = conn.execute(
        """INSERT INTO tags (facet, value_id, taxonomy_version, description, needs_reembed)
           VALUES ('topic', %s, 'v1', %s, false) RETURNING id""",
        (label, description),
    ).fetchone()
    tag_id = row[0]
    for alias in (aliases or []):
        conn.execute(
            "INSERT INTO tag_aliases (tag_id, alias) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (tag_id, alias),
        )
    return tag_id


def _make_other_facet_tag(conn, facet, value_id):
    """Insert a non-topic tag (e.g. program, office, doc_type)."""
    row = conn.execute(
        """INSERT INTO tags (facet, value_id, taxonomy_version)
           VALUES (%s, %s, 'v1') RETURNING id""",
        (facet, value_id),
    ).fetchone()
    return row[0]


def _insert_tag_embedding(conn, tag_id, vec=None):
    """Insert a tag_embeddings row with a dummy vector."""
    if vec is None:
        vec = [0.1] * 1536
    # psycopg needs the vector as a string for pgvector
    vec_str = "[" + ",".join(str(v) for v in vec) + "]"
    conn.execute(
        """INSERT INTO tag_embeddings (tag_id, embedding_model, dimension, embedding, embedded_text, embedded_at)
           VALUES (%s, 'cohere-embed-v4', 1536, %s::vector, 'test', now())""",
        (tag_id, vec_str),
    )


def _insert_document(conn, *, external_id="classify-doc", title="Test Doc", text="Some content."):
    """Insert a document + document_texts row; return doc id."""
    from psycopg.types.json import Jsonb
    row = conn.execute(
        """INSERT INTO documents (external_id, s3_key, title, status, content_hash, language, languages, metadata_source)
           VALUES (%s, %s, %s, 'draft', 'abc123', 'en', ARRAY['en'], %s)
           RETURNING id""",
        (external_id, f"documents/{external_id}.pdf", title, Jsonb({})),
    ).fetchone()
    doc_id = row[0]
    conn.execute(
        """INSERT INTO document_texts (document_id, full_text, char_count, page_boundaries)
           VALUES (%s, %s, %s, '[]'::jsonb)""",
        (doc_id, text, len(text)),
    )
    conn.commit()
    return doc_id


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestClassifyTopicRetrieveThenClassify:

    def test_picks_top5_and_preserves_human(self, clean_db, monkeypatch):
        """Topic retrieve-then-classify: embed_one returns a vector, chat_json
        returns a candidate tag with confidence 0.8 → status='accepted'.
        A pre-existing source='human' row on another candidate is NOT overwritten."""
        import worker.stages.classify as classify_mod

        with psycopg.connect(clean_db) as conn:
            tag_forests = _make_topic_tag(conn, "forests", description="Forest ecosystems")
            tag_water = _make_topic_tag(conn, "water", description="Water resources")
            _insert_tag_embedding(conn, tag_forests)
            _insert_tag_embedding(conn, tag_water)

            doc_id = _insert_document(
                conn, external_id="cls1", title="Forest Report",
                text="Full text about forests and water.",
            )

            # Pre-insert a human row on 'water' — must NOT be overwritten
            conn.execute(
                """INSERT INTO document_tags (document_id, tag_id, source, confidence, model_version, status)
                   VALUES (%s, %s, 'human', 0.99, 'manual', 'accepted')""",
                (doc_id, tag_water),
            )
            conn.commit()

        # Monkeypatch embed_one to return a dummy vector (avoid Bedrock)
        monkeypatch.setattr(classify_mod, "embed_one", lambda text: [0.1] * 1536)

        # Monkeypatch chat_json: LLM returns 'forests' with 0.8 confidence
        call_count = [0]

        def fake_chat_json(system, user, schema, model, max_tokens=1500):
            call_count[0] += 1
            # The schema for topic is {topic: [{value: enum, confidence}]}
            return {"topic": [{"value": "forests", "confidence": 0.8}]}

        monkeypatch.setattr(classify_mod, "chat_json", fake_chat_json)

        classify_mod.run(doc_id)

        assert call_count[0] == 1, f"Expected 1 LLM call for topic, got {call_count[0]}"

        with psycopg.connect(clean_db) as conn:
            # forests: should have an llm row, status=accepted (0.8 >= 0.7)
            forests_row = conn.execute(
                "SELECT source, confidence::float, status FROM document_tags WHERE document_id=%s AND tag_id=%s",
                (doc_id, tag_forests),
            ).fetchone()
            assert forests_row is not None, "forests tag should be written"
            assert forests_row[0] == "llm"
            assert abs(forests_row[1] - 0.8) < 0.001
            assert forests_row[2] == "accepted"

            # water: human row must be unchanged
            water_row = conn.execute(
                "SELECT source, confidence::float, model_version FROM document_tags WHERE document_id=%s AND tag_id=%s",
                (doc_id, tag_water),
            ).fetchone()
            assert water_row is not None
            assert water_row[0] == "human", "human row must not be overwritten"
            assert abs(water_row[1] - 0.99) < 0.001
            assert water_row[2] == "manual"

    def test_empty_embeddings_skips_topic_no_error(self, clean_db, monkeypatch):
        """No tag_embeddings rows → topic facet is skipped (log warning), no error.
        No document_tags rows written for topic."""
        import worker.stages.classify as classify_mod

        with psycopg.connect(clean_db) as conn:
            tag1 = _make_topic_tag(conn, "forests")
            tag2 = _make_topic_tag(conn, "water")
            # NO tag_embeddings inserted

            doc_id = _insert_document(
                conn, external_id="cls2", title="Empty Embed Doc",
                text="Content with no embeddings.",
            )
            conn.commit()

        monkeypatch.setattr(classify_mod, "embed_one", lambda text: [0.1] * 1536)

        call_count = [0]

        def fake_chat_json(system, user, schema, model, max_tokens=1500):
            call_count[0] += 1
            return {}

        monkeypatch.setattr(classify_mod, "chat_json", fake_chat_json)

        # Should not raise
        result = classify_mod.run(doc_id)
        assert result is None

        # Topic facet was skipped — 0 LLM calls for topic
        # (might be 0 total if only topic, or 1 if non-topic facets exist)
        with psycopg.connect(clean_db) as conn:
            topic_count = conn.execute(
                """SELECT count(*) FROM document_tags dt
                   JOIN tags t ON t.id = dt.tag_id
                   WHERE dt.document_id = %s AND t.facet = 'topic'""",
                (doc_id,),
            ).fetchone()[0]
            assert topic_count == 0, "no topic tags should be written without embeddings"

    def test_topic_only_skips_non_topic_facets(self, clean_db, monkeypatch):
        """run(document_id, topic_only=True) → only the topic LLM call runs;
        non-topic facets are skipped (no enum call for program/office/doc_type)."""
        import worker.stages.classify as classify_mod

        with psycopg.connect(clean_db) as conn:
            tag_forests = _make_topic_tag(conn, "forests")
            tag_report = _make_other_facet_tag(conn, "doc_type", "report")
            _insert_tag_embedding(conn, tag_forests)

            doc_id = _insert_document(
                conn, external_id="cls3", title="Topic Only Doc",
                text="Content about forests.",
            )
            conn.commit()

        monkeypatch.setattr(classify_mod, "embed_one", lambda text: [0.1] * 1536)

        chat_calls = [0]

        def fake_chat_json(system, user, schema, model, max_tokens=1500):
            chat_calls[0] += 1
            # Inspect the schema to determine which facet is being classified
            if "topic" in schema.get("properties", {}):
                return {"topic": [{"value": "forests", "confidence": 0.9}]}
            return {}

        monkeypatch.setattr(classify_mod, "chat_json", fake_chat_json)

        classify_mod.run(doc_id, topic_only=True)

        assert chat_calls[0] == 1, (
            f"topic_only=True should make exactly 1 LLM call (topic only), got {chat_calls[0]}"
        )

        with psycopg.connect(clean_db) as conn:
            # forests (topic) should be written
            forests_row = conn.execute(
                "SELECT status FROM document_tags WHERE document_id=%s AND tag_id=%s",
                (doc_id, tag_forests),
            ).fetchone()
            assert forests_row is not None, "topic tag should be written"
            assert forests_row[0] == "accepted"

            # report (doc_type) should NOT be written
            report_row = conn.execute(
                "SELECT 1 FROM document_tags WHERE document_id=%s AND tag_id=%s",
                (doc_id, tag_report),
            ).fetchone()
            assert report_row is None, "doc_type tag should NOT be written with topic_only=True"
