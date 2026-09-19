"""Reclassify queue: classify-only re-run worker (issue #323).

A separate queue from ingestion_jobs. Re-classify runs ONLY the classify stage
with topic_only=True (skip non-topic facets — reclassify is topic-focused).
Preserves human overrides (classify already protects source IN ('human','external')).

Claim model: status='queued' rows are claimable; FOR UPDATE SKIP LOCKED makes
concurrent workers safe. Mirrors worker/queue.py's pattern for ingestion_jobs.
"""
from concurrent.futures import ThreadPoolExecutor
import logging
import threading
import uuid

from psycopg.types.json import Jsonb

from app.config import get_settings
from app.db import get_pool
from worker.stages.classify import run as classify_run

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 2
EST_PER_DOC_COST = 0.0008

_CLAIM_SQL = """
    UPDATE reclassify_jobs
    SET status = 'running', error = %s, updated_at = now()
    WHERE id = (
        SELECT id FROM reclassify_jobs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    RETURNING id, document_id, scope_tag_id, run_id
"""


def claim_job(conn, lease_token=None):
    """Return ``(id, document_id, scope_tag_id, run_id)`` for one queued job.

    Uses FOR UPDATE SKIP LOCKED so concurrent workers never claim the same row.
    The caller owns the connection (tests pass one directly; process_one_reclassify
    opens one from the pool).
    """
    return conn.execute(_CLAIM_SQL, (lease_token,)).fetchone()


def _mark_done(conn, job_id, lease_token=None):
    params = [job_id]
    lease_guard = ""
    if lease_token is not None:
        lease_guard = " AND error=%s"
        params.append(lease_token)
    return conn.execute(
        """UPDATE reclassify_jobs SET status='done', error=NULL, updated_at=now()
           WHERE id=%s AND status='running'""" + lease_guard + " RETURNING id",
        params,
    ).fetchone() is not None


def _mark_failed(conn, job_id, attempts, error_msg, lease_token=None):
    """Retry (requeue, attempts+1) until MAX_ATTEMPTS, then status='error'."""
    new_attempts = attempts + 1
    status = "error" if new_attempts >= MAX_ATTEMPTS else "queued"
    params = [status, new_attempts, error_msg[:2000], job_id]
    lease_guard = ""
    if lease_token is not None:
        lease_guard = " AND error=%s"
        params.append(lease_token)
    updated = conn.execute(
        """UPDATE reclassify_jobs
           SET status=%s, attempts=%s, error=%s, updated_at=now()
           WHERE id=%s AND status='running'""" + lease_guard + " RETURNING id",
        params,
    ).fetchone()
    if updated is None:
        return None
    logger.warning(
        "reclassify job %s -> %s (attempt %d): %s",
        job_id, status, new_attempts, error_msg[:200],
    )
    return status


def _renew_lease(job_id, lease_token=None) -> bool:
    """Refresh one live claim, optionally fencing it to its owner token."""
    params = [job_id]
    lease_guard = ""
    if lease_token is not None:
        lease_guard = " AND error=%s"
        params.append(lease_token)
    with get_pool().connection() as conn:
        return conn.execute(
            """UPDATE reclassify_jobs SET updated_at=now()
               WHERE id=%s AND status='running'"""
            + lease_guard
            + " RETURNING id",
            params,
        ).fetchone() is not None


def _heartbeat_lease(job_id, lease_token, stop_event, interval_seconds) -> None:
    """Renew a claim until processing stops or the lease is no longer owned."""
    while not stop_event.wait(interval_seconds):
        try:
            if not _renew_lease(job_id, lease_token):
                return
        except Exception:  # noqa: BLE001 — stale recovery remains the backstop
            logger.exception("reclassify job %s lease heartbeat failed", job_id)


