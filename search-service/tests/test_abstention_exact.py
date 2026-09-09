"""The exact evaluator must not hide a bad minority extraction."""
import pytest

from scripts.abstention_exact import evaluate_cases, compare_reports


def test_every_distinct_variant_is_scored_including_nonmodal():
    cases = {"negative": {"polarity": "negative", "modal": "absent",
                           "samples": ["absent", "absent", "present"]}}
    results = evaluate_cases(cases, lambda text: {
        "present": text == "present", "matched_term": text if text == "present" else None,
        "matched_surface": "title" if text == "present" else None,
    })
    assert [r["present"] for r in results["negative"]["results"]] == [False, True]


def test_blank_extraction_fails_instead_of_manufacturing_success():
    with pytest.raises(ValueError, match="blank extraction"):
        evaluate_cases({"case": {"polarity": "positive", "samples": [None]}}, lambda _: {})


def test_comparison_reports_positive_and_negative_regressions():
    before = {"corpus_sha256": "same", "cases": {
        "pos": {"polarity": "positive", "results": [{"core_topic": "a", "present": True}]},
        "neg": {"polarity": "negative", "results": [{"core_topic": "b", "present": False}]},
    }}
    after = {"corpus_sha256": "same", "cases": {
        "pos": {"polarity": "positive", "results": [{"core_topic": "a", "present": False}]},
        "neg": {"polarity": "negative", "results": [{"core_topic": "b", "present": True}]},
    }}
    assert compare_reports(before, after) == ["pos: a", "neg: b"]


def test_comparison_rejects_corpus_drift():
    with pytest.raises(ValueError, match="corpus"):
        compare_reports({"corpus_sha256": "a"}, {"corpus_sha256": "b"})


def test_comparison_rejects_missing_variants():
    before = {"corpus_sha256": "same", "cases": {
        "x": {"polarity": "positive", "results": [{"core_topic": "a", "present": True}]},
    }}
    after = {"corpus_sha256": "same", "cases": {
        "x": {"polarity": "positive", "results": []},
    }}
    with pytest.raises(ValueError, match="extractions"):
        compare_reports(before, after)
