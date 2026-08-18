"""embed_tags: build/maintain tag_embeddings from label + aliases + description.

Uses the same scratch-DB pattern as test_worker_stages.py: a session-scoped
fixture creates askwri_embed_test, applies TypeORM migrations, and drops it
after. This gives us a real tag_embeddings table (pgvector) + tags with the
new columns (parent_tag_id, description, needs_reembed) from migration
1787160000000.
"""
import os
import subprocess

import psycopg
import pytest

from tests.conftest import _check_db_required

_check_db_required()

pytestmark = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="DATABASE_URL not set — skipping embed_tags integration tests",
)

_SUPERDB_URL = "postgresql://askwri:password@localhost:5432/postgres"
_TEST_DB = "askwri_embed_test"
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
def embed_test_db():
    """Create askwri_embed_test, apply migrations, yield URL, then drop.

    Saves and restores the original DATABASE_URL so other test modules that
    depend on the real qa DB aren't affected by our scratch DB.
    """
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

    # Restore the original DATABASE_URL before dropping the scratch DB
    # so other test modules (test_pg_store.py) can use the real qa DB.
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
def clean_db(embed_test_db):
    """Truncate tables and reset app state before each test."""
    _reset_app_state(embed_test_db)
    with psycopg.connect(embed_test_db) as conn:
        conn.execute("TRUNCATE audit_log CASCADE")
        conn.execute("TRUNCATE reclassify_jobs CASCADE")
        conn.execute("TRUNCATE document_tags CASCADE")
        conn.execute("TRUNCATE tag_aliases CASCADE")
        conn.execute("TRUNCATE tag_embeddings CASCADE")
        conn.execute("TRUNCATE tags CASCADE")
        conn.execute("TRUNCATE documents CASCADE")
        conn.commit()
    yield embed_test_db
    # Restore original DATABASE_URL so other test modules aren't affected
    _orig_db_url = os.environ.get("DATABASE_URL")
    import app.db as _db
    if _db._pool is not None:
        try:
            _db._pool.close()
        except Exception:
            pass
    _db._pool = None
    from app.config import get_settings
    get_settings.cache_clear()


def _make_topic_tag(conn, label, description=None, aliases=None, parent_id=None):
    """Insert a topic tag + optional aliases; return the tag id."""
    row = conn.execute(
        """INSERT INTO tags (facet, value_id, taxonomy_version, description, parent_tag_id, needs_reembed)
           VALUES ('topic', %s, 'v1', %s, %s, false) RETURNING id""",
        (label, description, parent_id),
    ).fetchone()
    tag_id = row[0]
    for alias in (aliases or []):
        conn.execute(
            "INSERT INTO tag_aliases (tag_id, alias) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (tag_id, alias),
        )
    return tag_id


class TestEmbedTag:

    def test_embed_tag_upserts_and_clears_flag(self, clean_db, monkeypatch):
        """embed_tag composes label+aliases+description, embeds, UPSERTs into
        tag_embeddings, and clears needs_reembed."""
        import worker.stages.embed_tags as mod

        # Stub embed_one to avoid a real Bedrock call
        monkeypatch.setattr(mod, "embed_one", lambda text: [0.1] * 1536)

        with psycopg.connect(clean_db) as conn:
            tag_id = _make_topic_tag(
                conn,
                label="Coal",
                description="Fossil fuel used for energy",
                aliases=["Coal Power", "Thermal Coal"],
            )
            # Set needs_reembed=true to verify it gets cleared
            conn.execute(
                "UPDATE tags SET needs_reembed = true WHERE id = %s", (tag_id,)
            )
            conn.commit()

            mod.embed_tag(conn, tag_id)
            conn.commit()

            row = conn.execute(
                """SELECT te.embedding_model, te.dimension, te.embedded_text,
                          t.needs_reembed
                   FROM tag_embeddings te
                   JOIN tags t ON t.id = te.tag_id
                   WHERE te.tag_id = %s""",
                (tag_id,),
            ).fetchone()

            assert row is not None, "tag_embeddings row should exist"
            assert row[0] == "cohere-embed-v4"
            assert row[1] == 1536
            # embedded_text should contain label + aliases (pipe-joined) + description
            assert "Coal" in row[2]
            assert "Coal Power" in row[2]
            assert "Thermal Coal" in row[2]
            assert "Fossil fuel used for energy" in row[2]
            assert "|" in row[2], "aliases should be pipe-joined"
            assert row[3] is False, "needs_reembed should be cleared"

    def test_embed_tag_label_only(self, clean_db, monkeypatch):
        """A tag with just a label (no aliases/description) embeds the label alone."""
        import worker.stages.embed_tags as mod

        monkeypatch.setattr(mod, "embed_one", lambda text: [0.1] * 1536)

        with psycopg.connect(clean_db) as conn:
            tag_id = _make_topic_tag(conn, label="Accessibility")
            conn.commit()

            mod.embed_tag(conn, tag_id)
            conn.commit()

            row = conn.execute(
                "SELECT embedded_text FROM tag_embeddings WHERE tag_id = %s",
                (tag_id,),
            ).fetchone()
            assert row is not None
            assert row[0] == "Accessibility", "label-only should embed just the label"

    def test_embed_tag_upsert_replaces_existing(self, clean_db, monkeypatch):
        """Calling embed_tag on a tag that already has an embedding replaces it."""
        import worker.stages.embed_tags as mod

        call_count = [0]

        def fake_embed(text):
            call_count[0] += 1
            return [float(call_count[0])] * 1536

        monkeypatch.setattr(mod, "embed_one", fake_embed)

        with psycopg.connect(clean_db) as conn:
            tag_id = _make_topic_tag(conn, label="Climate", description="v1 desc")
            conn.commit()

            # First call
            mod.embed_tag(conn, tag_id)
            conn.commit()
            row1 = conn.execute(
                "SELECT embedded_text FROM tag_embeddings WHERE tag_id = %s",
                (tag_id,),
            ).fetchone()
            assert "v1 desc" in row1[0]

            # Second call with updated description
            conn.execute(
                "UPDATE tags SET description = 'v2 desc' WHERE id = %s", (tag_id,)
            )
            conn.commit()
            mod.embed_tag(conn, tag_id)
            conn.commit()
            row2 = conn.execute(
                "SELECT embedded_text FROM tag_embeddings WHERE tag_id = %s",
                (tag_id,),
            ).fetchone()
            assert "v2 desc" in row2[0]
            assert "v1 desc" not in row2[0]


