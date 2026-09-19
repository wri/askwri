"""Unit tests for scripts/sweep_translation_pairs.py. Hermetic — no DB.

The sweep is idempotent (pairs with any existing relation row are skipped inside
relate.suggest_for_document) and dry-run-by-default. These tests pin the two
safety properties: a dry run scores but writes nothing, and --execute drives
every active doc through suggest_for_document.
"""
from scripts import sweep_translation_pairs as sweep


class _StubCursor:
    def __init__(self, rows):
        self._rows = rows

    def __iter__(self):
        return iter(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _StubConn:
    def __init__(self, rows=()):
        self._rows = rows
        self.queries = []
        self.commits = 0

    def execute(self, sql, params=None):
        self.queries.append((" ".join(sql.split()), params))
        return _StubCursor(self._rows)

    def commit(self):
        self.commits += 1

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Pool:
    def __init__(self, conn):
        self._conn = conn

    def connection(self):
        return self._conn

    def close(self):
        pass


def test_dry_run_counts_candidates_and_writes_nothing(monkeypatch):
    rows = [("id-1",), ("id-2",), ("id-3",)]
    conn = _StubConn(rows)
    monkeypatch.setattr(sweep, "get_pool", lambda: _Pool(conn))

    count_calls = []
    suggest_calls = []
    monkeypatch.setattr(
        sweep.relate, "count_candidates", lambda c, d: count_calls.append(d) or 0
    )
    monkeypatch.setattr(
        sweep.relate, "suggest_for_document", lambda c, d: suggest_calls.append(d) or 0
    )

    sweep.run()  # dry run

    assert count_calls == ["id-1", "id-2", "id-3"], "dry run scores every active doc"
    assert suggest_calls == [], "dry run must not call suggest_for_document"
    assert conn.commits == 0, "dry run must not commit"
    assert not any("INSERT" in q for q, _ in conn.queries), "dry run must not write"


def test_execute_iterates_every_active_doc_through_suggest(monkeypatch):
    rows = [("id-1",), ("id-2",), ("id-3",)]
    conn = _StubConn(rows)
    monkeypatch.setattr(sweep, "get_pool", lambda: _Pool(conn))

    count_calls = []
    suggest_calls = []
    monkeypatch.setattr(
        sweep.relate, "count_candidates", lambda c, d: count_calls.append(d) or 0
    )
    monkeypatch.setattr(
        sweep.relate, "suggest_for_document", lambda c, d: suggest_calls.append(d) or 1
    )

    total = sweep.run(execute=True)

    assert suggest_calls == ["id-1", "id-2", "id-3"], (
        "execute must call suggest_for_document for every active doc"
    )
    assert count_calls == [], "execute must not call count_candidates"
    assert conn.commits == 3, "execute must commit once per doc"
    assert total == 3


def test_limit_caps_the_swept_doc_list(monkeypatch):
    rows = [("id-1",), ("id-2",), ("id-3",), ("id-4",)]
    conn = _StubConn(rows)
    monkeypatch.setattr(sweep, "get_pool", lambda: _Pool(conn))

    count_calls = []
    monkeypatch.setattr(
        sweep.relate, "count_candidates", lambda c, d: count_calls.append(d) or 0
    )
    monkeypatch.setattr(sweep.relate, "suggest_for_document", lambda c, d: 0)

    sweep.run(limit=2)

    assert count_calls == ["id-1", "id-2"], "limit caps the swept doc list"
