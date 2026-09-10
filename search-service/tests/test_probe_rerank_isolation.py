"""Rerank-isolation probe (plan 2026-09-10 §4.1) — pure parts only.

The probe script is standalone (never imports app.*); these tests cover its
pure assembly/validation logic and main()'s artifact contract with boto3 and
OpenAI mocked at the boundary. No live calls anywhere.
"""
import json

import pytest
from pathlib import Path

from scripts import probe_rerank_isolation as probe


@pytest.fixture
def fake_sources(tmp_path, monkeypatch):
    """Point the module's fixture/capture/artifact paths at tmp data."""
    expected = [
        {"chunk_id": "d1_chunk_3", "doc_id": "d1", "page": 1},
        {"chunk_id": "d1_chunk_1", "doc_id": "d1", "page": 2},
    ]
    fixture = {"test_cases": [{
        "id": "caseA",
        "question": "What about A?",
        "retrieval_ground_truth": {"expected_passages": expected},
    }]}
    winners = [
        {"chunk_id": "d1_chunk_1", "doc_id": "d1", "text": "w1", "rank": 1},
        {"chunk_id": "d2_chunk_9", "doc_id": "d2", "text": "w2", "rank": 2},
        {"chunk_id": "d2_chunk_8", "doc_id": "d2", "text": "w3", "rank": 3},
        {"chunk_id": "d3_chunk_5", "doc_id": "d3", "text": "w4", "rank": 4},
    ]
    capture = {"cases": [{
        "case_id": "caseA",
        "passes": [{"retrieval": {"chunks": winners}}],
    }]}
    fdir, cdir, adir = tmp_path / "f", tmp_path / "c", tmp_path / "a"
    fdir.mkdir(); cdir.mkdir(); adir.mkdir()
    (fdir / "evalset.json").write_text(json.dumps(fixture))
    (cdir / "capture.json").write_text(json.dumps(capture))
    monkeypatch.setattr(probe, "FIXTURE_PATH", fdir / "evalset.json")
    monkeypatch.setattr(probe, "CAPTURE_PATH", cdir / "capture.json")
    monkeypatch.setattr(probe, "ARTIFACT_DIR", adir)
    return {"adir": adir, "expected": expected, "winners": winners}


# --- build_batch -------------------------------------------------------------

def test_build_batch_expected_first_then_winners_by_rank():
    batch = probe.build_batch(
        ["d1_chunk_3", "d1_chunk_1"],
        [{"chunk_id": "d2_chunk_9", "doc_id": "d2", "text": "w2", "rank": 2},
         {"chunk_id": "d1_chunk_1", "doc_id": "d1", "text": "w1", "rank": 1}])
    assert [c["chunk_id"] for c in batch] == ["d1_chunk_3", "d1_chunk_1", "d2_chunk_9"]
    assert [c["source"] for c in batch] == ["expected", "expected", "winner"]
    # dedupe keeps the FIRST occurrence: an expected chunk that also appears
    # among the winners keeps its expected role (text=None); main() fills its
    # text from RDS along with the other expected chunks
    assert batch[1]["text"] is None


def test_build_batch_caps_at_100():
    expected = [f"dX_chunk_{i}" for i in range(60)]
    winners = [{"chunk_id": f"dY_chunk_{i}", "doc_id": "dY", "text": "t",
                "rank": i} for i in range(60)]
    batch = probe.build_batch(expected, winners)
    assert len(batch) == 100
    assert batch[0]["chunk_id"] == "dX_chunk_0"
    assert batch[99]["chunk_id"] == "dY_chunk_39"


# --- orjoin_rendering ---------------------------------------------------------

def test_orjoin_rendering_joins_nonempty_parts():
    assert probe.orjoin_rendering(
        '{"zh": {"literal": "字面", "field": "术语"}}') == "字面 / 术语"
    assert probe.orjoin_rendering(
        '{"zh": {"literal": "字面", "field": ""}}') == "字面"
    assert probe.orjoin_rendering('{"zh": {"literal": "", "field": ""}}') is None


def test_orjoin_rendering_rejects_garbage():
    assert probe.orjoin_rendering("not json") is None
    assert probe.orjoin_rendering('{"zh": "not-a-dict"}') is None
    assert probe.orjoin_rendering('{"other": {"literal": "x"}}') is None


