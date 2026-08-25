"""DB-gated tests for the model-aware dense lane (v3 B1).

Scratch-DB pattern from test_sparse_retriever.py. Seeds a mixed corpus —
one doc on cohere-embed-v4 rows and one still on text-embedding-3-small
(both 1536-d; coexistence during the cutover window) — and verifies the
dense lane retrieves ONLY rows of the configured model. The sparse lane is
UNCHANGED in v3 and keeps its own coverage in test_sparse_retriever.py.
"""
import os
import subprocess

import psycopg
import pytest
from llama_index.core.schema import QueryBundle

from tests.conftest import _check_db_required

_check_db_required()
pytestmark = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="DATABASE_URL not set — skipping cohere dense retriever tests",
)

_SUPERDB_URL = "postgresql://askwri:password@localhost:5432/postgres"
_TEST_DB = "askwri_coheredense_test"
_TEST_DB_URL = f"postgresql://askwri:password@localhost:5432/{_TEST_DB}"
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_NEW = "00000000-0000-0000-0000-00000000000d"
_OLD = "00000000-0000-0000-0000-00000000000e"


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
def cohere_test_db():
    # Restore the pre-test DATABASE_URL on teardown: leaving the env pointed
    # at a dropped scratch DB breaks later @requires_db tests in the session.
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


def _unit_vec(hot_index, dim=1536):
    v = ["0"] * dim
    v[hot_index] = "1"
    return "[" + ",".join(v) + "]"


@pytest.fixture(scope="module")
def seeded(cohere_test_db):
    """doc_new on cohere-embed-v4 (2 chunks, unit vectors on axes 0/1);
    doc_old on text-embedding-3-small (unit vector on axis 0)."""
    from app.db import get_pool
    with get_pool().connection() as conn:
        conn.execute(
            f"""INSERT INTO documents (id, external_id, s3_key, title, status, language)
               VALUES ('{_NEW}', 'doc_new', 'documents/n.pdf', 'N', 'searchable', 'zh'),
                      ('{_OLD}', 'doc_old', 'documents/o.pdf', 'O', 'searchable', 'en')"""
        )
        conn.execute(
            f"""INSERT INTO document_chunks
                 (document_id, legacy_chunk_id, chunk_index, text, node_metadata,
                  corpus_order, embedding, embedding_model, dimension)
               VALUES
                 ('{_NEW}', 'doc_new_chunk_0', 0, 'N0', '{{}}', 0,
                  '{_unit_vec(0)}'::vector, 'cohere-embed-v4', 1536),
                 ('{_NEW}', 'doc_new_chunk_1', 1, 'N1', '{{}}', 1,
                  '{_unit_vec(1)}'::vector, 'cohere-embed-v4', 1536),
                 ('{_OLD}', 'doc_old_chunk_0', 0, 'O0', '{{}}', 2,
                  '{_unit_vec(0)}'::vector, 'text-embedding-3-small', 1536)"""
        )
    yield


class _StubDenseAdapter:
    def get_query_embedding(self, query):
        v = [0.0] * 1536
        v[0] = 1.0
        return v


def test_dense_lane_cohere_returns_only_cohere_rows(seeded, monkeypatch):
    from app.config import get_settings
    monkeypatch.setenv("EMBEDDING_MODEL", "cohere-embed-v4")
    get_settings.cache_clear()

    from app.pg_store import PgVectorRetriever
    r = PgVectorRetriever(embed_model=_StubDenseAdapter(), similarity_top_k=10)
    out = r._retrieve(QueryBundle(query_str="whatever"))
    ids = [n.node.node_id for n in out]

    assert ids[0] == "doc_new_chunk_0"          # cosine 1.0 along axis 0
    assert out[0].score == pytest.approx(1.0)
    assert "doc_old_chunk_0" not in ids          # other model excluded
    assert set(ids) == {"doc_new_chunk_0", "doc_new_chunk_1"}


def test_dense_lane_legacy_rollback_returns_only_3small_rows(seeded, monkeypatch):
    from app.config import get_settings
    monkeypatch.setenv("EMBEDDING_MODEL", "text-embedding-3-small")
    get_settings.cache_clear()

    from app.pg_store import PgVectorRetriever
    r = PgVectorRetriever(embed_model=_StubDenseAdapter(), similarity_top_k=10)
    out = r._retrieve(QueryBundle(query_str="whatever"))
    ids = [n.node.node_id for n in out]

    assert ids == ["doc_old_chunk_0"]
