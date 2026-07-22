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
    from app.config import Settings

    monkeypatch.delenv("EMBEDDING_MODEL", raising=False)
    # _env_file=None: local .env.local pins EMBEDDING_MODEL until the
    # re-embed cutover; this asserts the shipped DEFAULT, not the local pin.
    settings = Settings(_env_file=None)
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


def test_embed_documents_batch_size_configurable(monkeypatch):
    """Bulk jobs (worker embed stage, re-embeds) must be able to shrink the
    per-call burst: 96-chunk bursts blow the Bedrock tokens/min bucket on
    large docs and error whole jobs (Phase 1 re-ingest, 2026-07-22). The
    default stays 96 (the Cohere API cap); BEDROCK_EMBED_BATCH_SIZE lowers
    it, values above 96 are clamped to the API cap."""
    from app.config import get_settings
    import app.bedrock_embed as be

    stub = _StubBedrockClient()
    monkeypatch.setattr(be, "get_client", lambda: stub)
    monkeypatch.setenv("BEDROCK_EMBED_BATCH_SIZE", "24")
    get_settings.cache_clear()

    vectors = be.embed_documents([f"text {i}" for i in range(50)])
    assert len(vectors) == 50
    assert [len(c["body"]["texts"]) for c in stub.calls] == [24, 24, 2]

    stub.calls.clear()
    monkeypatch.setenv("BEDROCK_EMBED_BATCH_SIZE", "500")
    get_settings.cache_clear()
    be.embed_documents([f"text {i}" for i in range(100)])
    assert [len(c["body"]["texts"]) for c in stub.calls] == [96, 4]
    get_settings.cache_clear()


def test_client_config_has_tuned_timeouts_and_env_retry_override(monkeypatch):
    """L0 latency: default botocore config means a stalled embed blocks a
    request up to 60s before the sparse-only fallback can trigger. The
    client passes tuned timeouts + standard/2 retries; AWS_RETRY_MODE /
    AWS_MAX_ATTEMPTS env (bulk-job pacing) still wins when set."""
    import app.bedrock_embed as be

    captured = {}

    class _FakeBoto3:
        @staticmethod
        def client(name, **kw):
            captured.update(kw)
            return object()

    monkeypatch.setitem(__import__("sys").modules, "boto3", _FakeBoto3)
    monkeypatch.delenv("AWS_RETRY_MODE", raising=False)
    monkeypatch.delenv("AWS_MAX_ATTEMPTS", raising=False)
    be._client = None
    be.get_client()
    cfg = captured["config"]
    assert cfg.connect_timeout == 2
    assert cfg.read_timeout == 10
    assert cfg.retries == {"mode": "standard", "max_attempts": 2}

    captured.clear()
    monkeypatch.setenv("AWS_RETRY_MODE", "adaptive")
    monkeypatch.setenv("AWS_MAX_ATTEMPTS", "10")
    be._client = None
    be.get_client()
    assert captured["config"].retries == {"mode": "adaptive", "max_attempts": 10}
    be._client = None


def test_embed_query_lru_caches_repeat_queries(monkeypatch):
    """L0 latency: repeat queries (re-searches, eval loops) skip the
    ~50-130ms Bedrock embed hop. Cache returns a fresh list per call so
    callers can't mutate the cached vector."""
    import app.bedrock_embed as be

    stub = _StubBedrockClient()
    monkeypatch.setattr(be, "get_client", lambda: stub)
    be._embed_query_cached.cache_clear()

    v1 = be.embed_query("repeated query")
    v2 = be.embed_query("repeated query")
    assert v1 == v2
    assert v1 is not v2  # fresh list, not the cached object
    assert len(stub.calls) == 1  # second call served from cache
    be._embed_query_cached.cache_clear()


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