# --- validation_verdict -------------------------------------------------------

def _scores_from_reference(delta=0.0, swap_en=False):
    """{label: {chunk_id: score}} built from the recorded reference."""
    out = {"en": {}, "machine_zh": {}, "oracle_zh": {}}
    ids = list(probe.RECORDED_REFERENCE)
    if swap_en:
        a, b = ids[0], ids[1]
    for cid in ids:
        for label in out:
            val = probe.RECORDED_REFERENCE[cid][label]
            if swap_en and label == "en" and cid == a:
                val = probe.RECORDED_REFERENCE[b]["en"]
            elif swap_en and label == "en" and cid == b:
                val = probe.RECORDED_REFERENCE[a]["en"]
            out[label][cid] = min(1.0, val + delta)
    return out


def test_validation_verdict_passes_on_reproduced_scores():
    rows, all_pass = probe.validation_verdict(_scores_from_reference())
    assert all_pass is True
    assert len([r for r in rows if r.get("_column")]) == 3


def test_validation_verdict_en_strict_tolerates_only_small_drift():
    rows, all_pass = probe.validation_verdict(_scores_from_reference(delta=0.05))
    en_rows = [r for r in rows if r["query"] == "en" and not r.get("_column")]
    assert all_pass is False
    assert any(not r["ok"] for r in en_rows)
    rows, all_pass = probe.validation_verdict(_scores_from_reference(delta=0.01))
    assert all_pass is True


def test_validation_verdict_en_requires_recorded_ordering():
    # same values, attached to the wrong chunks -> ordering check must fail
    rows, all_pass = probe.validation_verdict(_scores_from_reference(swap_en=True))
    assert all_pass is False
    col = [r for r in rows if r.get("_column") and r["query"] == "en"][0]
    assert col["ok"] is False


def test_validation_verdict_machine_band_and_oracle_directional():
    # machine signature: a rendering reaching the oracle zone (well past the
    # 0.81 cut) means the failure mode did not reproduce -> fail
    scores = _scores_from_reference()
    scores["machine_zh"][list(probe.RECORDED_REFERENCE)[0]] = 0.85
    rows, all_pass = probe.validation_verdict(scores)
    assert all_pass is False
    # oracle directional: one expected chunk below 0.80 fails
    scores = _scores_from_reference()
    scores["oracle_zh"][list(probe.RECORDED_REFERENCE)[-1]] = 0.79
    rows, all_pass = probe.validation_verdict(scores)
    assert all_pass is False


def test_validation_verdict_missing_score_fails():
    scores = _scores_from_reference()
    scores["en"].popitem()
    rows, all_pass = probe.validation_verdict(scores)
    assert all_pass is False


# --- main(): artifact contract with live sides mocked -------------------------

