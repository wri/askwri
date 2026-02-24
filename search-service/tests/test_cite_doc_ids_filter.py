"""
Tests for the cite_doc_ids filtering in answer mode (PR #42 / AW-28).

Validates that when a user selects specific documents from Cite results,
only chunks belonging to those documents pass through to reranking and synthesis.

These tests are self-contained: they use a local dataclass for the request
so they run on any branch. The TestQueryRequestModel class imports the real
QueryRequest and is skipped if cite_doc_ids is not yet on the model.
"""

import pytest
from dataclasses import dataclass, field
from typing import Optional, List
from unittest.mock import MagicMock


# --- Self-contained request for filter logic tests ---

@dataclass
class MockRequest:
    query: str = "test"
    mode: str = "cite"
    cite_doc_ids: Optional[List[str]] = None


# --- Helpers ---

def make_node(doc_id: str, chunk_id: str = "chunk_1", score: float = 0.8):
    """Build a mock NodeWithScore matching llama_index's structure."""
    node = MagicMock()
    node.metadata = {"doc_id": doc_id, "chunk_id": chunk_id}
    node.text = f"Content from {doc_id}/{chunk_id}"
    wrapper = MagicMock()
    wrapper.node = node
    wrapper.score = score
    return wrapper


def apply_cite_filter(stage1_results, request):
    """
    Extracted filter logic from hybrid_query (main.py ~line 1078).
    Kept in sync: if answer mode and cite_doc_ids provided, keep only matching chunks.
    """
    if request.mode == "answer" and request.cite_doc_ids:
        return [
            n for n in stage1_results
            if n.node.metadata.get("doc_id") in request.cite_doc_ids
        ]
    return stage1_results


# --- QueryRequest model tests (require PR branch) ---

class TestQueryRequestModel:
    """Validates that the Pydantic model accepts cite_doc_ids.
    Skipped if the field hasn't been added yet (i.e. running on qa before merge)."""

    @pytest.fixture(autouse=True)
    def _import_model(self):
        try:
            from app.main import QueryRequest
        except Exception:
            pytest.skip("Cannot import QueryRequest (missing env/config)")
            return
        self.QueryRequest = QueryRequest
        if not any(f == "cite_doc_ids" for f in QueryRequest.model_fields):
            pytest.skip("cite_doc_ids not yet on QueryRequest (run on PR branch)")

    def test_cite_doc_ids_defaults_to_none(self):
        req = self.QueryRequest(query="test")
        assert req.cite_doc_ids is None

    def test_cite_doc_ids_accepts_string_list(self):
        ids = ["doc_a", "doc_b", "doc_c"]
        req = self.QueryRequest(query="test", cite_doc_ids=ids)
        assert req.cite_doc_ids == ids

    def test_cite_doc_ids_accepts_empty_list(self):
        req = self.QueryRequest(query="test", cite_doc_ids=[])
        assert req.cite_doc_ids == []

    def test_mode_defaults_to_cite(self):
        req = self.QueryRequest(query="test")
        assert req.mode == "cite"


# --- Filter logic tests (run on any branch) ---

class TestCiteDocIdsFilter:
    """Test the cite_doc_ids filter that runs after Stage 1 hybrid fusion."""

    @pytest.fixture
    def mixed_results(self):
        """5 chunks from 3 source documents."""
        return [
            make_node("doc_a", "chunk_1", 0.9),
            make_node("doc_a", "chunk_2", 0.85),
            make_node("doc_b", "chunk_1", 0.8),
            make_node("doc_c", "chunk_1", 0.7),
            make_node("doc_c", "chunk_2", 0.6),
        ]

    def test_filter_keeps_only_selected_docs(self, mixed_results):
        req = MockRequest(mode="answer", cite_doc_ids=["doc_a", "doc_c"])
        filtered = apply_cite_filter(mixed_results, req)
        result_doc_ids = [n.node.metadata["doc_id"] for n in filtered]
        assert set(result_doc_ids) == {"doc_a", "doc_c"}
        assert len(filtered) == 4  # 2 from doc_a + 2 from doc_c

    def test_filter_removes_unselected_docs(self, mixed_results):
        req = MockRequest(mode="answer", cite_doc_ids=["doc_b"])
        filtered = apply_cite_filter(mixed_results, req)
        result_doc_ids = [n.node.metadata["doc_id"] for n in filtered]
        assert result_doc_ids == ["doc_b"]

    def test_bogus_ids_return_empty(self, mixed_results):
        req = MockRequest(mode="answer", cite_doc_ids=["nonexistent"])
        filtered = apply_cite_filter(mixed_results, req)
        assert filtered == []

    def test_no_cite_doc_ids_passes_all_through(self, mixed_results):
        req = MockRequest(mode="answer", cite_doc_ids=None)
        filtered = apply_cite_filter(mixed_results, req)
        assert len(filtered) == 5

    def test_empty_cite_doc_ids_passes_all_through(self, mixed_results):
        """Empty list is falsy in Python, so filter should not apply."""
        req = MockRequest(mode="answer", cite_doc_ids=[])
        filtered = apply_cite_filter(mixed_results, req)
        assert len(filtered) == 5

    def test_cite_mode_ignores_cite_doc_ids(self, mixed_results):
        """cite_doc_ids should only take effect in answer mode."""
        req = MockRequest(mode="cite", cite_doc_ids=["doc_a"])
        filtered = apply_cite_filter(mixed_results, req)
        assert len(filtered) == 5

    def test_single_doc_multiple_chunks(self, mixed_results):
        req = MockRequest(mode="answer", cite_doc_ids=["doc_a"])
        filtered = apply_cite_filter(mixed_results, req)
        assert len(filtered) == 2
        assert all(n.node.metadata["doc_id"] == "doc_a" for n in filtered)

    def test_preserves_order(self, mixed_results):
        """Filtered results keep their original ranking order."""
        req = MockRequest(mode="answer", cite_doc_ids=["doc_c", "doc_a"])
        filtered = apply_cite_filter(mixed_results, req)
        scores = [n.score for n in filtered]
        assert scores == sorted(scores, reverse=True)

    def test_twenty_doc_ids(self):
        """Simulates the max selection (20 docs, each with 2 chunks = 40 nodes)."""
        doc_ids = [f"doc_{i}" for i in range(20)]
        nodes = []
        for doc_id in doc_ids:
            nodes.append(make_node(doc_id, "chunk_1"))
            nodes.append(make_node(doc_id, "chunk_2"))
        # Add 10 extra docs that should be filtered out
        for i in range(20, 30):
            nodes.append(make_node(f"doc_{i}", "chunk_1"))

        req = MockRequest(mode="answer", cite_doc_ids=doc_ids)
        filtered = apply_cite_filter(nodes, req)
        assert len(filtered) == 40
        filtered_ids = {n.node.metadata["doc_id"] for n in filtered}
        assert filtered_ids == set(doc_ids)
