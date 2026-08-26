"""Cohere embed-v4 via AWS Bedrock — the v3 dense lane (spec §4/§5).

A thin API client shared by the worker embed stage (document encoding) and
the query-side dense retriever (query encoding). NO self-hosted model: the
search-service stays model-free and calls Bedrock + Postgres.

Region nuance (spec §5): infra runs in us-east-2; embed-v4 is hosted in
us-east-1/eu/tokyo. The client targets settings.bedrock_embed_region with an
explicit endpoint_url — explicit because local dev sets AWS_ENDPOINT_URL for
MinIO (S3), which boto3 would otherwise apply to Bedrock too.
"""
import json
import logging
import threading
from functools import lru_cache
from typing import List

from app import usage_meter
from app.config import get_settings

logger = logging.getLogger(__name__)

COHERE_EMBED_MODEL_NAME = "cohere-embed-v4"   # document_chunks.embedding_model value
COHERE_EMBED_DIMENSION = 1536
_MAX_TEXTS_PER_CALL = 96                       # Cohere embed API cap


def _batch_size() -> int:
    """Per-call batch for bulk document embeds. 96-text bursts blow the
    Bedrock tokens/min bucket on large docs (whole worker jobs errored on
    ThrottlingException, 2026-07-22) — BEDROCK_EMBED_BATCH_SIZE lowers the
    burst; the Cohere API cap (96) is the ceiling."""
    return max(1, min(get_settings().bedrock_embed_batch_size,
                      _MAX_TEXTS_PER_CALL))

_client = None
_client_lock = threading.Lock()


def _botocore_config():
    """Tuned timeouts + retries (L0 latency): botocore defaults are 60s
    read timeouts and legacy retries — a stalled call blocks a /query up
    to a minute before the degradation paths can trigger. Bulk jobs
    (re-embed, worker drains) still control pacing via AWS_RETRY_MODE /
    AWS_MAX_ATTEMPTS env, which take precedence when set."""
    import os

    from botocore.config import Config

    mode = os.environ.get("AWS_RETRY_MODE", "standard")
    attempts = int(os.environ.get("AWS_MAX_ATTEMPTS", "2"))
    return Config(connect_timeout=2, read_timeout=10,
                  retries={"mode": mode, "max_attempts": attempts},
                  max_pool_connections=10)


def get_client():
    """Lazy singleton bedrock-runtime client pinned to the embed region."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                import boto3

                region = get_settings().bedrock_embed_region
                _client = boto3.client(
                    "bedrock-runtime",
                    region_name=region,
                    endpoint_url=f"https://bedrock-runtime.{region}.amazonaws.com",
                    config=_botocore_config(),
                )
    return _client


def _invoke(texts: List[str], input_type: str) -> List[List[float]]:
    settings = get_settings()
    body = json.dumps({
        "texts": texts,
        "input_type": input_type,
        "truncate": "END",
        "embedding_types": ["float"],
    })
    response = get_client().invoke_model(
        modelId=settings.bedrock_embed_model_id, body=body,
    )
    # Billed tokens come back in a Bedrock response header, not the Cohere
    # payload. A missing header records 0 tokens — visible in usage.calls
    # rather than silently absent.
    headers = response.get("ResponseMetadata", {}).get("HTTPHeaders", {})
    usage_meter.record_tokens(
        f"embed:{input_type}", settings.bedrock_embed_model_id,
        input_tokens=int(headers.get("x-amzn-bedrock-input-token-count") or 0),
    )
    payload = json.loads(response["body"].read())
    return payload["embeddings"]["float"]


def embed_documents(texts: List[str]) -> List[List[float]]:
    """Encode document chunks (input_type=search_document), batched at 96."""
    vectors: List[List[float]] = []
    step = _batch_size()
    for i in range(0, len(texts), step):
        vectors.extend(_invoke(texts[i:i + step], "search_document"))
    return vectors


@lru_cache(maxsize=256)
def _embed_query_cached(text: str) -> tuple:
    return tuple(_invoke([text], "search_query")[0])


def embed_query(text: str) -> List[float]:
    """Encode one query (input_type=search_query). LRU-cached (L0 latency):
    repeat queries — re-searches, eval loops — skip the Bedrock hop.
    Returns a fresh list so callers can't mutate the cached vector."""
    return list(_embed_query_cached(text))


def embed_one(text: str) -> List[float]:
    """Encode a single text as a search document (for tag embeddings).

    Uses input_type=search_document (not search_query like embed_query) so
    tag embeddings match the same input_type as document chunks, making
    doc↔tag cosine similarity meaningful. Not cached — tag embedding builds
    are infrequent and always replace the prior vector."""
    return _invoke([text], "search_document")[0]


class BedrockCohereQueryEmbedding:
    """Adapter with the llama_index embed-model surface PgVectorRetriever uses."""

    def get_query_embedding(self, query: str) -> List[float]:
        return embed_query(query)
