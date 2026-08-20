"""Stage: LLM classification.

Embedded facets (topic, geography): retrieve-then-classify — embed the doc
basis, find the top-N candidate tags by cosine similarity, then one LLM call
over the ~20 candidates (enum-constrained) to pick the top-K with confidence.
Other facets (program/office/doc_type): existing full-enum, zero-or-more
(small vocabs — the enum approach is cheap and accurate).

NEVER overwrites rows with source 'human' or 'external' (precedence, design §8).
Writes document_tags with source='llm' and status 'accepted' (confidence >=
settings.tag_confidence_accept) or 'suggested'. Logs a cost estimate before
calling the LLM.
"""
import logging
import math

from app.config import get_settings
from app.db import get_pool
from app.bedrock_embed import embed_one
from worker.llm import chat_json
from worker.stages import fetch_document, stage
from worker.stages.embed_tags import sweep_pending, EMBEDDED_FACETS

logger = logging.getLogger(__name__)

# Per-facet classify config. max_items bounds the LLM response (and the
# delete-and-refresh below). system_prompt is the conservative instruction.
# EMBEDDED_FACETS (imported from embed_tags) is the source of truth for which
# facets use retrieve-then-classify vs the full-enum path in _classify_other_facets.
_FACET_CONFIG = {
    "topic": {
        "max_items": 5,
        "max_tokens": 600,
        "system": (
            "Pick the top topic tags that clearly apply to this document. "
            "Return 0-5 values, each with a confidence in [0,1]. Be conservative."
        ),
    },
    "geography": {
        "max_items": 10,
        # gpt-5.6-luna is a reasoning model: max_completion_tokens covers
        # reasoning + output. 10-item responses need more room than topic's
        # 5, else finish_reason=length with empty content (the retry at 2x
        # 1200 still truncated in the qa backfill 2026-08-20).
        "max_tokens": 3000,
        "system": (
            "Pick the countries and/or continents this document specifically "
            "focuses on. Return 0-10 values, each with a confidence in [0,1]. "
            "Return an empty list if the document is global, methodological, or "
            "conceptual and does not focus on specific countries. Prefer the most "
            "specific geography (a country over its continent); tag a continent "
            "only for region-wide focus. Be conservative: 'focuses on', not "
            "'mentions.'"
        ),
    },
}


def _normalize_facet_picks(
    result: object, facet: str, label_to_id: dict, max_items: int
) -> list[tuple]:
    """Validate the facet response before returning up to max_items picks."""
    if not isinstance(result, dict) or set(result) != {facet}:
        raise RuntimeError(f"malformed {facet} classification response")
    picks = result[facet]
    if not isinstance(picks, list):
        raise RuntimeError(f"malformed {facet} classification response")

    selected: list[tuple] = []
    selected_ids = set()
    for pick in picks:
        if not isinstance(pick, dict) or set(pick) != {"value", "confidence"}:
            raise RuntimeError(f"malformed {facet} classification response")
        label = pick["value"]
        raw_confidence = pick["confidence"]
        if (
            not isinstance(label, str)
            or isinstance(raw_confidence, bool)
            or not isinstance(raw_confidence, (int, float))
        ):
            raise RuntimeError(f"malformed {facet} classification response")
        confidence = float(raw_confidence)
        if not math.isfinite(confidence):
            raise RuntimeError(f"malformed {facet} classification response")

        tag_id = label_to_id.get(label)
        if tag_id is None or tag_id in selected_ids or len(selected) == max_items:
            continue
        selected.append((tag_id, max(0.0, min(1.0, confidence))))
        selected_ids.add(tag_id)
    return selected


def _facet_schema(facet: str, candidate_labels: list[str], max_items: int) -> dict:
    """Build the JSON schema for an embedded-facet LLM call — enum-constrained
    to the candidate labels only."""
    return {
        "type": "object", "additionalProperties": False,
        "properties": {
            facet: {
                "type": "array",
                "maxItems": max_items,
                "items": {
                    "type": "object", "additionalProperties": False,
                    "properties": {
                        "value": {"type": "string", "enum": candidate_labels},
                        "confidence": {"type": "number"},
                    },
                    "required": ["value", "confidence"],
                },
            },
        },
        "required": [facet],
    }


def _other_facets_schema(vocab: dict) -> dict:
    """Build the JSON schema for full-enum facets — full-enum per facet."""
    props = {
        facet: {
            "type": "array",
            "items": {
                "type": "object", "additionalProperties": False,
                "properties": {
                    "value": {"type": "string", "enum": values},
                    "confidence": {"type": "number"},
                },
                "required": ["value", "confidence"],
            },
        }
        for facet, values in vocab.items()
    }
    return {
        "type": "object", "additionalProperties": False,
        "properties": props, "required": list(props),
    }


