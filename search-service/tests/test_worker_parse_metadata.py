"""Unit tests for parse-stage bibliographic metadata normalization."""
from unittest.mock import patch

from worker.stages.parse import (
    _EXTRACT_SCHEMA,
    _extract_metadata_llm,
    _format_authors,
)


def _empty_metadata(**overrides):
    result = {name: None for name in _EXTRACT_SCHEMA["properties"]}
    result.update(overrides)
    return result


def test_authors_schema_requires_semantic_name_parts():
    authors = _EXTRACT_SCHEMA["properties"]["authors"]
    assert authors["type"] == ["array", "null"]
    item = authors["items"]
    assert item["additionalProperties"] is False
    assert set(item["properties"]) == {
        "family_name",
        "given_names",
        "organization_name",
    }
    assert set(item["required"]) == set(item["properties"])


def test_formats_chinese_personal_names_family_first():
    assert _format_authors([
        {"family_name": "Xue", "given_names": "Lulu", "organization_name": None},
        {"family_name": "Chen", "given_names": "Ke", "organization_name": None},
    ]) == "Xue, Lulu; Chen, Ke"


def test_preserves_single_names_and_organizations_without_inventing_commas():
    assert _format_authors([
        {"family_name": "Sukarno", "given_names": None, "organization_name": None},
        {"family_name": None, "given_names": None, "organization_name": "World Resources Institute"},
    ]) == "Sukarno; World Resources Institute"


def test_discards_blank_malformed_and_conflicting_author_items():
    assert _format_authors([
        None,
        "Xue, Lulu",
        {"family_name": " ", "given_names": "", "organization_name": None},
        {"family_name": "Xue", "given_names": "Lulu", "organization_name": "WRI"},
        {"family_name": " Li ", "given_names": " Xiang ", "organization_name": None},
    ]) == "Li, Xiang"
    assert _format_authors(None) is None
    assert _format_authors("Xue, Lulu") is None


def test_metadata_extraction_formats_authors_and_keeps_one_model_call():
    captured = {}

    def fake_chat_json(**kwargs):
        captured.update(kwargs)
        return _empty_metadata(authors=[
            {"family_name": "Xue", "given_names": "Lulu", "organization_name": None},
            {"family_name": "Chen", "given_names": "Ke", "organization_name": None},
        ])

    with patch("worker.llm.chat_json", side_effect=fake_chat_json) as chat:
        result = _extract_metadata_llm("薛露露 陈科", "test-model")

    assert chat.call_count == 1
    assert result["authors"] == "Xue, Lulu; Chen, Ke"
    system = captured["system"]
    assert "family_name" in system and "given_names" in system
    assert "romanized form" in system
    assert "Latin alphabet" in system
