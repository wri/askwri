"""Reclassify queue: classify-only re-run worker (issue #323).

A separate queue from ingestion_jobs. Re-classify runs ONLY the classify stage
with topic_only=True (skip non-topic facets — reclassify is topic-focused).
Preserves human overrides (classify already protects source IN ('human','external')).

Claim model: status='queued' rows are claimable; FOR UPDATE SKIP LOCKED makes
concurrent workers safe. Mirrors worker/queue.py's pattern for ingestion_jobs.
"""
import logging

from app.db import get_pool
from worker.stages.classify import run as classify_run

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 2

_CLAIM_SQL = """
    UPDATE reclassify_jobs
    SET status = 'running', updated_at = now()
    WHERE id = (
        SELECT id FROM reclassify_jobs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    RETURNING id, document_id, scope_tag_id
"""


def claim_job(conn):
    """Claim one queued reclassify job. Returns (id, document_id, scope_tag_id) or None.

    Uses FOR UPDATE SKIP LOCKED so concurrent workers never claim the same row.
    The caller owns the connection (tests pass one directly; process_one_reclassify
    opens one from the pool).
    """
    return conn.execute(_CLAIM_SQL).fetchone()


def _mark_done(conn, job_id):
    conn.execute(
        """UPDATE reclassify_jobs SET status='done', error=NULL, updated_at=now()
           WHERE id=%s AND status='running'""",
        (job_id,),
    )


def _mark_failed(conn, job_id, attempts, error_msg):
    """Retry (requeue, attempts+1) until MAX_ATTEMPTS, then status='error'."""
    new_attempts = attempts + 1
    status = "error" if new_attempts >= MAX_ATTEMPTS else "queued"
    conn.execute(
        """UPDATE reclassify_jobs
           SET status=%s, attempts=%s, error=%s, updated_at=now()
           WHERE id=%s AND status='running'""",
        (status, new_attempts, error_msg[:2000], job_id),
    )
    logger.warning(
        "reclassify job %s -> %s (attempt %d): %s",
        job_id, status, new_attempts, error_msg[:200],
    )


def process_one_reclassify() -> bool:
    """Claim and process one reclassify job. Returns True if work was done.

    Claims a job, runs classify.run(document_id, topic_only=True), marks done
    on success. On failure, increments attempts; requeues if < MAX_ATTEMPTS,
    else marks error with the message.
    """
    with get_pool().connection() as conn:
        claimed = claim_job(conn)
        if claimed is None:
            return False

        job_id, document_id, scope_tag_id = claimed
        # Fetch current attempts for the retry counter
        row = conn.execute(
            "SELECT attempts FROM reclassify_jobs WHERE id = %s", (job_id,)
        ).fetchone()
        attempts = row[0] if row else 0

        try:
            logger.info("reclassify job %s doc %s: running classify (topic_only=True)", job_id, document_id)
            classify_run(document_id, topic_only=True)
            _mark_done(conn, job_id)
        except Exception as exc:
            _mark_failed(conn, job_id, attempts, str(exc))

    return True
