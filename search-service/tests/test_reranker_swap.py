"""Phase B1 (multilingual spec §8): rerankers swap ms-marco → bge-reranker-v2-m3.

The current cite reranker is hardcoded in main.py (English-only ms-marco L-6)
and its English-calibrated -9.0 logit floor silently drops zh docs in cite
mode. Both mode rerankers become config-driven and default to the
multilingual BAAI/bge-reranker-v2-m3; floor/tier defaults are recalibrated
for the new model (conservative until the golden set lands).

No model download happens here — init_rerankers is tested with the loader
classes stubbed out.
"""
import pytest

from app.config import get_settings

# Bind the real function at collection time: test_query_e2e's session-scoped
# fixture replaces app.main.init_rerankers with a stub and only restores it at
# session teardown, so `main.init_rerankers` is not trustworthy mid-session.
from app.main import init_rerankers as real_init_rerankers


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_reranker_models_default_to_bge_reranker_v2_m3(monkeypatch):
    monkeypatch.delenv("ANSWER_RERANKER_MODEL", raising=False)
    monkeypatch.delenv("CITE_RERANKER_MODEL", raising=False)
    settings = get_settings()
    assert settings.answer_reranker_model == "BAAI/bge-reranker-v2-m3"
    assert settings.cite_reranker_model == "BAAI/bge-reranker-v2-m3"


def test_cite_floor_and_tiers_recalibrated_for_bge_reranker(monkeypatch):
    """Floor/tiers are model-specific. The ms-marco values (-9.0/-2.3/-7.8)
    sit inside bge-reranker-v2-m3's DISTRACTOR score range (p50=-8.5) and
    would pass nearly the whole corpus. Recalibrated 2026-07-07 on the
    non-English smoke set + en probes against the local corpus:
    relevant per-doc max 0.05..7.4, distractor p90=-5.3."""
    for var in ("CITE_LOGIT_FLOOR", "CITE_STRONG_THRESHOLD", "CITE_PARTIAL_THRESHOLD"):
        monkeypatch.delenv(var, raising=False)
    settings = get_settings()
    assert settings.cite_logit_floor == -5.0
    assert settings.cite_partial_threshold == 0.0
    assert settings.cite_strong_threshold == 4.0


def test_cite_reranker_model_overridable_from_env(monkeypatch):
    monkeypatch.setenv("CITE_RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")
    settings = get_settings()
    assert settings.cite_reranker_model == "cross-encoder/ms-marco-MiniLM-L-6-v2"


def test_onnx_reranker_forces_raw_logit_activation(monkeypatch):
    """The cite floor/tiers (cite_logit_floor et al.) operate on RAW logits.

    sentence-transformers >=4 applies the model's default activation in
    predict(); bge-reranker-v2-m3 defaults to sigmoid, which squashes scores
    into [0,1] and saturates ranking ties at 1.0 for strong matches.
    OnnxReranker must pin activation to identity so scores stay logits for
    every model.
    """
    import torch

    import app.main as main

    captured = {}

    class _FakeCrossEncoder:
        def __init__(self, model, backend="onnx", activation_fn=None, **kwargs):
            captured["activation_fn"] = activation_fn

    import sentence_transformers

    monkeypatch.setattr(sentence_transformers, "CrossEncoder", _FakeCrossEncoder)

    main.OnnxReranker(model="test/model", top_n=5, backend="onnx")

    activation_fn = captured["activation_fn"]
    assert activation_fn is not None, "activation_fn must be pinned, not model default"
    t = torch.tensor([-9.0, 0.0, 7.3])
    assert torch.equal(activation_fn(t), t), "activation must be identity (raw logits)"


