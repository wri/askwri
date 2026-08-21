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

Region nuance (spec §5): infra is us-east-2; Rerank 3.5 is available in
us-east-1 (ACTIVE/ON_DEMAND as of 2026-07-22), us-west-2, ca-central, and
eu-central. The client targets settings.bedrock_rerank_region (us-east-1,
co-located with the cluster — ~35-55ms less than the earlier us-west-2
cross-continent hop) with an explicit endpoint_url — explicit because local
dev sets AWS_ENDPOINT_URL for MinIO (S3), which boto3 would otherwise apply
to Bedrock too.
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
                from app.bedrock_embed import _botocore_config

                _client = boto3.client(
                    "bedrock-agent-runtime",
                    region_name=region,
                    endpoint_url=f"https://bedrock-agent-runtime.{region}.amazonaws.com",
                    config=_botocore_config(),
                )
    return _client


class BedrockReranker:
    """Drop-in for the removed OnnxReranker: same postprocess_nodes surface
    (per-call top_n, no global mutation), scores from the Bedrock Rerank API.

    per_doc_cap: fused chunk lists cluster many chunks of the same top docs,
    so a plain top-N chunk cut can send only a handful of docs to the
    reranker (measured on the cite golden set: 100 chunks from 5 docs),
    capping doc-level recall. With a cap, candidate slots are filled in
    fusion order but each doc contributes at most `cap` chunks; leftover
    slots backfill in fusion order. Same slot count → same API cost/latency.
    Cite mode sets this (doc-level scoring); answer mode leaves it None
    (best chunks wherever they live).
    """

    def __init__(self, top_n: int = 20, per_doc_cap=None):
        self.top_n = top_n
        self.per_doc_cap = per_doc_cap
        settings = get_settings()
        self.model_name = settings.bedrock_rerank_model_id

    def _select_candidates(self, nodes, limit):
        if self.per_doc_cap is None:
            return nodes[:limit]
        per_doc = {}
        selected = []
        skipped = []
        for node in nodes:
            if len(selected) >= limit:
                break
            key = (node.node.metadata or {}).get("doc_id") or node.node.node_id
            if per_doc.get(key, 0) < self.per_doc_cap:
                per_doc[key] = per_doc.get(key, 0) + 1
                selected.append(node)
            else:
                skipped.append(node)
        if len(selected) < limit:
            selected.extend(skipped[: limit - len(selected)])
        return selected

    def _surface_flooding_best(self, candidates, nodes, query_bundle, limit):
        """Flood rerank (issue #353 d3): when one doc owns > flood_doc_share of
        the fused set, its rerank-best chunk often sits deep in fused order
        (d3: chunk_67 is the doc's #10 by fused rank, scores 0.553, while the
        top-2-by-fusion score 0.253/0.133). cap=2 admits only the top-2-by-fusion
        and the best chunk stays in `skipped` -> AP 25. Re-rank the flooding
        doc's top-K chunks and swap its rerank-best 2 into the window.

        Fires ONLY when a flood is detected (> threshold share of `nodes`),
        so normal queries pay no extra cost. Returns the (possibly modified)
        candidate list."""
        from collections import Counter
        settings = get_settings()
        share = settings.flood_doc_share
        k = settings.flood_rerank_k
        if not nodes or share <= 0 or k <= self.per_doc_cap:
            return candidates
        # doc_id -> chunk count over the FULL fused set (nodes), not the window
        counts = Counter((n.node.metadata or {}).get("doc_id") or n.node.node_id
                        for n in nodes)
        flooding = [d for d, c in counts.items() if c / len(nodes) > share]
        if not flooding:
            return candidates
        logger.info(f"Flood rerank: {len(flooding)} doc(s) >{share*100:.0f}% of fused set -> "
                    f"surfaceing rerank-best (k={k})")
        client = get_client()
        model_arn = (f"arn:aws:bedrock:{settings.bedrock_rerank_region}::"
                     f"foundation-model/{settings.bedrock_rerank_model_id}")
        for doc_id in flooding:
            # collect the doc's chunks from the full fused set, in fused order
            doc_chunks = [n for n in nodes
                          if ((n.node.metadata or {}).get("doc_id") or n.node.node_id) == doc_id]
            pool = doc_chunks[:k]  # top-K by fused order (admits the deep best chunk)
            if len(pool) <= self.per_doc_cap:
                continue  # nothing deep to surface
            body = [{"type": "INLINE", "inlineDocumentSource": {
                "type": "TEXT", "textDocument": {"text": n.node.get_content()}}}
                for n in pool]
            try:
                resp = client.rerank(
                    queries=[{"type": "TEXT", "textQuery": {"text": query_bundle.query_str}}],
                    sources=body,
                    rerankingConfiguration={"type": "BEDROCK_RERANKING_MODEL",
                        "bedrockRerankingConfiguration": {
                            "modelConfiguration": {"modelArn": model_arn},
                            "numberOfResults": len(pool)}},
                )
            except Exception as exc:  # noqa: BLE001 — flood rerank is advisory
                logger.warning(f"Flood rerank failed for {doc_id}: {exc}")
                continue
            # best-2 of the flood rerank
            ranked = sorted(resp["results"], key=lambda r: r["relevanceScore"], reverse=True)
            best_ids = {pool[r["index"]].node.node_id for r in ranked[:self.per_doc_cap]}
            # replace the flooding doc's windowed chunks with its flood-best
            new_candidates = [n for n in candidates
                              if ((n.node.metadata or {}).get("doc_id") or n.node.node_id) != doc_id
                              or n.node.node_id in best_ids]
            # ensure best_ids present (add any not already in window)
            in_best = {n.node.node_id for n in new_candidates}
            for n in pool:
                if n.node.node_id in best_ids and n.node.node_id not in in_best:
                    new_candidates.append(n)
            candidates = new_candidates
            # keep window size bounded (re-cap per-doc in case best_ids overshot)
            if len(candidates) > limit:
                candidates = candidates[:limit]
        return candidates

    def postprocess_nodes(self, nodes, query_bundle, top_n=None):
        if not nodes:
            return []
        if query_bundle is None:
            return nodes

        settings = get_settings()
        effective_top_n = top_n if top_n is not None else self.top_n
        candidates = self._select_candidates(nodes, settings.rerank_candidates)
        # Flood rerank: surface a flooding doc's rerank-best chunk (issue #353 d3).
        # Advisory + fires only on floods; no-op when no doc exceeds the share.
        if query_bundle is not None and self.per_doc_cap is not None:
            candidates = self._surface_flooding_best(
                candidates, nodes, query_bundle, settings.rerank_candidates)

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
