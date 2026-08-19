"""Single pre-rerank facet application point (design §4.5).

Semantics mirror the legacy apply_metadata_filters where they overlap
(year-unparseable docs are EXCLUDED when a year filter is set; program is
exact-match on node metadata; excluded_keywords substring on title+text)."""
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


def test_language_filters_on_docs_meta():
    nodes = [_node("d-en-2023"), _node("d-es-2019")]
    out = apply_facet_filters(nodes, [_hard("language", "es")], DOCS_META)
    assert [n.node.metadata["doc_id"] for n in out] == ["d-es-2019"]


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
