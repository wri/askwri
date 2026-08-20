"""P2.5 /query wiring: topic_dense lane construction, gated retirement,
flag-off leak detection (design §4.3, §5). TestClient + stubs — no DB/network,
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


class _RecordingTopicRetriever:
    """Stands in for TopicTagRetriever; records construction + retrieve calls
    so tests can assert the topic_dense lane fired without a real DB pool."""
    instances = []

    def __init__(self, nearby_topics, pool, **kwargs):
        self.nearby_topics = nearby_topics
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


def _stubbed(monkeypatch, lanes_on, topic_tags):
    stub = RecordingRetriever()
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", stub)
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setattr(app_main, "make_dense_retriever", lambda top_k: _DenseStub())
    monkeypatch.setattr(app_main, "understanding_active", lambda s, r: True)
    monkeypatch.setattr(app_main, "lanes_active", lambda s, r: lanes_on)

    def _build(query, explicit_facets, today_year, expansion_lanes=False, embed_model=None):
        u = QueryUnderstanding()
        if expansion_lanes:
            u.topic_tags = list(topic_tags)
        return u

    monkeypatch.setattr(app_main, "build_understanding", _build)
    import app.topic_sense as ts
    monkeypatch.setattr(ts, "attach_topic_suggestions", lambda u, q, m: None)
    # TopicTagRetriever stub + pool stub so no real DB is touched when the
    # topic_dense lane fires.
    _RecordingTopicRetriever.instances = []
    import app.topic_retrieval as tr
    monkeypatch.setattr(tr, "TopicTagRetriever", _RecordingTopicRetriever)
    import app.db as db
    monkeypatch.setattr(db, "get_pool", lambda: object())
    return stub


def test_lanes_on_topic_dense_lane_built_from_topic_tags(monkeypatch):
    tags = [("Climate Resilience", 0.82), ("Heat Islands", 0.71)]
    stub = _stubbed(monkeypatch, lanes_on=True, topic_tags=tags)
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    # TopicTagRetriever constructed with the matched tags (the topic_dense lane).
    assert len(_RecordingTopicRetriever.instances) == 1
    assert _RecordingTopicRetriever.instances[0].nearby_topics == tags
    assert _RecordingTopicRetriever.instances[0].retrieved is True
    # Original sparse lane: RAW query (DOMAIN_EXPANSIONS retirement holds).
    assert "urban finance mechanisms" in stub.seen_queries
    # No alias OR query anywhere (alias lane retired).
    assert not any(" OR " in q for q in stub.seen_queries)
    # No OR-stuffed DOMAIN_EXPANSIONS query anywhere.
    stuffed = sparse_query_for("urban finance mechanisms")
    assert stuffed not in stub.seen_queries
    assert resp.json()["debug"]["topic_tags_count"] == 2


def test_lanes_on_no_topic_tags_no_extra_lane(monkeypatch):
    stub = _stubbed(monkeypatch, lanes_on=True, topic_tags=[])
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    # No topic lane constructed; retirement still applies (raw sparse only).
    assert _RecordingTopicRetriever.instances == []
    assert stub.seen_queries == ["urban finance mechanisms"]
    assert resp.json()["debug"]["topic_tags_count"] == 0


def test_p1_only_keeps_or_stuffing(monkeypatch):
    stub = _stubbed(monkeypatch, lanes_on=False, topic_tags=[])
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    assert stub.seen_queries == [sparse_query_for("urban finance mechanisms")]
    assert resp.json()["debug"]["topic_tags_count"] == 0


def test_flag_off_no_topic_lane_code_touched(monkeypatch):
    """Leak detector: default flags => topic retrieval must never run and
    the sparse lane is byte-identical (OR-stuffed) — spec §5."""
    import app.topic_retrieval as tr

    def _boom(*a, **kw):
        raise AssertionError("leak")

    monkeypatch.setattr(tr, "TopicTagRetriever", _boom)
    stub = RecordingRetriever()
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", stub)
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setattr(app_main, "make_dense_retriever", lambda top_k: _DenseStub())
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    assert stub.seen_queries == [sparse_query_for("urban finance mechanisms")]
    assert resp.json()["debug"]["topic_tags_count"] is None


def test_diagnostic_debug_has_fused_nodes_and_window(monkeypatch):
    _stubbed(monkeypatch, lanes_on=True, topic_tags=[("Climate Resilience", 0.82)])
    client = TestClient(app_main.app)
    resp = _post(client, return_intermediate_results=True)
    assert resp.status_code == 200
    debug = resp.json()["debug"]
    fused = debug["fused_nodes"]
    assert fused[0]["fused_rank"] == 1
    assert {"node_id", "doc_id", "url", "fused_rank", "lanes"} <= set(fused[0])
    # rerank=False => no window capture (None), key still present
    assert debug["rerank_window_ids"] is None
    assert debug["topic_tags_count"] == 1


def test_non_diagnostic_debug_omits_heavy_payloads(monkeypatch):
    _stubbed(monkeypatch, lanes_on=True, topic_tags=[("Climate Resilience", 0.82)])
    client = TestClient(app_main.app)
    resp = _post(client)
    debug = resp.json()["debug"]
    assert debug["fused_nodes"] is None
    assert debug["rerank_window_ids"] is None
