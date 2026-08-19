"""P2 /query wiring: alias lane construction, gated retirement, flag-off
leak detection (design §4.3, §5). TestClient + stubs — no DB/network,
same pattern as test_diagnostic_parity.py."""
from unittest.mock import patch

from fastapi.testclient import TestClient
from llama_index.core.schema import NodeWithScore, TextNode

from app import main as app_main
from app.query_expansion import sparse_query_for
from app.understanding import QueryUnderstanding


class RecordingRetriever:
    def __init__(self):
        self.seen_queries = []

    def retrieve(self, bundle):
        self.seen_queries.append(bundle.query_str)
        return [
            NodeWithScore(node=TextNode(id_=f"c{i}", text="t",
                                        metadata={"doc_id": f"d{i}", "url": f"https://wri.org/research/doc-{i}"}),
                          score=1.0 - i * 0.01)
            for i in range(5)
        ]


class _DenseStub:
    def retrieve(self, bundle):
        return []


def _post(client, **overrides):
    body = {"query": "urban finance mechanisms", "mode": "cite", "rerank": False}
    body.update(overrides)
    return client.post("/query", json=body)


def _stubbed(monkeypatch, lanes_on, alias_expansions):
    stub = RecordingRetriever()
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", stub)
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setattr(app_main, "make_dense_retriever", lambda top_k: _DenseStub())
    monkeypatch.setattr(app_main, "understanding_active", lambda s, r: True)
    monkeypatch.setattr(app_main, "lanes_active", lambda s, r: lanes_on)

    def _build(query, explicit_facets, today_year, expansion_lanes=False):
        u = QueryUnderstanding()
        if expansion_lanes:
            u.alias_expansions = list(alias_expansions)
        return u

    monkeypatch.setattr(app_main, "build_understanding", _build)
    import app.topic_sense as ts
    monkeypatch.setattr(ts, "attach_topic_suggestions", lambda u, q, m: None)
    return stub


def test_lanes_on_alias_lane_and_raw_original_sparse(monkeypatch):
    stub = _stubbed(monkeypatch, lanes_on=True,
                    alias_expansions=["municipal finance", "transit financing"])
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    # Original sparse lane: RAW query (retirement). Alias lane: query + terms.
    assert "urban finance mechanisms" in stub.seen_queries
    assert ("urban finance mechanisms OR municipal finance OR transit financing"
            in stub.seen_queries)
    # No OR-stuffed DOMAIN_EXPANSIONS query anywhere.
    stuffed = sparse_query_for("urban finance mechanisms")
    assert stuffed not in stub.seen_queries
    assert resp.json()["debug"]["alias_lane_size"] == 2


def test_lanes_on_no_alias_match_single_sparse_raw(monkeypatch):
    stub = _stubbed(monkeypatch, lanes_on=True, alias_expansions=[])
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    # Retirement still applies; no extra lane constructed.
    assert stub.seen_queries == ["urban finance mechanisms"]
    assert resp.json()["debug"]["alias_lane_size"] == 0


def test_p1_only_keeps_or_stuffing(monkeypatch):
    stub = _stubbed(monkeypatch, lanes_on=False, alias_expansions=[])
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    assert stub.seen_queries == [sparse_query_for("urban finance mechanisms")]
    assert resp.json()["debug"]["alias_lane_size"] == 0


def test_flag_off_no_alias_code_touched(monkeypatch):
    """Leak detector: default flags => alias module must never run and the
    sparse lane is byte-identical (OR-stuffed) — spec §5."""
    import app.alias_expand as ae
    monkeypatch.setattr(ae, "db_expander",
                        lambda: (_ for _ in ()).throw(AssertionError("leak")))
    stub = RecordingRetriever()
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", stub)
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setattr(app_main, "make_dense_retriever", lambda top_k: _DenseStub())
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    assert stub.seen_queries == [sparse_query_for("urban finance mechanisms")]
    assert resp.json()["debug"]["alias_lane_size"] is None


def test_diagnostic_debug_has_fused_nodes_and_window(monkeypatch):
    _stubbed(monkeypatch, lanes_on=True, alias_expansions=["municipal finance"])
    client = TestClient(app_main.app)
    resp = _post(client, return_intermediate_results=True)
    assert resp.status_code == 200
    debug = resp.json()["debug"]
    fused = debug["fused_nodes"]
    assert fused[0]["fused_rank"] == 1
    assert {"node_id", "doc_id", "url", "fused_rank", "lanes"} <= set(fused[0])
    # rerank=False => no window capture (None), key still present
    assert debug["rerank_window_ids"] is None


def test_non_diagnostic_debug_omits_heavy_payloads(monkeypatch):
    _stubbed(monkeypatch, lanes_on=True, alias_expansions=["municipal finance"])
    client = TestClient(app_main.app)
    resp = _post(client)
    debug = resp.json()["debug"]
    assert debug["fused_nodes"] is None
    assert debug["rerank_window_ids"] is None
