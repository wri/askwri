"""Trigram did-you-mean: unit tests with an injected in-memory vocabulary
(fixture-driven, incl. false-positive traps) + a requires_db smoke test."""
import json
import os
from pathlib import Path

import pytest

from app.spell_suggest import TrigramSuggester
from tests.conftest import requires_db

_FIX = json.loads(
    (Path(__file__).parent / "fixtures" / "didyoumean_queries.json").read_text()
)


def _trigrams(w: str) -> set:
    w = f"  {w} "
    return {w[i:i + 3] for i in range(len(w) - 2)}


def _sim(a: str, b: str) -> float:
    ta, tb = _trigrams(a), _trigrams(b)
    return len(ta & tb) / len(ta | tb)


def _fake_suggester(vocab, threshold=0.45):
    vocab_set = set(vocab)

    def exact_lookup(words):
        return {w for w in words if w in vocab_set}

    def fuzzy_lookup(word):
        best = max(vocab_set, key=lambda t: _sim(word, t))
        return (best, _sim(word, best))

    return TrigramSuggester(exact_lookup, fuzzy_lookup, threshold)


@pytest.mark.parametrize("case", _FIX["cases"], ids=[c["q"] for c in _FIX["cases"]])
def test_labeled_suggestions(case):
    s = _fake_suggester(_FIX["vocab"])
    out = s.suggest(case["q"])
    if case["expect"] is None:
        assert out is None
    else:
        assert out is not None
        assert out.type == "spelling"
        assert out.text == case["expect"]


def test_lookup_failure_is_silent():
    def boom(_):
        raise RuntimeError("db down")

    s = TrigramSuggester(lambda ws: set(), boom, 0.45)
    assert s.suggest("hydrogin buses") is None


@requires_db
def test_db_suggester_smoke():
    from app.spell_suggest import db_suggester
    # Just proves the SQL runs against a real search_vocab (may be empty).
    db_suggester().suggest("hydrogin buses")
