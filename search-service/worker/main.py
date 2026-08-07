"""Ingestion worker entrypoint: poll the queue, run pipeline stages.

Run:  cd search-service && ./venv/bin/python -m worker.main [--once]
The --once flag processes at most one intake sweep + one job, then exits
(used by tests and smoke checks).
"""
import argparse
import logging
import time

from app.env import load_env

load_env()  # local dev: .env.local then .env into os.environ (see app/env.py)

from app.config import get_settings  # noqa: E402
from app.db import get_pool  # noqa: E402
from worker import intake_s3, queue  # noqa: E402
from worker.stages import STAGE_ORDER, fetch_document, run_stage  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("worker")


def process_one_job() -> bool:
    """Claim and advance one job by one stage. Returns True if work was done."""
    settings = get_settings()
    claimed = queue.claim_job()
    if claimed is None:
        return False
    job_id, document_id, stage, attempts = claimed
    next_stage = stage  # fallback label if next_stage() itself raises below
    try:
        # Inside the try: a malformed stage value (e.g. a manually-requeued job
        # whose stage is already 'publish') must route to retry/error, not kill
        # the worker.
        next_stage = queue.next_stage(stage)
        # Claim-time guard: never run stages for a withdrawn document.
        with get_pool().connection() as conn:
            doc = fetch_document(conn, document_id)
        if doc["status"] == "withdrawn":
            logger.info(f"job {job_id} doc {document_id}: document withdrawn — skipping stages, marking job done")
            queue.mark_done(job_id, stage)
            return True
        logger.info(f"job {job_id} doc {document_id}: running stage '{next_stage}' (attempt {attempts + 1})")
        outcome = run_stage(next_stage, document_id)
        if outcome == "needs_review":
            queue.mark_needs_review(job_id, next_stage)
        elif next_stage == STAGE_ORDER[-1]:
            queue.mark_done(job_id, next_stage)
        else:
            queue.advance(job_id, next_stage)
    except Exception as exc:  # noqa: BLE001 — every stage failure routes to retry/error
        logger.exception(f"job {job_id} stage '{next_stage}' failed")
        queue.mark_failed(job_id, next_stage, str(exc), attempts, settings.worker_max_attempts)
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    settings = get_settings()
    logger.info("Ingestion worker started")
    while True:
        # Reap and sweep are each guarded: one poison object or transient DB
        # error must cost a log line per poll, not an ECS crash-loop that
        # blocks all ingestion.
        try:
            with get_pool().connection() as conn:
                reclaimed = queue.reap_stale_jobs(conn, settings.worker_reap_minutes)
            if reclaimed:
                logger.warning(f"reaped stale running jobs back to queued: {reclaimed}")
        except Exception:  # noqa: BLE001
            logger.exception("reap_stale_jobs failed — continuing poll loop")
        try:
            swept = intake_s3.sweep()
        except Exception:  # noqa: BLE001
            logger.exception("intake sweep failed — continuing poll loop")
            swept = False
        worked = process_one_job()
        if args.once:
            break
        if not swept and not worked:
            time.sleep(settings.worker_poll_seconds)


if __name__ == "__main__":
    main()
