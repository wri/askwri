"""Cohere Rerank 3.5 via AWS Bedrock — the v3 rerank lane (spec §4/§5).

Replaces the in-process ms-marco cross-encoder for BOTH cite and answer
modes: a thin bedrock-agent-runtime Rerank API client, no self-hosted model.
Scores are 0-1 relevance (NOT logits) — the cite floor/tiers in config.py
are on that scale.

Cost/latency scale with document count (spec §9: rerank is the dominant
hop), so only the top settings.rerank_candidates fused candidates are sent.
The un-reranked tail is DROPPED rather than passed through — RRF scores and
0-1 relevance scores must never mix in one ranked list, or the floor/tiers
downstream become meaningless.

Region nuance (spec §5): infra is us-east-2; Rerank 3.5 is hosted in
us-west-2/ca-central/eu-central. The client targets
settings.bedrock_rerank_region with an explicit endpoint_url — explicit
because local dev sets AWS_ENDPOINT_URL for MinIO (S3), which boto3 would
otherwise apply to Bedrock too.
"""
import logging
import threading

from app.config import get_settings

logger = logging.getLogger(__name__)

_client = None
_client_lock = threading.Lock()


def get_client():
    """Lazy singleton bedrock-agent-runtime client pinned to the rerank region."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                import boto3

                region = get_settings().bedrock_rerank_region
                _client = boto3.client(
                    "bedrock-agent-runtime",
                    region_name=region,
                    endpoint_url=f"https://bedrock-agent-runtime.{region}.amazonaws.com",
                )
    return _client


class BedrockReranker:
    """Drop-in for the removed OnnxReranker: same postprocess_nodes surface
    (per-call top_n, no global mutation), scores from the Bedrock Rerank API.
    """

    def __init__(self, top_n: int = 20):
        self.top_n = top_n
        settings = get_settings()
        self.model_name = settings.bedrock_rerank_model_id

    def postprocess_nodes(self, nodes, query_bundle, top_n=None):
        if not nodes:
            return []
        if query_bundle is None:
            return nodes

        settings = get_settings()
        effective_top_n = top_n if top_n is not None else self.top_n
        candidates = nodes[: settings.rerank_candidates]

        model_arn = (f"arn:aws:bedrock:{settings.bedrock_rerank_region}::"
                     f"foundation-model/{settings.bedrock_rerank_model_id}")
        response = get_client().rerank(
            queries=[{"type": "TEXT",
                      "textQuery": {"text": query_bundle.query_str}}],
            sources=[
                {"type": "INLINE",
                 "inlineDocumentSource": {
                     "type": "TEXT",
                     "textDocument": {"text": node.node.get_content()},
                 }}
                for node in candidates
            ],
            rerankingConfiguration={
                "type": "BEDROCK_RERANKING_MODEL",
                "bedrockRerankingConfiguration": {
                    "modelConfiguration": {"modelArn": model_arn},
                    "numberOfResults": len(candidates),
                },
            },
        )

        for result in response["results"]:
            candidates[result["index"]].score = float(result["relevanceScore"])

        candidates.sort(key=lambda n: n.score, reverse=True)
        return candidates[:effective_top_n]