def _classify_embedded_facet(
    conn, doc, basis: str, protected: set, facet: str, *,
    require_candidates: bool = False,
) -> None:
    """Retrieve-then-classify for an embedded facet (topic or geography).

    1. Embed the doc basis (one Bedrock call).
    2. Find top-N candidate tags by cosine similarity.
    3. One LLM call over the ~20 candidates (enum-constrained) for top-K.
    4. Insert accepted/suggested rows, never overwriting protected rows.
    """
    settings = get_settings()
    cfg = _FACET_CONFIG[facet]
    max_items = cfg["max_items"]

    # Opportunistic sweep: fresh embeddings before classify
    sweep_pending(conn)

    doc_vec = embed_one(basis[:8000])
    # psycopg needs the vector as a string for pgvector
    vec_str = "[" + ",".join(str(v) for v in doc_vec) + "]"

    candidates = conn.execute(
        """SELECT t.id, t.value_id AS label, t.description,
                  COALESCE(
                    (SELECT array_agg(a.alias) FROM tag_aliases a WHERE a.tag_id = t.id),
                    '{}'::text[]
                  ) AS aliases,
                  te.embedding <=> %s::vector AS cosine_distance
           FROM tag_embeddings te
           JOIN tags t ON t.id = te.tag_id
           WHERE t.facet = %s
             AND t.taxonomy_version = 'v1'
             AND te.embedding_model = 'cohere-embed-v4'
           ORDER BY cosine_distance
           LIMIT %s""",
        (vec_str, facet, settings.tag_candidate_top_n),
    ).fetchall()

    if not candidates:
        if require_candidates:
            raise RuntimeError(
                f"classify {doc['external_id']}: no candidate {facet} embeddings"
            )
        logger.warning(
            "classify %s: no candidate %s tags — skipping %s facet",
            doc['external_id'], facet, facet,
        )
        return

    # Build label→id map and candidate labels for the enum schema
    label_to_id: dict[str, str] = {}
    candidate_labels: list[str] = []
    for tag_id, label, _desc, _aliases, distance in candidates:
        label_to_id[label] = tag_id
        candidate_labels.append(label)
        logger.info(
            "classify %s: %s candidate tag_id=%s label=%s cosine_distance=%.6f",
            doc["external_id"], facet, tag_id, label, float(distance),
        )

    # Build candidate description for the user prompt
    candidate_lines = []
    for _id, label, desc, aliases, _distance in candidates:
        details = []
        if aliases:
            details.append(f"aka: {', '.join(aliases)}")
        if desc:
            details.append(desc)
        suffix = f" ({'; '.join(details)})" if details else ""
        candidate_lines.append(f"- {label}{suffix}")

    logger.info(
        "classify %s: %s 1 LLM call, %d candidates, model=%s",
        doc['external_id'], facet, len(candidate_labels), settings.worker_llm_model,
    )

    result = chat_json(
        system=cfg["system"],
        user=(
            f"Title: {doc['title']}\n\n"
            f"Summary/content:\n{basis[:8000]}\n\n"
            f"Candidate {facet}s:\n" + "\n".join(candidate_lines)
        ),
        schema=_facet_schema(facet, candidate_labels, max_items),
        model=settings.worker_llm_model,
        max_tokens=cfg["max_tokens"],
    )

    selected = _normalize_facet_picks(result, facet, label_to_id, max_items)
    selected_ids = {tag_id for tag_id, _confidence in selected}

    conn.execute(
        """DELETE FROM document_tags dt
           USING tags t
           WHERE dt.tag_id = t.id
             AND dt.document_id = %s
             AND dt.source = 'llm'
             AND t.facet = %s
             AND t.taxonomy_version = 'v1'
             AND NOT (dt.tag_id = ANY(%s::uuid[]))""",
        (doc["id"], facet, list(selected_ids)),
    )

    for tag_id, conf in selected:
        if tag_id in protected:
            continue
        status = "accepted" if conf >= settings.tag_confidence_accept else "suggested"
        conn.execute(
            """INSERT INTO document_tags (document_id, tag_id, source, confidence, model_version, status)
               VALUES (%s, %s, 'llm', %s, %s, %s)
               ON CONFLICT (document_id, tag_id) DO UPDATE
               SET confidence = EXCLUDED.confidence,
                   model_version = EXCLUDED.model_version,
                   status = EXCLUDED.status
               WHERE document_tags.source = 'llm'""",
            (doc['id'], tag_id, conf, settings.worker_llm_model, status),
        )


