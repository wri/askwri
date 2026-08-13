"""
Tests for translation-pair filtering in /query (issue #325).

Task 10: answer mode drops a confirmed translation's chunks before rerank
(citations come from originals). Task 11: cite mode collapses a pair to the
original's identity. These tests use the same self-contained approach as
test_cite_doc_ids_filter.py: a local dataclass for the request and an
extracted copy of the filter logic, with load_confirmed_pairs monkeypatched
into app.main so the flag-off path ({} short-circuit) is exercised too.
"""
import pytest
from dataclasses import dataclass
from typing import Optional, List
from unittest.mock import MagicMock

import app.main


# --- Self-contained request for filter logic tests ---

@dataclass
class MockRequest:
    query: str = "test"
    mode: str = "cite"
    cite_doc_ids: Optional[List[str]] = None


# --- Helpers ---

def make_node(doc_id: str, chunk_id: str = "chunk_1", score: float = 0.8,
              title: str = None):
    """Build a mock NodeWithScore matching llama_index's structure."""
    node = MagicMock()
    metadata = {"doc_id": doc_id, "chunk_id": chunk_id}
    if title is not None:
        metadata["title"] = title
    node.metadata = metadata
    node.text = f"Content from {doc_id}/{chunk_id}"
    node.node_id = f"{doc_id}/{chunk_id}"
    wrapper = MagicMock()
    wrapper.node = node
    wrapper.score = score
    return wrapper


# --- Answer-mode filter (Task 10): extracted copy kept in sync with main.py ---

def apply_translation_pairs_answer_filter(stage1_results, request):
    """Answer mode: drop a confirmed translation's chunks (citations come from
    originals). Flag-gated: load_confirmed_pairs() returns {} when off."""
    from app.main import load_confirmed_pairs
    translation_pairs = load_confirmed_pairs()
    if request.mode == "answer" and translation_pairs:
        return [n for n in stage1_results
                if n.node.metadata.get("doc_id") not in translation_pairs]
    return stage1_results


PAIRS = {"t1": {"original": "o1", "original_title": "Original Title",
                "original_searchable": True}}


def test_answer_mode_drops_translation_chunks(monkeypatch):
    monkeypatch.setattr(app.main, "load_confirmed_pairs", lambda: PAIRS)
    results = [make_node("t1", score=0.9), make_node("o1", score=0.8)]
    filtered = apply_translation_pairs_answer_filter(results, MockRequest(mode="answer"))
    doc_ids = [n.node.metadata["doc_id"] for n in filtered]
    assert doc_ids == ["o1"], "answer mode drops the translation, keeps the original"


def test_flag_off_drops_nothing(monkeypatch):
    monkeypatch.setattr(app.main, "load_confirmed_pairs", lambda: {})
    results = [make_node("t1", score=0.9), make_node("o1", score=0.8)]
    filtered = apply_translation_pairs_answer_filter(results, MockRequest(mode="answer"))
    assert len(filtered) == 2, "flag off (empty pairs) drops nothing"


def test_cite_mode_drops_nothing(monkeypatch):
    monkeypatch.setattr(app.main, "load_confirmed_pairs", lambda: PAIRS)
    results = [make_node("t1", score=0.9), make_node("o1", score=0.8)]
    filtered = apply_translation_pairs_answer_filter(results, MockRequest(mode="cite"))
    assert len(filtered) == 2, "cite mode does not apply the answer-mode filter"
