"""Unit tests for app/translation_pairs.py. Hermetic — no DB (stub pool)."""
from app.config import get_settings
from app import translation_pairs as tp


class _StubCursor:
    def __init__(self, rows):
        self._rows = rows

    def __iter__(self):
        return iter(self._rows)


class _StubConn:
    def __init__(self, rows):
        self._rows = rows

    def execute(self, sql, params=None):
        return _StubCursor(self._rows)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Pool:
    def __init__(self, conn):
        self._conn = conn
        self.called = False

    def connection(self):
        self.called = True
        return self._conn

    def close(self):
        pass


def test_flag_off_returns_empty_without_querying(monkeypatch):
    monkeypatch.delenv("TRANSLATION_PAIRS_ENABLED", raising=False)
    get_settings.cache_clear()
    pool = _Pool(_StubConn([]))
    monkeypatch.setattr(tp, "get_pool", lambda: pool)

    assert tp.load_confirmed_pairs() == {}
    assert pool.called is False, "flag off must not touch the DB"


def test_flag_on_maps_confirmed_pairs(monkeypatch):
    monkeypatch.setenv("TRANSLATION_PAIRS_ENABLED", "true")
    get_settings.cache_clear()
    rows = [
        ("t1", "o1", "Original Title", True),
        ("t2", "o2", "Withdrawn Original", False),  # original withdrawn
    ]
    pool = _Pool(_StubConn(rows))
    monkeypatch.setattr(tp, "get_pool", lambda: pool)

    pairs = tp.load_confirmed_pairs()

    assert pairs == {
        "t1": {"original": "o1", "original_title": "Original Title", "original_searchable": True},
        "t2": {"original": "o2", "original_title": "Withdrawn Original", "original_searchable": False},
    }
