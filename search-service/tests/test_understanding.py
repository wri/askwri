# search-service/tests/test_understanding.py
"""QueryUnderstanding schema + activation guard (design 2026-08-19 §4.1, §5).

Strict validation: a malformed object must be rejected WHOLE — half-applied
understanding is the brittleness the design bans."""
import pytest
from pydantic import ValidationError

from app.understanding import (
    Facet,
    QueryUnderstanding,
    Suggestion,
    understanding_active,
)


def test_defaults_are_empty_and_versioned():
    u = QueryUnderstanding()
    assert u.version == 1
    assert u.intent == "topical"
    assert u.facets == [] and u.variants == [] and u.suggestions == []
    assert u.degraded == []


def test_unknown_facet_name_rejected_whole():
    with pytest.raises(ValidationError):
        Facet(facet="vibe", value="good", confidence=0.9, source="parser", action="hard")


def test_out_of_range_confidence_rejected():
    with pytest.raises(ValidationError):
        Facet(facet="language", value="es", confidence=1.7, source="parser", action="hard")


def test_unknown_suggestion_type_rejected():
    with pytest.raises(ValidationError):
        Suggestion(type="telepathy", text="x")


def test_activation_guard():
    class S:  # duck-typed settings/request
        query_understanding_enabled = True

    class R:
        expansion = True

    assert understanding_active(S(), R()) is True
    R.expansion = False
    assert understanding_active(S(), R()) is False
    R.expansion = True
    S.query_understanding_enabled = False
    assert understanding_active(S(), R()) is False


def test_flag_defaults_off():
    from app.config import Settings
    assert Settings.model_fields["query_understanding_enabled"].default is False


def test_alias_expansions_default_empty_and_lookup_not_run():
    import app.alias_expand as ae

    def _boom():
        raise AssertionError("alias lookup must not run when expansion_lanes is off")

    orig = ae.db_expander
    ae.db_expander = _boom
    try:
        from app.understanding import build_understanding
        u = build_understanding("urban finance", explicit_facets=None, today_year=2026)
        assert u.alias_expansions == []
        assert "alias_expansion" not in u.degraded
    finally:
        ae.db_expander = orig


def test_alias_expansions_populated_when_lanes_on(monkeypatch):
    import app.alias_expand as ae
    from app.understanding import build_understanding

    class _Stub:
        def expand(self, query):
            return ["mass transit", "BRT"]

    monkeypatch.setattr(ae, "db_expander", lambda: _Stub())
    u = build_understanding(
        "bus systems", explicit_facets=None, today_year=2026, expansion_lanes=True
    )
    assert u.alias_expansions == ["mass transit", "BRT"]
    assert "alias_expansion" not in u.degraded


def test_alias_lookup_failure_soft(monkeypatch):
    import app.alias_expand as ae
    from app.understanding import build_understanding

    def _raise():
        raise RuntimeError("db down")

    monkeypatch.setattr(ae, "db_expander", _raise)
    u = build_understanding(
        "bus systems", explicit_facets=None, today_year=2026, expansion_lanes=True
    )
    assert u.alias_expansions == []
    assert "alias_expansion" in u.degraded
