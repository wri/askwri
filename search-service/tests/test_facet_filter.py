"""Single pre-rerank facet application point (design §4.5).

Semantics mirror the legacy apply_metadata_filters where they overlap
(missing year is KEPT, present-but-unparseable year is EXCLUDED when a year
filter is set; program is exact-match on node metadata; excluded_keywords
match whole normalized words in title+text and exclude at the DOCUMENT
level). Language has no legacy counterpart: unknown
language is KEPT — exclusion requires a positive mismatch."""
from types import SimpleNamespace
from datetime import date
from unittest.mock import MagicMock

from app.facet_filter import (
    apply_facet_filters, boost_facet_matches, excluded_doc_ids, legacy_request_facets,
)
import pytest

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


def test_publication_date_range_is_inclusive_and_falls_back_to_year():
    metadata = {
        "start": {"date_published": date(2020, 6, 1), "year_int": 2019},
        "end": {"date_published": date(2020, 6, 30)},
        "before": {"date_published": date(2020, 5, 31)},
        "after": {"date_published": date(2020, 7, 1)},
        "year": {"year_int": 2020},
        "old": {"year_int": 2019},
        "unknown": {},
    }
    nodes = [_node(doc_id) for doc_id in metadata]
    out = apply_facet_filters(
        nodes, [_hard("date_min", "2020-06-01"), _hard("date_max", "2020-06-30")], metadata,
    )
    assert [node.node.metadata["doc_id"] for node in out] == ["start", "end", "year", "unknown"]


def test_publication_date_falls_back_to_legacy_year():
    # RETRIEVAL_BACKEND=legacy: load_csv_metadata supplies "year" only — no
    # year_int, no date_published. A 2019 doc must still be excluded by
    # date_min=2020-06-01, else every legacy doc reads as undated.
    metadata = {"legacy-2019": {"year": "2019"}, "legacy-2021": {"year": "2021"}}
    nodes = [_node(doc_id) for doc_id in metadata]
    out = apply_facet_filters(nodes, [_hard("date_min", "2020-06-01")], metadata)
    assert [n.node.metadata["doc_id"] for n in out] == ["legacy-2021"]


def test_invalid_publication_date_is_ignored():
    nodes = [_node("doc")]
    assert apply_facet_filters(nodes, [_hard("date_min", "invalid")], {}) is nodes


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


def test_language_multiple_facets_are_or():
    # Two language chips keep docs in EITHER language (the FilterPanel is
    # multi-select); values are ISO codes compared case-insensitively.
    nodes = [_node("d-en-2023"), _node("d-es-2019")]
    out = apply_facet_filters(
        nodes,
        [_hard("language", "en"), _hard("language", "ES")],
        DOCS_META,
    )
    assert [n.node.metadata["doc_id"] for n in out] == ["d-en-2023", "d-es-2019"]


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


def test_program_match_is_normalized():
    # The chip shows canonical spacing/case; the corpus keeps its own
    # spelling (double spaces, mixed case) for the same program series.
    nodes = [_node("a", program="World Resources Report"), _node("b", program="WRR")]
    out = apply_facet_filters(nodes, [_hard("program", "world  resources  report")], {})
    assert [n.node.metadata["doc_id"] for n in out] == ["a"]


def test_program_none_metadata_is_a_mismatch_not_a_crash():
    # An explicit program_series: None must behave like an absent value
    # (mismatch → excluded), never raise in _normalize_meta.
    nodes = [_node("a", program=None)]
    out = apply_facet_filters(nodes, [_hard("program", "WRR")], {})
    assert out == []


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


WORK_LANG_META = {
    # en translation whose work also has an es original sibling
    "d-en": {"language": "en", "work_languages": frozenset({"es"})},
    # es original whose work also has an en translation sibling
    "d-es": {"language": "es", "work_languages": frozenset({"en"})},
    # monolingual doc, no siblings
    "d-fr": {"language": "fr", "work_languages": frozenset()},
}


def test_language_matches_work_sibling_language():
    # A bilingual work is two rows: filtering language=en keeps BOTH the en
    # row and its es-original sibling (the work covers en either way).
    nodes = [_node("d-en"), _node("d-es"), _node("d-fr")]
    out = apply_facet_filters(nodes, [_hard("language", "en")], WORK_LANG_META)
    assert [n.node.metadata["doc_id"] for n in out] == ["d-en", "d-es"]


def test_language_work_match_is_symmetric():
    # Same from the es side: filtering es keeps the es original AND its en
    # translation sibling.
    nodes = [_node("d-en"), _node("d-es"), _node("d-fr")]
    out = apply_facet_filters(nodes, [_hard("language", "es")], WORK_LANG_META)
    assert [n.node.metadata["doc_id"] for n in out] == ["d-en", "d-es"]


def test_language_no_work_match_excludes():
    # A monolingual fr doc matches neither en nor es: excluded.
    nodes = [_node("d-fr")]
    out = apply_facet_filters(
        nodes,
        [_hard("language", "en"), _hard("language", "es")],
        WORK_LANG_META,
    )
    assert out == []


def test_every_facet_type_has_a_policy_mode():
    from typing import get_args
    from app.understanding import FACET_MODES, Facet
    assert set(FACET_MODES) == set(get_args(Facet.model_fields["facet"].annotation))


def test_hard_facet_without_a_mode_is_not_applied():
    f = Facet.model_construct(facet="mystery", value="x", confidence=1.0,
                              source="user", action="hard")
    nodes = [_node("a")]
    assert apply_facet_filters(nodes, [f], {}) is nodes


