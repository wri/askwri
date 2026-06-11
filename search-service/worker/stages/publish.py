"""Stage: quality gate, then flip to searchable and refresh BM25.

extraction_confidence heuristic (cheap signals, design §7.9):
  0.4 * (chars/page >= settings.quality_min_chars_per_page, capped at 1)
+ 0.3 * (language detected in supported set)
+ 0.3 * (chunk count > 0)
< 0.7 -> needs_review (document + job), else searchable + best-effort
POST {SEARCH_SERVICE_URL}/reindex so the BM25 lane picks the doc up.
"""
import logging
import os

from app.config import get_settings
from app.db import get_pool
from worker.stages import fetch_document, stage
from worker.stages.language import SUPPORTED

logger = logging.getLogger(__name__)


def _confidence(conn, document_id, language) -> float:
    settings = get_settings()
    chars, pages = conn.execute(
        """SELECT char_count, GREATEST(jsonb_array_length(page_boundaries), 1)
           FROM document_texts WHERE document_id=%s""", (document_id,),
    ).fetchone()
    chunks = conn.execute(
        "SELECT count(*) FROM document_chunks WHERE document_id=%s", (document_id,)
    ).fetchone()[0]
    density = min((chars / pages) / settings.quality_min_chars_per_page, 1.0)
    return 0.4 * density + 0.3 * (1.0 if language in SUPPORTED else 0.0) + 0.3 * (1.0 if chunks else 0.0)


@stage("publish")
def run(document_id):
    with get_pool().connection() as conn:
        doc = fetch_document(conn, document_id)
        score = round(_confidence(conn, document_id, doc["language"]), 3)
        if score < 0.7:
            # Never overwrite an admin takedown: a withdrawn doc stays withdrawn.
            conn.execute(
                """UPDATE documents SET status='needs_review', extraction_confidence=%s,
                   updated_at=now() WHERE id=%s AND status <> 'withdrawn'""", (score, document_id))
            logger.warning(f"{doc['external_id']}: confidence {score} -> needs_review")
            return "needs_review"
        cur = conn.execute(
            """UPDATE documents SET status='searchable', extraction_confidence=%s,
               updated_at=now() WHERE id=%s AND status <> 'withdrawn'""", (score, document_id))
        if cur.rowcount == 0:
            logger.info(f"{doc['external_id']}: withdrawn — publishing skipped")
            return None
        logger.info(f"{doc['external_id']}: searchable (confidence {score})")
    url = os.getenv("SEARCH_SERVICE_URL", "")
    if url:
        try:
            import httpx
            httpx.post(f"{url}/reindex", timeout=10)
        except Exception as exc:  # noqa: BLE001 — refresh is best-effort; dense lane is already live
            logger.warning(f"/reindex refresh failed (BM25 stale until restart): {exc}")
    return None
