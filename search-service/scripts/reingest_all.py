"""Bulk re-ingest: enqueue every non-withdrawn document at the parse stage.

The Python-native equivalent of the admin reenqueueIngestion (bake-off plan
§6.1 #3): inserts an ingestion_jobs row at stage=NULL per doc, so the worker
re-runs parse → language → summarize → classify → embed → publish. enqueue()
is idempotent — docs with an open (queued/running) job are counted, not
duplicated. This is the re-parse trigger; POST /reindex does NOT re-parse.

Run: cd search-service && ./venv/bin/python -m scripts.reingest_all
     cd search-service && ./venv/bin/python -m scripts.reingest_all --ids <uuid>,<uuid>

--ids narrows the run to specific documents (repairing a handful of docs
without paying for a full-corpus re-parse). The filter is applied in SQL, so
an unknown id enqueues nothing rather than falling back to the whole corpus.
"""
import argparse
import logging

from app.db import get_pool
from worker.queue import enqueue

logger = logging.getLogger(__name__)


def reingest_all(ids: list[str] | None = None) -> int:
    """Enqueue non-withdrawn documents at the parse stage.

    ids=None re-ingests the whole corpus; an explicit list narrows it, and an
    explicit EMPTY list is a no-op (never a full run).
    """
    if ids is not None and not ids:
        return 0
    sql = "SELECT id FROM documents WHERE status <> 'withdrawn'"
    params = None
    if ids is not None:
        sql += " AND id = ANY(%s)"
        params = (ids,)
    sql += " ORDER BY created_at, external_id"
    with get_pool().connection() as conn:
        doc_ids = [r[0] for r in conn.execute(sql, params).fetchall()]
        for doc_id in doc_ids:
            enqueue(conn, doc_id)
    return len(doc_ids)


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ids",
        type=lambda v: [s.strip() for s in v.split(",") if s.strip()],
        default=None,
        help="comma-separated document ids; omit to re-ingest every document",
    )
    return parser.parse_args(argv)


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    args = _parse_args(argv)
    try:
        n = reingest_all(args.ids)
    finally:
        get_pool().close()
    scope = "full re-ingest" if args.ids is None else f"{len(args.ids)} requested id(s)"
    logger.info(f"enqueued {n} documents ({scope})")
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
