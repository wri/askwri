"""POST /tags/nearby — additive query→tag lookup for the experts mode.

Wraps topic_sense.nearby_tags per facet. Never raises for a facet failure;
the facet is named in `degraded` instead. /query is untouched."""
import threading

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
    monkeypatch.setattr(ts, "facet_has_tag_embeddings", lambda model, facet: True)
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
async def test_facet_without_tag_embedding_coverage_is_degraded(client, monkeypatch):
    """P1 (spec §5.2): coverage is per FACET, not per model. A model with topic
    rows but no geography rows must name geography in `degraded` — the empty
    list alone is indistinguishable from a legitimate no-match."""
    c, _ = client
    monkeypatch.setattr(ts, "facet_has_tag_embeddings",
                        lambda model, facet: facet == "topic")
    monkeypatch.setattr(
        ts, "nearby_tags",
        lambda emb, facet, top_k=None: [("Buses", 0.5)] if facet == "topic" else [],
    )
    async with c:
        r = await c.post("/tags/nearby",
                         json={"query": "buses", "facets": ["topic", "geography"]})
    assert r.status_code == 200
    body = r.json()
    assert body["facets"] == {"topic": [["Buses", 0.5]], "geography": []}
    assert body["degraded"] == ["geography"]


@pytest.mark.asyncio
async def test_covered_facet_with_no_match_is_not_degraded(client, monkeypatch):
    """P1 counterpart: a facet WITH coverage whose tags all sit below the cosine
    floor returns [] and is NOT degraded. Only absent coverage is degraded."""
    c, _ = client
    monkeypatch.setattr(ts, "facet_has_tag_embeddings",
                        lambda model, facet: True)
    monkeypatch.setattr(ts, "nearby_tags", lambda emb, facet, top_k=None: [])
    async with c:
        r = await c.post("/tags/nearby", json={"query": "buses", "facets": ["topic"]})
    assert r.status_code == 200
    assert r.json() == {"facets": {"topic": []},
                        "model": r.json()["model"], "degraded": []}


@pytest.mark.asyncio
async def test_no_covered_facet_skips_the_embedding_call(client, monkeypatch):
    """P1: probe before embedding, so a fully uncovered request costs no embed."""
    c, embed = client
    monkeypatch.setattr(ts, "facet_has_tag_embeddings",
                        lambda model, facet: False)
    async with c:
        r = await c.post("/tags/nearby", json={"query": "buses", "facets": ["topic"]})
    assert r.status_code == 200
    assert r.json()["degraded"] == ["topic"]
    assert embed.calls == []


@pytest.mark.asyncio
async def test_coverage_probe_failure_degrades_and_never_500s(client, monkeypatch):
    """P2: the coverage probe opens a pool connection. A DB/pool outage must
    degrade the affected facets, not raise out of the handler (spec §5.2:
    "Never raises for a facet failure")."""
    c, _ = client

    def boom(model, facet):
        raise RuntimeError("pool exhausted")

    monkeypatch.setattr(ts, "facet_has_tag_embeddings", boom)
    monkeypatch.setattr(ts, "model_has_tag_embeddings", boom)
    monkeypatch.setattr(ts, "nearby_tags",
                        lambda emb, facet, top_k=None: [("Buses", 0.5)])
    async with c:
        r = await c.post("/tags/nearby",
                         json={"query": "buses", "facets": ["topic", "geography"]})
    assert r.status_code == 200
    assert r.json()["facets"] == {"topic": [], "geography": []}
    assert r.json()["degraded"] == ["topic", "geography"]


@pytest.mark.parametrize("bad_top_k", [-5, 0, 101, 10_000_000])
@pytest.mark.asyncio
async def test_out_of_range_top_k_is_422(client, monkeypatch, bad_top_k):
    """P3: /tags/nearby is unauthenticated and top_k reaches a SQL LIMIT and a
    list slice. Unbounded, top_k=-5 slices rows[:-5] (silently dropping the last
    5 of 20), top_k=0 returns [] undegraded, and 10_000_000 issues LIMIT
    40000000. Bounds make a bad value a 422 instead of silent nonsense."""
    c, _ = client
    called = []
    monkeypatch.setattr(ts, "nearby_tags",
                        lambda emb, facet, top_k=None: called.append(top_k) or [])
    async with c:
        r = await c.post("/tags/nearby",
                         json={"query": "buses", "facets": ["topic"], "top_k": bad_top_k})
    assert r.status_code == 422
    assert called == []


