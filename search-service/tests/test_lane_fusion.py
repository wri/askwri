"""P2 multi-lane fusion (design 2026-08-19 §4.3).

lanes_active is THE P2 flag-off guard: it must require BOTH flags and honor
the request-level expansion control, so flag-off (either flag) is
byte-identical and `expansion: false` disables lanes for eval control."""
from types import SimpleNamespace


def _settings(understanding=False, lanes=False):
    return SimpleNamespace(
        query_understanding_enabled=understanding,
        query_expansion_lanes_enabled=lanes,
    )


def test_lanes_active_requires_both_flags():
    from app.understanding import lanes_active
    req = SimpleNamespace(expansion=True)
    assert lanes_active(_settings(False, False), req) is False
    assert lanes_active(_settings(True, False), req) is False
    assert lanes_active(_settings(False, True), req) is False
    assert lanes_active(_settings(True, True), req) is True


def test_lanes_active_honors_request_expansion_control():
    from app.understanding import lanes_active
    assert lanes_active(_settings(True, True), SimpleNamespace(expansion=False)) is False


def test_p2_flag_defaults_off():
    from app.config import Settings
    assert Settings.model_fields["query_expansion_lanes_enabled"].default is False
    assert Settings.model_fields["alias_expand_max_groups"].default == 3
    assert Settings.model_fields["alias_expand_max_terms"].default == 2


from llama_index.core.schema import NodeWithScore, QueryBundle, TextNode

from app.main import HybridFusionRetriever


def _nws(node_id: str, score: float) -> NodeWithScore:
    return NodeWithScore(node=TextNode(id_=node_id, text=f"text {node_id}"), score=score)


class _StubRetriever:
    def __init__(self, results):
        self._results = results
        self.seen_queries = []

    def retrieve(self, bundle):
        self.seen_queries.append(bundle.query_str)
        return list(self._results)


class _BoomRetriever:
    def retrieve(self, bundle):
        raise RuntimeError("lane down")


def _retriever(dense, sparse, extra_lanes=None, **kw):
    return HybridFusionRetriever(
        vector_retriever=_StubRetriever(dense),
        bm25_retriever=_StubRetriever(sparse),
        mode="cite",
        fusion_top_k=10,
        extra_lanes=extra_lanes,
        **kw,
    )


def test_no_extra_lanes_reproduces_two_lane_output_exactly():
    """Design §8: the generalization must reproduce current two-lane output
    exactly when given the legacy lane list (weights NOT doubled)."""
    dense = [_nws("a", 0.9), _nws("b", 0.8)]
    sparse = [_nws("b", 5.0), _nws("c", 4.0)]
    r = _retriever(dense, sparse)
    out = r._retrieve(QueryBundle(query_str="anything"))
    scores = {n.node.node_id: n.score for n in out}
    assert scores["a"] == 0.5 * (1.0 / 61)
    assert scores["b"] == 0.5 * (1.0 / 62) + 0.5 * (1.0 / 61)
    assert scores["c"] == 0.5 * (1.0 / 62)
    assert set(r.lane_ranks["a"].keys()) == {"dense", "sparse"}
    assert r.degraded_lanes == []


def test_extra_lane_weight_math_and_2x_originals():
    dense = [_nws("a", 0.9), _nws("b", 0.8)]
    sparse = [_nws("b", 5.0), _nws("c", 4.0)]
    alias = _StubRetriever([_nws("c", 3.0), _nws("d", 2.0)])
    r = _retriever(dense, sparse, extra_lanes=[
        {"name": "alias_sparse", "retriever": alias,
         "query_str": "q OR syn", "weight": None, "top_k": None},
    ])
    out = r._retrieve(QueryBundle(query_str="q"))
    scores = {n.node.node_id: n.score for n in out}
    # originals at 2x their 0.5 default; alias at 1x sparse weight (0.5)
    assert scores["a"] == 1.0 * (1.0 / 61)
    assert scores["b"] == 1.0 * (1.0 / 62) + 1.0 * (1.0 / 61)
    assert scores["c"] == 1.0 * (1.0 / 62) + 0.5 * (1.0 / 61)
    assert scores["d"] == 0.5 * (1.0 / 62)
    assert [n.node.node_id for n in out] == ["b", "c", "a", "d"]
    # lane_ranks covers all three lanes for every fused node
    assert r.lane_ranks["b"] == {"dense": 2, "sparse": 1, "alias_sparse": None}
    assert r.lane_ranks["d"] == {"dense": None, "sparse": None, "alias_sparse": 2}
    # the alias lane got ITS OWN query text
    assert alias.seen_queries == ["q OR syn"]


