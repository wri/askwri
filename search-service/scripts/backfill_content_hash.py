"""Backfill documents.content_hash for CSV-imported documents.

Why this exists: the parse cache compares a stored stamp against
documents.content_hash, so a document with NULL content_hash can never hit the
cache and re-OCRs on every re-ingest. Only documents that arrived through the
worker's intake path have a hash (worker/intake_s3.py sets it); the CSV-migrated
corpus does not. On qa that was 167 of 178 documents — i.e. the parse cache
covered 6% of the corpus until this ran.

The hash is sha256 of the stored PDF bytes, identical to intake's computation,
so a later re-drop of the same file dedupes correctly against these rows.

COLLISIONS. documents.content_hash carries a unique partial index, so two rows
whose files are byte-identical cannot both be stamped. Those are genuine
duplicate documents. This script never guesses: it reports each collision group
and stamps NONE of its members, leaving them exactly as they were for a human to
merge or withdraw.

DRY RUN IS THE DEFAULT — it reads S3 and reports what it would write, touching
nothing. Pass --execute to write.

Run: cd search-service && ./venv/bin/python -m scripts.backfill_content_hash
     cd search-service && ./venv/bin/python -m scripts.backfill_content_hash --execute
"""
import argparse
import hashlib
import logging
from collections import defaultdict

from app.env import load_env

# Before boto3: it reads os.environ, not Settings (see scripts/batch_ocr.py).
load_env()

from app.db import get_pool  # noqa: E402
from worker.stages.parse import _load_pdf_bytes  # noqa: E402

logger = logging.getLogger(__name__)

_TARGET_SQL = """
    SELECT id, external_id, s3_key
    FROM documents
    WHERE content_hash IS NULL
      AND s3_key IS NOT NULL
      AND status <> 'withdrawn'
    ORDER BY created_at, external_id
"""


def select_targets(conn, ids=None) -> list[dict]:
    """Documents with a file but no hash — the ones the parse cache cannot reach."""
    sql, params = _TARGET_SQL, None
    if ids is not None:
        if not ids:
            return []
        sql = sql.replace("ORDER BY", "AND id = ANY(%s) ORDER BY")
        params = (ids,)
    rows = conn.execute(sql, params).fetchall()
    return [dict(zip(["id", "external_id", "s3_key"], r)) for r in rows]


def hash_documents(targets: list[dict]) -> tuple[dict, list[dict]]:
    """Return ({doc_id: hash} for stampable docs, [unreadable docs]).

    Collision groups are dropped from the result — see the module docstring.
    """
    by_hash = defaultdict(list)
    unreadable = []
    for doc in targets:
        content = _load_pdf_bytes(doc)
        if content is None:
            logger.warning("%s: no retrievable file — skipped", doc["external_id"])
            unreadable.append(doc)
            continue
        by_hash[hashlib.sha256(content).hexdigest()].append(doc)

    stampable = {}
    for digest, docs in by_hash.items():
        if len(docs) > 1:
            logger.warning(
                "collision: %d documents share identical bytes (%s) — none stamped, "
                "these are duplicates for a human to merge: %s",
                len(docs), digest[:12], ", ".join(d["external_id"] for d in docs))
            continue
        stampable[docs[0]["id"]] = digest
    return stampable, unreadable


def _existing_hashes(conn, digests: list[str]) -> set[str]:
    """Hashes already held by OTHER documents — stamping these would violate the
    unique index, and means the file duplicates one already in the corpus."""
    if not digests:
        return set()
    rows = conn.execute(
        "SELECT content_hash FROM documents WHERE content_hash = ANY(%s)", (digests,)
    ).fetchall()
    return {r[0] for r in rows}


def run(ids=None, execute=False, limit=None) -> int:
    with get_pool().connection() as conn:
        targets = select_targets(conn, ids)
    if limit:
        targets = targets[:limit]
    if not targets:
        logger.info("no documents need a content_hash")
        return 0

    logger.info("%d document(s) have a file but no content_hash", len(targets))
    stampable, unreadable = hash_documents(targets)

    with get_pool().connection() as conn:
        taken = _existing_hashes(conn, list(stampable.values()))
    if taken:
        for doc_id, digest in list(stampable.items()):
            if digest in taken:
                logger.warning("hash %s already belongs to another document — "
                               "skipping %s (duplicate file)", digest[:12], doc_id)
                del stampable[doc_id]

    if not execute:
        print(f"\n--- DRY RUN ---")
        print(f"  {len(targets)} candidates")
        print(f"  {len(stampable)} would be stamped")
        print(f"  {len(unreadable)} unreadable (no file in S3)")
        print(f"  {len(targets) - len(stampable) - len(unreadable)} skipped as duplicates")
        print("\nRe-run with --execute to write.\n")
        return 0

    written = 0
    with get_pool().connection() as conn:
        for doc_id, digest in stampable.items():
            # Guarded on still-NULL: never overwrite a hash the worker set while
            # this script was reading S3.
            cur = conn.execute(
                "UPDATE documents SET content_hash = %s WHERE id = %s AND content_hash IS NULL",
                (digest, doc_id))
            if cur.rowcount:
                written += 1
            conn.commit()
    logger.info("stamped %d document(s) with a content_hash", written)
    return written


def _parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--ids", type=lambda v: [s.strip() for s in v.split(",") if s.strip()],
                   default=None, help="comma-separated document ids (default: all)")
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--execute", action="store_true",
                   help="actually write (default is a dry run)")
    return p.parse_args(argv)


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    args = _parse_args(argv)
    try:
        run(ids=args.ids, execute=args.execute, limit=args.limit)
    finally:
        get_pool().close()
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
