"""E2E contract tests for the /query endpoint against the real qa database.

These tests are READ-ONLY against qa except for the withdrawn-doc test which
restores the original status in a try/finally block.

Skip guard: requires DATABASE_URL.  If REQUIRE_DB_TESTS=1 and DATABASE_URL
is absent the session fails loudly instead of silently skipping.

Startup note: `load_from_postgres()` is called once per session (BM25 build
takes ~30–60 s).  The FastAPI TestClient is instantiated WITHOUT the context
manager so lifespan is skipped — we boot the service state ourselves.
"""
import os

import psycopg
import pytest
from starlette.testclient import TestClient

from tests.conftest import _check_db_required, requires_db

# ---------------------------------------------------------------------------
# Module-level loud-skip guard
# ---------------------------------------------------------------------------
_check_db_required()

pytestmark = requires_db

_QA_DB_URL = "postgresql://askwri:password@localhost:5432/qa"


# ---------------------------------------------------------------------------
# Stub helpers
# ---------------------------------------------------------------------------

class _StubEmbedModel:
    """Returns a fixed 1536-dim vector for any query — no OpenAI calls."""

    def get_query_embedding(self, query: str):
        return [0.01] * 1536

    def get_text_embedding(self, text: str):
        return [0.01] * 1536


class _StubReranker:
    """Reranker stub: keep the fused order but emit 0-1 relevance scores like
    the real Bedrock Cohere Rerank client — the cite floor/tiers downstream
    are calibrated on that scale, and raw RRF scores (~0.008-0.03) would all
    land below the floor."""

    def postprocess_nodes(self, nodes, query_bundle, top_n=None):
        sorted_nodes = sorted(nodes, key=lambda n: (n.score or 0.0), reverse=True)
        if top_n is not None:
            sorted_nodes = sorted_nodes[:top_n]
        for i, node in enumerate(sorted_nodes):
            node.score = max(0.05, 0.95 - i * 0.002)
        return sorted_nodes


# ---------------------------------------------------------------------------
# Session-scoped service boot
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session", autouse=False)
def booted_service(tmp_path_factory):
    """Boot the search service against qa, yield (client, qa_db_url).

    The fixture patches app.main.settings directly (not just the lru_cache)
    because app.main captures `settings = get_settings()` at module import
    time.  We need the module-level reference to reflect retrieval_backend=postgres.
    """
    import app.db as _db
    from app.config import get_settings, Settings

    # Point env vars at qa DB + postgres retrieval backend
    _saved_env = {
        k: os.environ.get(k)
        for k in ("DATABASE_URL", "RETRIEVAL_BACKEND")
    }
    os.environ["DATABASE_URL"] = _QA_DB_URL
    os.environ["RETRIEVAL_BACKEND"] = "postgres"
    get_settings.cache_clear()

    # Reset pool
    if _db._pool is not None:
        try:
            _db._pool.close()
        except Exception:
            pass
    _db._pool = None

    import app.main as _main

    # These are CONTRACT tests: retrieval must run against whatever model the
    # qa corpus rows actually carry (text-embedding-3-small before the v3 B1
    # cutover, cohere-embed-v4 after), with all embedding calls stubbed.
    with psycopg.connect(_QA_DB_URL) as _conn:
        _row = _conn.execute(
            """SELECT embedding_model FROM document_chunks
               WHERE embedding_model IS NOT NULL
               GROUP BY 1 ORDER BY count(*) DESC LIMIT 1"""
        ).fetchone()
    _corpus_model = _row[0] if _row else "text-embedding-3-small"

    # Patch the module-level settings reference in app.main (it captured
    # get_settings() at import time and won't re-read the env var).
    _orig_settings = _main.settings
    _main.settings = Settings(
        database_url=_QA_DB_URL,
        retrieval_backend="postgres",
        environment="test",
        embedding_model=_corpus_model,
        OPENAI_API_KEY=os.environ.get("OPENAI_API_KEY", "test-key"),
    )
    # pg_store retrievers read get_settings() per query — point the cached
    # settings at the same model as the corpus rows.
    os.environ["EMBEDDING_MODEL"] = _corpus_model
    get_settings.cache_clear()

    # Monkeypatch both embedding entry points before load_from_postgres:
    # the OpenAI factory (legacy) and the Bedrock adapter (cohere path).
    import app.bedrock_embed as _bedrock_embed
    _orig_embed = _main.OpenAIEmbedding
    _main.OpenAIEmbedding = lambda **kw: _StubEmbedModel()
    _orig_bedrock_adapter = _bedrock_embed.BedrockCohereQueryEmbedding
    _bedrock_embed.BedrockCohereQueryEmbedding = lambda: _StubEmbedModel()

    # Patch init_rerankers to return stubs
    _orig_init_rerankers = _main.init_rerankers
    _main.init_rerankers = lambda: (_StubReranker(), _StubReranker())

    try:
        _main.load_from_postgres()
        client = TestClient(_main.app, raise_server_exceptions=True)
        yield client, _QA_DB_URL
    finally:
        # Restore originals
        _main.settings = _orig_settings
        _main.OpenAIEmbedding = _orig_embed
        _bedrock_embed.BedrockCohereQueryEmbedding = _orig_bedrock_adapter
        os.environ.pop("EMBEDDING_MODEL", None)
        _main.init_rerankers = _orig_init_rerankers
        # Close pool
        if _db._pool is not None:
            try:
                _db._pool.close()
            except Exception:
                pass
        _db._pool = None
        # Restore env
        for k, v in _saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        get_settings.cache_clear()


