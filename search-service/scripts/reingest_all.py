"""Bulk re-ingest: enqueue every non-withdrawn document at the parse stage.

The Python-native equivalent of the admin reenqueueIngestion (bake-off plan
§6.1 #3): inserts an ingestion_jobs row at stage=NULL per doc, so the worker
re-runs parse → language → summarize → classify → embed → publish. enqueue()
is idempotent — docs with an open (queued/running) job are counted, not
duplicated. This is the re-parse trigger; POST /reindex does NOT re-parse.

Run: cd search-service && ./venv/bin/python -m scripts.reingest_all
"""
import logging

from app.db import get_pool
from worker.queue import enqueue

logger = logging.getLogger(__name__)


def reingest_all() -> int:
    with get_pool().connection() as conn:
        ids = [r[0] for r in conn.execute(
            """SELECT id FROM documents WHERE status <> 'withdrawn'
               ORDER BY created_at, external_id"""
        ).fetchall()]
        for doc_id in ids:
            enqueue(conn, doc_id)
    return len(ids)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    try:
        n = reingest_all()
    finally:
        get_pool().close()
    logger.info(f"enqueued {n} documents for full re-ingest")
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
