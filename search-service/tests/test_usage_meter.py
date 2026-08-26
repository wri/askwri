"""Contract tests for the per-request dollar meter (app/usage_meter.py)."""
import contextvars

from app import usage_meter


def test_record_without_start_is_noop():
    """Worker processes (document embedding) share the paid-call modules but
    never start a ledger — recording there must cost nothing and crash nothing."""
    usage_meter.reset()
    usage_meter.record_tokens("embed:search_document", "cohere.embed-v4:0",
                              input_tokens=5000)
    assert usage_meter.summary() is None


def test_token_call_priced_from_table():
    usage_meter.start()
    # gpt-5-mini: $0.25/1M input, $2.00/1M output
    usage_meter.record_tokens("query_translation", "gpt-5-mini",
                              input_tokens=1_000_000, output_tokens=500_000)
    s = usage_meter.summary()
    assert s["total_usd"] == 1.25
    assert s["calls"][0]["call"] == "query_translation"
    assert s["calls"][0]["input_tokens"] == 1_000_000


def test_rerank_bills_one_query_per_100_documents():
    usage_meter.start()
    # cohere.rerank-v3-5: $2/1k queries; one billed query covers <=100 docs.
    usage_meter.record_rerank("rerank", "cohere.rerank-v3-5:0", documents=100)
    usage_meter.record_rerank("rerank", "cohere.rerank-v3-5:0", documents=150)
    s = usage_meter.summary()
    # 1 + 2 billed queries = 3 * $0.002
    assert s["total_usd"] == 0.006


def test_unknown_model_is_flagged_not_priced():
    """A config override to a model missing from the price table must show up
    as an unpriced call, never as a silent $0 that looks measured."""
    usage_meter.start()
    usage_meter.record_tokens("query_translation", "some-new-model",
                              input_tokens=1000)
    s = usage_meter.summary()
    assert s["total_usd"] == 0.0
    assert s["calls"][0]["unpriced"] is True


def test_ledger_visible_across_copied_context():
    """The lane ThreadPoolExecutor propagates via contextvars.copy_context —
    a record made inside the copied context must land in the request ledger."""
    usage_meter.start()
    ctx = contextvars.copy_context()
    ctx.run(usage_meter.record_tokens, "embed:search_query",
            "cohere.embed-v4:0", 250)
    s = usage_meter.summary()
    assert len(s["calls"]) == 1
    # embed-v4: $0.12/1M input tokens
    assert s["calls"][0]["usd"] == round(250 * 0.12 / 1_000_000, 6)
