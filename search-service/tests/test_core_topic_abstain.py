"""Slice 6 (#356): corpus-coverage abstain gate (design 2026-08-26).

The abstain signal is corpus vocabulary membership of the query's core noun
phrase (extracted by the LLM sidecar). The negatives d8/d9/d10 all have core
terms absent from titles/tags/aliases (0 hits); every positive has >=1. The
reranker can't see this (scores generic-topic noise as high as real positives).
This is deterministic + failure-soft: no core_topic (LLM off/degraded) or DB
error -> no abstain (today's behavior).
"""
import pytest

import app.main as _main


def test_core_topic_in_corpus_none_or_blank_returns_true(monkeypatch):
    """No core topic extracted -> can't abstain -> today's behavior (return docs)."""
    assert _main.core_topic_in_corpus(None) is True
    assert _main.core_topic_in_corpus("") is True
    assert _main.core_topic_in_corpus("   ") is True


def test_core_topic_in_corpus_db_failure_returns_true(monkeypatch):
    """A DB outage must never abstain — degrade to today's behavior."""
    def _boom():
        raise RuntimeError("db down")
    monkeypatch.setattr("app.db.get_pool", _boom)
    assert _main.core_topic_in_corpus("nuclear microreactors") is True


def test_core_topic_in_corpus_present_returns_true(monkeypatch):
    """Core topic present in titles -> not off-topic."""
    class _Conn:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def execute(self, sql, params):
            class _R:
                def fetchone(self): return (True,)
            return _R()
    class _Pool:
        def connection(self): return _Conn()
    monkeypatch.setattr("app.db.get_pool", lambda: _Pool())
    assert _main.core_topic_in_corpus("hydrogen") is True


def test_core_topic_in_corpus_absent_returns_false(monkeypatch):
    """Core topic absent from titles/tags/aliases -> off-topic (abstain)."""
    class _Conn:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def execute(self, sql, params):
            class _R:
                def fetchone(self): return (False,)
            return _R()
    class _Pool:
        def connection(self): return _Conn()
    monkeypatch.setattr("app.db.get_pool", lambda: _Pool())
    assert _main.core_topic_in_corpus("nuclear microreactors") is False

# ci: force retrigger


def test_core_topic_long_phrase_matches_via_2gram(monkeypatch):
    """A long core_topic whose full phrase misses titles but a contiguous
    2-gram hits -> not off-topic. Catches the false abstention on d1
    ('zero-emission heavy-duty truck adoption' full-misses, but
    'zero-emission heavy-duty' hits). Proves the 2-gram split is what finds
    the hit: the full phrase and single words all return False; only the
    'zero-emission heavy-duty' 2-gram returns True."""
    seen = []
    class _Conn:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def execute(self, sql, params):
            seen.append(params[0])
            class _R:
                def fetchone(self): return (True,) if params[0] == "%zero-emission heavy-duty%" else (False,)
            return _R()
    class _Pool:
        def connection(self): return _Conn()
    monkeypatch.setattr("app.db.get_pool", lambda: _Pool())
    assert _main.core_topic_in_corpus("zero-emission heavy-duty truck adoption") is True
    # the full phrase was tried first (and missed)
    assert any(t == "%zero-emission heavy-duty truck adoption%" for t in seen)
    # a single-word-only query would have missed (sanity: the split is load-bearing)
    assert not all(t in ("zero-emission", "heavy-duty", "truck", "adoption") for t in seen)


def test_core_topic_single_word_matches_whole_word(monkeypatch):
    """A single-word core_topic (e.g. "hydrogen") matches as itself."""
    seen = []
    class _Conn:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def execute(self, sql, params):
            seen.append(params[0])
            class _R:
                def fetchone(self): return (True,) if params[0] == "%hydrogen%" else (False,)
            return _R()
    class _Pool:
        def connection(self): return _Conn()
    monkeypatch.setattr("app.db.get_pool", lambda: _Pool())
    assert _main.core_topic_in_corpus("hydrogen") is True
    assert seen == ["%hydrogen%"]  # single word -> only itself, no 2-grams


def test_multi_word_negative_not_rescued_by_single_words(monkeypatch):
    """A multi-word negative's single words (e.g. "urban" in "urban vertical
    farming") are generic corpus noise and must NOT rescue the abstain. Only
    the full phrase + 2-grams are checked; single words are not."""
    seen = []
    class _Conn:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def execute(self, sql, params):
            seen.append(params[0])
            class _R:
                def fetchone(self): return (False,)  # nothing hits (the negative)
            return _R()
    class _Pool:
        def connection(self): return _Conn()
    monkeypatch.setattr("app.db.get_pool", lambda: _Pool())
    assert _main.core_topic_in_corpus("urban vertical farming") is False
    # the candidates are the full phrase + 2-grams only, NOT the single words
    assert "%urban%" not in seen
    assert "%vertical%" not in seen
    assert "%farming%" not in seen
