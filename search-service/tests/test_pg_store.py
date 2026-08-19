import os

import pytest

requires_db = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"), reason="DATABASE_URL not set (needs migrated Postgres)"
)
requires_openai = pytest.mark.skipif(
    not os.getenv("OPENAI_API_KEY"), reason="OPENAI_API_KEY not set"
)


@requires_db
def test_load_nodes_reconstructs_legacy_node_shape():
    from app.pg_store import load_nodes

    nodes = load_nodes()
    assert len(nodes) > 1000
    node = next(n for n in nodes if not n.metadata.get("is_summary_node"))
    for key in ("doc_id", "chunk_id", "title", "page", "chunk_index"):
        assert key in node.metadata, f"missing legacy metadata key {key}"
    assert node.node_id == node.metadata["chunk_id"]
    assert any(n.metadata.get("is_summary_node") for n in nodes)


@requires_db
def test_document_texts_cover_all_docs():
    from app.pg_store import load_document_texts, load_documents_metadata

    texts = load_document_texts()
    meta = load_documents_metadata()
    # Covers every searchable doc (migrated baseline 169 + any worker-ingested uploads).
    assert len(meta) >= 169
    assert set(texts) == set(meta)
    assert all(len(t) > 0 for t in texts.values())


@requires_db
@requires_openai
def test_dense_retrieval_returns_ranked_results(monkeypatch):
    from llama_index.core.schema import QueryBundle
    from llama_index.embeddings.openai import OpenAIEmbedding

    from app.config import get_settings
    from app.db import get_pool
    from app.pg_store import PgVectorRetriever

    # This test exercises the LEGACY dense lane against the qa corpus rows;
    # the retriever is model-aware since v3 B1 and defaults to cohere-embed-v4.
    # After the 2026-07-22 corpus cutover the local DB has no 3-small rows —
    # the legacy lane is then legitimately empty, not broken.
    with get_pool().connection() as conn:
        n_legacy = conn.execute(
            """SELECT count(*) FROM document_chunks
               WHERE embedding_model = 'text-embedding-3-small'"""
        ).fetchone()[0]
    if n_legacy == 0:
        pytest.skip("no text-embedding-3-small rows (post-cohere-cutover DB)")

    monkeypatch.setenv("EMBEDDING_MODEL", "text-embedding-3-small")
    get_settings.cache_clear()

    retriever = PgVectorRetriever(
        embed_model=OpenAIEmbedding(model="text-embedding-3-small"),
        similarity_top_k=10,
    )
    results = retriever._retrieve(QueryBundle(query_str="electric buses in Latin America"))
    assert len(results) == 10
    scores = [r.score for r in results]
    assert scores == sorted(scores, reverse=True)
    assert all("doc_id" in r.node.metadata for r in results)


def test_year_int_fallback_parsing():
    from app.pg_store import _year_int

    assert _year_int(2021, {"YEAR published": "2019"}) == 2021   # column wins
    assert _year_int(None, {"YEAR published": "2019"}) == 2019   # string fallback
    assert _year_int(None, {"YEAR published": "n.d."}) is None
    assert _year_int(None, {}) is None
