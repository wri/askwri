"""Stage: LLM classification constrained to the controlled vocabulary.

Reads the live taxonomy from `tags`; emits per-facet selections with
confidence. Writes document_tags with source='llm' and status
'accepted' (confidence >= settings.tag_confidence_accept) or 'suggested'.
NEVER touches rows with source 'human' or 'external' (precedence, design §8).
Logs a cost estimate before calling the LLM.
"""
import logging

from app.config import get_settings
from app.db import get_pool
from worker.llm import chat_json
from worker.stages import fetch_document, stage

logger = logging.getLogger(__name__)


def _schema(vocab: dict) -> dict:
    props = {
        facet: {
            "type": "array",
            "items": {"type": "object", "additionalProperties": False,
                      "properties": {"value": {"type": "string", "enum": values},
                                     "confidence": {"type": "number"}},
                      "required": ["value", "confidence"]},
        }
        for facet, values in vocab.items()
    }
    return {"type": "object", "additionalProperties": False,
            "properties": props, "required": list(props)}


@stage("classify")
def run(document_id):
    settings = get_settings()
    with get_pool().connection() as conn:
        doc = fetch_document(conn, document_id)
        vocab: dict[str, list] = {}
        tag_ids: dict[tuple, object] = {}
        for tag_id, facet, value in conn.execute(
            "SELECT id, facet, value_id FROM tags WHERE taxonomy_version='v1' ORDER BY facet, value_id"
        ).fetchall():
            vocab.setdefault(facet, []).append(value)
            tag_ids[(facet, value)] = tag_id
        if not vocab:
            logger.warning("classify: empty taxonomy — skipping")
            return None
        summary = conn.execute(
            """SELECT text FROM document_summaries
               WHERE document_id=%s AND language='en' AND kind='long'""", (document_id,)
        ).fetchone()
        basis = summary[0] if summary else conn.execute(
            "SELECT left(full_text, 8000) FROM document_texts WHERE document_id=%s", (document_id,)
        ).fetchone()[0]
        logger.info(f"classify {doc['external_id']}: 1 LLM call, model={settings.worker_llm_model}")
        result = chat_json(
            system=("Classify the document against the controlled vocabulary. For each facet pick zero or "
                    "more values that clearly apply, each with a confidence in [0,1]. Be conservative."),
            user=f"Title: {doc['title']}\n\nSummary/content:\n{basis}",
            schema=_schema(vocab), model=settings.worker_llm_model,
        )
        protected = {r[0] for r in conn.execute(
            """SELECT tag_id FROM document_tags
               WHERE document_id=%s AND source IN ('human','external')""", (document_id,)
        ).fetchall()}
        for facet, picks in result.items():
            for pick in picks:
                tag_id = tag_ids.get((facet, pick["value"]))
                if tag_id is None or tag_id in protected:
                    continue
                conf = max(0.0, min(1.0, float(pick["confidence"])))
                status = "accepted" if conf >= settings.tag_confidence_accept else "suggested"
                conn.execute(
                    """INSERT INTO document_tags (document_id, tag_id, source, confidence, model_version, status)
                       VALUES (%s,%s,'llm',%s,%s,%s)
                       ON CONFLICT (document_id, tag_id) DO NOTHING""",
                    (document_id, tag_id, conf, settings.worker_llm_model, status),
                )
    return None
