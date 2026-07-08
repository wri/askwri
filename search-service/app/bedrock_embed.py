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
from typing import List

from app.config import get_settings

logger = logging.getLogger(__name__)

COHERE_EMBED_MODEL_NAME = "cohere-embed-v4"   # document_chunks.embedding_model value
COHERE_EMBED_DIMENSION = 1536
_MAX_TEXTS_PER_CALL = 96                       # Cohere embed API cap

_client = None
_client_lock = threading.Lock()


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
    payload = json.loads(response["body"].read())
    return payload["embeddings"]["float"]


def embed_documents(texts: List[str]) -> List[List[float]]:
    """Encode document chunks (input_type=search_document), batched at 96."""
    vectors: List[List[float]] = []
    for i in range(0, len(texts), _MAX_TEXTS_PER_CALL):
        vectors.extend(_invoke(texts[i:i + _MAX_TEXTS_PER_CALL], "search_document"))
    return vectors


def embed_query(text: str) -> List[float]:
    """Encode one query (input_type=search_query)."""
    return _invoke([text], "search_query")[0]


class BedrockCohereQueryEmbedding:
    """Adapter with the llama_index embed-model surface PgVectorRetriever uses."""

    def get_query_embedding(self, query: str) -> List[float]:
        return embed_query(query)
