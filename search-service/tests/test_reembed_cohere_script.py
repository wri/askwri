"""DB-gated tests for scripts/reembed_cohere.py against a scratch database.

Hermetic pattern from test_sparse_retriever.py. The re-embed is IN PLACE and
DENSE-ONLY (v3: re-embed, not re-ingest; sparse lane untouched): chunk rows
keep legacy ids, text, node_metadata, corpus_order AND their bm25 sparse
vectors; only embedding/embedding_model/dimension change. Bedrock is stubbed.
"""
import os
import subprocess

import psycopg
import pytest

from tests.conftest import _check_db_required

_check_db_required()
pytestmark = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="DATABASE_URL not set — skipping reembed script tests",
)

_SUPERDB_URL = "postgresql://askwri:password@localhost:5432/postgres"
_TEST_DB = "askwri_reembed_test"
_TEST_DB_URL = f"postgresql://askwri:password@localhost:5432/{_TEST_DB}"
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_DOC_A = "00000000-0000-0000-0000-0000000000a1"
_DOC_B = "00000000-0000-0000-0000-0000000000b1"
_COLL = "00000000-0000-0000-0000-0000000000c1"


def _reset_app_state(db_url):
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


@pytest.fixture(scope="module")
def reembed_test_db():
    orig_db_url = os.environ.get("DATABASE_URL")
    with psycopg.connect(_SUPERDB_URL, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {_TEST_DB}")
        conn.execute(f"CREATE DATABASE {_TEST_DB}")
    env = {**os.environ, "DATABASE_URL": _TEST_DB_URL}
    subprocess.run(
        ["npm", "run", "migration:run"], cwd=_REPO_ROOT, env=env,
        check=True, capture_output=True,
    )
    _reset_app_state(_TEST_DB_URL)

    zero_vec = "[" + ",".join(["0.0"] * 1536) + "]"
    with psycopg.connect(_TEST_DB_URL) as conn:
        conn.execute(
            f"""INSERT INTO documents (id, external_id, s3_key, title, status, language)
               VALUES ('{_DOC_A}', 'doc_a', 'documents/a.pdf', 'A', 'searchable', 'en'),
                      ('{_DOC_B}', 'doc_b', 'documents/b.pdf', 'B', 'needs_review', 'zh')"""
        )
        conn.execute(
            f"""INSERT INTO collections (id, slug, name)
               VALUES ('{_COLL}', 'test-coll', 'Test Collection')"""
        )
        conn.execute(
            f"""INSERT INTO document_collections (document_id, collection_id)
               VALUES ('{_DOC_A}', '{_COLL}')"""
        )
        conn.execute(
            f"""INSERT INTO document_chunks
                 (document_id, legacy_chunk_id, chunk_index, text, node_metadata,
                  corpus_order, embedding, embedding_model, dimension, sparse)
               VALUES
                 ('{_DOC_A}', 'doc_a_chunk_0', 0, 'alpha text', '{{"title": "A Title"}}', 0,
                  '{zero_vec}'::vector, 'text-embedding-3-small', 1536, '{{1:0.5}}/1000000'),
                 ('{_DOC_A}', 'doc_a_chunk_1', 1, 'beta text', '{{"title": "A Title"}}', 1,
                  '{zero_vec}'::vector, 'text-embedding-3-small', 1536, '{{2:0.5}}/1000000'),
                 ('{_DOC_B}', 'doc_b_chunk_0', 0, 'gamma text', '{{"title": "B Title"}}', 2,
                  '{zero_vec}'::vector, 'text-embedding-3-small', 1536, '{{3:0.5}}/1000000')"""
        )
        conn.commit()

    yield _TEST_DB_URL

    import app.db as _db
    if _db._pool is not None:
        _db._pool.close()
        _db._pool = None
    with psycopg.connect(_SUPERDB_URL, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {_TEST_DB} WITH (FORCE)")
    if orig_db_url is not None:
        _reset_app_state(orig_db_url)
    else:
        os.environ.pop("DATABASE_URL", None)
        from app.config import get_settings
        get_settings.cache_clear()


def test_reembed_updates_dense_in_place_sparse_untouched(reembed_test_db, monkeypatch):
    captured = []

    def fake_embed(texts):
        captured.extend(texts)
        return [[0.03] * 1536 for _ in texts]

    import scripts.reembed_cohere as script
    monkeypatch.setattr(script, "_embed", fake_embed)

    stats = script.reembed_all(batch_size=2)

    assert stats["chunks"] == 3
    assert stats["documents"] == 2

    with psycopg.connect(reembed_test_db) as conn:
        rows = conn.execute(
            """SELECT legacy_chunk_id, text, corpus_order, embedding_model,
                      dimension, sparse::text, embedding::vector(1536)::text
               FROM document_chunks ORDER BY corpus_order"""
        ).fetchall()
        coll_version = conn.execute(
            "SELECT embedding_model_version FROM collections WHERE slug='test-coll'"
        ).fetchone()[0]

    # In place: identity columns untouched, all statuses covered
    assert [r[0] for r in rows] == ["doc_a_chunk_0", "doc_a_chunk_1", "doc_b_chunk_0"]
    assert [r[1] for r in rows] == ["alpha text", "beta text", "gamma text"]
    assert [r[2] for r in rows] == [0, 1, 2]
    assert all(r[3] == "cohere-embed-v4" for r in rows)
    assert all(r[4] == 1536 for r in rows)
    assert all(r[6].startswith("[0.03,") for r in rows)
    # SPARSE UNTOUCHED (v3: English bm25 lane unchanged)
    assert [r[5] for r in rows] == ["{1:0.5}/1000000", "{2:0.5}/1000000", "{3:0.5}/1000000"]

    # Encoding sees the EMBED-mode content (metadata prefix + text), exactly
    # what the worker embed stage embeds — not the bare text column.
    assert any("A Title" in t and "alpha text" in t for t in captured)

    # Per-collection cutover marker
    assert coll_version == "cohere-embed-v4"


def test_reembed_is_idempotent(reembed_test_db, monkeypatch):
    def fake_embed(texts):
        return [[0.03] * 1536 for _ in texts]

    import scripts.reembed_cohere as script
    monkeypatch.setattr(script, "_embed", fake_embed)

    stats = script.reembed_all(batch_size=2)
    # Already cohere-embed-v4 → nothing to do unless --force
    assert stats["chunks"] == 0

    stats = script.reembed_all(batch_size=2, force=True)
    assert stats["chunks"] == 3
