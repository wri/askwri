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


def _fake_suggester(vocab, threshold=0.45, df=None, min_df=1):
    # df: {term: df} overrides; fixture vocab terms default to a high df so
    # the labeled cases exercise similarity policy, not the df floor.
    vocab_set = set(vocab)
    df = df or {}

    def exact_lookup(words):
        return {w for w in words if w in vocab_set}

    def fuzzy_lookup(word):
        best = max(vocab_set, key=lambda t: _sim(word, t))
        return (best, _sim(word, best), df.get(best, 10))

    return TrigramSuggester(exact_lookup, fuzzy_lookup, threshold, min_df=min_df)


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


def test_rare_vocab_term_is_not_suggested_below_df_floor():
    # A one-off title word (df=1) must not become a correction target: the
    # vocabulary is corpus-derived, so ordinary English words are OOV and
    # would otherwise be 'corrected' to whatever rare term clears the
    # similarity threshold.
    s = _fake_suggester(
        ["hydrogen", "freight"], df={"hydrogen": 1}, min_df=2
    )
    assert s.suggest("hydrogin buses") is None


def test_df_floor_allows_established_terms():
    s = _fake_suggester(["hydrogen", "freight"], df={"hydrogen": 2}, min_df=2)
    out = s.suggest("hydrogin buses")
    assert out is not None and out.text == "hydrogen buses"


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
