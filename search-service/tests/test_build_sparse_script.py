"""DB-gated tests for scripts/build_sparse_keyword.py against a scratch database.

Hermetic pattern from test_sparse_retriever.py: scratch DB askwri_buildsparse_test,
TypeORM migrations via subprocess, app.db pool reset. Never touches qa.

Covers:
- backfill spans ALL document statuses (a needs_review doc gets sparse vectors
  now, so it is keyword-ready the moment it is promoted later)
- refresh keeps token_ids stable for existing tokens (UPDATE-existing path)
- refresh burns ~zero identity values (INSERT-only-missing anti-join)
- SPARSE_EN_HANDLES injects English handles into a non-EN doc's sparse
  weights, and flag-off rebuilds are byte-identical (rollback guarantee)
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


_ES_DOC_ID = "00000000-0000-0000-0000-000000000003"


@pytest.fixture(scope="module")
def seeded_es(seeded):
    """A non-EN doc with an English title_en + curated English long summary.

    node_metadata must carry doc_id (handle lookup key) and chunk_index
    (chunk_index == -1 selects the summary chunk) — that is the contract
    scripts/build_sparse_keyword.py relies on for injection.
    """
    with psycopg.connect(seeded) as conn:
        conn.execute(
            """INSERT INTO documents (id, external_id, s3_key, title, status, language, title_en)
               VALUES ('00000000-0000-0000-0000-000000000003', 'doc_es',
                       'documents/doc_es.pdf', 'Índice de Desigualdad', 'searchable', 'es',
                       'Urban Inequality Index')"""
        )
        conn.execute(
            """INSERT INTO document_summaries (document_id, language, kind, text, source)
               VALUES ('00000000-0000-0000-0000-000000000003', 'en', 'long',
                       'Measures unequal access to services.', 'external')"""
        )
        conn.execute(
            """INSERT INTO document_chunks
                 (document_id, legacy_chunk_id, chunk_index, text, node_metadata,
                  corpus_order, unit_type)
               VALUES
                 ('00000000-0000-0000-0000-000000000003', 'doc_es_chunk_0', 0,
                  'el transporte urbano segregado limita el acceso al empleo',
                  '{"doc_id": "doc_es", "title": "Índice de Desigualdad", "chunk_index": 0}',
                  2, 'text'),
                 ('00000000-0000-0000-0000-000000000003', 'doc_es_summary', -1,
                  'resumen del indice de desigualdad urbana',
                  '{"doc_id": "doc_es", "title": "Índice de Desigualdad", "chunk_index": -1}',
                  3, 'summary')"""
        )
    yield seeded


def _sparse_dims(sparse_text):
    """{token_id} from a sparsevec text value '{i:w,i:w}/dim' (1-based indices,
    which equal the DB token_id — see app/sparse_keyword.py's convention note)."""
    body = sparse_text.split("}")[0].lstrip("{")
    return {int(pair.split(":")[0]) for pair in body.split(",") if pair}


def _es_vectors(db_url):
    with psycopg.connect(db_url) as conn:
        return dict(
            conn.execute(
                "SELECT legacy_chunk_id, sparse::text FROM document_chunks "
                "WHERE document_id = %s",
                (_ES_DOC_ID,),
            ).fetchall()
        )


def test_en_handles_injected_when_flag_on_and_rollback_is_byte_identical(
    seeded_es, monkeypatch
):
    """Flag on: the non-EN doc's chunks gain title_en/en_summary tokens.

    Flag off again: the vectors are byte-identical to the flag-off baseline —
    the rollback guarantee the design promises (spec 2026-07-26 §3.2/§3.4).
    """
    from app.config import get_settings
    from scripts.build_sparse_keyword import main as build_main

    # Baseline: flag off (default).
    get_settings.cache_clear()
    build_main()
    base = _es_vectors(seeded_es)
    assert set(base) == {"doc_es_chunk_0", "doc_es_summary"}
    with psycopg.connect(seeded_es) as conn:
        # stemmed 'inequality' / 'unequal' are absent from every seeded chunk
        # text, so they can only appear via handle injection
        assert (
            conn.execute(
                "SELECT count(*) FROM keyword_vocab WHERE token IN ('inequ', 'unequ')"
            ).fetchone()[0]
            == 0
        )

    # Flag on.
    monkeypatch.setenv("SPARSE_EN_HANDLES", "true")
    get_settings.cache_clear()
    build_main()
    with psycopg.connect(seeded_es) as conn:
        vocab = dict(
            conn.execute(
                "SELECT token, token_id FROM keyword_vocab "
                "WHERE token IN ('inequ', 'unequ')"
            ).fetchall()
        )
    assert "inequ" in vocab, "title_en vocabulary must reach every chunk of the doc"
    assert "unequ" in vocab, "the English long summary must reach the summary chunk"
    after = _es_vectors(seeded_es)
    assert after != base

    text_dims = _sparse_dims(after["doc_es_chunk_0"])
    summary_dims = _sparse_dims(after["doc_es_summary"])
    assert vocab["inequ"] in text_dims, (
        "title_en tokens must be weighted into every chunk, including plain text"
    )
    assert vocab["inequ"] in summary_dims
    assert vocab["unequ"] in summary_dims, (
        "the English long summary must be weighted into the summary chunk"
    )
    assert vocab["unequ"] not in text_dims, (
        "the English long summary belongs to the summary chunk only"
    )

    # Rollback: flag off again — byte-identical to the first baseline.
    monkeypatch.delenv("SPARSE_EN_HANDLES")
    get_settings.cache_clear()
    build_main()
    assert _es_vectors(seeded_es) == base
