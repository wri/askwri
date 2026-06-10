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
    assert len(meta) == 169
    assert set(texts) == set(meta)
    assert all(len(t) > 0 for t in texts.values())


@requires_db
@requires_openai
def test_dense_retrieval_returns_ranked_results():
    from llama_index.core.schema import QueryBundle
    from llama_index.embeddings.openai import OpenAIEmbedding

    from app.pg_store import PgVectorRetriever

    retriever = PgVectorRetriever(
        embed_model=OpenAIEmbedding(model="text-embedding-3-small"),
        similarity_top_k=10,
    )
    results = retriever._retrieve(QueryBundle(query_str="electric buses in Latin America"))
    assert len(results) == 10
    scores = [r.score for r in results]
    assert scores == sorted(scores, reverse=True)
    assert all("doc_id" in r.node.metadata for r in results)
