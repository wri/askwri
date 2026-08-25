"""Dense-lane graceful degradation (decision 2026-07-22, todos doc).

Post-cutover the dense lane is a Bedrock API call with no local fallback;
an embed failure must degrade /query to sparse-only results (mirroring the
rerank lane's degradation to fused) instead of a hard 500 — and the
degradation must be observable via service_state for /health.
Total failure (both lanes down) still raises.
"""
import pytest
from llama_index.core.retrievers import BaseRetriever
from llama_index.core.schema import NodeWithScore, QueryBundle, TextNode

import app.main as main
from app.main import HybridFusionRetriever


class _StaticRetriever(BaseRetriever):
    def __init__(self, nodes):
        super().__init__()
        self._nodes = nodes

    def _retrieve(self, query_bundle):
        return self._nodes


class _FailingRetriever(BaseRetriever):
    def __init__(self, exc=None):
        super().__init__()
        self._exc = exc or RuntimeError("UnrecognizedClientException: bad token")

    def _retrieve(self, query_bundle):
        raise self._exc


def _nodes(prefix, n):
    return [NodeWithScore(node=TextNode(id_=f"{prefix}{i}", text=f"{prefix} text {i}"),
                          score=float(n - i)) for i in range(n)]


@pytest.fixture(autouse=True)
def _reset_dense_state():
    main.service_state["dense_degraded_at"] = None
    main.service_state["dense_error"] = None
    yield
    main.service_state["dense_degraded_at"] = None
    main.service_state["dense_error"] = None


def test_dense_failure_serves_sparse_only(caplog):
    sparse = _nodes("s", 4)
    r = HybridFusionRetriever(
        vector_retriever=_FailingRetriever(),
        bm25_retriever=_StaticRetriever(sparse),
    )
    out = r.retrieve(QueryBundle(query_str="electric buses"))

    assert [n.node.node_id for n in out] == ["s0", "s1", "s2", "s3"]
    assert main.service_state["dense_degraded_at"] is not None
    assert "UnrecognizedClientException" in main.service_state["dense_error"]
    assert any("sparse-only" in rec.message for rec in caplog.records)


def test_dense_success_clears_degraded_flag():
    main.service_state["dense_degraded_at"] = "2026-07-22T00:00:00+00:00"
    main.service_state["dense_error"] = "stale"
    r = HybridFusionRetriever(
        vector_retriever=_StaticRetriever(_nodes("d", 2)),
        bm25_retriever=_StaticRetriever(_nodes("s", 2)),
    )
    out = r.retrieve(QueryBundle(query_str="q"))
    assert len(out) == 4
    assert main.service_state["dense_degraded_at"] is None
    assert main.service_state["dense_error"] is None


def test_both_lanes_failing_still_raises():
    r = HybridFusionRetriever(
        vector_retriever=_FailingRetriever(),
        bm25_retriever=_FailingRetriever(RuntimeError("sparse down")),
    )
    with pytest.raises(RuntimeError, match="sparse down"):
        r.retrieve(QueryBundle(query_str="q"))
