"""User-picked FilterPanel facets must filter with QUERY_UNDERSTANDING_ENABLED off.

Production runs with the understanding flag off (production-release.md §11).
The FilterPanel sends language/office/date selections as explicit `facets`;
before this fix they were silently dropped whenever understanding was inactive,
so a Spanish filter on prod returned every language. Explicit facets are human
input, not inferred understanding, so they apply regardless of the flag — with
the same semantics as QA (work-level language matching, unknown kept).

TestClient + stubs — no DB/network (pattern: test_diagnostic_parity.py).
"""
from fastapi.testclient import TestClient
from llama_index.core.schema import NodeWithScore, TextNode

from app import main as app_main


DOCS_META = {
    "es_doc": {"language": "es", "work_languages": frozenset()},
    "en_doc": {"language": "en", "work_languages": frozenset()},
    # English original with a confirmed Spanish translation: QA keeps it.
    "en_with_es": {"language": "en", "work_languages": frozenset({"es"})},
    "unknown_lang": {"language": None, "work_languages": frozenset()},
}


class _Retriever:
    def retrieve(self, bundle):
        return [
            NodeWithScore(
                node=TextNode(id_=f"c-{d}", text="t", metadata={"doc_id": d, "title": d}),
                score=1.0 - i * 0.01,
            )
            for i, d in enumerate(DOCS_META)
        ]


class _DenseStub:
    def retrieve(self, bundle):
        return []


def _post(monkeypatch, **overrides):
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", _Retriever())
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setitem(app_main.service_state, "documents_metadata", DOCS_META)
    monkeypatch.setattr(app_main, "make_dense_retriever", lambda top_k: _DenseStub())
    # Production configuration: understanding flag off.
    monkeypatch.setattr(app_main, "understanding_active", lambda s, r: False)
    body = {"query": "urban finance mechanisms", "mode": "cite", "rerank": False}
    body.update(overrides)
    resp = TestClient(app_main.app).post("/query", json=body)
    assert resp.status_code == 200
    return resp.json()


def _doc_ids(payload):
    return {d["doc_id"] for d in payload["docs"]}


def test_flag_off_language_facet_filters_like_qa(monkeypatch):
    payload = _post(monkeypatch, facets=[{"facet": "language", "value": "es"}])
    assert _doc_ids(payload) == {"es_doc", "en_with_es", "unknown_lang"}
    # Flag-off contract: no understanding object is surfaced.
    assert payload["query_understanding"] is None


def test_flag_off_no_facets_is_unfiltered(monkeypatch):
    payload = _post(monkeypatch)
    assert _doc_ids(payload) == set(DOCS_META)


def test_flag_off_invalid_facet_is_dropped_not_fatal(monkeypatch):
    payload = _post(monkeypatch, facets=[{"facet": "nonsense", "value": "x"},
                                         {"facet": "language", "value": "es"}])
    assert _doc_ids(payload) == {"es_doc", "en_with_es", "unknown_lang"}
