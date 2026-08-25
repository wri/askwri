"""P2.5 /query wiring: topic_dense lane construction, gated retirement,
flag-off leak detection (design §4.3, §5). TestClient + stubs — no DB/network,
same pattern as test_diagnostic_parity.py."""
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


class _RecordingTagRetriever:
    """Stands in for TagRetriever; records construction + retrieve calls
    so tests can assert a lane fired without a real DB pool."""
    instances = []

    def __init__(self, nearby_tags, pool, **kwargs):
        self.nearby_tags = nearby_tags
        self.kwargs = kwargs
        self.retrieved = False
        type(self).instances.append(self)

    def retrieve(self, bundle):
        self.retrieved = True
        return []


def _post(client, **overrides):
    body = {"query": "urban finance mechanisms", "mode": "cite", "rerank": False}
    body.update(overrides)
    return client.post("/query", json=body)


def _stubbed(monkeypatch, lanes_on, matched_tags=None):
    """matched_tags: dict[str, list[(label, cosine)]] — keyed by facet."""
    stub = RecordingRetriever()
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", stub)
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setattr(app_main, "make_dense_retriever", lambda top_k: _DenseStub())
    monkeypatch.setattr(app_main, "understanding_active", lambda s, r: True)
    monkeypatch.setattr(app_main, "lanes_active", lambda s, r: lanes_on)

    def _build(query, explicit_facets, today_year, expansion_lanes=False, embed_model=None):
        u = QueryUnderstanding()
        if expansion_lanes:
            u.matched_tags = dict(matched_tags or {})
        return u

    monkeypatch.setattr(app_main, "build_understanding", _build)
    import app.topic_sense as ts
    monkeypatch.setattr(ts, "attach_topic_suggestions", lambda u, q, m: None)
    # TagRetriever stub + pool stub so no real DB is touched when a lane fires.
    _RecordingTagRetriever.instances = []
    import app.topic_retrieval as tr
    monkeypatch.setattr(tr, "TagRetriever", _RecordingTagRetriever)
    import app.db as db
    monkeypatch.setattr(db, "get_pool", lambda: object())
    return stub


def test_lanes_on_topic_dense_lane_built_from_matched_tags(monkeypatch):
    tags = [("Climate Resilience", 0.82), ("Heat Islands", 0.71)]
    stub = _stubbed(monkeypatch, lanes_on=True, matched_tags={"topic": tags})
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    # TagRetriever constructed with the matched topic tags (topic_dense lane).
    assert len(_RecordingTagRetriever.instances) == 1
    assert _RecordingTagRetriever.instances[0].nearby_tags == tags
    assert _RecordingTagRetriever.instances[0].kwargs.get("facet") == "topic"
    assert _RecordingTagRetriever.instances[0].retrieved is True
    # Original sparse lane: RAW query (DOMAIN_EXPANSIONS retirement holds).
    assert "urban finance mechanisms" in stub.seen_queries
    # No alias OR query anywhere (alias lane retired).
    assert not any(" OR " in q for q in stub.seen_queries)
    # No OR-stuffed DOMAIN_EXPANSIONS query anywhere.
    stuffed = sparse_query_for("urban finance mechanisms")
    assert stuffed not in stub.seen_queries
    assert resp.json()["debug"]["matched_tags_count"] == {"topic": 2}


def test_lanes_on_no_topic_tags_no_extra_lane(monkeypatch):
    stub = _stubbed(monkeypatch, lanes_on=True, matched_tags={})
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    # No lane constructed; retirement still applies (raw sparse only).
    assert _RecordingTagRetriever.instances == []
    assert stub.seen_queries == ["urban finance mechanisms"]
    assert resp.json()["debug"]["matched_tags_count"] == {}


