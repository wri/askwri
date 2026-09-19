"""Sweep the corpus for translation-pair suggestions (issue #325).

Idempotent: pairs with ANY existing document_relations row (suggested,
confirmed, or rejected) are skipped, so re-running after threshold changes
only surfaces new candidates. DRY RUN IS THE DEFAULT; pass --execute to
write suggestion rows.

Run: cd search-service && ./venv/bin/python -m scripts.sweep_translation_pairs
     cd search-service && ./venv/bin/python -m scripts.sweep_translation_pairs --execute
"""
import argparse
import logging

from app.env import load_env

load_env()

from app.db import get_pool  # noqa: E402
from worker import relate  # noqa: E402

logger = logging.getLogger(__name__)


def run(execute=False, limit=None) -> int:
    with get_pool().connection() as conn:
        ids = [r[0] for r in conn.execute(
            "SELECT id FROM documents WHERE status <> 'withdrawn' ORDER BY created_at")]
    if limit:
        ids = ids[:limit]
    total = 0
    with get_pool().connection() as conn:
        for doc_id in ids:
            if execute:
                total += relate.suggest_for_document(conn, doc_id)
                conn.commit()
            else:
                total += relate.count_candidates(conn, doc_id)
    verb = "inserted" if execute else "would suggest (dry run; --execute to write)"
    print(f"{len(ids)} documents swept; {total} suggestion(s) {verb}")
    return total


def _parse_args(argv=None):
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--limit", type=int, default=None,
                   help="cap the number of documents swept")
    p.add_argument("--execute", action="store_true",
                   help="actually write suggestion rows (default is a dry run)")
    return p.parse_args(argv)


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    args = _parse_args(argv)
    try:
        run(execute=args.execute, limit=args.limit)
    finally:
        get_pool().close()
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
