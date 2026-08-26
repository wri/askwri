"""Per-request dollar metering for the paid hops in the query path.

The /query pipeline pays four external APIs: query translation and the LLM
understanding sidecar (OpenAI), query embedding (Bedrock Cohere embed-v4),
and reranking (Bedrock Cohere Rerank 3.5). None go through LlamaIndex, so
its token counting can't see them; each call site records its own usage here
instead, and the /query handler folds the ledger into the response's `usage`
field. run-evalset.ts sums those dollars into the eval report.

The ledger is a contextvar holding a plain list, set once per request by
start(). asyncio.to_thread propagates it automatically; the lane
ThreadPoolExecutor in HybridFusionRetriever._retrieve propagates it via
contextvars.copy_context (the list object is shared, so child-context appends
land in the request ledger). With no ledger started — worker document
embedding, tag builds — recording is a no-op, so shared modules stay free.

Recording sits INSIDE the lru_cached call bodies on purpose: a cache hit
makes no API call, records nothing, and correctly reports $0.
"""
import contextvars
import math
from typing import Any, Dict, List, Optional

# USD per 1M tokens (input, output). Verified 2026-08-26 against:
#   https://pricepertoken.com/pricing-page/model/openai-gpt-5-mini
#   https://pricepertoken.com/pricing-page/model/openai-gpt-5.4-mini
#   https://caylent.com/blog/amazon-bedrock-pricing-explained (Cohere on Bedrock)
# Update this table when a priced model in config.py changes, re-verifying
# against those pages. A model missing here still works — its calls report
# "unpriced": true in usage.calls, so a missed update is visible in the next
# eval report rather than a silent $0.
_TOKEN_PRICES = {
    "gpt-5-mini": (0.25, 2.00),        # query_translation_model
    "gpt-5.4-mini": (0.75, 4.50),      # query_understanding_llm_model
    "cohere.embed-v4:0": (0.12, 0.0),  # bedrock_embed_model_id
}

# USD per 1,000 billed queries. One billed query covers up to 100 documents;
# larger candidate sets bill multiple queries per API call.
_RERANK_PRICES = {
    "cohere.rerank-v3-5:0": 2.00,      # bedrock_rerank_model_id
}
_RERANK_DOCS_PER_QUERY = 100

_ledger: contextvars.ContextVar[Optional[List[Dict[str, Any]]]] = (
    contextvars.ContextVar("usage_ledger", default=None)
)


def start() -> None:
    """Open a fresh ledger for the current request."""
    _ledger.set([])


def reset() -> None:
    """Drop any ledger in the current context (tests)."""
    _ledger.set(None)


def _append(entry: Dict[str, Any], usd: Optional[float]) -> None:
    ledger = _ledger.get()
    if ledger is None:
        return
    if usd is None:
        # A model missing from the price table must be visible in the report,
        # never a silent $0 that looks measured.
        entry["usd"] = 0.0
        entry["unpriced"] = True
    else:
        entry["usd"] = round(usd, 6)
    ledger.append(entry)


def record_tokens(call: str, model: str,
                  input_tokens: int, output_tokens: int = 0) -> None:
    prices = _TOKEN_PRICES.get(model)
    usd = None
    if prices is not None:
        usd = (input_tokens * prices[0] + output_tokens * prices[1]) / 1_000_000
    _append({"call": call, "model": model,
             "input_tokens": input_tokens, "output_tokens": output_tokens}, usd)


def record_rerank(call: str, model: str, documents: int) -> None:
    price = _RERANK_PRICES.get(model)
    billed_queries = max(1, math.ceil(documents / _RERANK_DOCS_PER_QUERY))
    usd = None if price is None else billed_queries * price / 1_000
    _append({"call": call, "model": model, "documents": documents,
             "billed_queries": billed_queries}, usd)


def summary() -> Optional[Dict[str, Any]]:
    """{"calls": [...], "total_usd": ...} for the current request, or None if
    no ledger was started. An empty calls list is meaningful: every paid hop
    was an in-process cache hit."""
    ledger = _ledger.get()
    if ledger is None:
        return None
    return {
        "calls": list(ledger),
        "total_usd": round(sum(e["usd"] for e in ledger), 6),
    }
