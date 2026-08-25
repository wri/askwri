from app.indexing import build_nodes


class NoCache:
    """Cache stub: always miss, never store."""

    def get_cached_nodes(self, *args):
        return None

    def cache_nodes(self, *args):
        pass


def make_doc(doc_id: str, text: str, summary: str = ""):
    return {
        "doc_id": doc_id,
        "text": text,
        "metadata": {
            "title": f"Title {doc_id}",
            "authors": "Author A",
            "year": "2021",
            "subtag": "Transport decarbonization",
            "program_series": "",
            "url": "",
            "file_path": f"{doc_id}.pdf",
            "summary": summary,
            "page_boundaries": [],
        },
    }


def test_chunk_ids_use_legacy_format_and_are_deterministic():
    docs = [make_doc("doc_a", "transport decarbonization " * 200)]
    nodes, content_hash = build_nodes(docs, NoCache())
    chunk_nodes = [n for n in nodes if not n.metadata.get("is_summary_node")]
    assert chunk_nodes, "expected text chunks"
    assert chunk_nodes[0].metadata["chunk_id"] == "doc_a_chunk_0"
    assert all(n.metadata["doc_id"] == "doc_a" for n in nodes)

    nodes2, content_hash2 = build_nodes(docs, NoCache())
    assert [n.metadata["chunk_id"] for n in nodes2] == [n.metadata["chunk_id"] for n in nodes]
    assert [n.text for n in nodes2] == [n.text for n in nodes]
    assert content_hash2 == content_hash


def test_summary_node_carries_sentinel_metadata():
    docs = [make_doc("doc_a", "transport decarbonization " * 200, summary="A dense summary.")]
    nodes, _ = build_nodes(docs, NoCache())
    summaries = [n for n in nodes if n.metadata.get("is_summary_node")]
    assert len(summaries) == 1
    s = summaries[0]
    assert s.metadata["chunk_id"] == "doc_a_summary"
    assert s.metadata["chunk_index"] == -1
    assert s.text.startswith("Title doc_a")


def test_doc_without_summary_gets_no_summary_node():
    docs = [make_doc("doc_b", "words " * 300, summary="")]
    nodes, _ = build_nodes(docs, NoCache())
    assert not [n for n in nodes if n.metadata.get("is_summary_node")]
