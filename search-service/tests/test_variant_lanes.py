"""P3 slice 2 — variant lanes (design 2026-08-19 §4.3).

Each LLM variant contributes a dense + sparse retrieval lane at 1× weight
(vs 2× for the original lanes), fed into `extra_lanes`. The reranker still
only ever sees the original query (§4.4 — the precision guard): variants
widen the candidate pool pre-rerank; they never redefine the question.

`build_variant_lanes` is pure + factory-injected so it's unit-testable without
a DB: it builds the lane dicts; the fusion core (HybridFusionRetriever)
runs each lane's retriever in its existing parallel pool. A variant that
equals the original query (case-insensitive) is skipped (dedupe, §4.1).
"""
from app.main import build_variant_lanes


def _dense_factory(top_k):
    """Stand-in for make_dense_retriever; records the top_k it got."""
    class _R:
        def __init__(self, top_k): self.top_k = top_k
        def retrieve(self, bundle): return []
    return _R(top_k)


def _bm25_stub():
    class _B:
        def retrieve(self, bundle): return []
    return _B()


def test_no_variants_no_lanes():
    lanes = build_variant_lanes(
        variants=[], query="hydrogen", dense_retriever_factory=_dense_factory,
        bm25_retriever=_bm25_stub(), lanes_on=True, top_k=100,
    )
    assert lanes == []


def test_variant_equal_to_query_is_deduped():
    """Design §4.1: a variant that is the original query (case-insensitive)
    is skipped — re-querying the original adds no candidates and would
    inflate its RRF weight."""
    lanes = build_variant_lanes(
        variants=["Hydrogen", "hydrogen fuel cells"],
        query="hydrogen",
        dense_retriever_factory=_dense_factory, bm25_retriever=_bm25_stub(),
        lanes_on=True, top_k=100,
    )
    # only the second variant survives dedupe
    assert len(lanes) == 2  # dense + sparse for the one surviving variant
    assert lanes[0]["name"] == "variant0_dense"
    assert lanes[1]["name"] == "variant0_sparse"


def test_each_variant_gets_dense_and_sparse_lane():
    lanes = build_variant_lanes(
        variants=["hydrogen fuel cells", "H2 transport"],
        query="hydrogen",
        dense_retriever_factory=_dense_factory, bm25_retriever=_bm25_stub(),
        lanes_on=True, top_k=100,
    )
    assert len(lanes) == 4
    names = [l["name"] for l in lanes]
    assert names == ["variant0_dense", "variant0_sparse",
                     "variant1_dense", "variant1_sparse"]
    # dense lanes carry the variant query; sparse lanes carry the expanded
    # variant query (sparse_query_for).
    assert lanes[0]["query_str"] == "hydrogen fuel cells"
    assert lanes[1]["query_str"]  # expanded form, not raw variant
    assert lanes[1]["query_str"] != "hydrogen fuel cells"


def test_no_lanes_when_lanes_off():
    """Variant lanes are expansion lanes — gated by lanes_active, exactly like
    the tag lanes. Flag-off (lanes_on=False) ⇒ no lanes (byte-identical)."""
    lanes = build_variant_lanes(
        variants=["hydrogen fuel cells"],
        query="hydrogen",
        dense_retriever_factory=_dense_factory, bm25_retriever=_bm25_stub(),
        lanes_on=False, top_k=100,
    )
    assert lanes == []


def test_lanes_carry_1x_weight_none():
    """Design §4.3: variant lanes at 1× (weight=None → sparse/dense weight,
    not doubled). The fusion core doubles ONLY the original lanes when an
    expansion lane materializes."""
    lanes = build_variant_lanes(
        variants=["hydrogen fuel cells"],
        query="hydrogen",
        dense_retriever_factory=_dense_factory, bm25_retriever=_bm25_stub(),
        lanes_on=True, top_k=100,
    )
    for lane in lanes:
        assert lane["weight"] is None
        assert lane["top_k"] == 100


def test_dense_retriever_factory_called_per_variant():
    """One dense retriever per variant (each variant embeds its own query)."""
    calls = []
    def factory(top_k):
        calls.append(top_k)
        return _dense_factory(top_k)
    build_variant_lanes(
        variants=["a", "b", "c"], query="q",
        dense_retriever_factory=factory, bm25_retriever=_bm25_stub(),
        lanes_on=True, top_k=50,
    )
    assert calls == [50, 50, 50]
