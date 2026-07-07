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


def _recompute_boundaries_on_text(boundaries: list, original_text: str, normalized_text: str) -> list:
    """Re-map page boundaries from the original text onto the normalized text.

    For zh, parse produces boundaries in Traditional-character space but the
    embed stage chunks the Simplified (t2s) text. If OpenCC changes any phrase
    length, character offsets drift and get_page_number_for_position returns
    the wrong page (R4). We re-derive boundaries by converting each page slice
    of the original text and accumulating the normalized lengths, so positions
    stay aligned with the text that's actually chunked.

    `convert_fn` is the OpenCC convert callable (passed in to avoid re-importing).
    """
    if not boundaries or original_text == normalized_text:
        return boundaries
    # Slice the original text at each boundary, convert each slice independently,
    # and accumulate the converted lengths into new boundary positions.
    out, norm_pos, prev_end = [], 0, 0
    for b in boundaries:
        orig_slice = original_text[prev_end:b["end_pos"]]
        # The normalized text is the full conversion; the slice's converted form
        # is a contiguous run starting at norm_pos. Find its length by converting
        # the slice directly (OpenCC is deterministic and stateless).
        conv_len = len(_CONVERT_FN(orig_slice)) if _CONVERT_FN else len(orig_slice)
        norm_pos += conv_len
        out.append({"page": b["page"], "end_pos": norm_pos})
        prev_end = b["end_pos"]
    return out


# Thread-local convert function pointer, set by the run() zh branch before
# _build_nodes_for_doc is called (avoids passing it through the call chain).
_CONVERT_FN = None


def _build_nodes_for_doc(doc, full_text: str, boundaries: list, summary: str):
    """Single-document version of app.indexing.build_nodes (same params/metadata).

    node_metadata must match what the Phase-0 migration's indexing.build_nodes
    produces (R3): title from Publication Title (load_csv_metadata line 59),
    full authors (the per-chunk update restores the full value, not the
    Document-level [:100] truncation), file_path from the CSV file_path (not
    the s3_key).
    """
    from llama_index.core.node_parser import SimpleNodeParser
    from llama_index.core.schema import Document, TextNode

    from app.indexing import get_page_number_for_position

    src_meta = doc["source_metadata"] or {}
    src = (src_meta.get("metadata") or {}) if isinstance(src_meta, dict) else {}
    # title: prefer Publication Title (matches indexing.load_csv_metadata:59),
    # fallback to Article Title, then the stored documents.title.
    title = src.get("Publication Title") or src.get("Article Title") or doc["title"] or ""
    # authors: full value (indexing.build_nodes restores full in the per-chunk
    # node.metadata.update at line 365; the Document-level [:100] is only the
    # embedding-time Document metadata, not the stored chunk metadata).
    authors = src.get("All authors") or ""
    # file_path: the CSV bare file_path (indexing uses doc['metadata']['file_path']),
    # not the s3_key which carries the documents/ prefix.
    file_path = src_meta.get("file_path") if isinstance(src_meta, dict) else ""
    if not file_path:
        file_path = doc["s3_key"]
    url = src.get("Source URL", src.get("URL", src.get("Attribution URL", "")))
    base = {
        "doc_id": doc["external_id"],
        "title": title[:100],  # Document-level metadata matches indexing:328 (truncated)
        "authors": authors[:100],  # Document-level matches indexing:329 (truncated)
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
            # Per-chunk restore: FULL authors (indexing:365), not the truncated base.
            "authors": authors, "year": base["year"],
            "url": url, "file_path": file_path,
            "program_series": base["program_series"],
            "prev_chunk_id": f"{doc['external_id']}_chunk_{idx-1}" if idx else None,
            "next_chunk_id": f"{doc['external_id']}_chunk_{idx+1}" if idx < len(nodes) - 1 else None,
        })
    if summary:
        nodes.append(TextNode(
            text=f"{title}\n\n{summary}" if title else summary,
            metadata={**base, "chunk_id": f"{doc['external_id']}_summary", "chunk_index": -1,
                      "total_chunks": -1, "page": 1, "chunk_start_pos": 0,
                      # Summary node carries FULL authors (indexing:392 uses the
                      # full value, not the truncated Document-level base).
                      "authors": authors,
                      "url": url, "file_path": file_path,
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
        # Never rewrite chunks for a withdrawn document (NEW-P2-5: an admin
        # takedown must not be undone by a racing embed stage). The claim-time
        # guard in main.py reduces but does not close the TOCTOU window.
        if doc["status"] == "withdrawn":
            logger.info(f"embed {doc['external_id']}: withdrawn — skipping chunk rewrite")
            return None
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
            # Recompute page boundaries on the Simplified text so character
            # offsets align with the text that's actually chunked (R4: reusing
            # Traditional-text boundaries drifts page attribution if OpenCC
            # changes any phrase length). Set the convert fn for the helper.
            global _CONVERT_FN
            _CONVERT_FN = cc.convert
            boundaries = _recompute_boundaries_on_text(boundaries, full_text, index_text)
            _CONVERT_FN = None
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