@pytest.mark.parametrize("ok_top_k", [1, 100])
@pytest.mark.asyncio
async def test_top_k_bounds_are_inclusive(client, monkeypatch, ok_top_k):
    """P3 boundary: 1 and 100 are accepted and passed through verbatim."""
    c, _ = client
    called = []
    monkeypatch.setattr(ts, "nearby_tags",
                        lambda emb, facet, top_k=None: called.append(top_k) or [])
    async with c:
        r = await c.post("/tags/nearby",
                         json={"query": "buses", "facets": ["topic"], "top_k": ok_top_k})
    assert r.status_code == 200
    assert called == [ok_top_k]


@pytest.mark.asyncio
async def test_duplicate_facets_are_deduped_in_request_order(client, monkeypatch):
    """P4: ["topic","topic","geography"] builds one key per facet but must not
    run the probe or the cosine query twice for identical output."""
    c, _ = client
    probed, queried = [], []
    monkeypatch.setattr(ts, "facet_has_tag_embeddings",
                        lambda model, facet: probed.append(facet) or True)
    monkeypatch.setattr(
        ts, "nearby_tags",
        lambda emb, facet, top_k=None: queried.append(facet) or [(facet.title(), 0.5)],
    )
    async with c:
        r = await c.post("/tags/nearby",
                         json={"query": "buses",
                               "facets": ["topic", "topic", "geography", "topic"]})
    assert r.status_code == 200
    assert list(r.json()["facets"]) == ["topic", "geography"]
    assert probed == ["topic", "geography"]
    assert queried == ["topic", "geography"]


@pytest.mark.asyncio
async def test_duplicate_failing_facet_is_named_once_in_degraded(client, monkeypatch):
    """P4: a duplicated failing facet must appear once in `degraded`."""
    c, _ = client

    def boom(emb, facet, top_k=None):
        raise RuntimeError("no rows")

    monkeypatch.setattr(ts, "nearby_tags", boom)
    async with c:
        r = await c.post("/tags/nearby",
                         json={"query": "buses", "facets": ["topic", "topic"]})
    assert r.status_code == 200
    assert r.json()["degraded"] == ["topic"]


@pytest.mark.asyncio
async def test_unknown_facet_falls_out_as_degraded(client, monkeypatch):
    """P4: "authors" is not a tag facet, so it has no tag_embeddings coverage and
    the P1 probe degrades it. No special-casing of facet names."""
    c, _ = client
    monkeypatch.setattr(ts, "facet_has_tag_embeddings",
                        lambda model, facet: facet in ("topic", "geography"))
    monkeypatch.setattr(ts, "nearby_tags",
                        lambda emb, facet, top_k=None: [("Buses", 0.5)])
    async with c:
        r = await c.post("/tags/nearby",
                         json={"query": "buses", "facets": ["topic", "authors"]})
    assert r.status_code == 200
    assert r.json()["facets"] == {"topic": [["Buses", 0.5]], "authors": []}
    assert r.json()["degraded"] == ["authors"]


@pytest.mark.asyncio
async def test_coverage_probe_runs_off_the_event_loop(client, monkeypatch):
    """P5: the probe opens a pool connection and does a blocking SELECT, like the
    embed and cosine calls that are already wrapped in asyncio.to_thread."""
    c, _ = client
    loop_thread = threading.get_ident()
    probe_threads = []

    def probe(model, facet):
        probe_threads.append(threading.get_ident())
        return True

    monkeypatch.setattr(ts, "facet_has_tag_embeddings", probe)
    monkeypatch.setattr(ts, "nearby_tags", lambda emb, facet, top_k=None: [])
    async with c:
        r = await c.post("/tags/nearby", json={"query": "buses", "facets": ["topic"]})
    assert r.status_code == 200
    assert probe_threads and loop_thread not in probe_threads


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