def test_extra_lane_top_k_slices_that_lane_only():
    dense = [_nws("a", 0.9)]
    sparse = [_nws("b", 5.0)]
    alias = _StubRetriever([_nws(f"x{i}", 5.0 - i) for i in range(5)])
    r = _retriever(dense, sparse, extra_lanes=[
        {"name": "alias_sparse", "retriever": alias,
         "query_str": "q", "weight": None, "top_k": 2},
    ])
    r._retrieve(QueryBundle(query_str="q"))
    alias_ranked = [nid for nid, lanes in r.lane_ranks.items()
                    if lanes["alias_sparse"] is not None]
    assert set(alias_ranked) == {"x0", "x1"}


def test_extra_lane_failure_drops_lane_and_records_degraded():
    dense = [_nws("a", 0.9)]
    sparse = [_nws("b", 5.0)]
    r = _retriever(dense, sparse, extra_lanes=[
        {"name": "alias_sparse", "retriever": _BoomRetriever(),
         "query_str": "q", "weight": None, "top_k": None},
    ])
    out = r._retrieve(QueryBundle(query_str="q"))
    assert r.degraded_lanes == ["alias_sparse"]
    # no materialized extra lane => weights NOT doubled (degrade toward P1)
    scores = {n.node.node_id: n.score for n in out}
    assert scores["a"] == 0.5 * (1.0 / 61)
    assert set(r.lane_ranks["a"].keys()) == {"dense", "sparse"}


def test_domain_expansion_false_uses_raw_query_for_sparse_lane():
    dense = [_nws("a", 0.9)]
    sparse_stub = _StubRetriever([_nws("b", 5.0)])
    r = HybridFusionRetriever(
        vector_retriever=_StubRetriever(dense),
        bm25_retriever=sparse_stub,
        mode="cite",
        fusion_top_k=10,
        domain_expansion=False,
    )
    r._retrieve(QueryBundle(query_str="urban finance mechanisms"))
    # "urban finance" is a DOMAIN_EXPANSIONS key; with the kwarg off the
    # sparse lane must see the RAW query (the gated retirement, §4.3)
    assert sparse_stub.seen_queries == ["urban finance mechanisms"]


def test_build_sparse_query_domain_expansion_kwarg():
    from app.query_expansion import build_sparse_query, expand_query_conservative
    q = "What have we published on urban finance since 2020?"
    assert build_sparse_query(q) == expand_query_conservative(q, max_expansions=3)
    assert build_sparse_query(q, domain_expansion=False) == q


def test_expansion_lane_weight_applied_when_lane_weight_none():
    """5a: a lane with weight=None gets the expansion_lane_weight (per-mode
    config), not sparse_weight. This is the dead-knob fix: today weight=None
    falls back to sparse_weight (0.5) regardless of mode; the config knob is
    not read. cite (recall-first) = 1.0, answer (precision-first) = 0.25."""
    dense = [_nws("a", 0.9), _nws("b", 0.8)]
    sparse = [_nws("b", 5.0), _nws("c", 4.0)]
    alias = _StubRetriever([_nws("c", 3.0), _nws("d", 2.0)])
    # cite mode, expansion_lane_weight=1.0 (recall-first)
    r = _retriever(dense, sparse, extra_lanes=[
        {"name": "alias_sparse", "retriever": alias,
         "query_str": "q OR syn", "weight": None, "top_k": None},
    ], expansion_lane_weight=1.0)
    out = r._retrieve(QueryBundle(query_str="q"))
    scores = {n.node.node_id: n.score for n in out}
    # originals at 2x (0.5*2=1.0); alias at 1.0 (expansion_lane_weight, not 0.5)
    assert scores["a"] == 1.0 * (1.0 / 61)
    assert scores["d"] == 1.0 * (1.0 / 62)


def test_expansion_lane_weight_answer_mode_lower_weight():
    """answer (precision-first): expansion_lane_weight=0.25 → the alias lane
    contributes less than under cite (1.0), so a doc only the alias found ranks
    lower. Originals still at 2x (the recall-vs-precision asymmetry stays)."""
    dense = [_nws("a", 0.9), _nws("b", 0.8)]
    sparse = [_nws("b", 5.0), _nws("c", 4.0)]
    alias = _StubRetriever([_nws("c", 3.0), _nws("d", 2.0)])
    r = _retriever(dense, sparse, extra_lanes=[
        {"name": "alias_sparse", "retriever": alias,
         "query_str": "q OR syn", "weight": None, "top_k": None},
    ], expansion_lane_weight=0.25)
    out = r._retrieve(QueryBundle(query_str="q"))
    scores = {n.node.node_id: n.score for n in out}
    # originals at 2x; alias at 0.25
    assert scores["a"] == 1.0 * (1.0 / 61)
    assert scores["d"] == 0.25 * (1.0 / 62)


