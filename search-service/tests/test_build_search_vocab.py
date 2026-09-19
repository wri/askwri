"""Vocab builder: pure term collection + (DB-marked) rebuild idempotency."""
import os

import pytest

from scripts.build_search_vocab import collect_terms


def test_collect_terms_merges_sources_and_counts_df():
    titles = [("Urban Inequality Index",), ("Urban Freight Decarbonization",)]
    tags = [("Land Value Capture",)]
    aliases = [("LVC betterment levy",)]
    vocab = collect_terms(titles, tags, aliases)

    assert vocab["urban"] == ("title", 2)          # df counts occurrences
    assert vocab["inequality"] == ("title", 1)
    assert vocab["capture"][0] == "tag"
    assert vocab["betterment"][0] == "alias"
    # short tokens (<3 chars) and pure numbers excluded
    assert "of" not in vocab and "lvc" in vocab    # 3-char acronym kept


def test_collect_terms_lowercases_and_strips():
    vocab = collect_terms([("BRT Corridors—Design",)], [], [])
    assert "brt" in vocab and "corridors" in vocab and "design" in vocab
