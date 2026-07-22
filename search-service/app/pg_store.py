"""Read-side access to Postgres-resident chunks for the search service.

Reconstructs LlamaIndex TextNodes carrying the EXACT legacy node metadata
(stored verbatim in document_chunks.node_metadata), so the downstream
fusion/rerank/formatting pipeline behaves identically to the legacy
in-memory path. node ids are the legacy chunk_ids, shared by the dense and
BM25 lanes so RRF dedupes correctly.
"""
import logging
from typing import List

import numpy as np
from llama_index.core.retrievers import BaseRetriever
from llama_index.core.schema import NodeWithScore, QueryBundle, TextNode

from app.config import EMBEDDING_DIMENSIONS, get_settings
from app.db import get_pool

logger = logging.getLogger(__name__)

_CHUNKS_SQL = """
    SELECT dc.legacy_chunk_id, dc.text, dc.node_metadata
    FROM document_chunks dc
    JOIN documents d ON d.id = dc.document_id
    WHERE d.status = 'searchable'
    ORDER BY dc.corpus_order NULLS LAST, dc.legacy_chunk_id
"""
# corpus_order reproduces the legacy node build order: BM25 breaks score ties
# by corpus position, so any other order changes tail rankings vs legacy.

# The vector(N) cast must match the configured model's dimension — it is
# interpolated from EMBEDDING_DIMENSIONS (trusted ints, never user input) so
# the model-scoped partial HNSW index can serve the query. The model filter
# keeps the cutover window safe: cohere-embed-v4 and text-embedding-3-small
# rows coexist until the re-embed is validated (spec v3 §8.1).
_DENSE_SQL_TMPL = """
    SELECT dc.legacy_chunk_id, dc.text, dc.node_metadata,
           1 - (dc.embedding::vector({dim}) <=> %(q)s) AS similarity
    FROM document_chunks dc
    JOIN documents d ON d.id = dc.document_id
    WHERE d.status = 'searchable'
      AND dc.embedding_model = %(model)s
    ORDER BY dc.embedding::vector({dim}) <=> %(q)s
    LIMIT %(k)s
"""


def load_nodes() -> List[TextNode]:
    """All searchable chunks as TextNodes (for the in-memory BM25 lane)."""
    nodes = []
    with get_pool().connection() as conn:
        for legacy_id, text, meta in conn.execute(_CHUNKS_SQL):
            nodes.append(TextNode(id_=legacy_id, text=text, metadata=meta))
    logger.info(f"Loaded {len(nodes)} chunks from Postgres")
    return nodes


def load_document_texts() -> dict:
    """{external_id: full_text} for query-time passage context."""
    with get_pool().connection() as conn:
        rows = conn.execute(
            """SELECT d.external_id, t.full_text
               FROM document_texts t JOIN documents d ON d.id = t.document_id
               WHERE d.status = 'searchable'"""
        ).fetchall()
    return {ext: text for ext, text in rows}


def load_documents_metadata() -> dict:
    """Mirror of the legacy documents_metadata dict (used by /stats and legacy endpoints)."""
    out = {}
    with get_pool().connection() as conn:
        rows = conn.execute(
            "SELECT external_id, source_metadata FROM documents WHERE status = 'searchable'"
        ).fetchall()
    for ext, src in rows:
        src = src or {}
        raw = src.get("metadata", {}) or {}
        out[ext] = {
            "title": raw.get("Publication Title", f"Document {ext}"),
            "authors": raw.get("All authors", ""),
            "year": raw.get("YEAR published", ""),
            "url": raw.get("Source URL", raw.get("URL", raw.get("Attribution URL", ""))),
            "summary": src.get("summary", ""),
            "subtag": raw.get("Sub-tag", "") if isinstance(raw.get("Sub-tag"), str) else "",
            "program_series": raw.get("program_series", ""),
            "file_path": src.get("file_path", ""),
            "raw_metadata": raw,
        }
    return out