def reap_stale_reclassify_jobs(conn, max_age_minutes: int) -> list:
    """Recover expired claims, consuming one attempt for the abandoned work."""
    rows = conn.execute(
        """WITH stale AS (
               SELECT id
               FROM reclassify_jobs
               WHERE status='running'
                 AND updated_at < now() - make_interval(mins => %s)
               ORDER BY updated_at, id
               FOR UPDATE SKIP LOCKED
           )
           UPDATE reclassify_jobs jobs
           SET status = CASE
                   WHEN jobs.attempts + 1 >= %s THEN 'error'
                   ELSE 'queued'
               END,
               attempts = jobs.attempts + 1,
               error = 'worker lease expired',
               updated_at = now()
           FROM stale
           WHERE jobs.id = stale.id
           RETURNING jobs.id, jobs.run_id, jobs.status""",
        (max_age_minutes, MAX_ATTEMPTS),
    ).fetchall()

    for run_id in {run_id for _job_id, run_id, status in rows if status == "error"}:
        _audit_completed_run(conn, run_id)
    return [job_id for job_id, _run_id, _status in rows]


def _audit_completed_run(conn, run_id) -> bool:
    """Insert or refresh the one audit after every job in ``run_id`` is terminal.

    The transaction-scoped lock serializes final-job checks across worker
    threads and replicas. Existing summaries are updated after supported retries.
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

    existing_audit = conn.execute(
        """SELECT id FROM audit_log
           WHERE source='system'
             AND action='reclassify_run'
             AND entity_type='reclassify_run'
             AND entity_id=%s
           ORDER BY id
           LIMIT 1""",
        (run_id,),
    ).fetchone()

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
    if existing_audit:
        conn.execute(
            "UPDATE audit_log SET after=%s, at=now() WHERE id=%s",
            (Jsonb(after), existing_audit[0]),
        )
    else:
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
    lease_token = f"lease:{uuid.uuid4()}"
    with get_pool().connection() as conn:
        claimed = claim_job(conn, lease_token)
        if claimed is None:
            return False

        job_id, document_id, _scope_tag_id, run_id = claimed

    settings = get_settings()
    heartbeat_interval = max(
        1.0, min(30.0, settings.worker_reap_minutes * 60.0 / 3.0)
    )
    heartbeat_stop = threading.Event()
    heartbeat = threading.Thread(
        target=_heartbeat_lease,
        args=(job_id, lease_token, heartbeat_stop, heartbeat_interval),
        daemon=True,
        name=f"reclassify-heartbeat-{job_id}",
    )
    heartbeat.start()
    try:
        logger.info(
            "reclassify job %s doc %s run %s: running classify (topic_only=True)",
            job_id,
            document_id,
            run_id,
        )
        classify_run(document_id, topic_only=True)
    except Exception as exc:
        heartbeat_stop.set()
        heartbeat.join(timeout=5)
        with get_pool().connection() as conn:
            row = conn.execute(
                "SELECT attempts FROM reclassify_jobs WHERE id = %s", (job_id,)
            ).fetchone()
            attempts = row[0] if row else 0
            status = _mark_failed(
                conn, job_id, attempts, str(exc), lease_token=lease_token
            )
            if status == "error":
                _audit_completed_run(conn, run_id)
    else:
        heartbeat_stop.set()
        heartbeat.join(timeout=5)
        with get_pool().connection() as conn:
            if _mark_done(conn, job_id, lease_token=lease_token):
                _audit_completed_run(conn, run_id)

    return True


def process_reclassify_batch(concurrency: int) -> int:
    """Run at most ``concurrency`` independent SKIP LOCKED claim attempts."""
    bounded = max(0, int(concurrency))
    if bounded == 0:
        return 0
    settings = get_settings()
    with get_pool().connection() as conn:
        recovered = reap_stale_reclassify_jobs(
            conn, settings.worker_reap_minutes
        )
    if recovered:
        logger.warning("recovered stale reclassify jobs: %s", recovered)
    with ThreadPoolExecutor(max_workers=bounded) as executor:
        results = executor.map(lambda _slot: process_one_reclassify(), range(bounded))
        return sum(bool(worked) for worked in results)
