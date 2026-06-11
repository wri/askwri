"""Stage: generate native + English summaries (long + short).

Summarize-from-source in the target language (design §7.5) — never
translate-the-summary. Skips languages/kinds that already exist (idempotent;
also preserves CSV-imported 'external' summaries: they satisfy the existence
check, and the worker never overwrites rows it didn't write).
"""
import logging

from app.config import get_settings
from app.db import get_pool
from worker.llm import chat_json
from worker.stages import fetch_document, stage

logger = logging.getLogger(__name__)

_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {"long": {"type": "string"}, "short": {"type": "string"}},
    "required": ["long", "short"],
}
_LANG_NAMES = {"en": "English", "es": "Spanish", "zh": "Simplified Chinese", "pt": "Portuguese", "id": "Indonesian"}


def _summarize(text: str, title: str, lang: str, model: str) -> dict:
    return chat_json(
        system=(f"You summarize research publications in {_LANG_NAMES.get(lang, 'English')}. "
                "Return JSON with 'long' (120-180 words) and 'short' (max 40 words) summaries "
                "written in that language, faithful to the source."),
        user=f"Title: {title}\n\nDocument text (truncated):\n{text[:24000]}",
        schema=_SCHEMA, model=model,
    )


@stage("summarize")
def run(document_id):
    settings = get_settings()
    with get_pool().connection() as conn:
        doc = fetch_document(conn, document_id)
        text = conn.execute(
            "SELECT full_text FROM document_texts WHERE document_id=%s", (document_id,)
        ).fetchone()[0]
        existing = {(r[0], r[1]) for r in conn.execute(
            "SELECT language, kind FROM document_summaries WHERE document_id=%s", (document_id,)
        ).fetchall()}
        targets = {doc["language"], "en"}
        for lang in sorted(targets):
            if {(lang, "long"), (lang, "short")} <= existing:
                continue
            result = _summarize(text, doc["title"] or doc["external_id"], lang, settings.worker_llm_model)
            for kind in ("long", "short"):
                if (lang, kind) in existing:
                    continue
                conn.execute(
                    """INSERT INTO document_summaries (document_id, language, kind, text, source, model_version)
                       VALUES (%s,%s,%s,%s,'generated',%s)""",
                    (document_id, lang, kind, result[kind], settings.worker_llm_model),
                )
        # title_en convenience (design §7.5) when missing and doc is non-English
        if doc["language"] != "en":
            conn.execute(
                """UPDATE documents SET title_en = COALESCE(title_en, title), updated_at=now()
                   WHERE id=%s""", (document_id,))
    return None