class PgVectorRetriever(BaseRetriever):
    """Dense retrieval against pgvector — drop-in for VectorIndexRetriever.

    Only the RANKING feeds RRF fusion downstream, but the score is set to
    cosine similarity (same scale as the legacy in-memory retriever) for
    diagnostics parity.
    """

    def __init__(self, embed_model, similarity_top_k: int = 500, **kwargs):
        super().__init__(**kwargs)
        self._embed_model = embed_model
        self._similarity_top_k = similarity_top_k
        # Per-request latency split (L0 instrumentation): instances are
        # created per request, so these attrs are race-free.
        self.embed_ms: float | None = None
        self.db_ms: float | None = None

    def _retrieve(self, query_bundle: QueryBundle) -> List[NodeWithScore]:
        import time as _time

        model = get_settings().embedding_model
        t0 = _time.time()
        qvec = np.array(
            self._embed_model.get_query_embedding(query_bundle.query_str),
            dtype=np.float32,
        )
        self.embed_ms = round((_time.time() - t0) * 1000, 1)
        results = []
        t0 = _time.time()
        with get_pool().connection() as conn:
            # Near-exact ANN recall at this corpus size (ef_search cap is 1000).
            conn.execute("SET LOCAL hnsw.ef_search = 1000")
            rows = conn.execute(
                _DENSE_SQL_TMPL.format(dim=EMBEDDING_DIMENSIONS[model]),
                {"q": qvec, "model": model, "k": self._similarity_top_k},
            ).fetchall()
        self.db_ms = round((_time.time() - t0) * 1000, 1)
        for legacy_id, text, meta, similarity in rows:
            results.append(
                NodeWithScore(
                    node=TextNode(id_=legacy_id, text=text, metadata=meta),
                    score=float(similarity),
                )
            )
        return results


_SPARSE_KEYWORD_SQL = """
    SELECT dc.legacy_chunk_id, dc.text, dc.node_metadata,
           -(dc.sparse <#> %(q)s) AS score
    FROM document_chunks dc
    JOIN documents d ON d.id = dc.document_id
    WHERE d.status = 'searchable'
      AND dc.sparse IS NOT NULL
    ORDER BY dc.sparse <#> %(q)s, dc.corpus_order NULLS LAST, dc.legacy_chunk_id
    LIMIT %(k)s
"""
# <#> is the NEGATIVE inner product (ascending = best first). corpus_order
# tie-break mirrors bm25s, which resolves equal scores by corpus position.
# Exact scan by design: 30k rows, nnz<=~200 — no ANN index, zero recall loss.


class SparseKeywordRetriever(BaseRetriever):
    """Postgres-resident BM25 lane (KEYWORD_BACKEND=sparse).

    Per-chunk bm25s impact weights live in document_chunks.sparse; a query is
    scored as the inner product with its token-count vector — score-identical
    to the in-memory BM25Retriever (scripts/sparse_parity_check.py, 26/26).
    status='searchable' filters per query, like the dense lane: withdraw and
    promote are consistent on the next query, no reindex.
    """

    def __init__(self, similarity_top_k: int = 1000, **kwargs):
        super().__init__(**kwargs)
        self._similarity_top_k = similarity_top_k

    def _retrieve(self, query_bundle: QueryBundle) -> List[NodeWithScore]:
        from pgvector import SparseVector

        from app.sparse_keyword import SPARSE_DIM, tokenize

        tokens = tokenize(query_bundle.query_str)
        counts: dict = {}
        if tokens:
            with get_pool().connection() as conn:
                rows = conn.execute(
                    "SELECT token, token_id FROM keyword_vocab WHERE token = ANY(%s)",
                    (sorted(set(tokens)),),
                ).fetchall()
            token_id = {t: i for t, i in rows}
            for t in tokens:
                i = token_id.get(t)
                if i is not None:  # OOV query tokens score 0, same as bm25s
                    counts[i - 1] = counts.get(i - 1, 0.0) + 1.0
        qvec = SparseVector(counts, SPARSE_DIM)

        results = []
        with get_pool().connection() as conn:
            rows = conn.execute(
                _SPARSE_KEYWORD_SQL, {"q": qvec, "k": self._similarity_top_k}
            ).fetchall()
        for legacy_id, text, meta, score in rows:
            results.append(
                NodeWithScore(
                    node=TextNode(id_=legacy_id, text=text, metadata=meta),
                    score=float(score),
                )
            )
        return results