def test_main_queries_json_writes_artifact_without_gate(fake_sources, monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(
        probe, "fetch_chunk_texts",
        lambda url, ids: {cid: f"rds-{cid}" for cid in ids})

    def fake_rerank(query, batch, client=None):
        calls.append(query)
        return {c["chunk_id"]: 0.5 for c in batch}

    monkeypatch.setattr(probe, "rerank_scores", fake_rerank)
    rc = probe.main(["--case-id", "caseA", "--label", "testlabel",
                     "--queries-json", json.dumps({"variantA": "查询A"})])
    assert rc == 0
    assert calls == ["查询A"]
    artifact = json.loads(
        (fake_sources["adir"] / "probe-isolation-testlabel.json").read_text())
    assert artifact["probe"] == "rerank-isolation"
    assert artifact["case_id"] == "caseA"
    assert artifact["queries"] == {"variantA": "查询A"}
    assert artifact["scores"]["variantA"]["d1_chunk_1"] == 0.5
    assert len(artifact["batch"]) == 5  # 2 expected + 4 winners, one deduped
    assert "validation" not in artifact


def test_main_standard_mode_translates_and_gates(fake_sources, monkeypatch, capsys):
    # batch assembly inside main(): expected chunks have no text until RDS
    # fills them — provide a fake fetch and a fake translator
    monkeypatch.setattr(
        probe, "fetch_chunk_texts",
        lambda url, ids: {cid: f"rds-{cid}" for cid in ids})
    monkeypatch.setattr(probe, "translate_orjoined",
                        lambda q: "字面翻译 / 领域术语")
    monkeypatch.setattr(
        probe, "rerank_scores",
        lambda query, batch, client=None:
            {c["chunk_id"]: probe.RECORDED_REFERENCE[c["chunk_id"]][
                {"What about A?": "en", "字面翻译 / 领域术语": "machine_zh"}.get(query, "oracle_zh")]
             if c["chunk_id"] in probe.RECORDED_REFERENCE else 0.0 for c in batch})
    monkeypatch.setattr(probe, "RECORDED_REFERENCE", {
        "d1_chunk_3": {"en": 0.7, "machine_zh": 0.6, "oracle_zh": 0.9},
        "d1_chunk_1": {"en": 0.5, "machine_zh": 0.6, "oracle_zh": 0.9},
        "d2_chunk_9": {"en": 0.4, "machine_zh": 0.6, "oracle_zh": 0.9},
        "d2_chunk_8": {"en": 0.3, "machine_zh": 0.6, "oracle_zh": 0.9},
        "d3_chunk_5": {"en": 0.2, "machine_zh": 0.6, "oracle_zh": 0.9},
    })
    rc = probe.main(["--case-id", "caseA", "--label", "gatetest"])
    out = capsys.readouterr().out
    assert rc == 0  # reproduced scores pass every column
    assert "VALIDATION PASSED" in out
    artifact = json.loads(
        (fake_sources["adir"] / "probe-isolation-gatetest.json").read_text())
    assert artifact["queries"]["machine_zh"] == "字面翻译 / 领域术语"
    assert artifact["validation"]["passed"] is True
    # every batch chunk carries text (RDS-filled for expected, capture for winners)
    assert all(row["text_chars"] > 0 for row in artifact["batch"])


def test_main_standard_mode_fails_closed(fake_sources, monkeypatch, capsys):
    monkeypatch.setattr(
        probe, "fetch_chunk_texts",
        lambda url, ids: {cid: f"rds-{cid}" for cid in ids})
    monkeypatch.setattr(probe, "translate_orjoined", lambda q: "翻译")
    monkeypatch.setattr(
        probe, "rerank_scores",
        lambda query, batch, client=None: {c["chunk_id"]: 0.1 for c in batch})
    monkeypatch.setattr(probe, "RECORDED_REFERENCE", {
        "d1_chunk_3": {"en": 0.7, "machine_zh": 0.6, "oracle_zh": 0.9},
        "d1_chunk_1": {"en": 0.5, "machine_zh": 0.6, "oracle_zh": 0.9},
        "d2_chunk_9": {"en": 0.4, "machine_zh": 0.6, "oracle_zh": 0.9},
        "d2_chunk_8": {"en": 0.3, "machine_zh": 0.6, "oracle_zh": 0.9},
        "d3_chunk_5": {"en": 0.2, "machine_zh": 0.6, "oracle_zh": 0.9},
    })
    rc = probe.main(["--case-id", "caseA", "--label", "failtest"])
    assert rc == 1
    assert "VALIDATION FAILED" in capsys.readouterr().out


def test_main_dry_run_makes_no_calls(fake_sources, monkeypatch, capsys):
    def boom(*a, **kw):
        raise AssertionError("dry-run must not call live sides")

    monkeypatch.setattr(probe, "translate_orjoined", boom)
    monkeypatch.setattr(probe, "rerank_scores", boom)
    monkeypatch.setattr(probe, "fetch_chunk_texts", boom)
    rc = probe.main(["--case-id", "caseA", "--dry-run"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "What about A?" in out
    assert "NEEDS_RDS" in out  # expected chunks' texts not fetched in dry-run


# --- pool-realistic mode (pure parts) ----------------------------------------

def test_build_pool_dedupes_preserving_lane_order():
    from scripts.probe_rerank_isolation import build_pool
    out = build_pool(["s1", "s2", "e1"], ["e1", "e3", "s2"])
    assert out == ["s1", "s2", "e1", "e3"]


def test_predict_final15_max_merges_and_cuts():
    from scripts.probe_rerank_isolation import predict_final15
    en = {"a": 0.9, "b": 0.8, "c": 0.1}
    zh = {"a": 0.5, "d": 0.95}
    # rerank_top_n=20 > cut=15 here; pass a small top_n to exercise both cuts
    out = predict_final15(en, zh, top_n=3, cut=2)
    assert [cid for cid, _ in out] == ["d", "a"]
    assert out[0] == ("d", 0.95) and out[1] == ("a", 0.9)


def test_predict_final15_en_only_nodes_survive():
    from scripts.probe_rerank_isolation import predict_final15
    out = predict_final15({"x": 0.7}, {}, top_n=20, cut=15)
    assert out == [("x", 0.7)]


def test_main_pool_realistic_fetches_pool_texts(fake_sources, monkeypatch, capsys):
    """Regression (fix round 2): the pool rebuild must fetch pool sources'
    texts from RDS before reranking — Bedrock rejects null document text."""
    fetch_calls = []
    monkeypatch.setattr(probe, "fetch_chunk_texts",
                        lambda url, ids: fetch_calls.append(list(ids)) or
                        {cid: f"rds-{cid}" for cid in ids})
    monkeypatch.setattr(probe, "translate_orjoined", lambda q: "字面 / 术语")
    monkeypatch.setattr(probe, "dense_doc_top",
                        lambda url, q, doc_ids, k: ["d1_chunk_1", "d2_chunk_9"][:k // 100])
    seen_batches = []

    def fake_rerank(query, batch, client=None):
        seen_batches.append([c["chunk_id"] for c in batch])
        assert all(c["text"] is not None for c in batch), "null pool text reached rerank"
        return {c["chunk_id"]: 0.5 for c in batch}

    monkeypatch.setattr(probe, "rerank_scores", fake_rerank)
    rc = probe.main(["--case-id", "caseA", "--label", "poollabel",
                     "--pool-realistic",
                     "--queries-json", json.dumps({"variantA": "查询A"})])
    assert rc == 0
    # the LAST fetch is the pool fetch (the first is the 20-source fill),
    # and it covers exactly the rebuilt pool's ids
    assert fetch_calls[-1] == ["d1_chunk_1", "d2_chunk_9"]
    artifact = json.loads(
        (fake_sources["adir"] / "probe-isolation-poollabel.json").read_text())
    assert artifact["mode"] == "pool-realistic"
    assert "predictions" in artifact
    assert artifact["predictions"]["variantA"]["n_hits"] >= 0

# --- snapshot mode (program Step 1): pure parts -------------------------------

def test_resolve_expected_detail_full_matrix():
    pool = ["c1", "c2", "c3", "c4", "c5", "c6"]
    scores = {"c1": 0.9, "c2": 0.5, "c3": 0.4, "c4": 0.3, "c5": 0.2, "c6": 0.1}
    detail = probe.resolve_expected_detail(
        ["c1", "c2", "c9"], pool, scores, final15_ids=["c1", "c4"])
    by = {d["chunk_id"]: d for d in detail}
    assert by["c1"] == {"chunk_id": "c1", "in_pool": True, "pool_rank": 1,
                        "in_final15": True, "final_rank": 1, "score": 0.9}
    assert by["c2"]["in_final15"] is False and by["c2"]["final_rank"] is None
    assert by["c2"]["pool_rank"] == 2 and by["c2"]["score"] == 0.5
    assert by["c9"] == {"chunk_id": "c9", "in_pool": False, "pool_rank": None,
                        "in_final15": False, "final_rank": None, "score": None}


def test_stable_rank_ties_keep_pool_order():
    # production sorts candidates stably: ties keep candidate-list order
    # (standard lane first, seeds appended) — NOT a (score, chunk_id) sort
    ranked = probe.stable_rank(
        ["b", "a", "c"], {"a": 0.9, "b": 0.9, "c": 0.1}, top_n=3, cut=3)
    assert [cid for cid, _ in ranked] == ["b", "a", "c"]


def test_stable_rank_applies_page1_demotion_between_cuts():
    # production Stage 2.1: after the rerank top_n cut, chunk_index==0 scores
    # are halved and the list re-sorts — a demoted chunk can fall out of the
    # final cut while a formerly-below-top_n chunk rises in
    pool = [f"c{i}" for i in range(1, 21)]  # c1..c20, descending scores
    scores = {f"c{i}": 1.0 - i * 0.01 for i in range(1, 21)}
    # c1 (rank 1) and c18 (rank 18) are chunk_index 0
    idx = {"c1": 0, "c18": 0}
    idx.update({f"c{i}": i for i in range(2, 18)})
    ranked = probe.stable_rank(pool, scores, top_n=20, cut=15,
                               chunk_index_of=idx)
    ids = [cid for cid, _ in ranked]
    assert "c1" not in ids                      # demoted out of the 15
    assert "c18" not in ids                     # demoted below the cut
    assert ids[-1] == "c16"                     # formerly rank 16 rose in
    assert [s for cid, s in ranked if cid == "c16"] == [pytest.approx(0.84)]


def test_stable_rank_missing_chunk_index_is_demoted_like_production():
    # production reads metadata.get("chunk_index", 0) — a chunk with no
    # chunk_index is treated as index 0 and demoted
    ranked = probe.stable_rank(
        ["a", "b"], {"a": 0.9, "b": 0.8}, top_n=2, cut=2,
        chunk_index_of={"a": 3})  # b missing from the map
    assert [cid for cid, _ in ranked] == ["a", "b"]
    assert dict(ranked)["b"] == pytest.approx(0.4)


def test_attribute_baseline_drift_labels_new_docs_vs_approximation():
    baseline = [{"chunk_id": "old1", "doc_id": "d_old"},
                {"chunk_id": "gone", "doc_id": "d_new"}]
    out = probe.attribute_baseline_drift(
        predicted_ids=["old1", "fresh"],
        baseline_entries=baseline,
        new_doc_ids={"d_new"},
        doc_of=lambda cid: {"old1": "d_old", "fresh": "d_new",
                            "gone": "d_new"}[cid])
    assert out["shared"] == ["old1"]
    assert out["predicted_only"] == [
        {"chunk_id": "fresh", "doc_id": "d_new", "attribution": "new-doc-drift"}]
    assert out["baseline_only"] == [
        {"chunk_id": "gone", "doc_id": "d_new", "attribution": "new-doc-drift"}]


def test_attribute_baseline_drift_known_doc_delta_is_approximation():
    baseline = [{"chunk_id": "gone", "doc_id": "d_old"}]
    out = probe.attribute_baseline_drift(
        predicted_ids=["old1"], baseline_entries=baseline,
        new_doc_ids=set(),
        doc_of=lambda cid: {"old1": "d_old", "gone": "d_old"}[cid])
    assert out["baseline_only"][0]["attribution"] == "lane-approximation"


def test_compare_final15_distinguishes_set_from_order():
    cmp = probe.compare_final15(
        ["a", "b", "c"], ["b", "a", "c"])
    assert cmp["set_equal"] is True and cmp["order_equal"] is False
    cmp2 = probe.compare_final15(["a", "b"], ["a", "c"])
    assert cmp2["set_equal"] is False
    assert cmp2["only_predicted"] == ["b"] and cmp2["only_recorded"] == ["c"]


def test_load_served_bundles_maps_run_lists_by_case_order(tmp_path, monkeypatch):
    served = {"schema": "probe-mirror2-served-bundles@1",
              "run_r1": [{"lang": "zh", "grounded": True, "text": "t1"},
                          {"lang": "zh", "grounded": True, "text": "t2"},
                          {"lang": "zh", "grounded": True, "text": "t3"},
                          {"lang": "zh", "grounded": True, "text": "t4"}],
              "run_r2": [{"lang": "zh", "grounded": True, "text": "u1"},
                          {"lang": "zh", "grounded": True, "text": "u2"},
                          {"lang": "zh", "grounded": True, "text": "u3"},
                          {"lang": "zh", "grounded": True, "text": "u4"}]}
    p = tmp_path / "served.json"
    p.write_text(json.dumps(served))
    monkeypatch.setattr(probe, "MIRROR2_CASE_ORDER",
                        ["caseA", "caseB", "caseC", "caseD"])
    out = probe.load_served_bundles(p)
    assert out == {"r1": {"caseA": "t1", "caseB": "t2", "caseC": "t3",
                           "caseD": "t4"},
                    "r2": {"caseA": "u1", "caseB": "u2", "caseC": "u3",
                            "caseD": "u4"}}


def test_load_mirror2_run_extracts_ids(tmp_path):
    mirror = {"cases": {"caseA": {
        "final15": [{"chunk_id": "x1"}, {"chunk_id": "x2"}],
        "expected_hits": ["x2"],
        "expected_chunk_ids": ["x2", "x3"]}}}
    p = tmp_path / "m.json"
    p.write_text(json.dumps(mirror))
    out = probe.load_mirror2_run(p)
    assert out["caseA"]["final15_ids"] == ["x1", "x2"]
    assert out["caseA"]["expected_hits"] == ["x2"]


def test_load_pool_probe_en_returns_none_when_absent(tmp_path):
    p = tmp_path / "nope.json"
    assert probe.load_pool_probe_en(p) is None
    rec = {"en": {"top15": [["a", 0.9], ["b", 0.8]], "hits15": ["a"],
                   "n_hits": 1}, "pool_size": 7}
    p2 = tmp_path / "pp.json"
    p2.write_text(json.dumps(rec))
    out = probe.load_pool_probe_en(p2)
    assert out["top15_ids"] == ["a", "b"]
    assert out["top15_scores"] == {"a": 0.9, "b": 0.8}
    assert out["pool_size"] == 7


def test_load_selection_doc_ids_reads_capture(fake_sources):
    capture = {"cases": [{
        "case_id": "caseA",
        "passes": [{"retrieval": {"chunks": []},
                     "selected_doc_ids": ["d1", "d2"]}]}]}
    (probe.CAPTURE_PATH).write_text(json.dumps(capture))
    assert probe.load_selection_doc_ids("caseA") == ["d1", "d2"]

# --- snapshot flow: orchestration contract (live sides mocked) ----------------

def _snapshot_env(fake_sources, monkeypatch, hits_a=1):
    """Synthetic recorded-reality set: one mirror2 case (caseA), served
    bundles, deterministic dense/rerank fakes. Returns the recorded r1 final15."""
    fixture = {"test_cases": [{
        "id": "caseA", "question": "Q?",
        "retrieval_ground_truth": {"expected_passages": [
            {"chunk_id": "s1"}, {"chunk_id": "s9"}]}}]}
    capture = {"cases": [{
        "case_id": "caseA",
        "passes": [{"retrieval": {"chunks": [
            {"chunk_id": "e1", "doc_id": "d1", "text": "t-e1", "rank": 1}]},
            "selected_doc_ids": ["d1", "d2"]}]}]}
    served = {"schema": "probe-mirror2-served-bundles@1",
              "run_r1": [{"lang": "zh", "grounded": True, "text": "ZH1"}],
              "run_r2": [{"lang": "zh", "grounded": True, "text": "ZH2"}]}
    final15 = ["s1", "e1", "e2", "s2", "s3"]
    mirror = {"cases": {"caseA": {
        "final15": [{"chunk_id": c} for c in final15],
        "expected_hits": ["s1"],
        "expected_chunk_ids": ["s1", "s9"]}}}
    (probe.FIXTURE_PATH).write_text(json.dumps(fixture))
    (probe.CAPTURE_PATH).write_text(json.dumps(capture))
    (probe.ARTIFACT_DIR / "probe-mirror2-served-bundles-20260910.json").write_text(
        json.dumps(served))
    (probe.ARTIFACT_DIR / "probe-mirror2-grounded-r1-20260910.json").write_text(
        json.dumps(mirror))
    (probe.ARTIFACT_DIR / "probe-mirror2-confirm-r2-20260910.json").write_text(
        json.dumps(mirror))
    monkeypatch.setattr(probe, "MIRROR2_CASE_ORDER", ["caseA"])
    monkeypatch.setattr(probe, "translate_orjoined", lambda q: "ZHSEED")
    def fake_dense(db, query, doc_ids, k):
        return ["e1", "e2"] if query == "Q?" else ["s1", "s2", "s3"]
    monkeypatch.setattr(probe, "dense_doc_top", fake_dense)
    texts = {"e1": "t-e1", "e2": "t-e2", "s1": "t-s1", "s2": "t-s2", "s3": "t-s3"}
    monkeypatch.setattr(probe, "fetch_chunk_texts", lambda db, ids: {c: texts[c] for c in ids})
    monkeypatch.setattr(probe, "fetch_chunk_meta",
                        lambda db, ids: ({c: 3 for c in ids},
                                          {c: False for c in ids}))
    en_scores = {"e1": 0.95, "e2": 0.90, "s1": 0.50, "s2": 0.40, "s3": 0.30}
    zh_scores = {"s1": 0.99, "e1": 0.60, "e2": 0.55, "s2": 0.20, "s3": 0.10}
    def fake_rerank(query, batch, client=None):
        return dict(zh_scores if query.startswith("ZH") else en_scores)
    monkeypatch.setattr(probe, "rerank_scores", fake_rerank)
    return final15


def test_run_validity_gate_reproduces_recorded_run(fake_sources, monkeypatch, capsys):
    final15 = _snapshot_env(fake_sources, monkeypatch)
    monkeypatch.setenv("DATABASE_URL", "postgres://x")
    rows, all_pass = probe.run_validity_gate("postgres://x", ["caseA"])
    assert all_pass is True
    a_rows = [r for r in rows if r["check"].startswith("mirror2")]
    assert len(a_rows) == 2  # r1 + r2
    assert all(r["set_equal"] and r["pass"] for r in a_rows)
    assert a_rows[0]["hits_predicted"] == ["s1"]
    assert a_rows[0]["pool_size"] == 5  # e1,e2 standard-first + s1,s2,s3 seeds


def test_run_validity_gate_tail_mismatch_fails_gate(fake_sources, monkeypatch):
    """RESTORED ruling: the full final-15 SET is the gating criterion — a
    tail mismatch FAILS the gate (a failed gate is a finding, not a
    tune-away). The expected-hits still match here; that does not rescue
    the verdict."""
    _snapshot_env(fake_sources, monkeypatch)
    mirror = json.loads((probe.ARTIFACT_DIR /
                         "probe-mirror2-grounded-r1-20260910.json").read_text())
    mirror["cases"]["caseA"]["final15"].append({"chunk_id": "zz"})
    (probe.ARTIFACT_DIR / "probe-mirror2-grounded-r1-20260910.json").write_text(
        json.dumps(mirror))
    rows, all_pass = probe.run_validity_gate("postgres://x", ["caseA"])
    assert all_pass is False
    bad = [r for r in rows if not r["pass"]]
    assert bad and bad[0]["gating"] is True
    assert bad[0]["only_recorded"] == ["zz"]
    # hits still match — reported, and visibly NOT the gating criterion
    assert bad[0]["hits_predicted"] == bad[0]["hits_recorded"]


def test_run_validity_gate_reports_hit_divergence_when_sets_match(fake_sources, monkeypatch):
    """A corrupted recording whose expected_hits disagree with its own
    final15 is a recording-integrity issue: set_equal still holds (the
    reconstruction matched), and the row REPORTS the hits divergence."""
    _snapshot_env(fake_sources, monkeypatch)
    mirror = json.loads((probe.ARTIFACT_DIR /
                         "probe-mirror2-grounded-r1-20260910.json").read_text())
    mirror["cases"]["caseA"]["expected_hits"] = ["s9"]
    (probe.ARTIFACT_DIR / "probe-mirror2-grounded-r1-20260910.json").write_text(
        json.dumps(mirror))
    rows, all_pass = probe.run_validity_gate("postgres://x", ["caseA"])
    assert all_pass is True  # set_equal intact — the reconstruction matched
    assert rows[0]["hits_predicted"] == ["s1"]
    assert rows[0]["hits_recorded"] == ["s9"]


def test_main_snapshot_flow_proceeds_on_gate_failure(fake_sources, monkeypatch):
    """Ruling: the gate validates the UNION reconstruction; the EN-only
    snapshots do not depend on it — they run regardless, with the verdict
    recorded in the gate artifact."""
    monkeypatch.setenv("DATABASE_URL", "postgres://x")
    monkeypatch.setattr(probe, "measurable_case_ids", lambda: ["caseA"])
    monkeypatch.setattr(probe, "run_validity_gate",
                        lambda db, cases, demotion=True, log=print:
                        ([{"check": "x", "pass": False, "gating": True}], False))
    snapshots = []
    monkeypatch.setattr(probe, "snapshot_case",
                        lambda *a, **k: snapshots.append(a) or "p")
    monkeypatch.setattr(probe, "new_doc_ids_since",
                        lambda db, date_str=None: (set(), "created_at"))
    rc = probe.main(["--snapshot", "--all-cases", "--label", "t1"])
    assert rc == 0
    assert len(snapshots) == 1  # the EN-only snapshot ran despite the failure
    assert (probe.ARTIFACT_DIR / "snapshot-validity-t1.json").exists()


def test_main_snapshot_flow_success_runs_every_measurable_case(fake_sources, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://x")
    monkeypatch.setattr(probe, "measurable_case_ids", lambda: ["caseA", "caseB"])
    monkeypatch.setattr(probe, "run_validity_gate",
                        lambda db, cases, demotion=True, log=print: ([], True))
    seen = []
    monkeypatch.setattr(probe, "snapshot_case",
                        lambda case_id, db, tc, ic, sc, nd, dc, **k:
                        seen.append(case_id) or "p")
    monkeypatch.setattr(probe, "new_doc_ids_since",
                        lambda db: ({"d_new"}, "created_at"))
    rc = probe.main(["--snapshot", "--all-cases", "--label", "t2"])
    assert rc == 0
    assert seen == ["caseA", "caseB"]

def test_stable_rank_strips_summary_nodes_after_demotion():
    # production strips is_summary_node chunks from the answer results AFTER
    # the rerank cut and demotion: a summary can occupy a rerank slot but
    # never the final list, and chunks beyond top_n do NOT get promoted
    pool = [f"c{i}" for i in range(1, 21)]
    scores = {f"c{i}": 1.0 - i * 0.01 for i in range(1, 21)}
    idx = {f"c{i}": i for i in range(1, 21)}
    ranked = probe.stable_rank(pool, scores, top_n=20, cut=15,
                               chunk_index_of=idx,
                               exclude={"c2", "c3"})   # summaries at ranks 2,3
    ids = [cid for cid, _ in ranked]
    assert "c2" not in ids and "c3" not in ids
    assert ids[:3] == ["c1", "c4", "c5"]              # no promotion from rank 21
    assert len(ids) == 15 and ids[-1] == "c17"


def test_doc_of_chunk_handles_summary_ids():
    assert probe.doc_of_chunk("doc1_chunk_12") == "doc1"
    assert probe.doc_of_chunk("doc1_summary") == "doc1"


def test_run_validity_gate_makes_no_openai_calls(fake_sources, monkeypatch):
    """The gate replays RECORDED served strings — a fresh draw would change
    the seed pool itself (measured: q4 pool 238 vs 264 across draws)."""
    _snapshot_env(fake_sources, monkeypatch)
    monkeypatch.setenv("DATABASE_URL", "postgres://x")

    def _forbidden(question, api_key=None):
        raise AssertionError("validity gate must not call the translator")

    monkeypatch.setattr(probe, "translate_orjoined", _forbidden)
    rows, all_pass = probe.run_validity_gate("postgres://x", ["caseA"])
    assert all_pass is True


def test_snapshot_case_is_en_only_shipped_state(fake_sources, monkeypatch):
    """Snapshot = the EN-only SHIPPED state (flag dark): no seed lane, no zh
    lane, NO LLM call anywhere; pool = standard candidates only."""
    _snapshot_env(fake_sources, monkeypatch)
    monkeypatch.setenv("DATABASE_URL", "postgres://x")

    def _forbidden(question, api_key=None):
        raise AssertionError("snapshot mode must not call the translator")

    monkeypatch.setattr(probe, "translate_orjoined", _forbidden)
    path = probe.snapshot_case("caseA", "postgres://x", {}, {}, {},
                               [], "since_col", label="t")
    data = json.loads(Path(path).read_text())
    assert "seed_query" not in data
    assert data["pool"]["order"].startswith("standard candidates only")
    assert "seed_ids" not in data["pool"]
    assert list(data["views"].keys()) == ["shipped_en_only"]
