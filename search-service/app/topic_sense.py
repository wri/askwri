"""Query-to-topic sensing via tag_embeddings cosine (design §4.1).

The query embedding is looked up through the SAME embed model instance the
dense lane used, so after stage 1 the call is an LRU cache hit — zero extra
Bedrock calls in the normal path.

Invariant 2: output is SUGGESTIONS ONLY (nearby_topic). Never facets.
"""
import logging
import re
from functools import lru_cache

import numpy as np

from app.understanding import QueryUnderstanding, Suggestion

logger = logging.getLogger(__name__)

# Matches the partial HNSW index (1787160000000-TopicTaxonomy.ts): the
# ::vector(1536) cast + embedding_model predicate are what make it usable.
# Facet is parameterized (P2.6): value_id is unique PER FACET, not globally,
# so the facet filter MUST stay (do not remove it).
_TAG_SQL = """
    SELECT t.value_id, 1 - (te.embedding::vector(1536) <=> %(q)s) AS cosine
    FROM tag_embeddings te
    JOIN tags t ON t.id = te.tag_id
    WHERE te.embedding_model = %(model)s
      AND t.facet = %(facet)s
    ORDER BY te.embedding::vector(1536) <=> %(q)s
    LIMIT %(k)s
"""


# Models confirmed to have tag_embeddings rows. Positive-only cache: a miss
# is re-probed (one cheap indexed SELECT per query) so a later tag-embedding
# backfill is picked up without a restart.
_MODEL_COVERAGE: set = set()


def model_has_tag_embeddings(model: str) -> bool:
    from app.db import get_pool

    if model in _MODEL_COVERAGE:
        return True
    with get_pool().connection() as conn:
        row = conn.execute(
            "SELECT 1 FROM tag_embeddings WHERE embedding_model = %s LIMIT 1",
            (model,),
        ).fetchone()
    if row is not None:
        _MODEL_COVERAGE.add(model)
        return True
    return False


# Facet-scoped coverage, keyed (model, facet). value_id is unique per facet
# and a facet can be absent for a model that has rows for another facet, so the
# model-scoped probe above cannot answer "does /tags/nearby have geography?".
# Positive-only, same as _MODEL_COVERAGE: a miss is re-probed so a later
# tag-embedding backfill is picked up without a restart.
_FACET_COVERAGE: set = set()


def facet_has_tag_embeddings(model: str, facet: str) -> bool:
    """True when at least one tag_embeddings row exists for (model, facet).

    Distinguishes "this facet is not covered" (degraded, spec §5.2) from
    "covered but nothing cleared the cosine floor" (a legitimate empty result).
    """
    from app.db import get_pool

    key = (model, facet)
    if key in _FACET_COVERAGE:
        return True
    with get_pool().connection() as conn:
        row = conn.execute(
            """SELECT 1 FROM tag_embeddings te
                 JOIN tags t ON t.id = te.tag_id
                WHERE te.embedding_model = %s AND t.facet = %s LIMIT 1""",
            (model, facet),
        ).fetchone()
    if row is not None:
        _FACET_COVERAGE.add(key)
        return True
    return False


def filter_topics(rows, top_k: int, min_cosine: float):
    """Pure: threshold + limit. Split out so the policy is unit-testable."""
    return [(label, cos) for label, cos in rows if cos >= min_cosine][:top_k]


# Deterministic literal names. The cosine match compares the WHOLE query to a
# one-word tag label, so a country spelled out inside a normal question falls
# under the floor and vanishes: "electric buses in India" misses India while
# "India transport" finds it at 0.40. A literal mention is certain, so it is
# added at cosine 1.0 and ranks ahead of the semantic matches. Same facet, same
# downstream lane, no new flag.
_VALUES_SQL = """
    SELECT DISTINCT value_id FROM tags WHERE facet = %(facet)s
"""


