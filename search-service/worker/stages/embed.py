"""Stage: chunk the document and write embedded document_chunks rows.

Chunking is IDENTICAL to Phase 0 (SimpleNodeParser 400/80 + one summary node;
legacy chunk-id format; node_metadata verbatim) so retrieval semantics and
golden-set chunk references stay coherent. corpus_order appends after the
global max under an advisory lock (BM25 tie parity: append == legacy rebuild
behavior for new docs). Re-ingest deletes the doc's prior chunks first.
zh text is OpenCC-normalized (t2s) in chunk/summary TEXT (indexed form);
document_texts keeps the original.
"""
import logging

from psycopg.types.json import Jsonb

from app.config import get_settings
from app.db import get_pool
from worker.stages import fetch_document, stage

logger = logging.getLogger(__name__)
EMBEDDING_MODEL = "text-embedding-3-small"
DIMENSION = 1536
_LOCK_KEY = 0x636F7270  # 'corp' — corpus_order allocation lock


def _build_nodes_for_doc(doc, full_text: str, boundaries: list, summary: str):
    """Single-document version of app.indexing.build_nodes (same params/metadata)."""
    from llama_index.core.node_parser import SimpleNodeParser
    from llama_index.core.schema import Document, TextNode

    from app.indexing import get_page_number_for_position

    src = (doc["source_metadata"] or {}).get("metadata", {}) or {}
    # Same fallback chain as app.indexing.prepare_documents (line 62)
    url = src.get("Source URL", src.get("URL", src.get("Attribution URL", "")))
    base = {
        "doc_id": doc["external_id"],
        "title": (doc["title"] or "")[:100],
        "authors": (src.get("All authors") or "")[:100],
        "year": str(src.get("YEAR published") or ""),
        "subtag": (src.get("Sub-tag") or "")[:50] if isinstance(src.get("Sub-tag"), str) else "",
        "program_series": src.get("program_series", ""),
    }
    parser = SimpleNodeParser.from_defaults(chunk_size=400, chunk_overlap=80)
    nodes = parser.get_nodes_from_documents([Document(text=full_text, metadata=dict(base))])
    for idx, node in enumerate(nodes):
        start = full_text.find(node.text[:100])
        if start == -1:
            start = idx * (len(full_text) // max(len(nodes), 1))
        node.metadata.update({
            "chunk_id": f"{doc['external_id']}_chunk_{idx}",
            "chunk_index": idx, "total_chunks": len(nodes),
            "page": get_page_number_for_position(start, boundaries),
            "chunk_start_pos": start,
            "authors": base["authors"], "year": base["year"],
            "url": url, "file_path": doc["s3_key"],
            "program_series": base["program_series"],
            "prev_chunk_id": f"{doc['external_id']}_chunk_{idx-1}" if idx else None,
            "next_chunk_id": f"{doc['external_id']}_chunk_{idx+1}" if idx < len(nodes) - 1 else None,
        })
    if summary:
        nodes.append(TextNode(
            text=f"{doc['title']}\n\n{summary}" if doc["title"] else summary,
            metadata={**base, "chunk_id": f"{doc['external_id']}_summary", "chunk_index": -1,
                      "total_chunks": -1, "page": 1, "chunk_start_pos": 0,
                      "url": url, "file_path": doc["s3_key"],
                      "is_summary_node": True, "prev_chunk_id": None,
                      "next_chunk_id": f"{doc['external_id']}_chunk_0"},
        ))
    return nodes


def _embed_texts(texts: list) -> list:
    import os
    from llama_index.embeddings.openai import OpenAIEmbedding

    return OpenAIEmbedding(model=EMBEDDING_MODEL, api_key=os.getenv("OPENAI_API_KEY")) \
        .get_text_embedding_batch(texts)


@stage("embed")
def run(document_id):
    import numpy as np
    from llama_index.core.schema import MetadataMode

    with get_pool().connection() as conn:
        doc = fetch_document(conn, document_id)
        full_text, boundaries = conn.execute(
            "SELECT full_text, page_boundaries FROM document_texts WHERE document_id=%s",
            (document_id,),
        ).fetchone()
        summary_row = conn.execute(
            """SELECT text FROM document_summaries WHERE document_id=%s
               AND language=%s AND kind='long'""", (document_id, doc["language"]),
        ).fetchone()
        index_text = full_text
        summary = summary_row[0] if summary_row else ""
        if doc["language"] == "zh":
            from opencc import OpenCC
            cc = OpenCC("t2s")
            index_text = cc.convert(full_text)
            if summary:
                summary = cc.convert(summary)
        nodes = _build_nodes_for_doc(doc, index_text, boundaries, summary)
        logger.info(f"embed {doc['external_id']}: {len(nodes)} chunks, "
                    f"~{sum(len(n.text) for n in nodes)//4} tokens to {EMBEDDING_MODEL}")
        vectors = _embed_texts([n.get_content(metadata_mode=MetadataMode.EMBED) for n in nodes])

        from pgvector import SparseVector

        from app.sparse_keyword import SPARSE_DIM, chunk_weights, lucene_idf, tokenize

        stats = conn.execute(
            "SELECT n_chunks, avgdl FROM keyword_corpus_stats WHERE id = 1"
        ).fetchone()
        if stats:
            n_chunks, avgdl = stats
            token_lists = [
                tokenize(n.get_content(metadata_mode=MetadataMode.EMBED)) for n in nodes
            ]
            doc_tokens = sorted({t for toks in token_lists for t in toks})
            # Insert only genuinely-new tokens: ON CONFLICT burns one identity
            # value per PROPOSED row, so proposing every distinct token of every
            # doc per run would erode SPARSE_DIM headroom. Anti-join first;
            # DO NOTHING stays only for race safety (concurrent embed/backfill).
            rows = conn.execute(
                "SELECT token, token_id, idf FROM keyword_vocab WHERE token = ANY(%s)",
                (doc_tokens,),
            ).fetchall()
            known = {t for t, _, _ in rows}
            missing = [t for t in doc_tokens if t not in known]
            if missing:
                with conn.cursor() as cur:
                    cur.executemany(
                        """INSERT INTO keyword_vocab (token, df, idf) VALUES (%s, 1, %s)
                           ON CONFLICT (token) DO NOTHING""",
                        [(t, lucene_idf(1, n_chunks)) for t in missing],
                    )
                rows += conn.execute(
                    "SELECT token, token_id, idf FROM keyword_vocab WHERE token = ANY(%s)",
                    (missing,),
                ).fetchall()
            id_by_token = {t: i for t, i, _ in rows}
            idf_by_token = {t: idf for t, _, idf in rows}
            max_token_id = max(id_by_token.values(), default=0)
            if max_token_id >= SPARSE_DIM:
                raise RuntimeError(
                    f"keyword_vocab token_id {max_token_id} >= SPARSE_DIM {SPARSE_DIM} — "
                    "sparse keyword dimension exhausted; run "
                    "scripts/build_sparse_keyword.py to rebuild the vocab, or migrate "
                    "document_chunks.sparse to a larger dimension"
                )
            if max_token_id >= 0.8 * SPARSE_DIM:
                logger.warning(
                    f"keyword_vocab token_id {max_token_id} is at "
                    f"{max_token_id / SPARSE_DIM:.0%} of SPARSE_DIM {SPARSE_DIM} — "
                    "headroom is running out; plan a rebuild via "
                    "scripts/build_sparse_keyword.py or a dimension migration"
                )
            sparse_vecs = [
                SparseVector(
                    {id_by_token[t] - 1: w
                     for t, w in chunk_weights(toks, idf_by_token, avgdl).items()},
                    SPARSE_DIM,
                )
                for toks in token_lists
            ]
        else:
            logger.warning("keyword_corpus_stats missing — sparse lane not backfilled; writing NULL sparse")
            sparse_vecs = [None] * len(nodes)

        conn.execute("SELECT pg_advisory_xact_lock(%s)", (_LOCK_KEY,))
        conn.execute("DELETE FROM document_chunks WHERE document_id=%s", (document_id,))
        next_order = conn.execute(
            "SELECT COALESCE(MAX(corpus_order), -1) + 1 FROM document_chunks"
        ).fetchone()[0]
        for offset, (node, vec) in enumerate(zip(nodes, vectors)):
            is_summary = bool(node.metadata.get("is_summary_node"))
            conn.execute(
                """INSERT INTO document_chunks
                   (document_id, legacy_chunk_id, chunk_index, unit_type, page, text,
                    language, node_metadata, embedding, embedding_model, dimension,
                    corpus_order, sparse)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (document_id, node.metadata["chunk_id"], node.metadata.get("chunk_index", 0),
                 "summary" if is_summary else "text", node.metadata.get("page"),
                 node.text, doc["language"], Jsonb(dict(node.metadata)),
                 np.array(vec, dtype=np.float32), EMBEDDING_MODEL, DIMENSION,
                 next_order + offset, sparse_vecs[offset]),
            )
    return None
