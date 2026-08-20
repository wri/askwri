"""classify: retrieve-then-classify for the topic facet; enum for others.

Uses a UUID-suffixed scratch DB: a session-scoped fixture creates it, applies
TypeORM migrations, and drops it after. embed_one and chat_json are
monkeypatched so tests are hermetic.
"""
import os
import subprocess
import uuid

import psycopg
import pytest

from tests.conftest import _check_db_required

_check_db_required()

pytestmark = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="DATABASE_URL not set — skipping classify topic integration tests",
)

_SUPERDB_URL = "postgresql://askwri:password@localhost:5432/postgres"
_TEST_DB = f"askwri_classify_{uuid.uuid4().hex[:12]}"
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

    def test_topic_schema_caps_llm_selection_at_five(self):
        from worker.stages.classify import _facet_schema

        schema = _facet_schema("topic", ["forests", "water"], 5)

        assert schema["properties"]["topic"]["maxItems"] == 5

    def test_reclassification_corrects_only_llm_topic_rows(
        self, clean_db, monkeypatch, caplog
    ):
        """A successful topic response replaces the prior LLM-owned topic set.

        The first five unique valid picks win. Existing selected LLM rows are
        refreshed, omitted LLM topic rows are removed, and protected/non-topic
        assignments survive unchanged.
        """
        import logging

        import worker.stages.classify as classify_mod

        with psycopg.connect(clean_db) as conn:
            topic_ids = {
                f"topic-{index}": _make_topic_tag(
                    conn,
                    f"topic-{index}",
                    description="Primary candidate" if index == 0 else None,
                    aliases=["first alias"] if index == 0 else None,
                )
                for index in range(8)
            }
            for tag_id in topic_ids.values():
                _insert_tag_embedding(conn, tag_id)
            non_topic_id = _make_other_facet_tag(conn, "doc_type", "report")
            doc_id = _insert_document(
                conn,
                external_id="corrective",
                title="Corrective classification",
            )
            conn.execute(
                """INSERT INTO document_tags
                       (document_id, tag_id, source, confidence, model_version, status)
                   VALUES
                       (%s, %s, 'llm', 0.11, 'old-model', 'suggested'),
                       (%s, %s, 'llm', 0.77, 'old-model', 'accepted'),
                       (%s, %s, 'human', 0.99, 'manual', 'accepted'),
                       (%s, %s, 'external', 0.98, 'external-feed', 'accepted'),
                       (%s, %s, 'llm', 0.66, 'old-model', 'suggested')""",
                (
                    doc_id,
                    topic_ids["topic-0"],
                    doc_id,
                    topic_ids["topic-6"],
                    doc_id,
                    topic_ids["topic-1"],
                    doc_id,
                    topic_ids["topic-7"],
                    doc_id,
                    non_topic_id,
                ),
            )
            conn.commit()

        monkeypatch.setattr(classify_mod, "embed_one", lambda text: [0.1] * 1536)
        monkeypatch.setattr(classify_mod, "sweep_pending", lambda conn: 0)
        monkeypatch.setattr(
            classify_mod.get_settings(), "worker_llm_model", "test-new-model"
        )
        captured = {}

        def fake_chat_json(system, user, schema, model, max_tokens=1500):
            captured.update(user=user, schema=schema)
            return {
                "topic": [
                    {"value": "topic-0", "confidence": 0.91},
                    {"value": "topic-0", "confidence": 0.12},
                    {"value": "topic-1", "confidence": 0.88},
                    {"value": "topic-2", "confidence": 0.81},
                    {"value": "topic-3", "confidence": 0.71},
                    {"value": "topic-4", "confidence": 0.61},
                    {"value": "topic-5", "confidence": 0.99},
                ]
            }

        monkeypatch.setattr(classify_mod, "chat_json", fake_chat_json)

        with caplog.at_level(logging.INFO, logger=classify_mod.__name__):
            classify_mod.run(doc_id, topic_only=True)

        with psycopg.connect(clean_db) as conn:
            stale_llm_row = conn.execute(
                "SELECT 1 FROM document_tags WHERE document_id=%s AND tag_id=%s",
                (doc_id, topic_ids["topic-6"]),
            ).fetchone()
            refreshed = conn.execute(
                """SELECT source, confidence::float, model_version, status
                   FROM document_tags WHERE document_id=%s AND tag_id=%s""",
                (doc_id, topic_ids["topic-0"]),
            ).fetchone()
            protected_human = conn.execute(
                """SELECT source, confidence::float, model_version
                   FROM document_tags WHERE document_id=%s AND tag_id=%s""",
                (doc_id, topic_ids["topic-1"]),
            ).fetchone()
            protected_external = conn.execute(
                "SELECT source FROM document_tags WHERE document_id=%s AND tag_id=%s",
                (doc_id, topic_ids["topic-7"]),
            ).fetchone()
            truncated = conn.execute(
                "SELECT 1 FROM document_tags WHERE document_id=%s AND tag_id=%s",
                (doc_id, topic_ids["topic-5"]),
            ).fetchone()
            non_topic = conn.execute(
                """SELECT source, confidence::float, model_version
                   FROM document_tags WHERE document_id=%s AND tag_id=%s""",
                (doc_id, non_topic_id),
            ).fetchone()
            selected_llm_topics = {
                row[0]
                for row in conn.execute(
                    """SELECT dt.tag_id
                       FROM document_tags dt
                       JOIN tags t ON t.id=dt.tag_id
                       WHERE dt.document_id=%s
                         AND dt.source='llm'
                         AND t.facet='topic'
                         AND t.taxonomy_version='v1'""",
                    (doc_id,),
                ).fetchall()
            }

        assert stale_llm_row is None
        assert refreshed == ("llm", pytest.approx(0.91), "test-new-model", "accepted")
        assert protected_human == ("human", pytest.approx(0.99), "manual")
        assert protected_external == ("external",)
        assert truncated is None
        assert non_topic == ("llm", pytest.approx(0.66), "old-model")
        assert selected_llm_topics == {
            topic_ids["topic-0"],
            topic_ids["topic-2"],
            topic_ids["topic-3"],
            topic_ids["topic-4"],
        }
        assert captured["schema"]["properties"]["topic"]["maxItems"] == 5
        assert "- topic-0 (aka: first alias; Primary candidate)" in captured["user"]
        assert "(; " not in captured["user"]
        candidate_log = "\n".join(caplog.messages)
        assert str(topic_ids["topic-0"]) in candidate_log
        assert "label=topic-0" in candidate_log
        assert "cosine_distance=" in candidate_log

    @pytest.mark.parametrize("llm_behavior", ["raises", "malformed"])
    def test_failed_or_malformed_llm_output_preserves_existing_llm_topics(
        self, clean_db, monkeypatch, llm_behavior
    ):
        """No corrective mutation occurs until the complete response is valid."""
        import worker.stages.classify as classify_mod

        with psycopg.connect(clean_db) as conn:
            forests = _make_topic_tag(conn, "forests")
            water = _make_topic_tag(conn, "water")
            _insert_tag_embedding(conn, forests)
            _insert_tag_embedding(conn, water)
            doc_id = _insert_document(
                conn,
                external_id=f"safe-{llm_behavior}",
                title="Preserve prior topic assignments",
            )
            conn.execute(
                """INSERT INTO document_tags
                       (document_id, tag_id, source, confidence, model_version, status)
                   VALUES
                       (%s, %s, 'llm', 0.81, 'prior-model', 'accepted'),
                       (%s, %s, 'llm', 0.62, 'prior-model', 'suggested')""",
                (doc_id, forests, doc_id, water),
            )
            conn.commit()

        monkeypatch.setattr(classify_mod, "embed_one", lambda text: [0.1] * 1536)
        monkeypatch.setattr(classify_mod, "sweep_pending", lambda conn: 0)

        def fake_chat_json(*args, **kwargs):
            if llm_behavior == "raises":
                raise RuntimeError("LLM unavailable")
            return {}  # missing required topic array

        monkeypatch.setattr(classify_mod, "chat_json", fake_chat_json)

        with pytest.raises(RuntimeError):
            classify_mod.run(doc_id, topic_only=True)

        with psycopg.connect(clean_db) as conn:
            rows = conn.execute(
                """SELECT tag_id, confidence::float, model_version, status
                   FROM document_tags
                   WHERE document_id=%s AND source='llm'
                   ORDER BY tag_id""",
                (doc_id,),
            ).fetchall()

        rows_by_tag = {row[0]: row[1:] for row in rows}
        assert rows_by_tag == {
            forests: (pytest.approx(0.81), "prior-model", "accepted"),
            water: (pytest.approx(0.62), "prior-model", "suggested"),
        }

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

    def test_empty_topic_candidates_continue_non_topic_classification(
        self, clean_db, monkeypatch
    ):
        """Normal ingest skips missing topic candidates but writes other facets."""
        import worker.stages.classify as classify_mod

        with psycopg.connect(clean_db) as conn:
            tag1 = _make_topic_tag(conn, "forests")
            tag2 = _make_topic_tag(conn, "water")
            report_tag = _make_other_facet_tag(conn, "doc_type", "report")
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
            assert set(schema["properties"]) == {"doc_type"}
            return {"doc_type": [{"value": "report", "confidence": 0.86}]}

        monkeypatch.setattr(classify_mod, "chat_json", fake_chat_json)

        # Should not raise
        result = classify_mod.run(doc_id)
        assert result is None
        assert call_count[0] == 1

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
            report = conn.execute(
                """SELECT source, confidence::float, status
                   FROM document_tags WHERE document_id=%s AND tag_id=%s""",
                (doc_id, report_tag),
            ).fetchone()
            assert report == ("llm", pytest.approx(0.86), "accepted")

    def test_topic_only_empty_candidates_raises_retryable_error(
        self, clean_db, monkeypatch
    ):
        """A reclassification cannot silently succeed without topic candidates."""
        import worker.stages.classify as classify_mod

        with psycopg.connect(clean_db) as conn:
            _make_topic_tag(conn, "forests")
            doc_id = _insert_document(
                conn,
                external_id="topic-only-empty",
                title="No candidate embeddings",
            )
            conn.commit()

        monkeypatch.setattr(classify_mod, "embed_one", lambda text: [0.1] * 1536)
        monkeypatch.setattr(classify_mod, "sweep_pending", lambda conn: 0)
        monkeypatch.setattr(
            classify_mod,
            "chat_json",
            lambda *args, **kwargs: pytest.fail("LLM must not run without candidates"),
        )

        with pytest.raises(RuntimeError, match="no candidate topic"):
            classify_mod.run(doc_id, topic_only=True)

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


