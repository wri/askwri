"""Cite mode shows a real passage for docs represented by a summary node (#233).

Summary nodes (title+summary) are a retrieval device that earns its ranking
place, so the fix substitutes the DISPLAYED chunk and carries the summary
node's score and tier over — the document set, order and scores must not
move. `CITE_SUBSTITUTE_SUMMARY_PASSAGE` defaults off, so the merge is
behaviour-neutral; the off-arm test below is the rollback proof.

No AWS, no DB — this exercises the grouping helper directly.
"""
from llama_index.core.schema import NodeWithScore, TextNode

from app.config import get_settings
from app.main import _substitute_summary_passages


def _node(doc_id, chunk_id, score, text, summary=False, tier=None):
    metadata = {"doc_id": doc_id, "chunk_id": chunk_id, "page": 1 if summary else 7}
    if summary:
        metadata["is_summary_node"] = True
    if tier is not None:
        metadata["relevance_tier"] = tier
    return NodeWithScore(node=TextNode(id_=chunk_id, text=text, metadata=metadata),
                         score=score)


def _grouped(reranked):
    """Mirror of the cite per-doc grouping in main.hybrid_query."""
    groups = {}
    for node in reranked:
        doc_id = node.node.metadata["doc_id"]
        if doc_id not in groups or node.score > groups[doc_id].score:
            groups[doc_id] = node
    return groups


# --- config ---------------------------------------------------------------

def test_substitution_is_off_by_default(monkeypatch):
    monkeypatch.delenv("CITE_SUBSTITUTE_SUMMARY_PASSAGE", raising=False)
    get_settings.cache_clear()
    assert get_settings().cite_substitute_summary_passage is False
    get_settings.cache_clear()


# --- behaviour -------------------------------------------------------------

def test_summary_winner_is_replaced_by_best_real_chunk():
    reranked = [
        _node("docA", "docA_summary", 0.91, "Title\n\nSummary text", summary=True,
              tier="strong"),
        _node("docA", "docA_chunk_12", 0.44, "A real passage from the PDF."),
        _node("docB", "docB_chunk_3", 0.60, "Another real passage."),
    ]
    groups = _substitute_summary_passages(_grouped(reranked), reranked)

    winner = groups["docA"]
    assert winner.node.metadata["chunk_id"] == "docA_chunk_12"
    assert winner.node.text == "A real passage from the PDF."
    assert not winner.node.metadata.get("is_summary_node", False)
    assert winner.node.metadata["page"] == 7          # not the summary's page 1
    # score and tier carry over from the summary node — ranking must not move
    assert winner.score == 0.91
    assert winner.node.metadata["relevance_tier"] == "strong"
    # untouched document is untouched
    assert groups["docB"].node.metadata["chunk_id"] == "docB_chunk_3"


def test_highest_scoring_real_chunk_wins_the_substitution():
    reranked = [
        _node("docA", "docA_summary", 0.80, "Title\n\nSummary", summary=True),
        _node("docA", "docA_chunk_1", 0.20, "weaker passage"),
        _node("docA", "docA_chunk_9", 0.55, "stronger passage"),
    ]
    groups = _substitute_summary_passages(_grouped(reranked), reranked)
    assert groups["docA"].node.metadata["chunk_id"] == "docA_chunk_9"


def test_document_order_is_preserved():
    reranked = [
        _node("docA", "docA_chunk_1", 0.95, "first"),
        _node("docB", "docB_summary", 0.90, "Title\n\nSummary", summary=True),
        _node("docB", "docB_chunk_4", 0.10, "b passage"),
        _node("docC", "docC_chunk_2", 0.50, "third"),
    ]
    groups = _substitute_summary_passages(_grouped(reranked), reranked)
    assert list(groups) == ["docA", "docB", "docC"]
    assert [n.score for n in groups.values()] == [0.95, 0.90, 0.50]


def test_document_with_no_real_chunk_keeps_its_summary_node():
    """A synthetic snippet beats a dropped document."""
    reranked = [
        _node("docA", "docA_summary", 0.70, "Title\n\nSummary", summary=True),
        _node("docB", "docB_chunk_1", 0.30, "real passage"),
    ]
    groups = _substitute_summary_passages(_grouped(reranked), reranked)
    assert set(groups) == {"docA", "docB"}
    assert groups["docA"].node.metadata["chunk_id"] == "docA_summary"


def test_real_chunks_of_other_documents_are_not_borrowed():
    reranked = [
        _node("docA", "docA_summary", 0.70, "Title\n\nSummary", summary=True),
        _node("docB", "docB_chunk_1", 0.65, "docB passage"),
    ]
    groups = _substitute_summary_passages(_grouped(reranked), reranked)
    assert groups["docA"].node.metadata["doc_id"] == "docA"
    assert groups["docA"].node.metadata["chunk_id"] == "docA_summary"


def test_stale_tier_on_a_shared_substitute_node_is_cleared():
    """Legacy in-memory mode reuses node objects across requests; when the
    current query assigned no tier (rerank did not run) the substitute must
    not carry one in from an earlier query."""
    stale = _node("docA", "docA_chunk_2", 0.40, "passage", tier="strong")
    reranked = [
        _node("docA", "docA_summary", 0.80, "Title\n\nSummary", summary=True),
        stale,
    ]
    groups = _substitute_summary_passages(_grouped(reranked), reranked)
    assert "relevance_tier" not in groups["docA"].node.metadata


def test_no_summary_nodes_is_a_no_op():
    reranked = [
        _node("docA", "docA_chunk_1", 0.9, "a"),
        _node("docB", "docB_chunk_1", 0.5, "b"),
    ]
    groups = _grouped(reranked)
    before = {k: (v.node.node_id, v.score) for k, v in groups.items()}
    out = _substitute_summary_passages(groups, reranked)
    assert {k: (v.node.node_id, v.score) for k, v in out.items()} == before
