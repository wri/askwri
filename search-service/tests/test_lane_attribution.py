"""Per-lane rank attribution (design 2026-08-19 P0; cross-lingual design §5.2).

The ranks recorded must be the rankings that FED RRF — the fusion path's own
dense/sparse lists — not the separate diagnostic lanes (the 2026-07-24 findings
retraction happened because those differ)."""
from types import SimpleNamespace
from unittest.mock import MagicMock

from llama_index.core.schema import NodeWithScore, QueryBundle, TextNode

from app.main import HybridFusionRetriever


def _nws(node_id: str, score: float) -> NodeWithScore:
    return NodeWithScore(node=TextNode(id_=node_id, text=f"text {node_id}"), score=score)


class _StubRetriever:
    def __init__(self, results):
        self._results = results

    def retrieve(self, bundle):
        return list(self._results)


def _make_retriever(dense, sparse):
    return HybridFusionRetriever(
        vector_retriever=_StubRetriever(dense),
        bm25_retriever=_StubRetriever(sparse),
        mode="cite",
        fusion_top_k=10,
    )


def test_lane_ranks_recorded_for_all_fused_nodes():
    dense = [_nws("a", 0.9), _nws("b", 0.8)]
    sparse = [_nws("b", 5.0), _nws("c", 4.0)]
    r = _make_retriever(dense, sparse)
    r._retrieve(QueryBundle(query_str="anything"))

    assert r.lane_ranks["a"] == {"dense": 1, "sparse": None}
    assert r.lane_ranks["b"] == {"dense": 2, "sparse": 1}
    assert r.lane_ranks["c"] == {"dense": None, "sparse": 2}


def test_lane_ranks_cover_exactly_the_fused_set():
    dense = [_nws(f"d{i}", 1.0 - i / 100) for i in range(15)]
    sparse = [_nws(f"s{i}", 10.0 - i) for i in range(15)]
    r = _make_retriever(dense, sparse)
    out = r._retrieve(QueryBundle(query_str="q"))
    assert set(r.lane_ranks.keys()) == {n.node.node_id for n in out}
