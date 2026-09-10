"""Answer-mode query translation (design 2026-09-09,
docs/plans/2026-09-09-answer-mode-query-translation-design.md).

The selection's non-English languages get a translated query; a dense seed
per translation feeds the rerank candidates; the rerank runs once per query
with a max-merge. Flag-dark: everything below must be inert when
`answer_translation_enabled` is off.

All units are pure or factory-injected — no live calls anywhere.
"""
import pytest
from llama_index.core.schema import NodeWithScore, QueryBundle, TextNode

from app import bedrock_rerank as br
from app import main
from app.config import get_settings


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _node(node_id, doc_id, text=None, score=0.0):
    return NodeWithScore(
        node=TextNode(id_=node_id, text=text or f"text {node_id}",
                      metadata={"doc_id": doc_id}),
        score=score,
    )


# --- config -----------------------------------------------------------------

def test_answer_translation_defaults_off(monkeypatch):
    for var in ("ANSWER_TRANSLATION_ENABLED", "ANSWER_TRANSLATION_MAX_LANGS",
                "ANSWER_TRANSLATION_SEED_K", "ANSWER_TRANSLATION_TIMEOUT_S"):
        monkeypatch.delenv(var, raising=False)
    s = get_settings()
    assert s.answer_translation_enabled is False
    assert s.answer_translation_max_langs == 2
    assert s.answer_translation_seed_k == 200
    assert s.answer_translation_timeout_s == 8.0


# --- _selection_languages (pure) --------------------------------------------

def test_selection_languages_drops_en_dedupes_and_caps():
    meta = {"d1": {"language": "zh"}, "d2": {"language": "en"},
            "d3": {"language": "es"}, "d4": {"language": "zh"},
            "d5": {"language": None}}
    assert main._selection_languages(["d1", "d2", "d3", "d4", "d5"], 2, meta) == ["zh", "es"]
    assert main._selection_languages(["d1", "d3"], 1, meta) == ["zh"]
    assert main._selection_languages(["d2", "d5"], 5, meta) == []
    assert main._selection_languages(["unknown-doc"], 5, meta) == []


# --- build_answer_translation (factory-injected) ----------------------------

class _FlakySeed:
    def __call__(self, query_str, doc_ids, k):
        raise RuntimeError("dense lane down")


def _seed(nodes):
    """A fake doc-scoped seed retriever returning `nodes`, recording calls."""
    calls = []

    def retriever(query_str, doc_ids, k):
        calls.append((query_str, sorted(doc_ids), k))
        return list(nodes)

    retriever.calls = calls
    return retriever


