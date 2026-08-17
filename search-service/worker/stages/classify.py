"""Stage: LLM classification.

Topic facet: retrieve-then-classify — embed the doc basis, find the top-N
candidate topic tags by cosine similarity, then one LLM call over the ~20
candidates (enum-constrained) to pick the top-5 with confidence.
Other facets (program/office/doc_type): existing full-enum, zero-or-more
(small vocabs — the enum approach is cheap and accurate).

NEVER overwrites rows with source 'human' or 'external' (precedence, design §8).
Writes document_tags with source='llm' and status 'accepted' (confidence >=
settings.tag_confidence_accept) or 'suggested'. Logs a cost estimate before
calling the LLM.
"""
import logging

from app.config import get_settings
from app.db import get_pool
from app.bedrock_embed import embed_one
from worker.llm import chat_json
from worker.stages import fetch_document, stage
from worker.stages.embed_tags import sweep_pending

logger = logging.getLogger(__name__)


def _topic_schema(candidate_labels: list[str]) -> dict:
    """Build the JSON schema for the topic LLM call — enum-constrained to the
    candidate labels only."""
    return {
        "type": "object", "additionalProperties": False,
        "properties": {
            "topic": {
                "type": "array",
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
        "required": ["topic"],
    }


def _other_facets_schema(vocab: dict) -> dict:
    """Build the JSON schema for non-topic facets — full-enum per facet."""
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


def _classify_topic(conn, doc, basis: str, protected: set) -> None:
    """Retrieve-then-classify for the topic facet.

    1. Embed the doc basis (one Bedrock call).
    2. Find top-N candidate topic tags by cosine similarity.
    3. One LLM call over the ~20 candidates (enum-constrained) for top-5.
    4. Insert accepted/suggested rows, never overwriting protected rows.
    """
    settings = get_settings()
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
                  ) AS aliases
           FROM tag_embeddings te
           JOIN tags t ON t.id = te.tag_id
           WHERE t.facet = 'topic'
             AND t.taxonomy_version = 'v1'
             AND te.embedding_model = 'cohere-embed-v4'
           ORDER BY te.embedding <=> %s::vector
           LIMIT %s""",
        (vec_str, settings.tag_candidate_top_n),
    ).fetchall()

    if not candidates:
        logger.warning("classify %s: no candidate topic tags — skipping topic facet", doc['external_id'])
        return

    # Build label→id map and candidate labels for the enum schema
    label_to_id: dict[str, str] = {}
    candidate_labels: list[str] = []
    for tag_id, label, _desc, _aliases in candidates:
        label_to_id[label] = tag_id
        candidate_labels.append(label)

    # Build candidate description for the user prompt
    candidate_lines = []
    for _id, label, desc, aliases in candidates:
        parts = [label]
        if aliases:
            parts.append(f"aka: {', '.join(aliases)}")
        if desc:
            parts.append(desc)
        candidate_lines.append(" - " + " (".join(parts[:1]) + ("; " + "; ".join(parts[1:]) if len(parts) > 1 else "") + (")" if len(parts) > 1 else ""))

    logger.info(
        "classify %s: topic 1 LLM call, %d candidates, model=%s",
        doc['external_id'], len(candidate_labels), settings.worker_llm_model,
    )

    result = chat_json(
        system=(
            "Pick the top topic tags that clearly apply to this document. "
            "Return 0–5 values, each with a confidence in [0,1]. Be conservative."
        ),
        user=(
            f"Title: {doc['title']}\n\n"
            f"Summary/content:\n{basis[:8000]}\n\n"
            f"Candidate topics:\n" + "\n".join(candidate_lines)
        ),
        schema=_topic_schema(candidate_labels),
        model=settings.worker_llm_model,
        max_tokens=600,
    )

    for pick in result.get("topic", []):
        tag_id = label_to_id.get(pick["value"])
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


def _classify_other_facets(conn, doc, basis: str, protected: set, tag_ids: dict) -> None:
    """Existing full-enum classification for non-topic facets (program/office/doc_type).

    Small vocabs → one LLM call with enum over the whole vocab per facet.
    """
    settings = get_settings()
    vocab: dict[str, list] = {}
    other_tag_ids: dict[tuple, str] = {}
    for tag_id, facet, value in conn.execute(
        """SELECT id, facet, value_id FROM tags
           WHERE taxonomy_version = 'v1' AND facet != 'topic'
           ORDER BY facet, value_id"""
    ).fetchall():
        vocab.setdefault(facet, []).append(value)
        other_tag_ids[(facet, value)] = tag_id

    if not vocab:
        return  # no non-topic tags — nothing to do

    tag_ids.update(other_tag_ids)

    logger.info(
        "classify %s: %d non-topic facet(s), 1 LLM call, model=%s",
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
def run(document_id, topic_only: bool = False):
    """Classify a document against the taxonomy.

    - topic_only=False (default, used by the ingest pipeline): classify all
      facets — topic via retrieve-then-classify, others via full-enum.
    - topic_only=True (used by reclassify jobs): classify only the topic facet,
      skip non-topic facets (cheaper, focused re-tag).
    """
    settings = get_settings()
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

        # Topic facet: always classify (retrieve-then-classify)
        _classify_topic(conn, doc, basis, protected)

        # Non-topic facets: skip when topic_only=True
        if not topic_only and not settings.classify_topic_only:
            tag_ids: dict[tuple, str] = {}
            _classify_other_facets(conn, doc, basis, protected, tag_ids)

    return None
