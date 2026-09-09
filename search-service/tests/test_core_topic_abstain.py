"""Slice 6 (#356): corpus-coverage abstain gate (design 2026-08-26).

The abstain signal is corpus vocabulary membership of the query's core noun
phrase (extracted by the LLM sidecar). The negatives d8/d9/d10 all have core
terms absent from titles/tags/aliases (0 hits); every positive has >=1. The
reranker can't see this (scores generic-topic noise as high as real positives).
This is deterministic + failure-soft: no core_topic (LLM off/degraded) or DB
error -> no abstain (today's behavior).

Workbench (2026-09-09): the check returns its decision plus details —
{present, matched_term, matched_surface} — so debug.abstention on the query
response explains exactly why a flag fired. Design:
docs/superpowers/specs/2026-09-09-abstention-workbench-design.md
"""
import pytest

import app.main as _main


def _pool_for(matcher):
    """A pool whose connection's execute(sql, params).fetchone() returns
    matcher(params) — simulating whatever the DB would answer."""

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            pass

        def execute(self, sql, params):
            class _R:
                def fetchone(self):
                    return matcher(params)

            return _R()

    class _Pool:
        def connection(self):
            return _Conn()

    return _Pool()


def test_no_core_topic_cannot_abstain():
    """No core topic extracted -> can't abstain -> today's behavior (return docs)."""
    for blank in (None, "", "   "):
        r = _main.core_topic_in_corpus(blank)
        assert r == {"present": True, "matched_term": None, "matched_surface": None}


def test_db_failure_never_abstains(monkeypatch):
    """A DB outage must never abstain — degrade to today's behavior."""
    def _boom():
        raise RuntimeError("db down")
    monkeypatch.setattr("app.db.get_pool", _boom)
    r = _main.core_topic_in_corpus("nuclear microreactors")
    assert r == {"present": True, "matched_term": None, "matched_surface": None}


def test_present_reports_term_and_surface(monkeypatch):
    """Present in titles -> not off-topic, and the details say WHICH term
    matched on WHICH surface (the one-call repro for false flags)."""
    def matcher(params):
        return ("title",) if params[0] == "%hydrogen%" else None
    monkeypatch.setattr("app.db.get_pool", lambda: _pool_for(matcher))
    r = _main.core_topic_in_corpus("hydrogen")
    assert r == {"present": True, "matched_term": "hydrogen", "matched_surface": "title"}


def test_absent_reports_false_with_no_details(monkeypatch):
    """Core topic absent from titles/tags/aliases -> off-topic (abstain)."""
    def matcher(params):
        return None
    monkeypatch.setattr("app.db.get_pool", lambda: _pool_for(matcher))
    r = _main.core_topic_in_corpus("nuclear microreactors")
    assert r == {"present": False, "matched_term": None, "matched_surface": None}


def test_long_phrase_matches_via_2gram_and_reports_it(monkeypatch):
    """A long core_topic whose full phrase misses titles but a contiguous
    2-gram hits -> not off-topic, matched_term is the 2-gram that hit.
    Catches the false abstention on d1 ('zero-emission heavy-duty truck
    adoption' full-misses, 'zero-emission heavy-duty' hits)."""
    seen = []

    def matcher(params):
        seen.append(params[0])
        return ("title_en",) if params[0] == "%zero-emission heavy-duty%" else None

    monkeypatch.setattr("app.db.get_pool", lambda: _pool_for(matcher))
    r = _main.core_topic_in_corpus("zero-emission heavy-duty truck adoption")
    assert r == {
        "present": True,
        "matched_term": "zero-emission heavy-duty",
        "matched_surface": "title_en",
    }
    # the full phrase was tried first (and missed)
    assert any(t == "%zero-emission heavy-duty truck adoption%" for t in seen)
    # single words are not candidates (the split is load-bearing)
    assert not all(
        t in ("%zero-emission%", "%heavy-duty%", "%truck%", "%adoption%") for t in seen
    )


def test_single_word_matches_as_itself(monkeypatch):
    """A single-word core_topic (e.g. "hydrogen") matches as itself, no 2-grams."""
    seen = []

    def matcher(params):
        seen.append(params[0])
        return ("tag",) if params[0] == "%hydrogen%" else None

    monkeypatch.setattr("app.db.get_pool", lambda: _pool_for(matcher))
    r = _main.core_topic_in_corpus("hydrogen")
    assert r == {"present": True, "matched_term": "hydrogen", "matched_surface": "tag"}
    assert seen == ["%hydrogen%"]  # single word -> only itself


def test_alias_surface_reported(monkeypatch):
    """A match on the alias arm is reported as surface='alias' — the surface
    label distinguishes tag-taxonomy rescues from title hits."""
    def matcher(params):
        # params[3] is the alias arm of the probe SQL
        return ("alias",) if params[3] == "%vertical farming%" else None
    monkeypatch.setattr("app.db.get_pool", lambda: _pool_for(matcher))
    r = _main.core_topic_in_corpus("vertical farming")
    assert r == {"present": True, "matched_term": "vertical farming", "matched_surface": "alias"}


def test_multi_word_negative_not_rescued_by_single_words(monkeypatch):
    """A multi-word negative's single words (e.g. "urban" in "urban vertical
    farming") are generic corpus noise and must NOT rescue the abstain. Only
    the full phrase + 2-grams are candidates; single words are not."""
    seen = []

    def matcher(params):
        seen.append(params[0])
        return None  # nothing hits (the negative)

    monkeypatch.setattr("app.db.get_pool", lambda: _pool_for(matcher))
    r = _main.core_topic_in_corpus("urban vertical farming")
    assert r["present"] is False
    # the candidates are the full phrase + 2-grams only, NOT the single words
    assert "%urban%" not in seen
    assert "%vertical%" not in seen
    assert "%farming%" not in seen
