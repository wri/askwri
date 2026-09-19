"""TDD tests for TopicTagRetriever — semantic tag→docs lane source (P2.5 Task 1).

Unit tests stub the pool (SimpleNamespace fakes). The DB test uses the
`requires_db` marker from conftest.py and skips cleanly without DATABASE_URL.
"""
from types import SimpleNamespace

import pytest

from llama_index.core.schema import QueryBundle

from app.topic_retrieval import TopicTagRetriever


class _FakeCursor:
    """Yields configured rows per execute() call, in order."""

    def __init__(self, row_sets):
        # row_sets: list of list[tuple] — one per execute() call.
        self._row_sets = row_sets
        self._call = 0
        self._rows = []

    def execute(self, sql, params=None):
        # Advance to the next configured row set (one per tag query).
        idx = min(self._call, len(self._row_sets) - 1)
        self._rows = self._row_sets[idx]
        self._call += 1
        return self

    def fetchall(self):
        return list(self._rows)


class _FakeConn:
    def __init__(self, row_sets):
        self._cur = _FakeCursor(row_sets)

    def execute(self, sql, params=None):
        return self._cur.execute(sql, params)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakePool:
    """Stub pool: returns a _FakeConn with configured row_sets, or raises."""

    def __init__(self, row_sets=None, raise_exc=None):
        self._row_sets = row_sets
        self._raise = raise_exc
        self.connection_count = 0

    def connection(self):
        self.connection_count += 1
        if self._raise is not None:
            raise self._raise
        return _FakeConn(self._row_sets)


def _bundle():
    return QueryBundle(query_str="climate resilience")


# Row shape: (legacy_chunk_id, text, node_metadata, score) — the 4th
# column is the FINAL score as the DB would compute it (cosine × confidence).
# Unit tests verify pass-through, dedup, top_k, failure-soft; the DB test
# verifies the actual cosine × confidence multiplication.
_ROW = lambda cid, score=1.0: (cid, f"text {cid}", {"ext": cid}, score)


def test_retrieve_returns_docs_for_matched_tags():
    """Stub pool returns 2 rows for tag 'Climate Resilience'; retriever
    returns 2 NodeWithScore, score = the DB-computed cosine × confidence."""
    # DB would compute 0.8×0.9=0.72 and 0.8×0.7=0.56
    pool = _FakePool(row_sets=[[_ROW("c1", 0.72), _ROW("c2", 0.56)]])
    r = TopicTagRetriever([("Climate Resilience", 0.8)], pool)
    out = r._retrieve(_bundle())
    assert len(out) == 2
    assert out[0].score == pytest.approx(0.72)
    assert out[1].score == pytest.approx(0.56)
    # NodeWithScore shape: TextNode with id_, text, metadata
    assert out[0].node.node_id == "c1"
    assert out[0].node.text == "text c1"
    assert out[0].node.metadata == {"ext": "c1"}


def test_dedup_across_tags():
    """Same doc tagged by two matched tags appears once, keeps max score."""
    # Tag 1 → doc "d1" score 0.45; Tag 2 → doc "d1" score 0.56 (max wins)
    pool = _FakePool(row_sets=[[_ROW("d1", 0.45)], [_ROW("d1", 0.56)]])
    r = TopicTagRetriever([("tag1", 0.9), ("tag2", 0.7)], pool)
    out = r._retrieve(_bundle())
    assert len(out) == 1
    assert out[0].node.node_id == "d1"
    assert out[0].score == pytest.approx(0.56)  # max wins


def test_top_k_caps():
    """5 docs, top_k=2 → 2 returned."""
    rows = [_ROW(f"c{i}", 1.0) for i in range(5)]
    pool = _FakePool(row_sets=[rows])
    r = TopicTagRetriever([("tag", 0.5)], pool, top_k=2)
    out = r._retrieve(_bundle())
    assert len(out) == 2


def test_empty_nearby_topics_returns_empty():
    """No tags → no SQL call, returns []."""
    pool = _FakePool(row_sets=[])
    r = TopicTagRetriever([], pool)
    out = r._retrieve(_bundle())
    assert out == []
    assert pool.connection_count == 0


def test_db_failure_returns_empty():
    """pool.connection() raises → returns [], no re-raise (lane drops)."""
    pool = _FakePool(raise_exc=RuntimeError("db down"))
    r = TopicTagRetriever([("tag", 0.8)], pool)
    out = r._retrieve(_bundle())
    assert out == []


# --- DB-backed test (skips cleanly without DATABASE_URL) ---

requires_db = pytest.mark.skipif(
    not __import__("os").getenv("DATABASE_URL"),
    reason="DATABASE_URL not set (needs migrated Postgres)",
)


@requires_db
def test_retrieves_real_docs_for_a_tag():
    """Against local docker: inserts a tag + doc + chunk + document_tag,
    calls retrieve, asserts it gets the chunk back. Cleans up."""
    from app.db import get_pool
    import uuid

    pool = get_pool()
    label = f"test-topic-{uuid.uuid4().hex[:8]}"
    doc_ext = f"test-doc-{uuid.uuid4().hex[:8]}"
    chunk_id = f"test-chunk-{uuid.uuid4().hex[:8]}"

    with pool.connection() as conn:
        # Insert tag
        tag_id = conn.execute(
            "INSERT INTO tags (facet, value_id) VALUES ('topic', %s) "
            "RETURNING id",
            (label,),
        ).fetchone()[0]
        # Insert doc (s3_key is NOT NULL)
        doc_id = conn.execute(
            "INSERT INTO documents (external_id, s3_key, status) "
            "VALUES (%s, %s, 'searchable') RETURNING id",
            (doc_ext, f"test/{doc_ext}.pdf"),
        ).fetchone()[0]
        # Insert chunk (chunk_index=0, the representative)
        conn.execute(
            "INSERT INTO document_chunks "
            "(document_id, legacy_chunk_id, chunk_index, text, node_metadata) "
            "VALUES (%s, %s, 0, %s, '{}'::jsonb)",
            (doc_id, chunk_id, "topic retrieval test text"),
        )
        # Insert document_tag with confidence
        conn.execute(
            "INSERT INTO document_tags (document_id, tag_id, source, confidence) "
            "VALUES (%s, %s, 'llm', 0.85)",
            (doc_id, tag_id),
        )

    try:
        r = TopicTagRetriever([(label, 0.9)], pool, weight_by_confidence=True)
        out = r._retrieve(_bundle())
        ids = [n.node.node_id for n in out]
        assert chunk_id in ids
        for n in out:
            if n.node.node_id == chunk_id:
                assert n.score == pytest.approx(0.9 * 0.85, rel=1e-3)
    finally:
        with pool.connection() as conn:
            conn.execute("DELETE FROM document_tags WHERE tag_id = %s", (tag_id,))
            conn.execute("DELETE FROM document_chunks WHERE document_id = %s", (doc_id,))
            conn.execute("DELETE FROM documents WHERE id = %s", (doc_id,))
            conn.execute("DELETE FROM tags WHERE id = %s", (tag_id,))
