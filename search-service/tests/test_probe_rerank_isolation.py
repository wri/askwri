"""Rerank-isolation probe (plan 2026-09-10 §4.1) — pure parts only.

The probe script is standalone (never imports app.*); these tests cover its
pure assembly/validation logic and main()'s artifact contract with boto3 and
OpenAI mocked at the boundary. No live calls anywhere.
"""
import json

import pytest

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