def test_p1_only_keeps_or_stuffing(monkeypatch):
    stub = _stubbed(monkeypatch, lanes_on=False, matched_tags={})
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    assert stub.seen_queries == [sparse_query_for("urban finance mechanisms")]
    # understanding IS built (understanding_active=True in stub) but lanes off
    # → matched_tags stays empty dict (no expansion_lanes)
    assert resp.json()["debug"]["matched_tags_count"] == {}


def test_flag_off_no_tag_lane_code_touched(monkeypatch):
    """Leak detector: default flags => tag retrieval must never run and
    the sparse lane is byte-identical (OR-stuffed) — spec §5."""
    import app.topic_retrieval as tr

    def _boom(*a, **kw):
        raise AssertionError("leak")

    monkeypatch.setattr(tr, "TagRetriever", _boom)
    stub = RecordingRetriever()
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", stub)
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setattr(app_main, "make_dense_retriever", lambda top_k: _DenseStub())
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    assert stub.seen_queries == [sparse_query_for("urban finance mechanisms")]
    assert resp.json()["debug"]["matched_tags_count"] is None


def test_diagnostic_debug_has_fused_nodes_and_window(monkeypatch):
    _stubbed(monkeypatch, lanes_on=True, matched_tags={"topic": [("Climate Resilience", 0.82)]})
    client = TestClient(app_main.app)
    resp = _post(client, return_intermediate_results=True)
    assert resp.status_code == 200
    debug = resp.json()["debug"]
    fused = debug["fused_nodes"]
    assert fused[0]["fused_rank"] == 1
    assert {"node_id", "doc_id", "url", "fused_rank", "lanes"} <= set(fused[0])
    # rerank=False => no window capture (None), key still present
    assert debug["rerank_window_ids"] is None
    assert debug["matched_tags_count"] == {"topic": 1}


def test_non_diagnostic_debug_omits_heavy_payloads(monkeypatch):
    _stubbed(monkeypatch, lanes_on=True, matched_tags={"topic": [("Climate Resilience", 0.82)]})
    client = TestClient(app_main.app)
    resp = _post(client)
    debug = resp.json()["debug"]
    assert debug["fused_nodes"] is None
    assert debug["rerank_window_ids"] is None


def test_lanes_on_geo_dense_lane_built_when_geo_matched(monkeypatch):
    """When expansion_facets includes geography and geo tags match, a
    geo_dense lane is built alongside topic_dense."""
    topic_tags = [("Climate Resilience", 0.82)]
    geo_tags = [("Kenya", 0.88), ("Africa", 0.75)]
    _stubbed(monkeypatch, lanes_on=True,
             matched_tags={"topic": topic_tags, "geography": geo_tags})
    # Override expansion_facets to include geography (default is topic-only).
    # Patch the module-level settings (line 92: settings = get_settings() at
    # import time, so patching get_settings is too late).
    from app.config import Settings
    monkeypatch.setattr(app_main, "settings", Settings(expansion_facets=["topic", "geography"]))
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    # Two lanes: topic_dense + geo_dense
    assert len(_RecordingTagRetriever.instances) == 2
    facets = [inst.kwargs.get("facet") for inst in _RecordingTagRetriever.instances]
    assert "topic" in facets and "geography" in facets
    assert all(inst.retrieved for inst in _RecordingTagRetriever.instances)
    assert resp.json()["debug"]["matched_tags_count"] == {"topic": 1, "geography": 2}


def test_lanes_on_no_geo_match_no_geo_lane(monkeypatch):
    """Geography in expansion_facets but no geo matches → no geo_dense lane
    (no cost). Only topic_dense fires."""
    topic_tags = [("Climate Resilience", 0.82)]
    _stubbed(monkeypatch, lanes_on=True, matched_tags={"topic": topic_tags})
    from app.config import Settings
    monkeypatch.setattr(app_main, "settings", Settings(expansion_facets=["topic", "geography"]))
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    # Only topic lane (geography had no matches → no lane)
    assert len(_RecordingTagRetriever.instances) == 1
    assert _RecordingTagRetriever.instances[0].kwargs.get("facet") == "topic"