class TestClassifyGeographyFacet:
    """Geography flows through the same retrieve-then-classify path as topic,
    gated by EMBEDDED_FACETS, and is isolated by facet in the delete/insert."""

    def test_run_facets_geography_writes_geography_only(self, clean_db, monkeypatch):
        """run(doc_id, facets=['geography']) classifies the geography facet only —
        geography tag written, topic untouched, exactly 1 LLM call."""
        import worker.stages.classify as classify_mod

        with psycopg.connect(clean_db) as conn:
            tag_kenya = _make_other_facet_tag(conn, "geography", "Kenya")
            tag_forests = _make_topic_tag(conn, "forests")
            _insert_tag_embedding(conn, tag_kenya)
            _insert_tag_embedding(conn, tag_forests)
            doc_id = _insert_document(
                conn, external_id="geo-doc", title="Kenya NDC analysis",
                text="Content about Kenyan climate policy.",
            )
            conn.commit()

        monkeypatch.setattr(classify_mod, "embed_one", lambda text: [0.1] * 1536)
        monkeypatch.setattr(classify_mod, "sweep_pending", lambda conn: 0)

        chat_calls = [0]

        def fake_chat_json(system, user, schema, model, max_tokens=1500):
            chat_calls[0] += 1
            assert "geography" in schema.get("properties", {}), \
                "schema must target the geography facet"
            assert schema["properties"]["geography"]["maxItems"] == 10
            return {"geography": [{"value": "Kenya", "confidence": 0.9}]}

        monkeypatch.setattr(classify_mod, "chat_json", fake_chat_json)

        classify_mod.run(doc_id, facets=["geography"])

        assert chat_calls[0] == 1, f"expected 1 geography LLM call, got {chat_calls[0]}"

        with psycopg.connect(clean_db) as conn:
            kenya_row = conn.execute(
                "SELECT status FROM document_tags WHERE document_id=%s AND tag_id=%s",
                (doc_id, tag_kenya),
            ).fetchone()
            assert kenya_row is not None, "geography tag should be written"
            assert kenya_row[0] == "accepted"

            forests_row = conn.execute(
                "SELECT 1 FROM document_tags WHERE document_id=%s AND tag_id=%s",
                (doc_id, tag_forests),
            ).fetchone()
            assert forests_row is None, "topic tag must NOT be written with facets=['geography']"