class TestSweepPending:

    def test_sweep_pending_processes_needs_reembed(self, clean_db, monkeypatch):
        """sweep_pending finds tags with needs_reembed=true, embeds them, clears the flag."""
        import worker.stages.embed_tags as mod

        monkeypatch.setattr(mod, "embed_one", lambda text: [0.1] * 1536)

        with psycopg.connect(clean_db) as conn:
            tag1 = _make_topic_tag(conn, label="Coal")
            tag2 = _make_topic_tag(conn, label="Climate")
            tag3 = _make_topic_tag(conn, label="Accessibility")
            # Mark two as needing re-embed
            conn.execute("UPDATE tags SET needs_reembed = true WHERE id IN (%s, %s)", (tag1, tag2))
            conn.commit()

            n = mod.sweep_pending(conn, batch_size=10)
            conn.commit()

            assert n == 2, f"sweep should process 2 tags, got {n}"

            # Both should have embeddings + flag cleared
            for tid in (tag1, tag2):
                emb = conn.execute(
                    "SELECT 1 FROM tag_embeddings WHERE tag_id = %s", (tid,)
                ).fetchone()
                assert emb is not None, f"tag {tid} should have an embedding"
                flag = conn.execute(
                    "SELECT needs_reembed FROM tags WHERE id = %s", (tid,)
                ).fetchone()
                assert flag[0] is False, f"tag {tid} needs_reembed should be cleared"

            # tag3 should NOT have an embedding (wasn't marked)
            emb3 = conn.execute(
                "SELECT 1 FROM tag_embeddings WHERE tag_id = %s", (tag3,)
            ).fetchone()
            assert emb3 is None, "tag3 should not have an embedding"


class TestBuildAllEmbeddings:

    def test_build_all_embeds_tags_without_rows(self, clean_db, monkeypatch):
        """build_all_embeddings finds topic tags with no tag_embeddings row and embeds them."""
        import worker.stages.embed_tags as mod

        monkeypatch.setattr(mod, "embed_one", lambda text: [0.1] * 1536)

        with psycopg.connect(clean_db) as conn:
            tag1 = _make_topic_tag(conn, label="Coal")
            tag2 = _make_topic_tag(conn, label="Climate")
            conn.commit()

            # Pre-embed tag1 so build_all should skip it
            mod.embed_tag(conn, tag1)
            conn.commit()

            n = mod.build_all_embeddings(conn, batch_size=10)
            conn.commit()

            assert n == 1, f"build_all should embed 1 new tag, got {n}"

            # tag2 should now have an embedding
            emb2 = conn.execute(
                "SELECT 1 FROM tag_embeddings WHERE tag_id = %s", (tag2,)
            ).fetchone()
            assert emb2 is not None, "tag2 should have an embedding after build_all"
