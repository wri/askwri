"""Re-embed existing document_chunks to Cohere embed-v4 (Bedrock) IN PLACE —
dense only (v3 B1, spec §10: re-embed, not re-ingest; sparse lane untouched).

For every chunk row not already on cohere-embed-v4 (all statuses — retrieval
filters status per query), recompute the dense embedding over the EMBED-mode
node content (metadata prefix + text, exactly what the worker embed stage
embeds) via Bedrock, and UPDATE embedding/embedding_model/dimension. Identity
columns (legacy_chunk_id, text, node_metadata, corpus_order) and the bm25
sparse vector are untouched.

After a full pass, collections whose member docs are all on cohere-embed-v4
get embedding_model_version='cohere-embed-v4' (per-collection cutover marker).

Rollback note: this REPLACES the 3-small vectors in place. Until the cutover
is validated, rollback = re-running this script's OpenAI counterpart (or the
worker embed path) with EMBEDDING_MODEL=text-embedding-3-small. Run only at
the reviewed cutover point (spec: PAUSE before full-corpus re-embed).

Run: cd search-service && ./venv/bin/python -m scripts.reembed_cohere [--force] [--batch-size 96] [--limit N]
"""
import argparse
import logging
import sys
import time

from llama_index.core.schema import MetadataMode, TextNode

from app.bedrock_embed import COHERE_EMBED_DIMENSION, COHERE_EMBED_MODEL_NAME
from app.db import get_pool

logger = logging.getLogger(__name__)

_PENDING_SQL = """
    SELECT id, legacy_chunk_id, text, node_metadata, document_id
    FROM document_chunks
    WHERE {where}
    ORDER BY corpus_order NULLS LAST, legacy_chunk_id
    {limit}
"""


def _embed(texts):
    from app.bedrock_embed import embed_documents

    return embed_documents(texts)


def _embed_content(legacy_id, text, meta) -> str:
    """EMBED-mode content, identical to what the worker embed stage encodes."""
    return TextNode(id_=legacy_id, text=text, metadata=meta or {}).get_content(
        metadata_mode=MetadataMode.EMBED
    )


def reembed_all(batch_size: int = 96, force: bool = False, limit: int = 0) -> dict:
    """Re-embed all non-cohere chunks (or ALL chunks with force=True)."""
    import numpy as np

    where = ("TRUE" if force
             else f"embedding_model IS DISTINCT FROM '{COHERE_EMBED_MODEL_NAME}'")
    limit_clause = f"LIMIT {int(limit)}" if limit else ""
    t0 = time.time()
    with get_pool().connection() as conn:
        rows = conn.execute(
            _PENDING_SQL.format(where=where, limit=limit_clause)
        ).fetchall()
        n_docs = conn.execute(
            f"SELECT count(DISTINCT document_id) FROM document_chunks WHERE {where}"
        ).fetchone()[0] if not limit else len({r[4] for r in rows})

        done = 0
        for i in range(0, len(rows), batch_size):
            batch = rows[i:i + batch_size]
            contents = [_embed_content(lid, text, meta)
                        for _, lid, text, meta, _ in batch]
            vectors = _embed(contents)
            with conn.cursor() as cur:
                cur.executemany(
                    """UPDATE document_chunks
                       SET embedding = %s, embedding_model = %s, dimension = %s
                       WHERE id = %s""",
                    [
                        (np.array(vec, dtype=np.float32), COHERE_EMBED_MODEL_NAME,
                         COHERE_EMBED_DIMENSION, chunk_id)
                        for (chunk_id, _, _, _, _), vec in zip(batch, vectors)
                    ],
                )
            # Commit per batch: a long run killed mid-flight (credential
            # expiry, throttle exhaustion) must keep every finished batch —
            # the WHERE clause makes reruns pick up only the remainder.
            conn.commit()
            done += len(batch)
            if done % 960 < batch_size or done == len(rows):
                logger.info(f"re-embedded {done}/{len(rows)} chunks "
                            f"({time.time() - t0:.0f}s)")

        # Per-collection cutover marker: every member doc fully on the new model.
        conn.execute(
            """UPDATE collections c SET embedding_model_version = %s
               WHERE NOT EXISTS (
                 SELECT 1 FROM document_collections dc2
                 JOIN document_chunks ch ON ch.document_id = dc2.document_id
                 WHERE dc2.collection_id = c.id
                   AND ch.embedding_model IS DISTINCT FROM %s
               )""",
            (COHERE_EMBED_MODEL_NAME, COHERE_EMBED_MODEL_NAME),
        )

    return {"chunks": len(rows), "documents": n_docs,
            "seconds": round(time.time() - t0, 1)}


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-size", type=int, default=96,
                        help="texts per Bedrock call (Cohere cap: 96)")
    parser.add_argument("--force", action="store_true",
                        help="re-embed even rows already on cohere-embed-v4")
    parser.add_argument("--limit", type=int, default=0,
                        help="re-embed at most N chunks (canary run)")
    args = parser.parse_args()

    try:
        stats = reembed_all(batch_size=args.batch_size, force=args.force,
                            limit=args.limit)
    finally:
        get_pool().close()
    logger.info(f"done: {stats}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
