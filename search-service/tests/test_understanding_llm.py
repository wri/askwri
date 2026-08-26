"""P3 LLM understanding sidecar (design 2026-08-19 §4.1, §5, §7).

Strict validation reuses the pydantic Facet model: an unknown facet name or
out-of-range confidence rejects the WHOLE object (design §5), never
half-applied. One attempt, lru_cached, failure-soft (returns None on any
failure; the caller records `understanding.degraded`).
"""
import json

import pytest

import app.understanding_llm as ullm


class _Resp:
    """Mimics openai ChatCompletion: .choices[0].message.content / .finish_reason."""

    def __init__(self, content, finish_reason="stop"):
        msg = type("M", (), {"content": content})()
        self.choices = [type("C", (), {"message": msg, "finish_reason": finish_reason})()]


class _FakeClient:
    """Mimics openai.OpenAI(...): .chat.completions.create(**kw) -> _Resp."""

    def __init__(self, create):
        class _Completions:
            def __init__(self, create): self._create = create
            def create(self, **kw): return self._create(**kw)
        completions = _Completions(create)
        self.chat = type("Chat", (), {"completions": completions})()


def _patch_openai(monkeypatch, *, content=None, raises=None):
    """Patch openai.OpenAI to a factory returning a fake client. Returns the
    create-callable so tests can assert call count."""
    state = {"calls": 0}

    def _create(**kw):
        state["calls"] += 1
        if raises:
            raise raises
        return _Resp(content)

    monkeypatch.setattr("openai.OpenAI", lambda **kw: _FakeClient(_create))
    return state


@pytest.fixture(autouse=True)
def _clear_cache():
    ullm.build_understanding_llm.cache_clear()
    yield
    ullm.build_understanding_llm.cache_clear()


def test_valid_output_merges_with_suggest_facets(monkeypatch):
    """A valid LLM response returns intent, facets (source=llm, action=suggest),
    variants (capped at 2), disambiguation."""
    body = json.dumps({
        "intent": "catalog",
        "facets": [{"facet": "year_min", "value": "2022", "confidence": 0.8}],
        "variants": ["hydrogen fuel", "H2", "fuel cells"],
        "disambiguation": ["hydrogen for transport", "hydrogen for industry"],
    })
    state = _patch_openai(monkeypatch, content=body)
    out = ullm.build_understanding_llm("hydrogen since 2022")
    assert out is not None
    assert out["intent"] == "catalog"
    assert len(out["facets"]) == 1
    f = out["facets"][0]
    assert f.facet == "year_min" and f.value == "2022" and f.confidence == 0.8
    assert f.source == "llm" and f.action == "suggest"
    # variants capped at 2 (design §4.1)
    assert out["variants"] == ["hydrogen fuel", "H2"]
    assert out["disambiguation"] == ["hydrogen for transport", "hydrogen for industry"]
    assert state["calls"] == 1


def test_unknown_facet_name_rejects_whole(monkeypatch):
    """Design §5: an unknown facet name rejects the whole object (None)."""
    body = json.dumps({"facets": [{"facet": "vibe", "value": "good", "confidence": 0.9}]})
    _patch_openai(monkeypatch, content=body)
    assert ullm.build_understanding_llm("anything") is None


def test_out_of_range_confidence_rejects_whole(monkeypatch):
    """Design §5: out-of-range confidence rejects the whole object."""
    body = json.dumps(
        {"facets": [{"facet": "language", "value": "es", "confidence": 1.7}]}
    )
    _patch_openai(monkeypatch, content=body)
    assert ullm.build_understanding_llm("anything") is None


def test_timeout_returns_none(monkeypatch):
    """A timeout degrades to None (caller records degraded), never 500s."""
    import openai

    _patch_openai(monkeypatch, raises=openai.APITimeoutError("timeout"))
    assert ullm.build_understanding_llm("anything") is None


def test_non_json_returns_none(monkeypatch):
    _patch_openai(monkeypatch, content="not json at all")
    assert ullm.build_understanding_llm("anything") is None


def test_empty_content_returns_none(monkeypatch):
    _patch_openai(monkeypatch, content=None)
    assert ullm.build_understanding_llm("anything") is None


def test_lru_cache_hits_one_openai_call(monkeypatch):
    """Repeat query skips the LLM hop entirely (design §4.1; mirrors
    query_translate's lru_cache)."""
    body = json.dumps({"intent": "topical", "facets": [], "variants": [], "disambiguation": []})
    state = _patch_openai(monkeypatch, content=body)
    ullm.build_understanding_llm("same query")
    ullm.build_understanding_llm("same query")
    assert state["calls"] == 1


def test_invalid_intent_coerced_to_none(monkeypatch):
    """A bad intent label doesn't reject the whole object — the caller keeps
    the deterministic tier's default (topical). Only facets are strict."""
    body = json.dumps({"intent": "vibe", "facets": [], "variants": [], "disambiguation": []})
    _patch_openai(monkeypatch, content=body)
    out = ullm.build_understanding_llm("anything")
    assert out is not None
    assert out["intent"] is None


def test_llm_call_uses_temperature_zero_for_determinism(monkeypatch):
    """Determinism: the sidecar must call the model with temperature=0 so the
    same query yields the same variants/facets/intent every call (the lru_cache
    then freezes a stable result). Nondeterministic output + cache made
    retrieval quality a per-deploy lottery (2026-08-26)."""
    body = json.dumps({"intent": "topical", "facets": [], "variants": [], "disambiguation": []})
    state = _patch_openai(monkeypatch, content=body)
    ullm.build_understanding_llm.cache_clear()
    ullm.build_understanding_llm("deterministic probe")
    assert state["calls"] == 1
    # capture the kwargs the create call received — we can't from the current
    # _patch_openai shape, so assert via the module-level call by re-patching
    # to record kwargs.
    seen = {}
    def _create_recording(**kw):
        seen.update(kw)
        return _Resp(body)
    monkeypatch.setattr("openai.OpenAI", lambda **kw: _FakeClient(_create_recording))
    ullm.build_understanding_llm.cache_clear()
    ullm.build_understanding_llm("deterministic probe 2")
    assert seen.get("temperature") == 0, f"expected temperature=0, got {seen.get('temperature')}"


def test_llm_core_topic_extracted(monkeypatch):
    """Slice 6: the LLM sidecar extracts core_topic (the query's core noun
    phrase) for the corpus-coverage abstain check. Reuses the same call — no
    extra latency."""
    body = json.dumps({
        "intent": "binary_presence",
        "facets": [], "variants": [], "disambiguation": [],
        "core_topic": "nuclear microreactors",
    })
    state = _patch_openai(monkeypatch, content=body)
    out = ullm.build_understanding_llm("Has WRI published research on nuclear microreactors")
    assert out is not None
    assert out["core_topic"] == "nuclear microreactors"


def test_llm_core_topic_none_when_missing_or_blank(monkeypatch):
    """core_topic is None when the LLM omits it or returns blank — the abstain
    gate can't fire (failure-soft → today's behavior)."""
    for c in ["{}", json.dumps({"intent": "topical", "core_topic": "  "}),
              json.dumps({"intent": "topical", "core_topic": 5})]:
        state = _patch_openai(monkeypatch, content=c)
        ullm.build_understanding_llm.cache_clear()
        out = ullm.build_understanding_llm("anything")
        assert out is not None
        assert out["core_topic"] is None
