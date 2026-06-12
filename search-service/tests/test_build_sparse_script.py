"""DB-gated tests for scripts/build_sparse_keyword.py against a scratch database.

Hermetic pattern from test_sparse_retriever.py: scratch DB askwri_buildsparse_test,
TypeORM migrations via subprocess, app.db pool reset. Never touches qa.

Covers:
- backfill spans ALL document statuses (a needs_review doc gets sparse vectors
  now, so it is keyword-ready the moment it is promoted later)
- refresh keeps token_ids stable for existing tokens (UPDATE-existing path)
- refresh burns ~zero identity values (INSERT-only-missing anti-join)
"""
import os
import subprocess

import psycopg
import pytest

from tests.conftest import _check_db_required

_check_db_required()
pytestmark = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="DATABASE_URL not set — skipping build_sparse_keyword script tests",
)

_SUPERDB_URL = "postgresql://askwri:password@localhost:5432/postgres"
_TEST_DB = "askwri_buildsparse_test"
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
def build_test_db():
    original_db_url = os.environ.get("DATABASE_URL", "")
    with psycopg.connect(_SUPERDB_URL, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {_TEST_DB}")
        conn.execute(f"CREATE DATABASE {_TEST_DB}")
    env = {**os.environ, "DATABASE_URL": _TEST_DB_URL, "DATABASE_SSL": "false"}
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
    # This module runs first alphabetically — point later modules back at the
    # original database instead of the dropped scratch DB.
    _reset_app_state(original_db_url)


@pytest.fixture(scope="module")
def seeded(build_test_db):
    """One searchable doc and one needs_review doc, one chunk each."""
    with psycopg.connect(build_test_db) as conn:
        conn.execute(
            """INSERT INTO documents (id, external_id, s3_key, title, status, language)
               VALUES ('00000000-0000-0000-0000-000000000001', 'doc_s',
                       'documents/doc_s.pdf', 'S', 'searchable', 'en'),
                      ('00000000-0000-0000-0000-000000000002', 'doc_r',
                       'documents/doc_r.pdf', 'R', 'needs_review', 'en')"""
        )
        conn.execute(
            """INSERT INTO document_chunks
                 (document_id, legacy_chunk_id, chunk_index, text, node_metadata, corpus_order)
               VALUES
                 ('00000000-0000-0000-0000-000000000001', 'doc_s_chunk_0', 0,
                  'sustainable transport corridors reduce emissions in bogota', '{}', 0),
                 ('00000000-0000-0000-0000-000000000002', 'doc_r_chunk_0', 0,
                  'mangrove restoration finance unlocks coastal resilience in jakarta', '{}', 1)"""
        )
    yield build_test_db


def test_backfill_covers_all_statuses_and_refresh_is_identity_stable(seeded):
    from scripts.build_sparse_keyword import main as build_main

    # First run: backfill
    build_main()
    with psycopg.connect(seeded) as conn:
        sparse_by_chunk = dict(
            conn.execute("SELECT legacy_chunk_id, sparse FROM document_chunks").fetchall()
        )
        vocab_first = dict(
            conn.execute("SELECT token, token_id FROM keyword_vocab").fetchall()
        )
    assert sparse_by_chunk["doc_s_chunk_0"] is not None
    assert sparse_by_chunk["doc_r_chunk_0"] is not None, (
        "needs_review doc chunks must be backfilled too — keyword-ready on promote"
    )
    assert vocab_first, "vocab should be populated by the backfill"
    max_first = max(vocab_first.values())

    # Second run: refresh
    build_main()
    with psycopg.connect(seeded) as conn:
        vocab_second = dict(
            conn.execute("SELECT token, token_id FROM keyword_vocab").fetchall()
        )
        # Sentinel: next identity value reveals whether the refresh burned ids
        sentinel_id = conn.execute(
            """INSERT INTO keyword_vocab (token, df, idf)
               VALUES ('zzz_refresh_sentinel', 1, 1.0) RETURNING token_id"""
        ).fetchone()[0]

    assert vocab_second == vocab_first, "token_ids must be stable across refreshes"
    assert sentinel_id == max_first + 1, (
        f"identity sequence advanced from {max_first} to {sentinel_id - 1} without "
        "inserting rows — the refresh upsert burned identity values"
    )
