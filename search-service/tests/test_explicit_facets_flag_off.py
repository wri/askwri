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
    retriever = overrides.pop("retriever", None) or _Retriever()
    docs_meta = overrides.pop("docs_meta", DOCS_META)
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", retriever)
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setitem(app_main.service_state, "documents_metadata", docs_meta)
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


YEAR_DOCS_META = {
    # DB metadata is the source of truth: it wins over the chunk's year string.
    "db_2025_chunk_2019": {"year_int": 2025},
    "db_2019_chunk_2025": {"year_int": 2019},
    # No DB year: the chunk's year string is the fallback.
    "chunk_2025": {},
    # No year anywhere: undated docs are KEPT, never dropped.
    "undated": {},
}
CHUNK_YEARS = {"db_2025_chunk_2019": "2019",
               "db_2019_chunk_2025": "2025",
               "chunk_2025": "2025"}


class _YearRetriever:
    def retrieve(self, bundle):
        return [
            NodeWithScore(
                node=TextNode(id_=f"c-{d}", text="t",
                              metadata={"doc_id": d, "title": d,
                                        "year": CHUNK_YEARS.get(d)}),
                score=1.0 - i * 0.01,
            )
            for i, d in enumerate(YEAR_DOCS_META)
        ]


def _year_post(monkeypatch, **overrides):
    return _post(monkeypatch, retriever=_YearRetriever(),
                 docs_meta=YEAR_DOCS_META, **overrides)


def test_chip_and_legacy_year_select_the_same_docs(monkeypatch):
    # #444 item 3: the FilterPanel chip and the legacy param are the same user
    # intent, so they must make the same decision from the same metadata.
    chip_min = _year_post(monkeypatch, facets=[{"facet": "year_min", "value": "2025"}])
    legacy_min = _year_post(monkeypatch, min_year=2025)
    assert _doc_ids(chip_min) == _doc_ids(legacy_min) == {
        "db_2025_chunk_2019", "chunk_2025", "undated"}

    chip_max = _year_post(monkeypatch, facets=[{"facet": "year_max", "value": "2020"}])
    legacy_max = _year_post(monkeypatch, max_year=2020)
    assert _doc_ids(chip_max) == _doc_ids(legacy_max) == {
        "db_2019_chunk_2025", "undated"}


class _RecordingReranker:
    seen = None

    def postprocess_nodes(self, nodes, query_bundle=None, top_n=None):
        self.seen = {n.node.metadata["doc_id"] for n in nodes}
        # Rerank-scale scores: cite mode's relevance floor drops raw RRF scores.
        return [NodeWithScore(node=n.node, score=0.9) for n in nodes]


def test_legacy_year_decides_on_the_pre_rerank_pool(monkeypatch):
    # A post-rerank year filter spends rerank slots on documents it then drops
    # and cannot admit an in-year doc pushed out by the top_n cut.
    reranker = _RecordingReranker()
    monkeypatch.setitem(app_main.service_state, "reranker_cite", reranker)
    payload = _year_post(monkeypatch, rerank=True, min_year=2025)
    assert "db_2019_chunk_2025" not in reranker.seen
    assert _doc_ids(payload) == {"db_2025_chunk_2019", "chunk_2025", "undated"}


def test_flag_off_legacy_excluded_keywords_apply(monkeypatch):
    payload = _post(monkeypatch, excluded_keywords=["coal"])
    assert _doc_ids(payload) == {"en_doc", "en_with_es", "unknown_lang"}


def test_debug_exposes_excluded_doc_ids(monkeypatch):
    payload = _post(monkeypatch, excluded_keywords=["coal"],
                   return_intermediate_results=True)
    assert payload["debug"]["excluded_doc_ids"] == ["es_doc"]


def test_excluded_doc_ids_match_with_understanding_on_and_off(monkeypatch):
    # The same exclusion must report the same debug.excluded_doc_ids whether
    # it arrives as the legacy param (flag off) or as a hard facet on the
    # understanding object (flag on) — the eval harness compares arms on
    # this field, so any divergence would read as facet-caused leakage.
    from app.understanding import Facet, QueryUnderstanding

    off = _post(monkeypatch, excluded_keywords=["coal"],
                return_intermediate_results=True)
    assert off["debug"]["excluded_doc_ids"] == ["es_doc"]

    # Flag-on arm: _post pins understanding_active off, so re-pin it on and
    # drive the same body through the handler directly. attach_topic_suggestions
    # is imported inside the handler, so patch it at its module.
    monkeypatch.setattr(app_main, "understanding_active", lambda s, r: True)
    monkeypatch.setattr(
        app_main, "build_understanding",
        lambda *a, **k: QueryUnderstanding(facets=[Facet(
            facet="excluded_keyword", value="coal",
            confidence=1.0, source="user", action="hard")]))
    monkeypatch.setattr("app.topic_sense.attach_topic_suggestions",
                        lambda *a, **k: None)
    monkeypatch.setattr(app_main, "lanes_active", lambda s, r: False)
    resp = TestClient(app_main.app).post("/query", json={
        "query": "urban finance mechanisms", "mode": "cite", "rerank": False,
        "excluded_keywords": ["coal"], "return_intermediate_results": True})
    assert resp.status_code == 200
    assert resp.json()["debug"]["excluded_doc_ids"] == off["debug"]["excluded_doc_ids"]


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
