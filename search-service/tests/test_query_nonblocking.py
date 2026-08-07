"""Regression test: /query must not block the event loop.

Stage 1 retrieval and Stage 2 reranking take seconds to tens of seconds on
Fargate.  If they run directly on the event loop, /health (ALB health
checks) and concurrent queries freeze for the whole duration.

The app is driven through httpx.ASGITransport inside a single asyncio
event loop: a slow /query task is started, then /health is awaited on the
same loop.  If retrieval/reranking block the loop, /health cannot complete
until the query finishes and the elapsed-time assertion fails.  (starlette
TestClient can't reproduce this — outside its context manager it spins up
a fresh event loop per request.)  No DB or network needed — retrieval is
stubbed.
"""
import asyncio
import time

import httpx
import pytest

import app.main as _main


_SLEEP_S = 1.0


@pytest.mark.asyncio
async def test_health_responds_while_query_is_running():
    class _SlowHybridRetriever:
        """Stands in for HybridFusionRetriever; sleeps like a real rerank."""

        def __init__(self, *args, **kwargs):
            pass

        def retrieve(self, query_bundle):
            time.sleep(_SLEEP_S)
            return []

    saved_state = {
        k: _main.service_state.get(k)
        for k in ("vector_index", "pg_dense_ready", "bm25_retriever")
    }
    saved_attrs = {
        "HybridFusionRetriever": _main.HybridFusionRetriever,
        "make_dense_retriever": _main.make_dense_retriever,
    }

    _main.service_state["vector_index"] = None
    _main.service_state["pg_dense_ready"] = True
    _main.service_state["bm25_retriever"] = object()
    _main.HybridFusionRetriever = _SlowHybridRetriever
    _main.make_dense_retriever = lambda top_k: None

    try:
        transport = httpx.ASGITransport(app=_main.app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            start = time.time()
            query_task = asyncio.create_task(
                client.post("/query", json={"query": "test", "mode": "cite"})
            )
            # Yield so the query task starts running; if it blocks the loop,
            # control only returns here after the full sleep.
            await asyncio.sleep(0.05)

            health_resp = await client.get("/health")
            health_done = time.time() - start

            query_resp = await query_task

        assert health_resp.status_code == 200
        assert query_resp.status_code == 200
        assert health_done < _SLEEP_S / 2, (
            f"/health completed {health_done:.2f}s after the query started — "
            "the event loop is blocked by retrieval/reranking"
        )
    finally:
        _main.service_state.update(saved_state)
        _main.HybridFusionRetriever = saved_attrs["HybridFusionRetriever"]
        _main.make_dense_retriever = saved_attrs["make_dense_retriever"]
