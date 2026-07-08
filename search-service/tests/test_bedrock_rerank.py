"""v3 B2 (spec §10): rerank swaps to Cohere Rerank 3.5 via AWS Bedrock.

The in-process OnnxReranker (ms-marco cross-encoder) is replaced by a thin
Bedrock Rerank API client for BOTH cite and answer modes. Cohere Rerank
returns 0-1 relevance scores, so the cite floor/tiers are re-derived on a
0-1 scale. The candidate set is reduced (~50-100) before the call — API
cost/latency scale with document count (spec §9).

boto3 is stubbed; no AWS calls happen here.
"""
import pytest
from llama_index.core.schema import NodeWithScore, QueryBundle, TextNode

from app.config import get_settings

# Bind at collection time: test_query_e2e's session-scoped fixture replaces
# app.main.init_rerankers with a stub and only restores it at session teardown.
from app.main import init_rerankers as real_init_rerankers


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _nodes(n):
    return [
        NodeWithScore(node=TextNode(id_=f"c{i}", text=f"text {i}"), score=float(n - i))
        for i in range(n)
    ]


# --- config ---------------------------------------------------------------

def test_bedrock_rerank_settings_defaults(monkeypatch):
    for var in ("BEDROCK_RERANK_REGION", "BEDROCK_RERANK_MODEL_ID", "RERANK_CANDIDATES"):
        monkeypatch.delenv(var, raising=False)
    settings = get_settings()
    # infra is us-east-2; Rerank 3.5 lives in us-west-2 (spec §5 region nuance)
    assert settings.bedrock_rerank_region == "us-west-2"
    assert settings.bedrock_rerank_model_id == "cohere.rerank-v3-5:0"
    assert settings.rerank_candidates == 100


def test_cite_floor_and_tiers_rederived_on_zero_one_scale(monkeypatch):
    """Cohere Rerank returns 0-1 relevance scores — the ms-marco raw-logit
    values (-9.0/-2.3/-7.8) are meaningless on that scale and would pass
    everything. Conservative (recall-first) provisional values; derive on
    the non-English smoke set once Bedrock access exists; TODO(golden-set)
    for formal per-language recalibration."""
    for var in ("CITE_LOGIT_FLOOR", "CITE_STRONG_THRESHOLD", "CITE_PARTIAL_THRESHOLD"):
        monkeypatch.delenv(var, raising=False)
    settings = get_settings()
    assert 0.0 < settings.cite_logit_floor <= 0.05
    assert 0.0 < settings.cite_partial_threshold < settings.cite_strong_threshold
    assert settings.cite_strong_threshold < 1.0


# --- reranker client -------------------------------------------------------

class _StubAgentRuntime:
    """Records rerank calls; scores source i as (i * 10 + 1) / 1000 so the
    stub deliberately REVERSES the incoming order (last doc scores highest)."""

    def __init__(self):
        self.calls = []

    def rerank(self, queries, sources, rerankingConfiguration, **kw):
        self.calls.append({
            "queries": queries,
            "sources": sources,
            "config": rerankingConfiguration,
        })
        n = len(sources)
        return {
            "results": [
                {"index": i, "relevanceScore": (i * 10 + 1) / 1000}
                for i in range(n)
            ]
        }


def test_postprocess_scores_sorts_and_slices(monkeypatch):
    import app.bedrock_rerank as br

    stub = _StubAgentRuntime()
    monkeypatch.setattr(br, "get_client", lambda: stub)

    r = br.BedrockReranker(top_n=3)
    out = r.postprocess_nodes(_nodes(10), QueryBundle(query_str="electric buses"))

    assert len(out) == 3
    # Stub reverses order: c9 got the highest relevance
    assert [n.node.node_id for n in out] == ["c9", "c8", "c7"]
    assert out[0].score == pytest.approx(0.091)
    # request shape
    call = stub.calls[0]
    assert call["queries"] == [{"type": "TEXT", "textQuery": {"text": "electric buses"}}]
    assert call["sources"][0] == {
        "type": "INLINE",
        "inlineDocumentSource": {"type": "TEXT", "textDocument": {"text": "text 0"}},
    }
    cfg = call["config"]["bedrockRerankingConfiguration"]
    assert "cohere.rerank-v3-5:0" in cfg["modelConfiguration"]["modelArn"]


def test_candidate_set_reduced_before_the_call(monkeypatch):
    """API cost/latency scale with doc count: only the top
    settings.rerank_candidates fused candidates are sent (spec §9 lever)."""
    import app.bedrock_rerank as br

    stub = _StubAgentRuntime()
    monkeypatch.setattr(br, "get_client", lambda: stub)
    monkeypatch.setenv("RERANK_CANDIDATES", "5")
    get_settings.cache_clear()

    r = br.BedrockReranker(top_n=1000)
    out = r.postprocess_nodes(_nodes(50), QueryBundle(query_str="q"))

    assert len(stub.calls[0]["sources"]) == 5
    # Un-reranked tail is dropped, not passed through with RRF scores
    # (mixing scales would corrupt the 0-1 floor/tiers).
    assert len(out) == 5
    assert {n.node.node_id for n in out} == {"c0", "c1", "c2", "c3", "c4"}


def test_per_call_top_n_override(monkeypatch):
    import app.bedrock_rerank as br

    stub = _StubAgentRuntime()
    monkeypatch.setattr(br, "get_client", lambda: stub)

    r = br.BedrockReranker(top_n=1000)
    out = r.postprocess_nodes(_nodes(10), QueryBundle(query_str="q"), top_n=2)
    assert len(out) == 2


def test_empty_and_none_query_early_returns(monkeypatch):
    import app.bedrock_rerank as br

    stub = _StubAgentRuntime()
    monkeypatch.setattr(br, "get_client", lambda: stub)

    r = br.BedrockReranker(top_n=3)
    assert r.postprocess_nodes([], QueryBundle(query_str="q")) == []
    nodes = _nodes(4)
    assert r.postprocess_nodes(nodes, None) is nodes
    assert stub.calls == []


def test_init_rerankers_returns_bedrock_rerankers_for_both_modes(monkeypatch):
    import app.main as main

    built = []

    class _FakeBedrockReranker:
        def __init__(self, top_n=20):
            built.append(top_n)

    monkeypatch.setattr(main, "BedrockReranker", _FakeBedrockReranker)

    answer, cite = real_init_rerankers()

    assert built == [20, 1000]
    assert isinstance(answer, _FakeBedrockReranker)
    assert isinstance(cite, _FakeBedrockReranker)
