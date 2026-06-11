"""Ingestion worker entrypoint: poll the queue, run pipeline stages.

Run:  cd search-service && ./venv/bin/python -m worker.main [--once]
The --once flag processes at most one intake sweep + one job, then exits
(used by tests and smoke checks).
"""
import argparse
import logging
import time

from dotenv import load_dotenv

load_dotenv()  # local dev: export .env (OPENAI_API_KEY etc.), same as app.main

from app.config import get_settings  # noqa: E402
from worker import intake_s3, queue  # noqa: E402
from worker.stages import STAGE_ORDER, run_stage  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("worker")


def process_one_job() -> bool:
    """Claim and advance one job by one stage. Returns True if work was done."""
    settings = get_settings()
    claimed = queue.claim_job()
    if claimed is None:
        return False
    job_id, document_id, stage, attempts = claimed
    next_stage = queue.next_stage(stage)
    logger.info(f"job {job_id} doc {document_id}: running stage '{next_stage}' (attempt {attempts + 1})")
    try:
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
        swept = intake_s3.sweep()
        worked = process_one_job()
        if args.once:
            break
        if not swept and not worked:
            time.sleep(settings.worker_poll_seconds)


if __name__ == "__main__":
    main()
