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


DOC_TEXTS = {**{d: "t" for d in DOCS_META}, "es_doc": "coal power"}


class _Retriever:
    def retrieve(self, bundle):
        return [
            NodeWithScore(
                node=TextNode(id_=f"c-{d}", text=DOC_TEXTS[d],
                              metadata={"doc_id": d, "title": d}),
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


def test_flag_off_legacy_excluded_keywords_apply(monkeypatch):
    payload = _post(monkeypatch, excluded_keywords=["coal"])
    assert _doc_ids(payload) == {"en_doc", "en_with_es", "unknown_lang"}


class _TwoChunkRetriever:
    def retrieve(self, bundle):
        return [
            NodeWithScore(node=TextNode(id_="c-coal", text="coal power",
                metadata={"doc_id": "es_doc", "title": "es_doc"}), score=0.9),
            NodeWithScore(node=TextNode(id_="c-clean", text="clean power",
                metadata={"doc_id": "es_doc", "title": "es_doc"}), score=0.8),
        ]


class _KeepCleanReranker:
    # Scores must be rerank-scale (0-1): the real Bedrock reranker assigns
    # fresh relevance scores, and cite mode's relevance floor (0.09) drops
    # the raw RRF-scale fusion scores (~0.008) — without this the response
    # would be empty and the pre/post-rerank distinction unobservable.
    def postprocess_nodes(self, nodes, query_bundle=None, top_n=None):
        return [NodeWithScore(node=n.node, score=0.9)
                for n in nodes if "coal" not in n.node.text]


def test_legacy_exclusion_decides_on_the_pre_rerank_pool(monkeypatch):
    # Two chunks for one doc: rerank keeps the clean one, the matching one
    # would be dropped. A post-rerank decision would keep the document.
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", _TwoChunkRetriever())
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setitem(app_main.service_state, "documents_metadata", {})
    monkeypatch.setitem(app_main.service_state, "reranker_cite", _KeepCleanReranker())
    monkeypatch.setattr(app_main, "make_dense_retriever", lambda top_k: _DenseStub())
    monkeypatch.setattr(app_main, "understanding_active", lambda s, r: False)
    resp = TestClient(app_main.app).post("/query", json={
        "query": "power", "mode": "cite", "rerank": True,
        "excluded_keywords": ["coal"]})
    assert resp.status_code == 200
    assert "es_doc" not in _doc_ids(resp.json())


PAIRS = {"t1": {"original": "o1", "original_title": "Autobuses electricos",
                "original_searchable": True}}


class _PairRetriever:
    def retrieve(self, bundle):
        return [
            NodeWithScore(node=TextNode(id_="c-o1", text="zero emission buses",
                metadata={"doc_id": "o1", "title": "Original"}), score=0.9),
            NodeWithScore(node=TextNode(id_="c-t1", text="autobuses electricos",
                metadata={"doc_id": "t1", "title": "Traduccion"}), score=0.8),
        ]


def test_citation_substitution_cannot_resurrect_excluded_original(monkeypatch):
    # The original is excluded by its own text; the translation does not match
    # and survives. Without the assembly guard it is credited back to o1.
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", _PairRetriever())
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setitem(app_main.service_state, "documents_metadata", {})
    monkeypatch.setattr(app_main, "make_dense_retriever", lambda top_k: _DenseStub())
    monkeypatch.setattr(app_main, "understanding_active", lambda s, r: False)
    monkeypatch.setattr(app_main, "load_confirmed_pairs", lambda: PAIRS)
    resp = TestClient(app_main.app).post("/query", json={
        "query": "buses", "mode": "cite", "rerank": False,
        "facets": [{"facet": "excluded_keyword", "value": "zero emission"}]})
    assert resp.status_code == 200
    assert "o1" not in _doc_ids(resp.json())
