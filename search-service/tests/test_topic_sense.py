"""Topic sensing: pure filtering logic + failure-soft attach + DB smoke.

Invariant 2 (spec §2): topics are model-inferred on BOTH sides — they may
only ever become suggestions, never hard facets. The attach function must
therefore never touch u.facets."""
import os

import pytest

from app.topic_sense import (
    attach_topic_suggestions,
    filter_topics,
    match_literal_values,
    merge_matched,
)
from app.understanding import QueryUnderstanding
from tests.conftest import requires_db


# Longest-first, as _facet_values returns them.
_VOCAB = ("Papua New Guinea", "Nigeria", "Guinea", "India", "Niger")


def test_filter_topics_applies_threshold_and_top_k():
    raw = [("freight", 0.61), ("air quality", 0.44), ("housing", 0.29), ("parks", 0.12)]
    out = filter_topics(raw, top_k=2, min_cosine=0.30)
    assert out == [("freight", 0.61), ("air quality", 0.44)]


def test_literal_match_fires_on_a_country_inside_a_question():
    assert match_literal_values("electric buses in India", _VOCAB) == [("India", 1.0)]


def test_literal_match_ignores_adjectives_and_longer_names():
    assert match_literal_values("Indian cities", _VOCAB) == []
    assert match_literal_values("Nigeria", _VOCAB) == [("Nigeria", 1.0)]


def test_literal_match_gives_the_span_to_the_longest_name():
    assert match_literal_values("Papua New Guinea", _VOCAB) == [("Papua New Guinea", 1.0)]


def test_merge_matched_keeps_literal_and_dedupes_by_label():
    out = merge_matched([("India", 1.0)], [("India", 0.31), ("Kenya", 0.88)], top_k=3)
    assert out == [("India", 1.0), ("Kenya", 0.88)]


def test_merge_matched_literal_survives_the_cap():
    out = merge_matched([("India", 1.0)], [("A", 0.9), ("B", 0.8)], top_k=2)
    assert out == [("India", 1.0), ("A", 0.9)]


def test_attach_appends_suggestions_never_facets(monkeypatch):
    import app.topic_sense as ts

    monkeypatch.setattr(ts, "model_has_tag_embeddings", lambda m: True)
    monkeypatch.setattr(ts, "nearby_topics", lambda emb: [("freight", 0.61)])

    class _Embed:
        def get_query_embedding(self, q):
            return [0.0] * 1536

    u = QueryUnderstanding()
    attach_topic_suggestions(u, "trucks", _Embed())
    assert [s.type for s in u.suggestions] == ["nearby_topic"]
    assert u.suggestions[0].text == "freight"
    assert u.facets == []
    assert "topic_sense" not in u.degraded


def test_attach_is_failure_soft(monkeypatch):
    import app.topic_sense as ts

    def boom(emb):
        raise RuntimeError("no table")

    monkeypatch.setattr(ts, "model_has_tag_embeddings", lambda m: True)
    monkeypatch.setattr(ts, "nearby_topics", boom)

    class _Embed:
        def get_query_embedding(self, q):
            return [0.0] * 1536

    u = QueryUnderstanding()
    attach_topic_suggestions(u, "trucks", _Embed())
    assert u.suggestions == []
    assert "topic_sense" in u.degraded


def test_attach_skips_embedding_when_model_has_no_tag_embeddings(monkeypatch):
    # tag_embeddings rows only exist for the model the worker embeds with
    # (embed_tags.py). Under any other embedding model the cosine query can
    # never match — so the (paid, blocking) query-embedding call must be
    # skipped entirely, not spent on a permanently-empty lookup.
    import app.topic_sense as ts

    monkeypatch.setattr(ts, "model_has_tag_embeddings", lambda m: False)
    calls = []

    class _Embed:
        def get_query_embedding(self, q):
            calls.append(q)
            return [0.0] * 1536

    u = QueryUnderstanding()
    attach_topic_suggestions(u, "trucks", _Embed())
    assert calls == []
    assert u.suggestions == []
    assert "topic_sense" in u.degraded


def test_attach_degrades_without_embed_model():
    u = QueryUnderstanding()
    attach_topic_suggestions(u, "trucks", None)
    assert "topic_sense" in u.degraded


@requires_db
def test_nearby_topics_sql_runs():
    from app.topic_sense import nearby_topics
    nearby_topics([0.0] * 1536)  # proves the SQL parses against a real DB
