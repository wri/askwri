"""Alias-expansion lane source (design §4.1, §4.3 P2).

Deterministic: longest matched phrase first, alphabetical (case-insensitive)
within a group, hard caps. Word-boundary matching only — substring hits
('art' in 'chart') are the over-matching DOMAIN_EXPANSIONS suffered."""
import pytest

from app.alias_expand import AliasExpander
from tests.conftest import requires_db


def _expander(groups, max_groups=3, max_terms=2):
    return AliasExpander(lambda: groups, max_groups=max_groups, max_terms=max_terms)


def test_alias_match_expands_to_rest_of_group():
    groups = {"Land Value Capture": ["LVC", "betterment levy"]}
    out = _expander(groups).expand("how does LVC work in Bogota?")
    # matched term "LVC" excluded; rest sorted case-insensitively
    assert out == ["betterment levy", "Land Value Capture"]


def test_label_match_expands_to_aliases():
    groups = {"Land Value Capture": ["LVC", "betterment levy", "land value tax"]}
    out = _expander(groups).expand("land value capture policies")
    # matching is case-insensitive; case-insensitive sort, max_terms=2 cap
    assert out == ["betterment levy", "land value tax"]


def test_word_boundary_no_substring_match():
    # "art" is inside "charting" but must not match (word boundary)
    groups = {"Art": ["visual arts"]}
    assert _expander(groups).expand("charting emissions") == []


def test_terms_shorter_than_three_chars_never_match():
    groups = {"Electric Vehicles": ["EV"]}
    assert _expander(groups).expand("ev charging") == []


def test_longest_matched_phrase_wins_group_cap():
    groups = {
        "Urban Finance": ["municipal finance"],
        "Finance": ["funding"],
        "Transit": ["public transport"],
        "Climate": ["ghg emissions"],
    }
    out = _expander(groups, max_groups=3).expand(
        "urban finance for transit and climate and finance"
    )
    # 4 groups match; "urban finance" (13 chars) sorts first; only 3 kept
    assert "municipal finance" in out
    assert len(out) <= 6  # 3 groups x 2 terms


def test_duplicate_terms_deduped_across_groups():
    groups = {"Buses": ["transit"], "Metro": ["transit"]}
    assert _expander(groups).expand("buses and metro") == ["transit"]


def test_empty_query_and_empty_groups():
    assert _expander({}).expand("anything") == []
    assert _expander({"A B C": ["x y z"]}).expand("") == []


def test_fetch_failure_propagates_to_caller():
    def boom():
        raise RuntimeError("db down")
    with pytest.raises(RuntimeError):
        AliasExpander(boom, 3, 2).expand("urban finance")


@requires_db
def test_db_expander_reads_tag_aliases():
    from app.alias_expand import db_expander
    from app.db import get_pool

    label = "__p2test Freight Decarbonization"
    with get_pool().connection() as conn:
        tag_id = conn.execute(
            "INSERT INTO tags (id, facet, value_id) "
            "VALUES (gen_random_uuid(), 'topic', %s) RETURNING id",
            (label,),
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO tag_aliases (tag_id, alias) VALUES (%s, %s), (%s, %s)",
            (tag_id, "freight decarb", tag_id, "zero-emission freight"),
        )
    try:
        out = db_expander().expand("what about freight decarb in cities?")
        assert label in out
        assert "zero-emission freight" in out
    finally:
        with get_pool().connection() as conn:
            conn.execute("DELETE FROM tags WHERE id = %s", (tag_id,))  # cascades
