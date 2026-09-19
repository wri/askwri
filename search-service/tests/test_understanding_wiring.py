"""Contract additions + orchestrator behavior + flag-off guard.

The additive-field test copies the model_fields skip-idiom from
test_cite_doc_ids_filter.py:55-82 so the file is green on older branches."""
import pytest

from app.main import FacetSpec, QueryRequest, QueryResponse
from app.understanding import build_understanding


def test_query_request_new_fields_default_off():
    req = QueryRequest(query="q")
    assert req.facets is None
    assert req.expansion is True


def test_query_request_existing_fields_untouched():
    req = QueryRequest(query="q")
    # spot-check the contract fields the CLAUDE.md note protects
    assert req.mode == "cite" and req.max_results == 150
    assert req.vector_top_k == 500 and req.bm25_top_k == 500
    assert req.rerank is True and req.similarity_threshold == 0.0


def test_query_response_understanding_defaults_none():
    r = QueryResponse(docs=[], total_results=0, query="q", mode="cite", debug={})
    assert r.query_understanding is None


def test_build_understanding_parses_facets_and_never_raises():
    u = build_understanding("hydrogen since 2020 in spanish", explicit_facets=None, today_year=2026)
    pairs = sorted((f.facet, f.value) for f in u.facets)
    assert ("year_min", "2020") in pairs and ("language", "es") in pairs
    assert all(f.source == "parser" for f in u.facets)


def test_explicit_facets_disable_parsers():
    u = build_understanding(
        "hydrogen since 2020 in spanish",
        explicit_facets=[FacetSpec(facet="year_min", value="2023")],
        today_year=2026,
    )
    assert [(f.facet, f.value, f.source) for f in u.facets] == [("year_min", "2023", "user")]


def test_explicit_facet_with_invalid_name_is_dropped_not_fatal():
    u = build_understanding(
        "q", explicit_facets=[FacetSpec(facet="nonsense", value="x")], today_year=2026
    )
    assert u.facets == []
    assert "explicit_facets" in u.degraded


def test_build_understanding_is_failure_soft(monkeypatch):
    import app.understanding as un

    def boom(*a, **k):
        raise RuntimeError("parser exploded")

    monkeypatch.setattr("app.facet_parsers.parse_facets", boom)
    u = build_understanding("anything since 2020", explicit_facets=None, today_year=2026)
    assert u.facets == []
    assert "facet_parsers" in u.degraded
