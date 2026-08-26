"""P3 LLM understanding sidecar (design 2026-08-19 §4.1, §5, §7).

One strict, schema-validated LLM call per query that augments the deterministic
tier with query variants, LLM-grade facet extraction, intent classification,
and disambiguation candidates. Flagged dark; deterministic-first; qa-only.

Posture mirrors app/query_translate.py: one call, lru_cached, short timeout,
max_retries=0, failure-soft (returns None on any failure; the caller records
`understanding.degraded`). Strict validation reuses the pydantic Facet model
— an unknown facet name or out-of-range confidence rejects the WHOLE object
(design §5), never half-applied. One attempt (design §5: no retry loop in the
request path).

LLM facets ship as `action="suggest"` in slice 1 — visible, never applied as a
hard filter while the confidence threshold is uncalibrated (design §7:
thresholds are DERIVED from a labeled set, never hand-picked).
"""
import json
import logging
import os
from functools import lru_cache

from app import usage_meter
from app.config import get_settings
from app.understanding import Facet

logger = logging.getLogger(__name__)

_SYSTEM = (
    "You analyze a search query for a document retrieval system over WRI's "
    "published corpus. Return JSON with: intent (one of \"topical\", "
    "\"known_item\", \"catalog\", \"binary_presence\"), facets (a list of "
    "{facet, value, confidence} where facet is one of \"year_min\", "
    "\"year_max\", \"language\", \"program\", \"excluded_keyword\" and "
    "confidence is 0.0-1.0), variants (0-2 alternative phrasings of the query), "
    "disambiguation (alternative readings if the query is ambiguous, else "
    "empty), and core_topic (the single core noun phrase of the query's "
    "subject — e.g. \"surveillance technologies\", \"vertical farming\", "
    "\"nuclear microreactors\", \"hydrogen\"; used for a corpus-coverage "
    "abstain check). Return only JSON, no commentary."
)

_INTENT_VALUES = ("topical", "known_item", "catalog", "binary_presence")


@lru_cache(maxsize=512)
def build_understanding_llm(query: str) -> dict | None:
    """One LLM call producing {intent, facets, variants, disambiguation}, or
    None on any failure (caller records `understanding.degraded`).

    Strict (design §5): a malformed facet (unknown name or out-of-range
    confidence) rejects the WHOLE object — reuses the pydantic Facet model as
    the single source of truth for the facet schema. A bad intent label does
    NOT reject (the caller keeps the deterministic tier's default).
    """
    settings = get_settings()
    from openai import OpenAI

    try:
        client = OpenAI(
            api_key=os.getenv("OPENAI_API_KEY"),
            timeout=settings.query_understanding_llm_timeout_s,
            max_retries=0,
        )
        resp = client.chat.completions.create(
            model=settings.query_understanding_llm_model,
            temperature=0,  # deterministic: same query -> same variants/facets
            # (the lru_cache then freezes a stable result; nondeterministic
            # output + cache made retrieval quality a per-deploy lottery,
            # 2026-08-26).
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": query},
            ],
            max_completion_tokens=600,
        )
        usage = getattr(resp, "usage", None)
        if usage:
            usage_meter.record_tokens(
                "query_understanding", settings.query_understanding_llm_model,
                input_tokens=usage.prompt_tokens,
                output_tokens=usage.completion_tokens,
            )
        content = resp.choices[0].message.content
        if not content:
            return None
        data = json.loads(content)
    except Exception:  # noqa: BLE001 — timeout / parse / api failure all soft
        logger.warning("understanding_llm: call failed for query %r", query, exc_info=True)
        return None

    # Strict facet validation (design §5): reject the whole object if any facet
    # is malformed. Reuses the pydantic Facet model — unknown facet name or
    # out-of-range confidence raises ValidationError → reject whole.
    facets = []
    try:
        for f in data.get("facets", []) or []:
            facets.append(
                Facet(
                    facet=f["facet"],
                    value=str(f["value"]),
                    confidence=float(f["confidence"]),
                    source="llm",
                    action="suggest",
                )
            )
    except Exception:  # noqa: BLE001 — ValidationError / KeyError / ValueError
        logger.warning("understanding_llm: rejecting malformed LLM facets for %r", query)
        return None

    intent = data.get("intent")
    if intent not in _INTENT_VALUES:
        intent = None

    # Variants capped at 2 (design §4.1); dedupe vs the original query is the
    # caller's job (it holds the original query string).
    variants = [v for v in (data.get("variants") or []) if isinstance(v, str)][:2]
    disambiguation = [
        d for d in (data.get("disambiguation") or []) if isinstance(d, str)
    ]
    core_topic = data.get("core_topic")
    if not isinstance(core_topic, str) or not core_topic.strip():
        core_topic = None

    return {"intent": intent, "facets": facets, "variants": variants,
            "disambiguation": disambiguation, "core_topic": core_topic}
