"""DB-gated tests for SparseKeywordRetriever against a scratch database.

Hermetic pattern from test_worker_stages.py: scratch DB askwri_sparse_test,
TypeORM migrations via subprocess, app.db pool reset. Never touches qa.

Verifies numerically: inner-product scoring (and thus the 1-based sparsevec /
0-based SparseVector convention), status filtering, NULL-sparse exclusion,
and corpus_order tie-breaking.
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
    reason="DATABASE_URL not set — skipping sparse retriever tests",
)

_SUPERDB_URL = "postgresql://askwri:password@localhost:5432/postgres"
_TEST_DB = "askwri_sparse_test"
_TEST_DB_URL = f"postgresql://askwri:password@localhost:5432/{_TEST_DB}"
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


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
def sparse_test_db():
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
        ["npm", "run", "migration:run"], cwd=_REPO_ROOT, env=env,
        capture_output=True, text=True,
    )
    assert result.returncode == 0, (
        f"migration:run failed (exit {result.returncode}):\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    _reset_app_state(_TEST_DB_URL)
    yield _TEST_DB_URL
    _reset_app_state(_TEST_DB_URL)
    import app.db as _db
    if _db._pool is not None:
        _db._pool.close()
        _db._pool = None
    with psycopg.connect(_SUPERDB_URL, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {_TEST_DB} WITH (FORCE)")


@pytest.fixture(scope="module")
def seeded(sparse_test_db):
    """Two docs (one searchable, one withdrawn), five chunks.

    Vocab: 'transport'->id 1 (idf 1.0), 'bogota'->id 2 (idf 2.0).
    sparsevec text literals use 1-BASED indices.
    Expected inner products for query 'transport bogota' (counts {1:1, 2:1}):
      doc_a_chunk_0: 0.5*1 + 1.5*1 = 2.0
      doc_a_chunk_1: 0.5
      doc_a_chunk_2: 0.5 (same score, later corpus_order — tie-break check)
      doc_a_chunk_3: sparse NULL — excluded
      doc_w_chunk_0: withdrawn doc — excluded
    """
    from app.db import get_pool
    with get_pool().connection() as conn:
        conn.execute(
            """INSERT INTO documents (id, external_id, s3_key, title, status, language)
               VALUES ('00000000-0000-0000-0000-000000000001', 'doc_a', 'documents/doc_a.pdf', 'A', 'searchable', 'en'),
                      ('00000000-0000-0000-0000-000000000002', 'doc_w', 'documents/doc_w.pdf', 'W', 'withdrawn', 'en')"""
        )
        conn.execute(
            """INSERT INTO keyword_vocab (token, token_id, df, idf)
               OVERRIDING SYSTEM VALUE
               VALUES ('transport', 1, 3, 1.0), ('bogota', 2, 1, 2.0)"""
        )
        conn.execute(
            """INSERT INTO keyword_corpus_stats (id, n_chunks, avgdl, k1, b, sparse_dim)
               VALUES (1, 4, 10.0, 1.5, 0.75, 1000000)"""
        )
        conn.execute(
            """INSERT INTO document_chunks
                 (document_id, legacy_chunk_id, chunk_index, text, node_metadata, corpus_order, sparse)
               VALUES
                 ('00000000-0000-0000-0000-000000000001', 'doc_a_chunk_0', 0, 'A0', '{}', 0,
                  '{1:0.5,2:1.5}/1000000'),
                 ('00000000-0000-0000-0000-000000000001', 'doc_a_chunk_1', 1, 'A1', '{}', 1,
                  '{1:0.5}/1000000'),
                 ('00000000-0000-0000-0000-000000000001', 'doc_a_chunk_2', 2, 'A2', '{}', 2,
                  '{1:0.5}/1000000'),
                 ('00000000-0000-0000-0000-000000000001', 'doc_a_chunk_3', 3, 'A3', '{}', 3, NULL),
                 ('00000000-0000-0000-0000-000000000002', 'doc_w_chunk_0', 0, 'W0', '{}', 4,
                  '{1:9.0,2:9.0}/1000000')"""
        )
    yield


def test_scoring_filtering_and_tiebreak(seeded):
    from app.pg_store import SparseKeywordRetriever
    r = SparseKeywordRetriever(similarity_top_k=10)
    out = r._retrieve(QueryBundle(query_str="transport bogota"))
    ids = [n.node.node_id for n in out]
    scores = {n.node.node_id: n.score for n in out}

    assert "doc_w_chunk_0" not in ids          # withdrawn excluded per query
    assert "doc_a_chunk_3" not in ids          # NULL sparse excluded
    assert ids[0] == "doc_a_chunk_0"
    assert scores["doc_a_chunk_0"] == pytest.approx(2.0)
    assert scores["doc_a_chunk_1"] == pytest.approx(0.5)
    # equal scores resolve by corpus_order
    assert ids[1] == "doc_a_chunk_1" and ids[2] == "doc_a_chunk_2"


def test_oov_query_returns_zero_scores_not_error(seeded):
    from app.pg_store import SparseKeywordRetriever
    r = SparseKeywordRetriever(similarity_top_k=10)
    out = r._retrieve(QueryBundle(query_str="zzznotavocabword"))
    assert len(out) == 3  # all non-NULL searchable chunks, not an empty list
    assert all(n.score == pytest.approx(0.0) for n in out)


def test_stemmed_query_matches_vocab(seeded):
    # 'transports' stems to 'transport' — query-side stemming must hit vocab
    from app.pg_store import SparseKeywordRetriever
    r = SparseKeywordRetriever(similarity_top_k=10)
    out = r._retrieve(QueryBundle(query_str="transports"))
    assert out[0].node.node_id == "doc_a_chunk_0"
    assert out[0].score == pytest.approx(0.5)
