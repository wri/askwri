"""Deterministic facet parsers vs the labeled fixture set.

The fixture is the derivation artifact for parser behavior (spec §7): if a
pattern change breaks a trap case, the change is wrong, not the fixture."""
import json
from pathlib import Path

import pytest

from app.facet_parsers import parse_facets

_FIX = json.loads(
    (Path(__file__).parent / "fixtures" / "facet_queries.json").read_text()
)


@pytest.mark.parametrize(
    "case", _FIX["queries"], ids=[c["q"][:40] for c in _FIX["queries"]]
)
def test_labeled_facet_extraction(case):
    got = parse_facets(case["q"], today_year=_FIX["today_year"])
    got_pairs = sorted((f.facet, f.value) for f in got)
    want_pairs = sorted((f["facet"], f["value"]) for f in case["facets"])
    assert got_pairs == want_pairs


def test_parser_facets_are_hard_parser_sourced():
    for f in parse_facets("hydrogen since 2020 in spanish", today_year=2026):
        assert f.source == "parser"
        assert f.action == "hard"
        assert f.confidence == 0.9
