"""Reclassify queue: classify-only re-run worker (issue #323).

A separate queue from ingestion_jobs. Re-classify runs ONLY the classify stage
with topic_only=True (skip non-topic facets — reclassify is topic-focused).
Preserves human overrides (classify already protects source IN ('human','external')).

Claim model: status='queued' rows are claimable; FOR UPDATE SKIP LOCKED makes
concurrent workers safe. Mirrors worker/queue.py's pattern for ingestion_jobs.
"""
from concurrent.futures import ThreadPoolExecutor
import logging

from psycopg.types.json import Jsonb

from app.db import get_pool
from worker.stages.classify import run as classify_run

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 2
EST_PER_DOC_COST = 0.0008

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
    RETURNING id, document_id, scope_tag_id, run_id
"""


def claim_job(conn):
    """Return ``(id, document_id, scope_tag_id, run_id)`` for one queued job.

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
    return status


def _audit_completed_run(conn, run_id) -> bool:
    """Write the one completion audit after every job in ``run_id`` is terminal.

    The transaction-scoped lock serializes final-job checks across worker
    threads and replicas. The audit existence check makes retries idempotent.
    """
    conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s::text, 0))",
        (run_id,),
    )
    has_open_jobs = conn.execute(
        """SELECT EXISTS (
               SELECT 1 FROM reclassify_jobs
               WHERE run_id=%s AND status IN ('queued', 'running')
           )""",
        (run_id,),
    ).fetchone()[0]
    if has_open_jobs:
        return False

    already_audited = conn.execute(
        """SELECT EXISTS (
               SELECT 1 FROM audit_log
               WHERE source='system'
                 AND action='reclassify_run'
                 AND entity_type='reclassify_run'
                 AND entity_id=%s
           )""",
        (run_id,),
    ).fetchone()[0]
    if already_audited:
        return False

    total, done, error = conn.execute(
        """SELECT count(*)::int,
                  count(*) FILTER (WHERE status='done')::int,
                  count(*) FILTER (WHERE status='error')::int
           FROM reclassify_jobs
           WHERE run_id=%s""",
        (run_id,),
    ).fetchone()
    if total == 0:
        return False

    after = {
        "runId": str(run_id),
        "total": total,
        "done": done,
        "error": error,
        "estCost": round(total * EST_PER_DOC_COST, 4),
    }
    conn.execute(
        """INSERT INTO audit_log
               (source, action, entity_type, entity_id, after)
           VALUES ('system', 'reclassify_run', 'reclassify_run', %s, %s)""",
        (run_id, Jsonb(after)),
    )
    return True


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

        job_id, document_id, _scope_tag_id, run_id = claimed

    try:
        logger.info(
            "reclassify job %s doc %s run %s: running classify (topic_only=True)",
            job_id,
            document_id,
            run_id,
        )
        classify_run(document_id, topic_only=True)
    except Exception as exc:
        with get_pool().connection() as conn:
            row = conn.execute(
                "SELECT attempts FROM reclassify_jobs WHERE id = %s", (job_id,)
            ).fetchone()
            attempts = row[0] if row else 0
            status = _mark_failed(conn, job_id, attempts, str(exc))
            if status == "error":
                _audit_completed_run(conn, run_id)
    else:
        with get_pool().connection() as conn:
            _mark_done(conn, job_id)
            _audit_completed_run(conn, run_id)

    return True


def process_reclassify_batch(concurrency: int) -> int:
    """Run at most ``concurrency`` independent SKIP LOCKED claim attempts."""
    bounded = max(0, int(concurrency))
    if bounded == 0:
        return 0
    with ThreadPoolExecutor(max_workers=bounded) as executor:
        results = executor.map(lambda _slot: process_one_reclassify(), range(bounded))
        return sum(bool(worked) for worked in results)
