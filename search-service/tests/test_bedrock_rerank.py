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
    # infra is us-east-2; Rerank 3.5 is now live in us-east-1 (ACTIVE/ON_DEMAND,
    # confirmed 2026-07-22) — co-located with the cluster, ~35-55ms less than the
    # prior us-west-2 cross-continent hop (spec §5 region nuance).
    assert settings.bedrock_rerank_region == "us-east-1"
    assert settings.bedrock_rerank_model_id == "cohere.rerank-v3-5:0"
    assert settings.rerank_candidates == 100


def test_cite_floor_and_tiers_rederived_on_zero_one_scale(monkeypatch):
    """Cohere Rerank returns 0-1 relevance scores — the ms-marco raw-logit
    values (-9.0/-2.3/-7.8) are meaningless on that scale and would pass
    everything. Floor derived 2026-07-22 from live-Bedrock score capture
    (macro-F1 peak on the cite golden set with per-doc-capped candidates);
    it must stay below the smoke-set primary-target minimum (0.77) by a
    wide margin. TODO(golden-set) for formal per-language recalibration."""
    for var in ("CITE_LOGIT_FLOOR", "CITE_STRONG_THRESHOLD", "CITE_PARTIAL_THRESHOLD"):
        monkeypatch.delenv(var, raising=False)
    settings = get_settings()
    assert 0.02 <= settings.cite_logit_floor <= 0.15
    assert settings.cite_logit_floor < settings.cite_partial_threshold
    assert settings.cite_partial_threshold < settings.cite_strong_threshold
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
        def __init__(self, top_n=20, per_doc_cap=None):
            built.append((top_n, per_doc_cap))

    monkeypatch.setattr(main, "BedrockReranker", _FakeBedrockReranker)

    answer, cite = real_init_rerankers()

    # Answer mode wants the best chunks wherever they live (no cap); cite mode
    # scores documents, so its candidate set is diversified across docs.
    assert built == [(20, None), (1000, get_settings().cite_rerank_per_doc_cap)]
    assert isinstance(answer, _FakeBedrockReranker)
    assert isinstance(cite, _FakeBedrockReranker)


def test_answer_reranker_defaults_to_no_cap():
    """Default stays uncapped: answer mode wants the best chunks wherever they
    live. Making the cap configurable must not change behaviour on its own."""
    import app.main as main

    reranker_answer, _cite = main.init_rerankers()

    assert reranker_answer.per_doc_cap is None


def test_answer_reranker_uses_configured_per_doc_cap(monkeypatch):
    """embed-v4 can concentrate a query's top chunks in a single doc (ans_006),
    so the answer candidate pool needs the same diversification lever cite has.

    init_rerankers() reads the module-level `settings` bound once at import, so
    patching the env + clearing the lru_cache would not reach it — patch the
    already-imported settings object instead.
    """
    import app.main as main

    monkeypatch.setattr(main.settings, "answer_rerank_per_doc_cap", 3)

    reranker_answer, _cite = main.init_rerankers()

    assert reranker_answer.per_doc_cap == 3


# --- per-doc candidate diversification (cite mode) -------------------------

def _doc_nodes(chunks_per_doc):
    """chunks_per_doc: list of (doc_id, n_chunks) — nodes in fusion order,
    all of doc 0 first, then doc 1, etc. (the pathological clustering case)."""
    nodes = []
    i = 0
    for doc_id, n in chunks_per_doc:
        for _ in range(n):
            node = TextNode(id_=f"c{i}", text=f"text {i}")
            node.metadata["doc_id"] = doc_id
            nodes.append(NodeWithScore(node=node, score=float(1000 - i)))
            i += 1
    return nodes


def test_per_doc_cap_diversifies_candidate_set(monkeypatch):
    """Fused chunk lists cluster many chunks of the same top docs, so a plain
    top-N chunk cut sends only a handful of docs to the reranker (measured:
    100 chunks from 5 docs) and caps cite recall. With a per-doc cap, the
    candidate slots spread across more documents."""
    import app.bedrock_rerank as br

    stub = _StubAgentRuntime()
    monkeypatch.setattr(br, "get_client", lambda: stub)
    monkeypatch.setenv("RERANK_CANDIDATES", "6")
    get_settings.cache_clear()

    nodes = _doc_nodes([("dA", 10), ("dB", 10), ("dC", 10), ("dD", 10)])
    r = br.BedrockReranker(top_n=1000, per_doc_cap=2)
    out = r.postprocess_nodes(nodes, QueryBundle(query_str="q"))

    sent_docs = [n["inlineDocumentSource"]["textDocument"]["text"]
                 for n in stub.calls[0]["sources"]]
    # 6 slots, cap 2 → three docs represented, best-fused chunks of each
    assert sent_docs == ["text 0", "text 1", "text 10", "text 11", "text 20", "text 21"]
    assert len(out) == 6


def test_per_doc_cap_fills_all_slots_when_docs_run_out(monkeypatch):
    """Fewer docs than slots/cap allows: fall back to fusion order for the
    remaining slots rather than sending a short candidate list."""
    import app.bedrock_rerank as br

    stub = _StubAgentRuntime()
    monkeypatch.setattr(br, "get_client", lambda: stub)
    monkeypatch.setenv("RERANK_CANDIDATES", "8")
    get_settings.cache_clear()

    nodes = _doc_nodes([("dA", 6), ("dB", 6)])
    r = br.BedrockReranker(top_n=1000, per_doc_cap=2)
    r.postprocess_nodes(nodes, QueryBundle(query_str="q"))

    sent = [n["inlineDocumentSource"]["textDocument"]["text"]
            for n in stub.calls[0]["sources"]]
    # cap pass admits c0,c1 (dA) + c6,c7 (dB); backfill is fusion-ordered
    # (every doc is already at cap, so balance among backfill is moot)
    assert len(sent) == 8
    assert sent[:4] == ["text 0", "text 1", "text 6", "text 7"]
    assert sent[4:] == ["text 2", "text 3", "text 4", "text 5"]


def test_per_doc_cap_none_preserves_plain_topn_cut(monkeypatch):
    import app.bedrock_rerank as br

    stub = _StubAgentRuntime()
    monkeypatch.setattr(br, "get_client", lambda: stub)
    monkeypatch.setenv("RERANK_CANDIDATES", "4")
    get_settings.cache_clear()

    nodes = _doc_nodes([("dA", 10), ("dB", 10)])
    r = br.BedrockReranker(top_n=1000, per_doc_cap=None)
    r.postprocess_nodes(nodes, QueryBundle(query_str="q"))

    sent = [n["inlineDocumentSource"]["textDocument"]["text"]
            for n in stub.calls[0]["sources"]]
    assert sent == ["text 0", "text 1", "text 2", "text 3"]


def test_per_doc_cap_missing_doc_id_treated_as_distinct(monkeypatch):
    """Nodes without doc_id metadata (summary nodes, legacy) must not all
    collapse into one capped bucket."""
    import app.bedrock_rerank as br

    stub = _StubAgentRuntime()
    monkeypatch.setattr(br, "get_client", lambda: stub)
    monkeypatch.setenv("RERANK_CANDIDATES", "4")
    get_settings.cache_clear()

    nodes = _nodes(4)  # no doc_id metadata
    r = br.BedrockReranker(top_n=1000, per_doc_cap=1)
    r.postprocess_nodes(nodes, QueryBundle(query_str="q"))

    assert len(stub.calls[0]["sources"]) == 4
