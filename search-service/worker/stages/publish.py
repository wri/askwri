"""Stage: quality gate — record extraction_confidence, then park or restore.

Ingestion never auto-publishes a NEW document (issue #310): it lands at
needs_review and only a human promote (admin UI → /api/admin/documents/[id]/status,
which also triggers /reindex) makes it searchable.

RE-ingest of an already-promoted document is the exception: the parse stage
records the pre-ingest status on the job (ingestion_jobs.prior_status), and a
doc that was 'searchable' going in is restored to 'searchable' — provided the
quality gate still passes — so routine re-ingests (and reingest_all campaigns)
don't silently unpublish the live corpus. A restore refreshes the search
service's in-memory passage context via best-effort POST /reindex, exactly as
the promote route does, because the doc's chunks changed while it stays live.

extraction_confidence heuristic (cheap signals, design §7.9):
  0.4 * (chars/page >= settings.quality_min_chars_per_page, capped at 1)
+ 0.3 * (language detected in supported set)
+ 0.3 * (chunk count > 0)
Score < 0.7 always parks the doc AND the job in needs_review — a degraded
re-parse of a live doc needs human eyes before going back up.
"""
import logging
import os

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


def _refresh_passage_context(external_id: str) -> None:
    """Best-effort POST /reindex so the search service reloads in-memory texts."""
    url = os.getenv("SEARCH_SERVICE_URL", "")
    if not url:
        return
    try:
        import time

        import httpx
        resp = httpx.post(f"{url}/reindex", timeout=10)
        if resp.status_code == 409:
            # already_running: a concurrent publish holds the reindex lock.
            # Retry once after a short pause so this doc's texts are covered
            # by a rebuild that started after its status flip.
            time.sleep(3)
            resp = httpx.post(f"{url}/reindex", timeout=10)
        if not 200 <= resp.status_code < 300:
            logger.warning(
                f"{external_id}: /reindex returned {resp.status_code} — "
                "in-memory passage context not refreshed for this doc"
            )
    except Exception:  # noqa: BLE001 — refresh is best-effort; retrieval lanes are already live
        logger.warning(
            f"{external_id}: /reindex refresh failed "
            "(in-memory passage context not updated)", exc_info=True,
        )


@stage("publish")
def run(document_id):
    with get_pool().connection() as conn:
        doc = fetch_document(conn, document_id)
        score = round(_confidence(conn, document_id, doc["language"]), 3)
        prior_row = conn.execute(
            """SELECT prior_status FROM ingestion_jobs
               WHERE document_id=%s AND status='running'""", (document_id,),
        ).fetchone()
        prior_status = prior_row[0] if prior_row else None
        restore = prior_status == "searchable" and score >= 0.7
        new_status = "searchable" if restore else "needs_review"
        # Never overwrite an admin takedown: a withdrawn doc stays withdrawn.
        cur = conn.execute(
            """UPDATE documents SET status=%s, extraction_confidence=%s,
               updated_at=now() WHERE id=%s AND status <> 'withdrawn'""",
            (new_status, score, document_id))
        if cur.rowcount == 0:
            logger.info(f"{doc['external_id']}: withdrawn — {new_status} skipped")
            return None  # job ends 'done', not parked in review for a withdrawn doc (NEW-P2-4)
        audit_system_event(conn, document_id, "lifecycle",
                           {"status": doc["status"]}, {"status": new_status})
        if score < 0.7:
            logger.warning(f"{doc['external_id']}: confidence {score} -> needs_review (extraction concerns)")
            return "needs_review"
        if restore:
            logger.info(f"{doc['external_id']}: re-ingest — restored to searchable (confidence {score})")
        else:
            logger.info(f"{doc['external_id']}: needs_review (confidence {score}, awaiting human review)")
    if restore:
        _refresh_passage_context(doc["external_id"])
    return None
