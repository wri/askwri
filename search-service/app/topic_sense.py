"""Query-to-topic sensing via tag_embeddings cosine (design §4.1).

The query embedding is looked up through the SAME embed model instance the
dense lane used, so after stage 1 the call is an LRU cache hit — zero extra
Bedrock calls in the normal path.

Invariant 2: output is SUGGESTIONS ONLY (nearby_topic). Never facets.
"""
import logging

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


def filter_topics(rows, top_k: int, min_cosine: float):
    """Pure: threshold + limit. Split out so the policy is unit-testable."""
    return [(label, cos) for label, cos in rows if cos >= min_cosine][:top_k]


def nearby_tags(query_embedding, facet: str) -> list:
    """Semantic query→tag match for one facet. Returns [(label, cosine), ...]
    filtered by threshold + top_k (failure-soft, design §4.1)."""
    from app.config import get_settings
    from app.db import get_pool

    s = get_settings()
    qvec = np.array(query_embedding, dtype=np.float32)
    with get_pool().connection() as conn:
        rows = conn.execute(
            _TAG_SQL,
            {"q": qvec, "model": s.embedding_model, "facet": facet,
             "k": max(s.topic_sense_top_k * 4, 20)},
        ).fetchall()
    return filter_topics(
        [(label, float(cos)) for label, cos in rows],
        top_k=s.topic_sense_top_k,
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
