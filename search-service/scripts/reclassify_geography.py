"""Bulk geography backfill: classify the geography facet on every doc.

One-off script to populate geography tags on the existing corpus after the
geography facet ships. New ingests get geography automatically via the
classify stage; this covers docs already in the database.

Dry run by default — lists the documents that would be classified and exits.
--execute opts in to actually classifying.

Touches ONLY the geography facet: classify.run(doc_id, facets=['geography'])
runs retrieve-then-classify for geography alone, never touching topic or the
full-enum facets. Protected (human/external) geography rows are never
overwritten, same as any classify call. Idempotent — re-running refreshes
LLM-owned geography rows.

Skips documents with no classify basis (no summary and no extracted text),
since the LLM call would have nothing to read.

Run: cd search-service && ./venv/bin/python -m scripts.reclassify_geography
     cd search-service && ./venv/bin/python -m scripts.reclassify_geography --execute
     cd search-service && ./venv/bin/python -m scripts.reclassify_geography --ids <uuid>,<uuid>
"""
import argparse
import logging

from app.db import get_pool
from worker.stages.classify import run as classify_run

logger = logging.getLogger(__name__)


def _candidate_docs(ids: list[str] | None):
    """Select docs to backfill: every doc with a classify basis, unless `ids`
    narrows it. An explicit EMPTY id list is a no-op."""
    if ids is not None and not ids:
        return []
    sql = """
        SELECT d.id, d.external_id, d.title
        FROM documents d
        LEFT JOIN document_summaries s
          ON s.document_id = d.id AND s.language = 'en' AND s.kind = 'long'
        LEFT JOIN document_texts t ON t.document_id = d.id
        WHERE d.status <> 'withdrawn'
          AND (s.text IS NOT NULL OR t.full_text IS NOT NULL)
    """
    params = None
    if ids is not None:
        sql += " AND d.id = ANY(%s)"
        params = (ids,)
    sql += " ORDER BY d.created_at, d.external_id"
    with get_pool().connection() as conn:
        return conn.execute(sql, params).fetchall()


def backfill_geography(ids: list[str] | None = None) -> int:
    """Classify the geography facet on every candidate doc. Returns the count
    actually classified."""
    rows = _candidate_docs(ids)
    for i, (doc_id, external_id, _title) in enumerate(rows, 1):
        classify_run(doc_id, facets=["geography"])
        logger.info("classified geography %d/%d %s", i, len(rows), external_id)
    return len(rows)


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="actually run the LLM classify calls (default: dry run)",
    )
    parser.add_argument(
        "--ids",
        type=lambda v: [s.strip() for s in v.split(",") if s.strip()],
        default=None,
        help="comma-separated document ids; omit to backfill every doc",
    )
    return parser.parse_args(argv)


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    args = _parse_args(argv)
    try:
        rows = _candidate_docs(args.ids)
        if not rows:
            logger.info("no documents to backfill")
            return 0
        logger.info("geography backfill: %d document(s)", len(rows))
        for _id, external_id, title in rows:
            logger.info("  %s  %s", external_id, (title or "")[:80])

        if not args.execute:
            logger.info("dry run — pass --execute to classify")
            return 0

        n = backfill_geography(args.ids)
        logger.info("classified geography on %d document(s)", n)
    finally:
        get_pool().close()
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