# ---------------------------------------------------------------------------
# /query contract tests
# ---------------------------------------------------------------------------

class TestQueryEndpointCiteMode:
    """Tests for /query in cite mode."""

    @requires_db
    def test_cite_mode_200_and_structure(self, booted_service):
        """POST /query cite mode returns 200 with required top-level keys."""
        client, _ = booted_service
        resp = client.post(
            "/query",
            json={"query": "electric buses", "mode": "cite", "max_results": 5},
        )
        assert resp.status_code == 200
        data = resp.json()
        for key in ("docs", "total_results", "query", "mode", "debug"):
            assert key in data, f"Missing key: {key}"

    @requires_db
    def test_cite_mode_doc_fields(self, booted_service):
        """Each result doc has required fields with correct types."""
        client, _ = booted_service
        resp = client.post(
            "/query",
            json={"query": "electric buses", "mode": "cite", "max_results": 5},
        )
        data = resp.json()
        assert data["docs"], "Expected at least one result"
        for doc in data["docs"]:
            assert "doc_id" in doc
            assert "chunk_id" in doc
            assert "title" in doc
            assert "content" in doc
            assert isinstance(doc["content"], str)
            assert "score" in doc
            assert 0.0 <= doc["score"] <= 1.0, f"score {doc['score']} out of [0,1]"
            assert "metadata" in doc
            assert isinstance(doc["metadata"], dict)

    @requires_db
    def test_cite_mode_chunk_id_legacy_format(self, booted_service):
        """chunk_ids must match the legacy {doc_id}_(chunk_N|summary) pattern."""
        import re
        client, _ = booted_service
        resp = client.post(
            "/query",
            json={"query": "electric buses", "mode": "cite", "max_results": 10},
        )
        data = resp.json()
        pattern = re.compile(r"^.+_(chunk_\d+|summary)$")
        for doc in data["docs"]:
            chunk_id = doc.get("chunk_id", "")
            assert pattern.match(chunk_id), (
                f"chunk_id {chunk_id!r} does not match legacy format"
            )

    @requires_db
    def test_cite_mode_deduped_by_doc_id(self, booted_service):
        """Cite mode must deduplicate by doc_id (one row per document)."""
        client, _ = booted_service
        resp = client.post(
            "/query",
            json={"query": "transport decarbonization", "mode": "cite", "max_results": 50},
        )
        data = resp.json()
        doc_ids = [doc["doc_id"] for doc in data["docs"]]
        assert len(doc_ids) == len(set(doc_ids)), "Duplicate doc_ids found in cite response"

    @requires_db
    def test_cite_mode_metadata_has_relevance_tier(self, booted_service):
        """Each doc's metadata dict must include relevance_tier."""
        client, _ = booted_service
        resp = client.post(
            "/query",
            json={"query": "electric vehicles", "mode": "cite", "max_results": 10},
        )
        data = resp.json()
        for doc in data["docs"]:
            assert "relevance_tier" in doc["metadata"], (
                f"Missing relevance_tier in metadata for doc {doc['doc_id']}"
            )

    @requires_db
    def test_cite_mode_unreranked_skips_floor_and_tiers(self, booted_service):
        """rerank=false (diagnostics/lane runs): scores are raw RRF
        (~0.008-0.03), NOT the 0-1 relevance scale the floor/tiers are
        calibrated on — the floor must not silently drop everything and no
        tier should be claimed."""
        client, _ = booted_service
        resp = client.post(
            "/query",
            json={"query": "electric buses", "mode": "cite", "max_results": 10,
                  "rerank": False},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["docs"], "unreranked cite results must not be floored away"
        for doc in data["docs"]:
            assert "relevance_tier" not in doc["metadata"], (
                "tier labels are rerank-score-based; unreranked results must not carry one"
            )

    @requires_db
    def test_cite_summary_substitution_off_by_default(self, booted_service):
        """Rollback proof for #233: with the flag off, cite mode is unchanged —
        summary nodes may still represent a document."""
        import app.main as _main
        assert _main.settings.cite_substitute_summary_passage is False
        client, _ = booted_service
        resp = client.post(
            "/query",
            json={"query": "urban mobility", "mode": "cite", "max_results": 50},
        )
        assert resp.status_code == 200

    @requires_db
    def test_cite_summary_substitution_swaps_in_real_passages(self, booted_service):
        """Flag on: no returned document may be represented by a summary node
        when a real chunk of that document was reranked, and the document set,
        order and scores must be identical to the flag-off run."""
        import app.main as _main
        client, _ = booted_service
        payload = {"query": "urban mobility", "mode": "cite", "max_results": 50}

        before_body = client.post(
            "/query", json={**payload, "return_intermediate_results": True}
        ).json()
        before = before_body["docs"]
        reranked_ids = {n["chunk_id"] for n in before_body["reranked_results"]}
        _main.settings.cite_substitute_summary_passage = True
        try:
            after = client.post("/query", json=payload).json()["docs"]
        finally:
            _main.settings.cite_substitute_summary_passage = False

        assert [d["doc_id"] for d in before] == [d["doc_id"] for d in after], (
            "substitution must not change the document set or its order"
        )
        assert [d["score"] for d in before] == [d["score"] for d in after], (
            "substitution must not change scores"
        )
        assert ([d["metadata"].get("relevance_tier") for d in before]
                == [d["metadata"].get("relevance_tier") for d in after]), (
            "substitution must not change relevance tiers"
        )
        for doc in after:
            if not doc["metadata"].get("is_summary_node", False):
                continue
            # Still a summary node is only allowed when this document had no
            # real chunk in the reranked set to substitute.
            assert not [cid for cid in reranked_ids
                        if cid.startswith(f"{doc['doc_id']}_chunk_")], (
                f"{doc['doc_id']} kept its summary node despite a reranked passage"
            )

    @requires_db
    def test_response_keys_match_query_response_model(self, booted_service):
        """Response JSON keys must exactly include all QueryResponse fields."""
        from app.main import QueryResponse
        client, _ = booted_service
        resp = client.post(
            "/query",
            json={"query": "climate", "mode": "cite", "max_results": 3},
        )
        data = resp.json()
        expected_keys = set(QueryResponse.model_fields.keys())
        # Optional fields may be absent when not set — strip None-valued optional keys
        present_keys = {k for k, v in data.items() if v is not None}
        # Required fields (non-optional) must be present
        required_keys = {
            k for k, f in QueryResponse.model_fields.items()
            if f.is_required()
        }
        missing = required_keys - set(data.keys())
        assert not missing, f"Required QueryResponse fields missing: {missing}"


class TestQueryEndpointAnswerMode:
    """Tests for /query in answer mode."""

    @requires_db
    def test_answer_mode_no_summary_nodes(self, booted_service):
        """Answer mode must strip summary nodes from results."""
        client, _ = booted_service
        resp = client.post(
            "/query",
            json={"query": "sustainable transport", "mode": "answer", "max_results": 50},
        )
        assert resp.status_code == 200
        data = resp.json()
        for doc in data["docs"]:
            assert not doc["metadata"].get("is_summary_node", False), (
                f"Summary node found in answer mode result: {doc['doc_id']}"
            )

    @requires_db
    def test_answer_mode_returns_200(self, booted_service):
        client, _ = booted_service
        resp = client.post(
            "/query",
            json={"query": "electric buses", "mode": "answer", "max_results": 10},
        )
        assert resp.status_code == 200


class TestQueryEndpointDiagnostic:
    """Tests for diagnostic/intermediate results."""

    @requires_db
    def test_return_intermediate_results_all_arrays_non_empty(self, booted_service):
        """return_intermediate_results=true → all four diagnostic arrays present."""
        client, _ = booted_service
        resp = client.post(
            "/query",
            json={
                "query": "transport decarbonization",
                "mode": "cite",
                "max_results": 10,
                "return_intermediate_results": True,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        for key in ("vector_results", "bm25_results", "fusion_results", "reranked_results"):
            assert key in data, f"Intermediate key missing: {key}"
            assert isinstance(data[key], list) and len(data[key]) > 0, (
                f"{key} is empty or missing"
            )


# ---------------------------------------------------------------------------
# Withdrawn-doc dense exclusion test
# ---------------------------------------------------------------------------

class TestWithdrawnDocExclusion:
    """Dense retriever must exclude docs with status='withdrawn'."""

    @requires_db
    def test_withdrawn_doc_excluded_from_dense(self, booted_service):
        """Set one doc to withdrawn; dense retriever should not return it."""
        client, qa_url = booted_service

        # Pick a known doc_id from qa
        with psycopg.connect(qa_url) as conn:
            row = conn.execute(
                "SELECT external_id FROM documents WHERE status='searchable' LIMIT 1"
            ).fetchone()
        assert row, "No searchable documents found in qa"
        withdrawn_ext_id = row[0]

        try:
            # Withdraw the document
            with psycopg.connect(qa_url) as conn:
                conn.execute(
                    "UPDATE documents SET status='withdrawn' WHERE external_id=%s",
                    (withdrawn_ext_id,),
                )
                conn.commit()

            # Run dense retrieval directly via PgVectorRetriever
            from llama_index.core.schema import QueryBundle
            from app.pg_store import PgVectorRetriever

            retriever = PgVectorRetriever(
                embed_model=_StubEmbedModel(),
                similarity_top_k=500,
            )
            results = retriever._retrieve(QueryBundle(query_str="transport decarbonization"))
            result_doc_ids = [r.node.metadata.get("doc_id") for r in results]

            assert withdrawn_ext_id not in result_doc_ids, (
                f"Withdrawn doc {withdrawn_ext_id!r} should not appear in dense results"
            )

        finally:
            # Always restore to searchable
            with psycopg.connect(qa_url) as conn:
                conn.execute(
                    "UPDATE documents SET status='searchable' WHERE external_id=%s",
                    (withdrawn_ext_id,),
                )
                conn.commit()

            # Verify restore
            with psycopg.connect(qa_url) as conn:
                status = conn.execute(
                    "SELECT status FROM documents WHERE external_id=%s",
                    (withdrawn_ext_id,),
                ).fetchone()[0]
            assert status == "searchable", "Failed to restore doc status to searchable"


# ---------------------------------------------------------------------------
# Translation-pair query-time filter (issue #325)
# ---------------------------------------------------------------------------

class TestTranslationPairsQueryFilter:
    """E2E: the real /query handler honors confirmed translation pairs (#325).

    The Task 10/11 filter logic is unit-tested via extracted copies in
    test_translation_pairs_filter.py; this exercises the real handler's filter
    placement and the real DB loader against a seeded confirmed edge. The flag
    is flipped by patching app.translation_pairs.get_settings (the loader reads
    get_settings().translation_pairs_enabled, not the module-level capture).
    """

    @requires_db
    def test_answer_excludes_translation_cite_collapses_to_original(
        self, booted_service, monkeypatch
    ):
        import app.translation_pairs as tp

        client, qa_url = booted_service

        # Pick two searchable docs: T = translation, O = original.
        with psycopg.connect(qa_url) as conn:
            rows = conn.execute(
                "SELECT external_id, id FROM documents WHERE status='searchable' "
                "ORDER BY external_id LIMIT 2"
            ).fetchall()
        assert len(rows) >= 2, "need two searchable docs"
        t_ext, t_id = rows[0]
        o_ext, o_id = rows[1]

        # Seed a confirmed translation_of edge T -> O.
        with psycopg.connect(qa_url) as conn:
            conn.execute(
                """INSERT INTO document_relations
                   (document_id, related_document_id, source, status, relation_type, signals)
                   VALUES (%s, %s, 'human', 'confirmed', 'translation_of', '{}')
                   ON CONFLICT DO NOTHING""",
                (t_id, o_id),
            )
            conn.commit()

        class _FlagOn:
            translation_pairs_enabled = True

        class _FlagOff:
            translation_pairs_enabled = False

        # rerank=False + wide top_k so the translation is actually retrieved
        # (otherwise the filter assertions are vacuous).
        payload = {
            "query": "transport",
            "max_results": 500,
            "fusion_top_k": 500,
            "rerank": False,
        }

        try:
            # Baseline (flag off): the translation must be retrievable, else the
            # filter assertions below are vacuous.
            monkeypatch.setattr(tp, "get_settings", lambda: _FlagOff())
            base_ans = client.post("/query", json={**payload, "mode": "answer"}).json()
            base_ans_ids = {d["doc_id"] for d in base_ans["docs"]}
            assert t_ext in base_ans_ids, (
                f"translation {t_ext!r} not retrieved with the flag off — test is vacuous"
            )

            # Flag on, answer mode: translation filtered out, original still present.
            monkeypatch.setattr(tp, "get_settings", lambda: _FlagOn())
            ans = client.post("/query", json={**payload, "mode": "answer"}).json()
            ans_ids = {d["doc_id"] for d in ans["docs"]}
            assert t_ext not in ans_ids, (
                "answer mode must exclude a confirmed translation's chunks"
            )
            assert o_ext in ans_ids, "the original must still be reachable"

            # Flag on, cite mode: the pair collapses to the original — the
            # translation never appears as a separate result.
            cite = client.post("/query", json={**payload, "mode": "cite"}).json()
            cite_ids = [d["doc_id"] for d in cite["docs"]]
            assert t_ext not in cite_ids, (
                "cite mode must not return the translation as a separate result"
            )
            assert o_ext in cite_ids, "cite mode must credit the pair to the original"

            # Flag off again (rollback): both appear as separate results.
            monkeypatch.setattr(tp, "get_settings", lambda: _FlagOff())
            restored = client.post("/query", json={**payload, "mode": "cite"}).json()
            restored_ids = {d["doc_id"] for d in restored["docs"]}
            assert t_ext in restored_ids and o_ext in restored_ids, (
                "flag off: current behavior (two separate results) must be restored"
            )
        finally:
            with psycopg.connect(qa_url) as conn:
                conn.execute(
                    "DELETE FROM document_relations WHERE document_id=%s AND related_document_id=%s",
                    (t_id, o_id),
                )
                conn.commit()
