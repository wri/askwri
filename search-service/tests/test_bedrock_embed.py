"""v3 B1 (spec §10): dense lane swaps to Cohere embed-v4 via AWS Bedrock.

Config-driven model selection; the provider is a thin Bedrock API client —
NO self-hosted models (spec §0.1). Sparse lane is untouched. boto3 is
stubbed; no AWS calls happen here.
"""
import json

import pytest

from app.config import get_settings


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


# --- config ---------------------------------------------------------------

def test_embedding_model_defaults_to_cohere_embed_v4(monkeypatch):
    monkeypatch.delenv("EMBEDDING_MODEL", raising=False)
    settings = get_settings()
    assert settings.embedding_model == "cohere-embed-v4"
    assert settings.embedding_dimension == 1536


def test_embedding_model_rollback_to_openai(monkeypatch):
    """3-small rows/index stay until cutover is validated — the old model
    must remain selectable for rollback."""
    monkeypatch.setenv("EMBEDDING_MODEL", "text-embedding-3-small")
    settings = get_settings()
    assert settings.embedding_model == "text-embedding-3-small"
    assert settings.embedding_dimension == 1536


def test_bedrock_embed_settings_defaults(monkeypatch):
    for var in ("BEDROCK_EMBED_REGION", "BEDROCK_EMBED_MODEL_ID"):
        monkeypatch.delenv(var, raising=False)
    settings = get_settings()
    # infra is us-east-2; embed-v4 lives in us-east-1 (spec §5 region nuance)
    assert settings.bedrock_embed_region == "us-east-1"
    assert settings.bedrock_embed_model_id == "cohere.embed-v4:0"


# --- provider -------------------------------------------------------------

class _StubBedrockClient:
    """Records InvokeModel calls; returns one 1536-d vector per input text."""

    def __init__(self):
        self.calls = []

    def invoke_model(self, modelId, body, **kw):
        payload = json.loads(body)
        self.calls.append({"modelId": modelId, "body": payload})
        n = len(payload["texts"])
        return {
            "body": _StubStream(json.dumps(
                {"embeddings": {"float": [[0.5] * 1536 for _ in range(n)]}}
            ))
        }


class _StubStream:
    def __init__(self, payload):
        self._payload = payload

    def read(self):
        return self._payload


def test_embed_documents_batches_at_96(monkeypatch):
    import app.bedrock_embed as be

    stub = _StubBedrockClient()
    monkeypatch.setattr(be, "get_client", lambda: stub)

    texts = [f"text {i}" for i in range(100)]
    vectors = be.embed_documents(texts)

    assert len(vectors) == 100
    assert len(vectors[0]) == 1536
    # Cohere embed caps at 96 texts per call
    assert [len(c["body"]["texts"]) for c in stub.calls] == [96, 4]
    assert all(c["body"]["input_type"] == "search_document" for c in stub.calls)


def test_embed_query_uses_search_query_input_type(monkeypatch):
    import app.bedrock_embed as be

    stub = _StubBedrockClient()
    monkeypatch.setattr(be, "get_client", lambda: stub)

    vec = be.embed_query("株洲完整街道设计指南")

    assert len(vec) == 1536
    assert stub.calls[0]["body"]["input_type"] == "search_query"
    assert stub.calls[0]["body"]["texts"] == ["株洲完整街道设计指南"]


def test_query_embedding_adapter_matches_llamaindex_interface(monkeypatch):
    """PgVectorRetriever calls embed_model.get_query_embedding(str)."""
    import app.bedrock_embed as be

    stub = _StubBedrockClient()
    monkeypatch.setattr(be, "get_client", lambda: stub)

    adapter = be.BedrockCohereQueryEmbedding()
    assert len(adapter.get_query_embedding("some query")) == 1536


def test_model_name_constant():
    import app.bedrock_embed as be

    # document_chunks.embedding_model value (spec §8.1)
    assert be.COHERE_EMBED_MODEL_NAME == "cohere-embed-v4"
    assert be.COHERE_EMBED_DIMENSION == 1536
