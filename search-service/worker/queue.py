"""ingestion_jobs queue operations. One job = one document through all stages.

Claim model: status='queued' rows are claimable; FOR UPDATE SKIP LOCKED makes
concurrent workers safe. `stage` records the last COMPLETED stage (NULL at
enqueue); status transitions: queued -> running -> queued (next stage) ...
-> done | needs_review | error.
"""
import logging
import uuid
from typing import Optional, Tuple

from psycopg.types.json import Jsonb

from app.db import get_pool
from worker.stages import STAGE_ORDER

logger = logging.getLogger(__name__)

_CLAIM_SQL = """
    UPDATE ingestion_jobs
    SET status = 'running', updated_at = now()
    WHERE id = (
        SELECT id FROM ingestion_jobs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    RETURNING id, document_id, stage, attempts
"""


def enqueue(conn, document_id, model_versions: dict | None = None) -> uuid.UUID:
    """Insert a queued job for a document (idempotent: returns the open job if one exists).

    Open = queued|running only. A parked needs_review job does NOT block a fresh
    drop of fixed content. The partial unique index ingestion_jobs_one_open_per_doc
    is the arbiter: ON CONFLICT (document_id) WHERE <index predicate> makes the
    open-job check and the insert one atomic statement (no enqueue race) — same
    approach as reenqueueIngestion in src/db/queries/documentsAdmin.ts.
    """
    job_id = uuid.uuid4()
    row = conn.execute(
        """INSERT INTO ingestion_jobs (id, document_id, stage, status, model_versions)
           VALUES (%s, %s, NULL, 'queued', %s)
           ON CONFLICT (document_id) WHERE status IN ('queued', 'running') DO NOTHING
           RETURNING id""",
        (job_id, document_id, Jsonb(model_versions or {})),
    ).fetchone()
    if row:
        return row[0]
    existing = conn.execute(
        """SELECT id FROM ingestion_jobs
           WHERE document_id = %s AND status IN ('queued', 'running')""",
        (document_id,),
    ).fetchone()
    return existing[0]


def claim_job() -> Optional[Tuple]:
    with get_pool().connection() as conn:
        return conn.execute(_CLAIM_SQL).fetchone()


def reap_stale_jobs(conn, max_age_minutes: int = 15) -> list:
    """Requeue jobs stuck in 'running' (worker died mid-stage). Stages are
    idempotent, so a requeue is safe. updated_at is touched on every transition
    (claim/advance/fail), so age is measured from the last transition. Returns
    the reclaimed job ids."""
    rows = conn.execute(
        """UPDATE ingestion_jobs SET status = 'queued'
           WHERE status = 'running' AND updated_at < now() - make_interval(mins => %s)
           RETURNING id""",
        (max_age_minutes,),
    ).fetchall()
    return [r[0] for r in rows]


def next_stage(completed_stage: Optional[str]) -> str:
    if completed_stage is None:
        return STAGE_ORDER[0]
    return STAGE_ORDER[STAGE_ORDER.index(completed_stage) + 1]


def advance(job_id, completed_stage: str) -> None:
    """Stage done; requeue for the next stage."""
    with get_pool().connection() as conn:
        conn.execute(
            """UPDATE ingestion_jobs
               SET status = 'queued', stage = %s, attempts = 0, error = NULL, updated_at = now()
               WHERE id = %s""",
            (completed_stage, job_id),
        )


def mark_done(job_id, completed_stage: str) -> None:
    with get_pool().connection() as conn:
        conn.execute(
            "UPDATE ingestion_jobs SET status='done', stage=%s, error=NULL, updated_at=now() WHERE id=%s",
            (completed_stage, job_id),
        )


def mark_needs_review(job_id, at_stage: str) -> None:
    with get_pool().connection() as conn:
        conn.execute(
            "UPDATE ingestion_jobs SET status='needs_review', stage=%s, updated_at=now() WHERE id=%s",
            (at_stage, job_id),
        )


def mark_failed(job_id, at_stage: str, error: str, attempts: int, max_attempts: int) -> None:
    """Retry (requeue, attempts+1) until max_attempts, then status='error'."""
    new_attempts = attempts + 1
    status = "error" if new_attempts >= max_attempts else "queued"
    with get_pool().connection() as conn:
        conn.execute(
            """UPDATE ingestion_jobs
               SET status=%s, attempts=%s, error=%s, updated_at=now()
               WHERE id=%s""",
            (status, new_attempts, error[:2000], job_id),
        )
    logger.warning(f"job {job_id} stage '{at_stage}' -> {status} (attempt {new_attempts}): {error[:200]}")