def _settings(monkeypatch, **over):
    for var in ("ANSWER_TRANSLATION_ENABLED", "ANSWER_TRANSLATION_MAX_LANGS",
                "ANSWER_TRANSLATION_SEED_K"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("ANSWER_TRANSLATION_ENABLED", "true")
    s = get_settings()
    for k, v in over.items():
        setattr(s, k, v)
    return s


def test_build_answer_translation_flag_off_is_inert(monkeypatch):
    s = _settings(monkeypatch)
    s.answer_translation_enabled = False
    called = []

    def translate(q, langs, timeout_s=None):
        called.append((q, langs))
        return {"zh": "translated"}

    bundles, seeds = main.build_answer_translation(
        "q", ["d1"], {"d1": {"language": "zh"}}, s,
        seed_retriever=_seed([_node("n1", "d1")]),
        translate=translate)
    assert (bundles, seeds) == ([], [])
    assert called == []


def test_build_answer_translation_translates_and_seeds(monkeypatch):
    s = _settings(monkeypatch)
    # the seed is doc-scoped at the SQL level, so the retriever receives the
    # selection and the configured k; returned nodes are taken as-is
    seed = _seed([_node("n1", "d1"), _node("n2", "other")])

    def translate(q, langs, timeout_s=None):
        assert q == "q"
        assert langs == ("zh",)
        assert timeout_s == s.answer_translation_timeout_s
        return {"zh": "区域运输问题"}

    bundles, seeds = main.build_answer_translation(
        "q", ["d1"], {"d1": {"language": "zh"}}, s,
        seed_retriever=seed, translate=translate)
    assert [b.query_str for b in bundles] == ["区域运输问题"]
    assert seed.calls == [("区域运输问题", ["d1"], s.answer_translation_seed_k)]
    assert [n.node.node_id for n in seeds] == ["n1", "n2"]


def test_build_answer_translation_all_english_selection(monkeypatch):
    s = _settings(monkeypatch)
    called = []
    bundles, seeds = main.build_answer_translation(
        "q", ["d1"], {"d1": {"language": "en"}}, s,
        seed_retriever=_seed([]),
        translate=lambda q, langs, timeout_s=None: called.append((q, langs)) or {})
    assert (bundles, seeds) == ([], [])
    assert called == []


def test_build_answer_translation_translate_failure_is_soft(monkeypatch):
    s = _settings(monkeypatch)

    def translate(q, langs, timeout_s=None):
        raise RuntimeError("openai down")

    bundles, seeds = main.build_answer_translation(
        "q", ["d1"], {"d1": {"language": "zh"}}, s,
        seed_retriever=_seed([_node("n1", "d1")]),
        translate=translate)
    assert (bundles, seeds) == ([], [])


def test_build_answer_translation_seed_failure_keeps_the_bundle(monkeypatch):
    s = _settings(monkeypatch)
    bundles, seeds = main.build_answer_translation(
        "q", ["d1"], {"d1": {"language": "zh"}}, s,
        seed_retriever=_FlakySeed(),
        translate=lambda q, langs, timeout_s=None: {"zh": "区域运输问题"})
    # the translation still reaches the rerank (its candidates may already
    # contain zh chunks from the English lanes); only the seed is lost
    assert [b.query_str for b in bundles] == ["区域运输问题"]
    assert seeds == []


# --- _union_seed_candidates (pure) ------------------------------------------

def test_union_seed_candidates_dedupes_and_appends():
    base = [_node("a", "d1"), _node("b", "d1")]
    seeds = [_node("b", "d1"), _node("c", "d1"), _node("a", "d1")]
    out = main._union_seed_candidates(base, seeds)
    assert [n.node.node_id for n in out] == ["a", "b", "c"]
    assert out[:2] is base[:2] or [n.node.node_id for n in out[:2]] == ["a", "b"]


# --- BedrockReranker.score_documents -----------------------------------------

class _StubAgentRuntime:
    def __init__(self, scores):
        self.scores = scores  # {index: score}
        self.calls = []

    def rerank(self, queries, sources, rerankingConfiguration, **kw):
        self.calls.append({"query": queries[0]["textQuery"]["text"],
                            "sources": sources})
        return {"results": [{"index": i, "relevanceScore": s}
                             for i, s in self.scores.items()]}


def test_score_documents_returns_scores_without_mutation(monkeypatch):
    stub = _StubAgentRuntime({0: 0.9, 2: 0.4})
    monkeypatch.setattr(br, "get_client", lambda: stub)
    rr = br.BedrockReranker()
    nodes = [_node("a", "d1", score=0.1), _node("b", "d1", score=0.2),
             _node("c", "d1", score=0.3)]
    out = rr.score_documents(nodes, QueryBundle(query_str="q"))
    assert out == {"a": 0.9, "c": 0.4}
    # no mutation: the caller (max-merge) owns the scores
    assert [n.score for n in nodes] == [0.1, 0.2, 0.3]
    assert stub.calls[0]["query"] == "q"
    assert len(stub.calls[0]["sources"]) == 3


def test_score_documents_empty_nodes(monkeypatch):
    stub = _StubAgentRuntime({})
    monkeypatch.setattr(br, "get_client", lambda: stub)
    rr = br.BedrockReranker()
    assert rr.score_documents([], QueryBundle(query_str="q")) == {}
    assert stub.calls == []


# --- max_merge (pure) ---------------------------------------------------------

def test_max_merge_takes_per_node_max():
    maps = [{"a": 0.5, "b": 0.1}, {"a": 0.2, "b": 0.8}, {}]
    assert br.max_merge(maps) == {"a": 0.5, "b": 0.8}
    assert br.max_merge([]) == {}


# --- _rerank_with_translation_bundles (the dual-query max-merge) --------------

def test_rerank_with_translation_bundles_max_merges(monkeypatch):
    rr = br.BedrockReranker()
    nodes = [_node("a", "d1"), _node("b", "d1"), _node("c", "d1")]
    scores = [("q-en", {"a": 0.2, "b": 0.9, "c": 0.1}),
              ("q-zh", {"a": 0.95, "b": 0.3, "c": 0.0})]
    monkeypatch.setattr(rr, "score_documents",
                        lambda cands, qb: dict(scores[0][1]) if qb.query_str == "q-en" else dict(scores[1][1]))
    out = main._rerank_with_translation_bundles(
        rr, nodes, QueryBundle(query_str="q-en"),
        [QueryBundle(query_str="q-zh")], top_n=2)
    # max-merge: a rides its zh score (0.95), b its en score (0.9); c drops
    assert [n.node.node_id for n in out] == ["a", "b"]
    assert [n.score for n in out] == [0.95, 0.9]


# --- translate_query_orjoined (parse/normalize over a stubbed cache) --------

def test_translate_query_orjoined_joins_renderings(monkeypatch):
    from app import query_translate as qt
    monkeypatch.setattr(
        qt, "_translate_answer_cached",
        lambda q, langs, timeout_s: '{"zh": {"literal": "字面", "field": "术语"}, '
                                     '"en": {"literal": "skipped"}, "zh2": "not-a-dict"}')
    out = qt.translate_query_orjoined("q", ("zh", "en"))
    # only requested langs; dict entries join their non-empty renderings;
    # the non-dict entry (zh2) is dropped
    assert out == {"zh": "字面 / 术语", "en": "skipped"}


def test_translate_query_orjoined_bad_json_is_empty(monkeypatch):
    from app import query_translate as qt
    monkeypatch.setattr(qt, "_translate_answer_cached",
                        lambda q, langs, timeout_s: "not json")
    assert qt.translate_query_orjoined("q", ("zh",)) == {}
