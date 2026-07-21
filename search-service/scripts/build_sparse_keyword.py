"""Build/refresh the Postgres-resident BM25 keyword lane.

Builds the exact boot-time bm25s index over the chunks of ALL documents
(weights don't depend on status; retrieval filters status per query), then
persists it: keyword_vocab (df/idf; token_ids stable across refreshes),
keyword_corpus_stats (frozen N/avgdl/k1/b), and per-chunk impact vectors in
document_chunks.sparse.

Run for the initial backfill and to refresh frozen stats after bulk corpus
changes. Lifecycle consistency (withdraw/promote) NEVER depends on this —
only IDF/avgdl freshness does. Idempotent. All writes commit atomically:
psycopg3's connection context manager wraps the block in one transaction
and commits on clean exit. ~1-2 min on 30k chunks.

Run: cd search-service && ./venv/bin/python -m scripts.build_sparse_keyword
"""
import sys
import time

import bm25s
import numpy as np
import scipy.sparse as sp
import Stemmer
from llama_index.core.schema import MetadataMode, TextNode
from pgvector import SparseVector

from app.db import get_pool
from app.sparse_keyword import B, K1, SPARSE_DIM, TOKEN_PATTERN, lucene_idf

BATCH = 1000

# ALL documents, not just status='searchable' (pg_store.load_nodes is
# searchable-only): impact weights don't depend on status, and backfilling a
# needs_review doc now makes it keyword-ready the moment it is promoted.
_ALL_CHUNKS_SQL = """
    SELECT dc.legacy_chunk_id, dc.text, dc.node_metadata
    FROM document_chunks dc
    ORDER BY dc.corpus_order NULLS LAST, dc.legacy_chunk_id
"""


def _load_all_nodes():
    nodes = []
    with get_pool().connection() as conn:
        for legacy_id, text, meta in conn.execute(_ALL_CHUNKS_SQL):
            nodes.append(TextNode(id_=legacy_id, text=text, metadata=meta))
    return nodes


def main():
    t0 = time.time()
    nodes = _load_all_nodes()
    print(f"loaded {len(nodes)} chunks (all statuses) in {time.time() - t0:.1f}s")

    # Exactly what BM25Retriever.from_defaults does at boot (base.py:99-112)
    stemmer = Stemmer.Stemmer("english")
    contents = [n.get_content(metadata_mode=MetadataMode.EMBED) for n in nodes]
    corpus_tokens = bm25s.tokenize(
        contents, stopwords="en", stemmer=stemmer,
        token_pattern=TOKEN_PATTERN, show_progress=False,
    )
    bm25 = bm25s.BM25()  # method='lucene', k1=1.5, b=0.75
    bm25.index(corpus_tokens, show_progress=False)
    print(f"indexed in {time.time() - t0:.1f}s")

    n_chunks = int(bm25.scores["num_docs"])
    n_tokens = len(bm25.scores["indptr"]) - 1
    assert n_chunks == len(nodes)
    # token-major CSC -> chunk-major CSR (construction validated 26/26 in
    # scripts/sparse_parity_check.py)
    rows = sp.csc_matrix(
        (bm25.scores["data"], bm25.scores["indices"], bm25.scores["indptr"]),
        shape=(n_chunks, n_tokens),
    ).tocsr()

    id_to_token = {v: k for k, v in corpus_tokens.vocab.items()}
    dls = [len(ids) for ids in corpus_tokens.ids]
    avgdl = float(np.mean(dls))
    df = np.zeros(n_tokens, dtype=np.int64)
    for ids in corpus_tokens.ids:
        for tid in set(ids):
            df[tid] += 1

    with get_pool().connection() as conn:
        # 1. vocab refresh — existing tokens keep their token_id (stable dims).
        # Split into UPDATE-existing + INSERT-only-missing: a full-vocab upsert
        # burns one identity value per PROPOSED row (conflict or not), which
        # erodes SPARSE_DIM headroom on every refresh. The anti-join makes
        # refreshes burn ~zero identity values; ON CONFLICT DO NOTHING stays
        # only for race safety against a concurrent embed-stage insert.
        vocab_rows = [
            (id_to_token[tid], int(df[tid]), lucene_idf(int(df[tid]), n_chunks))
            for tid in range(n_tokens)
        ]
        existing_tokens = {
            t for (t,) in conn.execute("SELECT token FROM keyword_vocab").fetchall()
        }
        update_rows = [(d, i, t) for t, d, i in vocab_rows if t in existing_tokens]
        insert_rows = [r for r in vocab_rows if r[0] not in existing_tokens]
        with conn.cursor() as cur:
            if update_rows:
                cur.executemany(
                    "UPDATE keyword_vocab SET df = %s, idf = %s WHERE token = %s",
                    update_rows,
                )
            if insert_rows:
                cur.executemany(
                    """INSERT INTO keyword_vocab (token, df, idf) VALUES (%s, %s, %s)
                       ON CONFLICT (token) DO NOTHING""",
                    insert_rows,
                )
        max_id = conn.execute("SELECT max(token_id) FROM keyword_vocab").fetchone()[0]
        if max_id >= SPARSE_DIM:
            print(f"FATAL: vocab token_id {max_id} >= SPARSE_DIM {SPARSE_DIM}")
            sys.exit(1)

        db_id = dict(conn.execute("SELECT token, token_id FROM keyword_vocab").fetchall())

        # 2. stats
        conn.execute(
            """INSERT INTO keyword_corpus_stats
                 (id, n_chunks, avgdl, k1, b, sparse_dim, method, built_at)
               VALUES (1, %s, %s, %s, %s, %s, 'lucene', now())
               ON CONFLICT (id) DO UPDATE SET n_chunks = EXCLUDED.n_chunks,
                 avgdl = EXCLUDED.avgdl, k1 = EXCLUDED.k1, b = EXCLUDED.b,
                 sparse_dim = EXCLUDED.sparse_dim, built_at = now()""",
            (n_chunks, avgdl, K1, B, SPARSE_DIM),
        )

        # 3. chunk vectors — bm25s column ids remapped to stable DB token_ids
        t0 = time.time()
        updates = []
        for i, node in enumerate(nodes):
            row = rows.getrow(i)
            vec = {
                db_id[id_to_token[tid]] - 1: float(w)   # 0-based for SparseVector
                for tid, w in zip(row.indices, row.data)
            }
            updates.append((SparseVector(vec, SPARSE_DIM), node.id_))
            if len(updates) >= BATCH:
                with conn.cursor() as cur:
                    cur.executemany(
                        "UPDATE document_chunks SET sparse = %s WHERE legacy_chunk_id = %s",
                        updates,
                    )
                updates = []
        if updates:
            with conn.cursor() as cur:
                cur.executemany(
                    "UPDATE document_chunks SET sparse = %s WHERE legacy_chunk_id = %s",
                    updates,
                )
        n = conn.execute(
            """SELECT count(*) FROM document_chunks dc
               JOIN documents d ON d.id = dc.document_id
               WHERE d.status = 'searchable' AND dc.sparse IS NOT NULL"""
        ).fetchone()[0]
    print(f"wrote {len(nodes)} vectors in {time.time() - t0:.1f}s; "
          f"searchable chunks with sparse: {n}; vocab {len(db_id)}; avgdl {avgdl:.1f}")


if __name__ == "__main__":
    main()