def _classify_other_facets(conn, doc, basis: str, protected: set) -> None:
    """Full-enum classification for non-embedded facets (program/office/doc_type).

    Small vocabs → one LLM call with enum over the whole vocab per facet.
    """
    settings = get_settings()
    vocab: dict[str, list] = {}
    other_tag_ids: dict[tuple, str] = {}
    for tag_id, facet, value in conn.execute(
        """SELECT id, facet, value_id FROM tags
           WHERE taxonomy_version = 'v1' AND facet != ALL(%s)
           ORDER BY facet, value_id""",
        (list(EMBEDDED_FACETS),),
    ).fetchall():
        vocab.setdefault(facet, []).append(value)
        other_tag_ids[(facet, value)] = tag_id

    if not vocab:
        return  # no non-embedded tags — nothing to do

    logger.info(
        "classify %s: %d non-embedded facet(s), 1 LLM call, model=%s",
        doc['external_id'], len(vocab), settings.worker_llm_model,
    )

    result = chat_json(
        system=(
            "Classify the document against the controlled vocabulary. "
            "For each facet pick zero or more values that clearly apply, "
            "each with a confidence in [0,1]. Be conservative."
        ),
        user=f"Title: {doc['title']}\n\nSummary/content:\n{basis}",
        schema=_other_facets_schema(vocab),
        model=settings.worker_llm_model,
    )

    for facet, picks in result.items():
        for pick in picks:
            tag_id = other_tag_ids.get((facet, pick["value"]))
            if tag_id is None or tag_id in protected:
                continue
            conf = max(0.0, min(1.0, float(pick["confidence"])))
            status = "accepted" if conf >= settings.tag_confidence_accept else "suggested"
            conn.execute(
                """INSERT INTO document_tags (document_id, tag_id, source, confidence, model_version, status)
                   VALUES (%s, %s, 'llm', %s, %s, %s)
                   ON CONFLICT (document_id, tag_id) DO NOTHING""",
                (doc['id'], tag_id, conf, settings.worker_llm_model, status),
            )


@stage("classify")
def run(document_id, facets: list[str] | None = None, topic_only: bool = False):
    """Classify a document against the taxonomy.

    - facets=None, topic_only=False (default, ingest pipeline): classify all
      facets — embedded facets (topic, geography) via retrieve-then-classify,
      others via full-enum.
    - facets=['topic'] (or legacy topic_only=True, used by reclassify jobs):
      classify only the topic facet.
    - facets=['geography'] (used by the geography backfill script): classify
      only the geography facet.

    When `facets` is set, missing candidate embeddings raise (an explicit
    request should fail loudly rather than silently skip). When `facets` is
    None (ingest), a missing embedding logs and skips that facet.

    `settings.classify_topic_only` (legacy deploy knob) restricts an ingest
    run to the topic facet only; it does NOT enable geography.
    """
    settings = get_settings()
    if topic_only:
        facets = ["topic"]

    with get_pool().connection() as conn:
        doc = fetch_document(conn, document_id)

        # Load basis: prefer en/long summary, else first 8000 chars of full_text
        summary = conn.execute(
            """SELECT text FROM document_summaries
               WHERE document_id = %s AND language = 'en' AND kind = 'long'""",
            (document_id,),
        ).fetchone()
        basis = summary[0] if summary else conn.execute(
            "SELECT left(full_text, 8000) FROM document_texts WHERE document_id = %s",
            (document_id,),
        ).fetchone()[0]

        # Protected rows: source IN ('human', 'external') — never overwritten
        protected = {
            r[0] for r in conn.execute(
                """SELECT tag_id FROM document_tags
                   WHERE document_id = %s AND source IN ('human', 'external')""",
                (document_id,),
            ).fetchall()
        }

        # Determine which embedded facets to run
        if facets is not None:
            embedded = [f for f in facets if f in EMBEDDED_FACETS]
            run_others = False
        elif settings.classify_topic_only:
            embedded = ["topic"]
            run_others = False
        else:
            embedded = list(EMBEDDED_FACETS)
            run_others = True

        for facet in embedded:
            _classify_embedded_facet(
                conn, doc, basis, protected, facet,
                require_candidates=(facets is not None),
            )

        if run_others:
            _classify_other_facets(conn, doc, basis, protected)

    return None