@lru_cache(maxsize=8)
def _facet_values(facet: str) -> tuple:
    """The facet's value_id vocabulary, longest first, one cached SELECT per
    facet. Raises on a DB error (the caller records the degradation)."""
    from app.db import get_pool

    with get_pool().connection() as conn:
        rows = conn.execute(_VALUES_SQL, {"facet": facet}).fetchall()
    return tuple(sorted((r[0] for r in rows), key=len, reverse=True))


def match_literal_values(query: str, values) -> list:
    """Pure: the value_ids this query spells out. Longest first, so a longer
    name consumes its span and a nested one is not also emitted ("Papua New
    Guinea" does not also yield "Guinea"). Non-word boundaries both sides, so
    "India" never fires inside "Indian" and "Niger" not inside "Nigeria"."""
    taken: list = []
    out: list = []
    for value in values:  # caller supplies these longest-first
        m = re.search(rf"(?<!\w){re.escape(value)}(?!\w)", query, re.I)
        if m is None:
            continue
        if any(start < m.end() and m.start() < end for start, end in taken):
            continue
        taken.append((m.start(), m.end()))
        out.append((value, 1.0))
    return out


def literal_tags(query: str, facet: str) -> list:
    """Literal [(value_id, 1.0)] matches for one facet."""
    return match_literal_values(query, _facet_values(facet))


def merge_matched(literal, semantic, top_k: int) -> list:
    """Pure: literal matches first, then semantic, deduped by label, capped at
    top_k — so an exact match can never be crowded out of the cap by a diluted
    cosine match."""
    seen = set()
    out = []
    for label, cosine in list(literal) + list(semantic):
        if label in seen:
            continue
        seen.add(label)
        out.append((label, cosine))
    return out[:top_k]


def nearby_tags(query_embedding, facet: str, top_k: int | None = None) -> list:
    """Semantic query→tag match for one facet. Returns [(label, cosine), ...]
    filtered by threshold + top_k (failure-soft, design §4.1).

    `top_k=None` keeps settings.topic_sense_top_k so /query's tag lanes are
    byte-identical; /tags/nearby (experts mode) passes an explicit value."""
    from app.config import get_settings
    from app.db import get_pool

    s = get_settings()
    k = s.topic_sense_top_k if top_k is None else int(top_k)
    qvec = np.array(query_embedding, dtype=np.float32)
    with get_pool().connection() as conn:
        rows = conn.execute(
            _TAG_SQL,
            {"q": qvec, "model": s.embedding_model, "facet": facet,
             "k": max(k * 4, 20)},
        ).fetchall()
    return filter_topics(
        [(label, float(cos)) for label, cos in rows],
        top_k=k,
        min_cosine=s.topic_sense_min_cosine,
    )


def nearby_topics(query_embedding) -> list:
    """Backward-compat wrapper: nearby_tags for the topic facet.
    Kept for attach_topic_suggestions (P1 suggestions, topic-only)."""
    return nearby_tags(query_embedding, "topic")


def attach_topic_suggestions(u: QueryUnderstanding, query: str, embed_model) -> None:
    """Append nearby_topic suggestions to `u`. Failure-soft (spec §5)."""
    if embed_model is None:
        u.degraded.append("topic_sense")
        return
    try:
        from app.config import get_settings

        # tag_embeddings rows only exist for the model the worker embeds
        # with (embed_tags.py hardcodes it) — under any other configured
        # embedding model the cosine query can never match, so skip before
        # paying the query-embedding call.
        if not model_has_tag_embeddings(get_settings().embedding_model):
            u.degraded.append("topic_sense")
            return
        emb = embed_model.get_query_embedding(query)
        for label, _cos in nearby_topics(emb):
            u.suggestions.append(Suggestion(type="nearby_topic", text=label))
    except Exception as exc:  # noqa: BLE001 — never fail a search on topic sensing
        logger.warning(f"topic sense degraded: {exc}")
        u.degraded.append("topic_sense")