def test_excluded_doc_ids_returns_translation_and_canonical():
    nodes = [_node("t1", text="english text", title="t")]
    pairs = {"t1": {"original": "o1", "original_title": "Zero-emission buses"}}
    got = excluded_doc_ids(nodes, [_hard("excluded_keyword", "zero emission")], {}, pairs)
    assert got == {"t1", "o1"}

def test_exclusion_propagates_from_original_to_translation():
    # pairs only maps translation → original; the ORIGINAL matching must also
    # exclude its translation — a user excluding a topic excludes the work in
    # every language, in both directions.
    nodes = [_node("o1", text="coal power"), _node("t1", text="texto limpio")]
    pairs = {"t1": {"original": "o1"}}
    got = excluded_doc_ids(nodes, [_hard("excluded_keyword", "coal")], {}, pairs)
    assert got == {"o1", "t1"}

def test_exclusion_propagates_to_sibling_translations():
    # o1 has two translations; only t1 matches. Excluding one version of a
    # work excludes the whole work: o1, the matching t1, and sibling t2.
    nodes = [
        _node("o1", text="clean energy"),
        _node("t1", text="coal power"),
        _node("t2", text="texte propre"),
    ]
    pairs = {"t1": {"original": "o1"}, "t2": {"original": "o1"}}
    got = excluded_doc_ids(nodes, [_hard("excluded_keyword", "coal")], {}, pairs)
    assert got == {"o1", "t1", "t2"}

def test_excluded_doc_ids_skips_docless_node():
    # A doc-less node must be skipped, not keyed as None: a None in the set
    # would drop every doc-less node in apply_facet_filters and make
    # sorted(excluded) raise in the debug payload.
    nodes = [_node("coal", text="coal power"), _node(None, text="coal power")]
    assert excluded_doc_ids(nodes, [_hard("excluded_keyword", "coal")], {}) == {"coal"}


def test_language_kept_when_doc_has_no_language_metadata():
    # Unknown language is still KEPT (conservative posture), siblings or not.
    nodes = [_node("mystery")]
    out = apply_facet_filters(nodes, [_hard("language", "es")], {})
    assert [n.node.metadata["doc_id"] for n in out] == ["mystery"]


def test_exclusion_respects_word_boundaries():
    nodes = [_node("coalition", text="coalition building"), _node("coal", text="coal power")]
    out = apply_facet_filters(nodes, [_hard("excluded_keyword", "coal")], {})
    assert [n.node.metadata["doc_id"] for n in out] == ["coalition"]


def test_exclusion_is_document_level():
    nodes = [_node("doc", text="school buses are safe"), _node("doc", text="electric buses")]
    out = apply_facet_filters(nodes, [_hard("excluded_keyword", "school buses")], {})
    assert out == []


def test_exclusion_normalizes_case_accents_hyphens_and_spacing():
    nodes = [_node("mx", title="México’s zero–emission  buses", text="x")]
    out = apply_facet_filters(nodes, [_hard("excluded_keyword", "ZERO EMISSION")], {})
    assert out == []


def test_blank_exclusion_never_matches():
    nodes = [_node("a")]
    out = apply_facet_filters(nodes, [_hard("excluded_keyword", "   ")], {})
    assert [n.node.metadata["doc_id"] for n in out] == ["a"]


# --- #522: pre-rerank boost (shape instead of filter) ------------------------
#
# Scores here are RRF-scale (4 votes ≈ 0.05): the boost unit is one RRF vote
# at rank 1, weight / (60 + 1) ≈ 0.0164, so the tests use scores a single
# vote can actually separate.

def _scored(doc_id, score, **kwargs):
    n = _node(doc_id, **kwargs)
    n.score = score
    return n


def test_boost_keeps_every_node_and_raises_only_matches():
    nodes = [_scored("a", 0.050), _scored("b", 0.060)]
    meta = {"a": {"year_int": 2020}, "b": {"year_int": 1990}}
    out, boosted = boost_facet_matches(nodes, [_hard("year_min", "2000")], meta, 1.0)
    assert len(out) == 2                       # the filter would drop "b"
    assert boosted == {"a"}
    assert [n.node.metadata["doc_id"] for n in out] == ["a", "b"]
    assert out[0].score == pytest.approx(0.050 + 1 / 61)
    assert out[1].score == pytest.approx(0.060)   # untouched


def test_boost_weight_zero_is_a_no_op_including_order():
    nodes = [_scored("a", 0.050), _scored("b", 0.060)]
    meta = {"a": {"office": "WRI India"}}
    out, boosted = boost_facet_matches(nodes, [_hard("office", "WRI India")], meta, 0.0)
    assert [n.node.metadata["doc_id"] for n in out] == ["a", "b"]
    assert boosted == set()


def test_boost_with_no_positive_constraints_returns_nodes_untouched():
    nodes = [_scored("a", 0.050), _scored("b", 0.060)]
    out, boosted = boost_facet_matches(nodes, [_hard("excluded_keyword", "coal")], {}, 1.0)
    assert out is nodes
    assert boosted == set()


def test_boost_tolerates_missing_metadata_and_none_score():
    node = _node("docless", year_meta=None)
    node.node.metadata = {}
    node.score = None
    out, boosted = boost_facet_matches([node], [_hard("year_min", "2000")], {}, 1.0)
    assert len(out) == 1
    assert boosted == set()
