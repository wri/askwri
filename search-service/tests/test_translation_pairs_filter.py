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

from llama_index.core.schema import TextNode, NodeWithScore

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
    """Build a real NodeWithScore so the cite-mode collapse can construct a
    copied TextNode from it (MagicMock would fail pydantic validation)."""
    metadata = {"doc_id": doc_id, "chunk_id": chunk_id}
    if title is not None:
        metadata["title"] = title
    node = TextNode(
        text=f"Content from {doc_id}/{chunk_id}",
        metadata=metadata,
        id_=f"{doc_id}/{chunk_id}",
    )
    return NodeWithScore(node=node, score=score)


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


# --- Cite-mode collapse (Task 11): extracted copy kept in sync with main.py ---

def collapse_cite_mode_pairs(stage2_results, translation_pairs):
    """Cite mode: credit a translation hit to its original. When the original
    also matched, its own best chunk is shown; a translation-only hit is
    substituted via a copied node. Withdrawn original -> the pair drops."""
    doc_groups = {}
    translation_best = {}
    for node in stage2_results:
        node.node.metadata.pop("has_english_translation", None)
        node.node.metadata.pop("excerpt_from_translation", None)
        doc_id = node.node.metadata.get("doc_id")
        pair = translation_pairs.get(doc_id)
        if pair is not None:
            canon = pair["original"]
            cur = translation_best.get(canon)
            if cur is None or node.score > cur.score:
                translation_best[canon] = node
            continue
        if doc_id not in doc_groups or node.score > doc_groups[doc_id].score:
            doc_groups[doc_id] = node
    originals_of = {p["original"]: p for p in translation_pairs.values()}
    for canon, tnode in translation_best.items():
        pair = originals_of[canon]
        if canon in doc_groups:
            doc_groups[canon].node.metadata["has_english_translation"] = True
            continue
        if not pair["original_searchable"]:
            continue  # withdrawn original: the work is off the site
        sub = TextNode(
            id_=tnode.node.node_id,
            text=tnode.node.text,
            metadata={**tnode.node.metadata,
                      "doc_id": canon,
                      "title": pair["original_title"],
                      "has_english_translation": True,
                      "excerpt_from_translation": True},
        )
        doc_groups[canon] = NodeWithScore(node=sub, score=tnode.score)
    return doc_groups


PAIRS = {"t1": {"original": "o1", "original_title": "Original Title",
                "original_searchable": True}}


# --- Task 10: answer-mode filter ---

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


# --- Task 11: cite-mode collapse ---

def test_cite_both_hit_shows_original_and_flags_translation():
    """Both members hit -> one result, the original's own text is shown even
    when the translation's chunk scored higher; has_english_translation is set
    and excerpt_from_translation is absent."""
    results = [
        make_node("t1", score=0.95, title="Translation Title"),  # translation, higher score
        make_node("o1", score=0.80, title="Original Title"),      # original
    ]
    doc_groups = collapse_cite_mode_pairs(results, PAIRS)
    assert list(doc_groups.keys()) == ["o1"], "pair collapses to one result (the original)"
    node = doc_groups["o1"]
    assert node.node.metadata["doc_id"] == "o1"
    assert node.node.text == "Content from o1/chunk_1", "original's own text shown"
    assert node.node.metadata.get("has_english_translation") is True
    assert node.node.metadata.get("excerpt_from_translation") is None


def test_cite_only_translation_hit_substitutes_original():
    """Only the translation hit -> one result credited to the original, with
    the original's title and excerpt_from_translation=true."""
    results = [make_node("t1", score=0.9, title="Translation Title")]
    doc_groups = collapse_cite_mode_pairs(results, PAIRS)
    assert list(doc_groups.keys()) == ["o1"]
    node = doc_groups["o1"]
    assert node.node.metadata["doc_id"] == "o1"
    assert node.node.metadata["title"] == "Original Title"
    assert node.node.metadata.get("excerpt_from_translation") is True
    assert node.node.metadata.get("has_english_translation") is True
    assert node.score == 0.9


def test_cite_withdrawn_original_drops_pair():
    """Original withdrawn (original_searchable False) and only the translation
    hit -> no result for the pair (the work is off the site)."""
    pairs = {"t1": {"original": "o1", "original_title": "Original Title",
                    "original_searchable": False}}
    results = [make_node("t1", score=0.9)]
    doc_groups = collapse_cite_mode_pairs(results, pairs)
    assert "o1" not in doc_groups, "withdrawn original: the work is off the site"
    assert "t1" not in doc_groups, "translation not credited to a withdrawn original"
    assert len(doc_groups) == 0


def test_cite_flag_off_keeps_both_as_separate_results():
    """Flag off (empty pairs) -> t1 and o1 appear as two separate results
    (current behavior preserved)."""
    results = [make_node("t1", score=0.9), make_node("o1", score=0.8)]
    doc_groups = collapse_cite_mode_pairs(results, {})
    assert set(doc_groups.keys()) == {"t1", "o1"}, "flag off: current behavior preserved"
