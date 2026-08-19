# search-service/app/understanding.py
"""Query understanding — one schema-validated object per query.

Design: docs/plans/2026-08-19-query-expansion-design.md §4.1, §5.
P1 = deterministic tier only. Strict enums + confidence bounds: an invalid
object is rejected WHOLE (never half-applied). Every signal is one attempt,
failure-soft, recorded in `degraded`.
"""
from typing import Literal

from pydantic import BaseModel, Field

UNDERSTANDING_VERSION = 1

FACET_NAMES = ("year_min", "year_max", "language", "program", "excluded_keyword")


class Facet(BaseModel):
    facet: Literal["year_min", "year_max", "language", "program", "excluded_keyword"]
    value: str
    confidence: float = Field(ge=0.0, le=1.0)
    source: Literal["parser", "llm", "user"]
    action: Literal["hard", "soft", "suggest"]


class Suggestion(BaseModel):
    type: Literal["spelling", "disambiguation", "nearby_topic"]
    text: str


class QueryUnderstanding(BaseModel):
    version: int = UNDERSTANDING_VERSION
    intent: Literal["topical", "known_item", "catalog"] = "topical"
    facets: list[Facet] = Field(default_factory=list)
    variants: list[str] = Field(default_factory=list)
    suggestions: list[Suggestion] = Field(default_factory=list)
    timings: dict = Field(default_factory=dict)
    degraded: list[str] = Field(default_factory=list)


def understanding_active(settings, request) -> bool:
    """THE flag-off guard. All query-path understanding code must sit behind
    this returning True — that is what makes flag-off byte-identical."""
    return bool(
        getattr(settings, "query_understanding_enabled", False)
        and getattr(request, "expansion", True)
    )


def lanes_active(settings, request) -> bool:
    """THE P2 flag-off guard (design §4.3). Requires the P1 flag too: lanes
    consume the deterministic tier (alias lookup) and record degradation in
    the understanding object."""
    return understanding_active(settings, request) and bool(
        getattr(settings, "query_expansion_lanes_enabled", False)
    )


def build_understanding(query: str, explicit_facets, today_year: int) -> QueryUnderstanding:
    """Deterministic tier (P1). Each signal isolated + failure-soft (spec §5).

    Explicit facets present ⇒ the user touched the chips: auto-detection is
    OFF for facets (spec §3 — the system stops second-guessing). Spelling
    suggestions still run. Topic sensing is attached separately after stage 1
    (topic_sense.attach_topic_suggestions) so the embed cache is warm.
    """
    u = QueryUnderstanding()

    if explicit_facets is not None:
        for spec in explicit_facets:
            try:
                u.facets.append(
                    Facet(facet=spec.facet, value=spec.value,
                          confidence=1.0, source="user", action="hard")
                )
            except Exception:  # noqa: BLE001 — invalid chip dropped, not fatal
                if "explicit_facets" not in u.degraded:
                    u.degraded.append("explicit_facets")
    else:
        try:
            from app import facet_parsers
            u.facets.extend(facet_parsers.parse_facets(query, today_year))
        except Exception:  # noqa: BLE001
            u.degraded.append("facet_parsers")

    try:
        from app.spell_suggest import db_suggester
        s = db_suggester().suggest(query)
        if s is not None:
            u.suggestions.append(s)
    except Exception:  # noqa: BLE001
        u.degraded.append("spell_suggest")

    return u
