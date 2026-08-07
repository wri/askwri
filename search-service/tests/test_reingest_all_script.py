"""Unit tests for scripts/reingest_all.py id filtering.

Hermetic — no DB. The script's only DB touch is one SELECT plus one enqueue()
per row, so a stub connection is enough to pin the contract that matters:
which documents get enqueued, and that an explicit id list never widens to
the whole corpus (a full re-parse is a 172-doc Mistral bill).
"""
import pytest

from scripts import reingest_all as ra


class _StubCursor:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class _StubConn:
    """Captures the SELECT the script issues and replays canned rows."""

    def __init__(self, rows):
        self._rows = rows
        self.queries = []

    def execute(self, sql, params=None):
        self.queries.append((" ".join(sql.split()), params))
        return _StubCursor(self._rows)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def stub_pool(monkeypatch):
    """Wire app.db.get_pool + worker.queue.enqueue out of the script."""
    enqueued = []

    def _install(rows):
        conn = _StubConn(rows)

        class _Pool:
            def connection(self):
                return conn

            def close(self):
                pass

        monkeypatch.setattr(ra, "get_pool", lambda: _Pool())
        monkeypatch.setattr(ra, "enqueue", lambda c, doc_id: enqueued.append(doc_id))
        return conn, enqueued

    return _install


def test_reingest_all_enqueues_every_non_withdrawn_doc(stub_pool):
    conn, enqueued = stub_pool([("doc-a",), ("doc-b",)])

    assert ra.reingest_all() == 2
    assert enqueued == ["doc-a", "doc-b"]
    sql, params = conn.queries[0]
    assert "status <> 'withdrawn'" in sql
    assert params is None


def test_reingest_all_with_ids_filters_in_sql(stub_pool):
    """The id list must narrow the SELECT itself, not post-filter in Python —
    otherwise a typo'd id silently re-parses the whole corpus."""
    conn, enqueued = stub_pool([("doc-b",)])

    assert ra.reingest_all(ids=["doc-b"]) == 1
    assert enqueued == ["doc-b"]
    sql, params = conn.queries[0]
    assert "id = ANY(" in sql
    assert params == (["doc-b"],)


def test_reingest_all_with_ids_still_excludes_withdrawn(stub_pool):
    conn, _ = stub_pool([])

    assert ra.reingest_all(ids=["gone"]) == 0
    sql, _params = conn.queries[0]
    assert "status <> 'withdrawn'" in sql


def test_empty_id_list_is_not_treated_as_full_corpus(stub_pool):
    """`--ids ''` must be a no-op, never a 172-doc re-parse."""
    conn, enqueued = stub_pool([("doc-a",), ("doc-b",)])

    assert ra.reingest_all(ids=[]) == 0
    assert enqueued == []
    assert conn.queries == []


def test_parse_args_splits_comma_separated_ids():
    assert ra._parse_args(["--ids", "a,b , c"]).ids == ["a", "b", "c"]


def test_parse_args_defaults_to_full_corpus():
    assert ra._parse_args([]).ids is None
