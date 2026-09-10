"""POST /tags/nearby — additive query→tag lookup for the experts mode.

Wraps topic_sense.nearby_tags per facet. Never raises for a facet failure;
the facet is named in `degraded` instead. /query is untouched."""
import httpx
import pytest

import app.main as _main
import app.topic_sense as ts


class _Embed:
    def __init__(self):
        self.calls = []

    def get_query_embedding(self, q):
        self.calls.append(q)
        return [0.0] * 1536


@pytest.fixture
def client(monkeypatch):
    embed = _Embed()
    monkeypatch.setitem(_main.service_state, "embed_model", embed)
    monkeypatch.setattr(ts, "model_has_tag_embeddings", lambda m: True)
    transport = httpx.ASGITransport(app=_main.app)
    return httpx.AsyncClient(transport=transport, base_url="http://test"), embed


@pytest.mark.asyncio
async def test_returns_per_facet_matches_and_passes_top_k(client, monkeypatch):
    c, embed = client
    seen = {}

    def fake_nearby(emb, facet, top_k=None):
        seen[facet] = top_k
        return [("Electric Mobility", 0.66)] if facet == "topic" else [("China", 0.41)]

    monkeypatch.setattr(ts, "nearby_tags", fake_nearby)
    async with c:
        r = await c.post("/tags/nearby", json={"query": "electric buses",
                                               "facets": ["topic", "geography"], "top_k": 10})
    assert r.status_code == 200
    body = r.json()
    assert body["facets"] == {"topic": [["Electric Mobility", 0.66]], "geography": [["China", 0.41]]}
    assert body["degraded"] == []
    assert seen == {"topic": 10, "geography": 10}
    assert embed.calls == ["electric buses"]


@pytest.mark.asyncio
async def test_failing_facet_is_degraded_not_500(client, monkeypatch):
    c, _ = client

    def fake_nearby(emb, facet, top_k=None):
        if facet == "geography":
            raise RuntimeError("no table")
        return [("Buses", 0.5)]

    monkeypatch.setattr(ts, "nearby_tags", fake_nearby)
    async with c:
        r = await c.post("/tags/nearby", json={"query": "buses", "facets": ["topic", "geography"]})
    assert r.status_code == 200
    assert r.json()["facets"] == {"topic": [["Buses", 0.5]], "geography": []}
    assert r.json()["degraded"] == ["geography"]


@pytest.mark.asyncio
async def test_no_embed_model_degrades_every_facet(client, monkeypatch):
    c, _ = client
    monkeypatch.setitem(_main.service_state, "embed_model", None)
    async with c:
        r = await c.post("/tags/nearby", json={"query": "buses", "facets": ["topic"]})
    assert r.status_code == 200
    assert r.json() == {"facets": {"topic": []}, "model": r.json()["model"], "degraded": ["topic"]}


@pytest.mark.asyncio
async def test_blank_query_is_400(client):
    c, _ = client
    async with c:
        r = await c.post("/tags/nearby", json={"query": "   "})
    assert r.status_code == 400


def test_nearby_tags_top_k_override_keeps_setting_default(monkeypatch):
    # top_k=None must still read settings.topic_sense_top_k so /query's lanes
    # are byte-identical; an explicit top_k must win.
    import app.topic_sense as mod
    captured = {}

    class _Conn:
        def execute(self, sql, params):
            captured["k"] = params["k"]
            class _R:
                def fetchall(self_inner):
                    return [("A", 0.9), ("B", 0.8), ("C", 0.7), ("D", 0.6)]
            return _R()
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    class _Pool:
        def connection(self):
            return _Conn()

    monkeypatch.setattr("app.db.get_pool", lambda: _Pool())

    class _S:
        embedding_model = "cohere-embed-v4"
        topic_sense_top_k = 3
        topic_sense_min_cosine = 0.30

    monkeypatch.setattr("app.config.get_settings", lambda: _S())
    assert len(mod.nearby_tags([0.0] * 1536, "topic")) == 3
    assert len(mod.nearby_tags([0.0] * 1536, "topic", top_k=10)) == 4
    assert captured["k"] == 40
