"""Phase 1 parse bake-off (plan §6.1): parse_backend flag + Mistral OCR
branch in worker/stages/parse.py.

Contract: _parse_pdf(content) -> (full_text, page_boundaries) with
boundaries [{"page": N, "end_pos": P}] — identical shape for every
backend. The mistral branch emits PER-PAGE text using the PARSER's page
indices, which is what structurally fixes R4 (zh page labels shifted by
OpenCC length changes under the joined-text arithmetic).

Mistral API is stubbed; no network calls here.
"""
import pytest

from app.config import get_settings


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class _StubResp:
    def __init__(self, pages):
        self._pages = pages
        self.status_code = 200

    def raise_for_status(self):
        pass

    def json(self):
        return {"pages": self._pages}


def test_parse_backend_defaults_to_pypdf(monkeypatch):
    monkeypatch.delenv("PARSE_BACKEND", raising=False)
    assert get_settings().parse_backend == "pypdf"


def test_mistral_branch_returns_contract_shape(monkeypatch):
    import worker.stages.parse as parse

    monkeypatch.setenv("PARSE_BACKEND", "mistral")
    monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
    get_settings.cache_clear()

    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        return _StubResp([
            {"index": 0, "markdown": "# Título\n\nHola mundo"},
            {"index": 1, "markdown": "Segunda página"},
        ])

    monkeypatch.setattr("requests.post", fake_post)

    full_text, boundaries = parse._parse_pdf(b"%PDF-fake")

    assert full_text == "# Título\n\nHola mundo\n\nSegunda página"
    assert boundaries == [
        {"page": 1, "end_pos": len("# Título\n\nHola mundo")},
        {"page": 2, "end_pos": len(full_text)},
    ]
    assert "mistral" in captured["url"]
    assert captured["json"]["document"]["document_url"].startswith(
        "data:application/pdf;base64,")


def test_mistral_branch_preserves_parser_page_numbers(monkeypatch):
    """R4 guard: a page the parser returns EMPTY must not shift later pages'
    labels — boundaries carry the parser's own page indices (zh fixture:
    page 2 is a full-bleed graphic with no text)."""
    import worker.stages.parse as parse

    monkeypatch.setenv("PARSE_BACKEND", "mistral")
    monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
    get_settings.cache_clear()

    monkeypatch.setattr("requests.post", lambda *a, **k: _StubResp([
        {"index": 0, "markdown": "## 执行摘要\n\n纯电动公交车"},
        {"index": 1, "markdown": "   "},
        {"index": 2, "markdown": "## 研究方法\n\n样本城市"},
    ]))

    full_text, boundaries = parse._parse_pdf(b"%PDF-fake")

    assert [b["page"] for b in boundaries] == [1, 3]
    assert full_text == "## 执行摘要\n\n纯电动公交车\n\n## 研究方法\n\n样本城市"
    assert boundaries[-1]["end_pos"] == len(full_text)


def test_mistral_branch_requires_api_key(monkeypatch):
    import worker.stages.parse as parse

    monkeypatch.setenv("PARSE_BACKEND", "mistral")
    # empty-string override: delenv would let pydantic fall back to a real
    # key in .env.local and the code would hit the live API
    monkeypatch.setenv("MISTRAL_API_KEY", "")
    get_settings.cache_clear()

    with pytest.raises(RuntimeError, match="MISTRAL_API_KEY"):
        parse._parse_pdf(b"%PDF-fake")


def test_pypdf_branch_untouched_by_default(monkeypatch):
    """Regression guard: default backend routes to the existing pypdf path."""
    import worker.stages.parse as parse

    monkeypatch.delenv("PARSE_BACKEND", raising=False)
    get_settings.cache_clear()

    called = {}
    monkeypatch.setattr(parse, "_parse_pdf_pypdf",
                        lambda content: called.setdefault("v", ("t", [])))
    out = parse._parse_pdf(b"%PDF-fake")
    assert out == ("t", [])
    assert "v" in called
