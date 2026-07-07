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
        # Load existing summaries with their source so we can decide per-row:
        #   source='external'/'human' → protected, never overwritten (precedence, §8)
        #   source='generated' → regenerated on re-ingest (NEW-P1-A: no stale summaries)
        existing = {
            (r[0], r[1]): r[2]
            for r in conn.execute(
                "SELECT language, kind, source FROM document_summaries WHERE document_id=%s",
                (document_id,),
            ).fetchall()
        }
        targets = {doc["language"], "en"}
        for lang in sorted(targets):
            # Is every (lang, kind) already present AND protected? Then skip the LLM call.
            protected_complete = all(
                (lang, kind) in existing and existing[(lang, kind)] in ("external", "human")
                for kind in ("long", "short")
            )
            if protected_complete:
                continue
            result = _summarize(text, doc["title"] or doc["external_id"], lang, settings.worker_llm_model)
            for kind in ("long", "short"):
                src = existing.get((lang, kind))
                if src in ("external", "human"):
                    continue  # protected: never overwrite curated/CSV summaries
                if src == "generated":
                    # Regenerate: delete the stale generated row, re-insert (NEW-P1-A)
                    conn.execute(
                        "DELETE FROM document_summaries WHERE document_id=%s AND language=%s AND kind=%s",
                        (document_id, lang, kind),
                    )
                conn.execute(
                    """INSERT INTO document_summaries (document_id, language, kind, text, source, model_version)
                       VALUES (%s,%s,%s,%s,'generated',%s)""",
                    (document_id, lang, kind, result[kind], settings.worker_llm_model),
                )
        # title_en convenience (design §6: always populated; §7.5). Set for ALL
        # docs (not just non-English) so worker-ingested EN docs also have it
        # (NEW-P2-8). True translation is deferred (§10.4) — COALESCE to native title.
        conn.execute(
            """UPDATE documents SET title_en = COALESCE(title_en, title), updated_at=now()
               WHERE id=%s""", (document_id,))
    return None
