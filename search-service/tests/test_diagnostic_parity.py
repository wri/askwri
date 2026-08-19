"""Diagnostic sparse lane must mirror the fusion sparse lane (spec F7).

The fusion path expands the query via build_sparse_query and slices to
bm25_top_k (main.py HybridFusionRetriever._retrieve). The diagnostic path
historically passed the RAW query and ignored bm25_top_k, making cross-lane
attribution invalid (findings 2026-07-24 §5). These tests pin the parity.

No DB or network is touched: the dense lane is stubbed via make_dense_retriever,
and rerank=False so no reranker is needed (see tests/test_query_nonblocking.py
for the pattern of stubbing service_state/make_dense_retriever without booting
the full postgres-backed fixture in tests/test_query_e2e.py).
"""
from unittest.mock import patch

from app.query_expansion import sparse_query_for


def test_sparse_query_for_matches_fusion_expansion():
    # Same function the fusion path uses; translation disabled by default so
    # this reduces to expand_query_conservative (byte-identical guarantee).
    from app.query_expansion import expand_query_conservative
    q = "What have we published on urban finance since 2020?"
    assert sparse_query_for(q) == expand_query_conservative(q, max_expansions=3)


def test_diagnostic_uses_expanded_query_and_top_k():
    """The /query diagnostic path must retrieve with the expanded query and
    slice to bm25_top_k."""
    from fastapi.testclient import TestClient

    from app import main as app_main

    class RecordingRetriever:
        def __init__(self):
            self.seen_queries = []

        def retrieve(self, bundle):
            self.seen_queries.append(bundle.query_str)
            from llama_index.core.schema import NodeWithScore, TextNode
            return [
                NodeWithScore(node=TextNode(id_=f"c{i}", text="t",
                                            metadata={"doc_id": f"d{i}"}), score=1.0 - i * 0.01)
                for i in range(10)
            ]

    class _DenseStub:
        """No-op dense lane — dense retrieval is irrelevant to this test and
        must not touch the network/DB (default retrieval_backend is legacy,
        which would otherwise build a VectorIndexRetriever over a None index)."""

        def retrieve(self, bundle):
            return []

    stub = RecordingRetriever()
    state_patch = {
        "bm25_retriever": stub,
        "pg_dense_ready": True,
    }
    with patch.dict(app_main.service_state, state_patch, clear=False), \
         patch.object(app_main, "make_dense_retriever", lambda top_k: _DenseStub()):
        client = TestClient(app_main.app)
        resp = client.post("/query", json={
            "query": "urban finance mechanisms",
            "mode": "cite",
            "rerank": False,
            "bm25_top_k": 3,
            "return_intermediate_results": True,
        })
    assert resp.status_code == 200
    expected = sparse_query_for("urban finance mechanisms")
    # Diagnostic call (first) and fusion call must BOTH use the expanded query.
    assert all(q == expected for q in stub.seen_queries)
    assert len(resp.json()["bm25_results"]) == 3  # bm25_top_k applied


def test_diagnostic_mirrors_retirement_when_lanes_on(monkeypatch):
    """Flag-on parity: the diagnostic BM25 lane must see the SAME raw query
    the fusion original-sparse lane sees (spec F7 extended to P2)."""
    from fastapi.testclient import TestClient

    from app import main as app_main
    from app.understanding import QueryUnderstanding

    class RecordingRetriever:
        def __init__(self):
            self.seen_queries = []

        def retrieve(self, bundle):
            self.seen_queries.append(bundle.query_str)
            from llama_index.core.schema import NodeWithScore, TextNode
            return [NodeWithScore(node=TextNode(id_="c0", text="t",
                                                metadata={"doc_id": "d0"}), score=1.0)]

    class _DenseStub:
        def retrieve(self, bundle):
            return []

    stub = RecordingRetriever()
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", stub)
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setattr(app_main, "make_dense_retriever", lambda top_k: _DenseStub())
    monkeypatch.setattr(app_main, "understanding_active", lambda s, r: True)
    monkeypatch.setattr(app_main, "lanes_active", lambda s, r: True)
    monkeypatch.setattr(
        app_main, "build_understanding",
        lambda query, explicit_facets, today_year, expansion_lanes=False: QueryUnderstanding(),
    )
    import app.topic_sense as ts
    monkeypatch.setattr(ts, "attach_topic_suggestions", lambda u, q, m: None)

    client = TestClient(app_main.app)
    resp = client.post("/query", json={
        "query": "urban finance mechanisms", "mode": "cite", "rerank": False,
        "return_intermediate_results": True,
    })
    assert resp.status_code == 200
    # Diagnostic call AND fusion call both use the RAW query when lanes are on.
    assert all(q == "urban finance mechanisms" for q in stub.seen_queries)
