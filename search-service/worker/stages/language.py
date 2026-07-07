"""Stage: detect document language; record on documents.

LANGUAGE_MAP extends Phase 0's with Indonesian ('id') — the 2 'Bahasa' docs
mislabeled as 'en' get corrected on re-ingest. zh text is NOT mutated here;
Traditional->Simplified normalization happens at chunk time (embed stage) so
document_texts keeps the original for display (capture-rich principle).
"""
import logging

from app.db import get_pool
from worker.stages import fetch_document, stage

logger = logging.getLogger(__name__)

SUPPORTED = {"en", "es", "zh", "pt", "id"}


def detect(text: str) -> str:
    from langdetect import DetectorFactory, detect as _detect

    DetectorFactory.seed = 0  # deterministic
    sample = text[:5000]
    code = _detect(sample)
    if code.startswith("zh"):
        return "zh"
    return code if code in SUPPORTED else "en"


@stage("language")
def run(document_id):
    with get_pool().connection() as conn:
        doc = fetch_document(conn, document_id)
        row = conn.execute(
            "SELECT full_text FROM document_texts WHERE document_id = %s", (document_id,)
        ).fetchone()
        lang = detect(row[0])
        # Merge the newly-detected language into the existing set; never shrink
        # the array. Design §7.4 ("detect the set present") + §323 ("preserve
        # existing languages"): a re-ingest must not drop a language a doc had.
        # Order: detected primary first, then any pre-existing codes preserved.
        existing = doc["languages"] or []
        merged = list(dict.fromkeys([lang, *existing]))  # dedupe, preserve order
        conn.execute(
            "UPDATE documents SET language=%s, languages=%s, updated_at=now() WHERE id=%s",
            (lang, merged, document_id),
        )
        logger.info(f"doc {document_id}: language={lang}, languages={merged}")
    return None
