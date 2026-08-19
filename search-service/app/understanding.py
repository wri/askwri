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
