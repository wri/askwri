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
