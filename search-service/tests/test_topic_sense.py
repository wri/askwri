"""Topic sensing: pure filtering logic + failure-soft attach + DB smoke.

Invariant 2 (spec §2): topics are model-inferred on BOTH sides — they may
only ever become suggestions, never hard facets. The attach function must
therefore never touch u.facets."""
import os

import pytest

from app.topic_sense import attach_topic_suggestions, filter_topics
from app.understanding import QueryUnderstanding
from tests.conftest import requires_db


def test_filter_topics_applies_threshold_and_top_k():
    raw = [("freight", 0.61), ("air quality", 0.44), ("housing", 0.29), ("parks", 0.12)]
    out = filter_topics(raw, top_k=2, min_cosine=0.30)
    assert out == [("freight", 0.61), ("air quality", 0.44)]


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