def test_onnx_reranker_loads_from_local_onnx_dir_when_configured(monkeypatch):
    """Fargate serves a pre-exported int8-quantized ONNX model from a local
    dir (the fp32 ONNX export of bge-reranker-v2-m3 is >2GB and hits the
    onnxruntime external-data limitation when exported on the fly).
    When reranker_onnx_dir is set, OnnxReranker must load from it with the
    configured file_name instead of the HF model id.
    """
    import app.main as main

    captured = {}

    class _FakeCrossEncoder:
        def __init__(self, model, backend="onnx", activation_fn=None, model_kwargs=None, **kw):
            captured.update(model=model, backend=backend, model_kwargs=model_kwargs)

    import sentence_transformers

    monkeypatch.setattr(sentence_transformers, "CrossEncoder", _FakeCrossEncoder)
    monkeypatch.setattr(main.settings, "reranker_onnx_dir", "/opt/models/bge-reranker-v2-m3-onnx")
    monkeypatch.setattr(main.settings, "reranker_onnx_file", "model_quantized.onnx")

    main.OnnxReranker(model="BAAI/bge-reranker-v2-m3", top_n=5, backend="onnx")

    assert captured["model"] == "/opt/models/bge-reranker-v2-m3-onnx"
    assert captured["model_kwargs"] == {"file_name": "model_quantized.onnx"}
    assert captured["backend"] == "onnx"


def test_onnx_reranker_ignores_local_dir_for_torch_backend(monkeypatch):
    """Local dev (torch) loads by HF model id even if the dir var is set
    (e.g. via a shared .env)."""
    import app.main as main

    captured = {}

    class _FakeCrossEncoder:
        def __init__(self, model, backend="onnx", activation_fn=None, model_kwargs=None, **kw):
            captured.update(model=model, backend=backend, model_kwargs=model_kwargs)

    import sentence_transformers

    monkeypatch.setattr(sentence_transformers, "CrossEncoder", _FakeCrossEncoder)
    monkeypatch.setattr(main.settings, "reranker_onnx_dir", "/opt/models/bge-reranker-v2-m3-onnx")

    main.OnnxReranker(model="BAAI/bge-reranker-v2-m3", top_n=5, backend="torch")

    assert captured["model"] == "BAAI/bge-reranker-v2-m3"
    assert captured["model_kwargs"] is None


def test_init_rerankers_uses_configured_models_onnx(monkeypatch):
    """init_rerankers must build BOTH rerankers from settings, not hardcodes."""
    import app.main as main

    built = []

    class _FakeOnnxReranker:
        def __init__(self, model, top_n=20, backend="onnx"):
            built.append({"model": model, "top_n": top_n, "backend": backend})

    monkeypatch.setattr(main, "OnnxReranker", _FakeOnnxReranker)
    monkeypatch.setattr(main.settings, "reranker_backend", "onnx")
    monkeypatch.setattr(main.settings, "answer_reranker_model", "test/answer-model")
    monkeypatch.setattr(main.settings, "cite_reranker_model", "test/cite-model")

    real_init_rerankers()

    assert built[0]["model"] == "test/answer-model"
    assert built[0]["top_n"] == 20
    assert built[1]["model"] == "test/cite-model"
    assert built[1]["top_n"] == 1000


def test_init_rerankers_torch_backend_uses_same_loader(monkeypatch):
    """Both backends go through OnnxReranker (which pins identity activation
    and takes per-call top_n) so score semantics never diverge between local
    torch dev and Fargate onnx."""
    import app.main as main

    built = []

    class _FakeOnnxReranker:
        def __init__(self, model, top_n=20, backend="onnx"):
            built.append({"model": model, "top_n": top_n, "backend": backend})

    monkeypatch.setattr(main, "OnnxReranker", _FakeOnnxReranker)
    monkeypatch.setattr(main.settings, "reranker_backend", "torch")
    monkeypatch.setattr(main.settings, "answer_reranker_model", "test/answer-model")
    monkeypatch.setattr(main.settings, "cite_reranker_model", "test/cite-model")

    real_init_rerankers()

    assert built[0] == {"model": "test/answer-model", "top_n": 20, "backend": "torch"}
    assert built[1] == {"model": "test/cite-model", "top_n": 1000, "backend": "torch"}
