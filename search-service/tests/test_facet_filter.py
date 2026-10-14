"""Single pre-rerank facet application point (design §4.5).

Semantics mirror the legacy apply_metadata_filters where they overlap
(missing year is KEPT, present-but-unparseable year is EXCLUDED when a year
filter is set; program is exact-match on node metadata; excluded_keywords
substring on title+text). Language has no legacy counterpart: unknown
language is KEPT — exclusion requires a positive mismatch."""
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.facet_filter import apply_facet_filters, legacy_request_facets
from app.understanding import Facet


def _node(doc_id, year_meta="2020", program="", text="body text", title="t"):
    n = MagicMock()
    n.node.metadata = {
        "doc_id": doc_id, "year": year_meta, "program_series": program, "title": title,
    }
    n.node.text = text
    return n


def _hard(facet, value):
    return Facet(facet=facet, value=value, confidence=0.9, source="parser", action="hard")


DOCS_META = {
    "d-en-2023": {"language": "en", "article_type": "report", "year_int": 2023},
    "d-es-2019": {"language": "es", "article_type": "report", "year_int": 2019},
    "d-noyear": {"language": "en", "article_type": None, "year_int": None},
}


def test_year_min_filters_on_docs_meta():
    nodes = [_node("d-en-2023"), _node("d-es-2019")]
    out = apply_facet_filters(nodes, [_hard("year_min", "2022")], DOCS_META)
    assert [n.node.metadata["doc_id"] for n in out] == ["d-en-2023"]


def test_year_filter_excludes_unparseable_year():
    nodes = [_node("d-noyear", year_meta="n.d.")]
    assert apply_facet_filters(nodes, [_hard("year_min", "2000")], DOCS_META) == []


def test_year_falls_back_to_node_metadata_when_doc_unknown():
    nodes = [_node("mystery", year_meta="2024")]
    out = apply_facet_filters(nodes, [_hard("year_min", "2022")], {})
    assert len(out) == 1


def test_year_filter_keeps_docs_with_no_year_at_all():
    # Legacy parity: apply_metadata_filters keeps docs whose year metadata is
    # absent (main.py:361 falls through on None); only present-but-unparseable
    # years are excluded.
    n = MagicMock()
    n.node.metadata = {"doc_id": "d-unknown", "program_series": "", "title": "t"}
    n.node.text = "body"
    out = apply_facet_filters([n], [_hard("year_min", "2000")], {})
    assert out == [n]


def test_invalid_year_value_facet_is_dropped_not_fatal():
    # An invalid chip value is dropped (module contract), never a ValueError
    # that hybrid_query's outer except would turn into a 500.
    nodes = [_node("d-en-2023")]
    assert apply_facet_filters(nodes, [_hard("year_min", "abc")], DOCS_META) is nodes


def test_language_filters_on_docs_meta():
    nodes = [_node("d-en-2023"), _node("d-es-2019")]
    out = apply_facet_filters(nodes, [_hard("language", "es")], DOCS_META)
    assert [n.node.metadata["doc_id"] for n in out] == ["d-es-2019"]


def test_language_filter_keeps_docs_without_language_metadata():
    # The relational language column is only hydrated on the postgres backend;
    # a doc with unknown language must be KEPT (conservative posture), not
    # excluded — otherwise a language facet on the legacy backend filters
    # every result to zero.
    nodes = [_node("mystery")]
    out = apply_facet_filters(nodes, [_hard("language", "es")], {})
    assert [n.node.metadata["doc_id"] for n in out] == ["mystery"]


def test_program_and_excluded_keyword():
    nodes = [
        _node("d-en-2023", program="WRR", text="clean freight"),
        _node("d-es-2019", program="WRR", text="dirty coal freight"),
    ]
    out = apply_facet_filters(
        nodes,
        [_hard("program", "WRR"), _hard("excluded_keyword", "coal")],
        DOCS_META,
    )
    assert [n.node.metadata["doc_id"] for n in out] == ["d-en-2023"]


def test_soft_and_suggest_facets_do_not_filter():
    nodes = [_node("d-es-2019")]
    soft = Facet(facet="language", value="en", confidence=0.5, source="llm", action="soft")
    assert apply_facet_filters(nodes, [soft], DOCS_META) is nodes


def test_no_hard_facets_returns_same_list_object():
    nodes = [_node("d-en-2023")]
    assert apply_facet_filters(nodes, [], DOCS_META) is nodes


def test_legacy_request_facets_conversion():
    req = SimpleNamespace(
        min_year=2020, max_year=2024,
        required_program="WRR", excluded_keywords=["coal", "oil"],
    )
    got = sorted((f.facet, f.value) for f in legacy_request_facets(req))
    assert got == [
        ("excluded_keyword", "coal"), ("excluded_keyword", "oil"),
        ("program", "WRR"), ("year_max", "2024"), ("year_min", "2020"),
    ]
    assert all(f.source == "user" and f.action == "hard" for f in legacy_request_facets(req))


def test_legacy_request_facets_empty_request():
    req = SimpleNamespace(min_year=None, max_year=None, required_program=None, excluded_keywords=None)
    assert legacy_request_facets(req) == []


OFFICE_META = {
    "d-us": {"office": "WRI US", "year_int": 2023},
    "d-mx": {"office": "WRI México", "year_int": 2023},
    "d-br": {"office": "WRI  São   Paulo", "year_int": 2023},
}


def _office_node(doc_id):
    n = MagicMock()
    n.node.metadata = {"doc_id": doc_id, "program_series": "", "title": "t"}
    n.node.text = "body"
    return n


def test_office_matches_across_case():
    # The UI canonicalizes "WRI US" to "WRI Us"; the corpus keeps "WRI US".
    nodes = [_office_node("d-us")]
    out = apply_facet_filters(nodes, [_hard("office", "WRI Us")], OFFICE_META)
    assert [n.node.metadata["doc_id"] for n in out] == ["d-us"]


def test_office_matches_across_accents():
    nodes = [_office_node("d-mx")]
    out = apply_facet_filters(nodes, [_hard("office", "WRI Mexico")], OFFICE_META)
    assert [n.node.metadata["doc_id"] for n in out] == ["d-mx"]


def test_office_matches_across_whitespace():
    nodes = [_office_node("d-br")]
    out = apply_facet_filters(nodes, [_hard("office", "WRI São Paulo")], OFFICE_META)
    assert [n.node.metadata["doc_id"] for n in out] == ["d-br"]


def test_office_mismatch_still_excludes():
    nodes = [_office_node("d-us"), _office_node("d-mx")]
    out = apply_facet_filters(nodes, [_hard("office", "WRI Brazil")], OFFICE_META)
    assert out == []


def test_office_multiple_facets_are_or():
    # Two office chips keep docs matching EITHER (the FilterPanel is
    # multi-select); a doc matching neither is dropped.
    nodes = [_office_node("d-us"), _office_node("d-mx"), _office_node("d-br")]
    out = apply_facet_filters(
        nodes,
        [_hard("office", "WRI Us"), _hard("office", "WRI Mexico")],
        OFFICE_META,
    )
    assert [n.node.metadata["doc_id"] for n in out] == ["d-us", "d-mx"]


def test_office_kept_when_doc_has_no_office():
    nodes = [_office_node("mystery")]
    out = apply_facet_filters(nodes, [_hard("office", "WRI Mexico")], {})
    assert [n.node.metadata["doc_id"] for n in out] == ["mystery"]