def test_expansion_lane_weight_explicit_lane_weight_wins():
    """A lane that sets its own weight (not None) is NOT overridden by
    expansion_lane_weight — the lane dict's weight is the source of truth;
    expansion_lane_weight is the default for lanes that don't specify."""
    dense = [_nws("a", 0.9)]
    sparse = [_nws("b", 5.0)]
    alias = _StubRetriever([_nws("c", 3.0)])
    r = _retriever(dense, sparse, extra_lanes=[
        {"name": "alias_sparse", "retriever": alias,
         "query_str": "q", "weight": 0.7, "top_k": None},
    ], expansion_lane_weight=0.25)
    out = r._retrieve(QueryBundle(query_str="q"))
    scores = {n.node.node_id: n.score for n in out}
    # alias at its own 0.7, not 0.25
    assert scores["c"] == 0.7 * (1.0 / 61)


def test_expansion_lane_weight_defaults_to_sparse_weight_when_not_passed():
    """Back-compat: when expansion_lane_weight is not passed (e.g. tests that
    don't care), lanes with weight=None fall back to sparse_weight (the
    pre-5a behavior) — so existing tests stay byte-identical."""
    dense = [_nws("a", 0.9)]
    sparse = [_nws("b", 5.0)]
    alias = _StubRetriever([_nws("c", 3.0)])
    r = _retriever(dense, sparse, extra_lanes=[
        {"name": "alias_sparse", "retriever": alias,
         "query_str": "q", "weight": None, "top_k": None},
    ])
    out = r._retrieve(QueryBundle(query_str="q"))
    scores = {n.node.node_id: n.score for n in out}
    # alias at sparse_weight (0.5), the pre-5a default
    assert scores["c"] == 0.5 * (1.0 / 61)


def test_expansion_lane_weight_defaults_per_mode():
    """5a config: cite 1.0 (recall-first), answer 0.25 (precision-first)."""
    from app.config import Settings
    assert Settings.model_fields["cite_expansion_lane_weight"].default == 0.5
    assert Settings.model_fields["answer_expansion_lane_weight"].default == 1.0


def test_expansion_lane_weight_env_override_back_compat(monkeypatch):
    """EXPANSION_LANE_WEIGHT env overrides both per-mode defaults (back-compat
    with qa.tfvars, where it's set to 0.25 but currently a dead knob)."""
    import app.main as _main
    monkeypatch.setattr(_main, "settings", type("S", (), {
        "cite_expansion_lane_weight": 0.5,
        "answer_expansion_lane_weight": 1.0,
    })())
    monkeypatch.setenv("EXPANSION_LANE_WEIGHT", "0.5")
    assert _main._expansion_lane_weight_for(_main.settings, "cite") == 0.5
    assert _main._expansion_lane_weight_for(_main.settings, "answer") == 0.5
    monkeypatch.delenv("EXPANSION_LANE_WEIGHT")
    assert _main._expansion_lane_weight_for(_main.settings, "cite") == 0.5
    assert _main._expansion_lane_weight_for(_main.settings, "answer") == 1.0


def test_request_expansion_lane_weight_override_wins(monkeypatch):
    """5a sweep knob: a request-level expansion_lane_weight override wins over
    per-mode defaults AND the EXPANSION_LANE_WEIGHT env — this is what lets us
    sweep answer/cite weight via curl against live qa without a redeploy."""
    import app.main as _main
    monkeypatch.setattr(_main, "settings", type("S", (), {
        "cite_expansion_lane_weight": 0.5,
        "answer_expansion_lane_weight": 1.0,
    })())
    monkeypatch.setenv("EXPANSION_LANE_WEIGHT", "0.5")
    # request override wins for both modes
    assert _main._expansion_lane_weight_for(_main.settings, "cite", 0.9) == 0.9
    assert _main._expansion_lane_weight_for(_main.settings, "answer", 0.9) == 0.9
    # None override -> env wins -> per-mode default
    monkeypatch.delenv("EXPANSION_LANE_WEIGHT")
    assert _main._expansion_lane_weight_for(_main.settings, "cite", None) == 0.5
    assert _main._expansion_lane_weight_for(_main.settings, "answer", None) == 1.0
