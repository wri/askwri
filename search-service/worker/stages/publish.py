"""Stage: quality gate — record extraction_confidence and park the doc for review.

Ingestion never auto-publishes (issue #310): every document lands at
needs_review and only a human promote (admin UI → /api/admin/documents/[id]/status,
which also triggers /reindex) makes it searchable.

extraction_confidence heuristic (cheap signals, design §7.9):
  0.4 * (chars/page >= settings.quality_min_chars_per_page, capped at 1)
+ 0.3 * (language detected in supported set)
+ 0.3 * (chunk count > 0)
The job is parked in the review state only when the score is < 0.7 (extraction
concerns need triage); a clean doc's job ends 'done' while the document itself
still awaits human review.
"""
import logging

from app.config import get_settings
from app.db import get_pool
from worker.stages import audit_system_event, fetch_document, stage
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
        # Never overwrite an admin takedown: a withdrawn doc stays withdrawn.
        cur = conn.execute(
            """UPDATE documents SET status='needs_review', extraction_confidence=%s,
               updated_at=now() WHERE id=%s AND status <> 'withdrawn'""", (score, document_id))
        if cur.rowcount == 0:
            logger.info(f"{doc['external_id']}: withdrawn — needs_review skipped")
            return None  # job ends 'done', not parked in review for a withdrawn doc (NEW-P2-4)
        audit_system_event(conn, document_id, "lifecycle",
                           {"status": doc["status"]}, {"status": "needs_review"})
        if score < 0.7:
            logger.warning(f"{doc['external_id']}: confidence {score} -> needs_review (extraction concerns)")
            return "needs_review"
        logger.info(f"{doc['external_id']}: needs_review (confidence {score}, awaiting human review)")
    return None
