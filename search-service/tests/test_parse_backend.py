"""Phase 1 parse bake-off (plan §6.1): parse_backend flag + Mistral OCR
branch in worker/stages/parse.py.

Contract: _parse_pdf(content) -> (full_text, page_boundaries) with
boundaries [{"page": N, "end_pos": P}] — identical shape for every
backend. The mistral branch emits PER-PAGE text using the PARSER's page
indices, which is what structurally fixes R4 (zh page labels shifted by
OpenCC length changes under the joined-text arithmetic).

Mistral API is stubbed; no network calls here.
"""
import shutil

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


class TestOversizedPdfShrink:
    """Issue #310 follow-up (Fix 2): Mistral OCR rejects files over 50MB, so a
    59MB WRI report was unparseable. The stage now downsamples raster imagery
    with Ghostscript for the OCR submission ONLY — S3 and the app keep the
    original file.

    The tests lower MISTRAL_MAX_BYTES rather than building a real 50MB fixture:
    the threshold is a constant, the mechanism is what needs proving. The
    constant's own value is pinned by test_max_bytes_pinned_to_mistral_limit.
    """

    def _raster_pdf(self) -> bytes:
        """A single-page PDF whose content is a 600-dpi noise raster. Noise
        rather than a gradient on purpose: a smooth image saves as a small JPEG
        that Ghostscript RE-ENCODES LARGER, which would make 'shrink' a lie.
        Real oversized WRI reports are photographic, i.e. this case."""
        import io
        import random

        from PIL import Image
        random.seed(7)
        small = Image.frombytes(
            "RGB", (300, 375),
            bytes(random.getrandbits(8) for _ in range(300 * 375 * 3)),
        )
        buf = io.BytesIO()
        small.resize((2400, 3000), Image.NEAREST).save(buf, format="PDF", resolution=600.0)
        return buf.getvalue()

    def _stub_ocr(self, monkeypatch) -> dict:
        """Capture what actually gets submitted to the OCR endpoint."""
        captured = {}

        def fake_post(url, headers=None, json=None, timeout=None):
            import base64
            uri = json["document"]["document_url"]
            captured["submitted"] = base64.b64decode(uri.split(",", 1)[1])
            return _StubResp([{"index": 0, "markdown": "page one"}])

        monkeypatch.setattr("requests.post", fake_post)
        return captured

    def _mistral_env(self, monkeypatch):
        monkeypatch.setenv("PARSE_BACKEND", "mistral")
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        get_settings.cache_clear()

    def test_max_bytes_pinned_to_mistral_limit(self):
        """50MB is Mistral OCR's hard limit, not a tunable. The intake cap in
        src/app/api/admin/intake/route.ts is pinned to the same number so an
        upload the parser cannot accept fails at the door (#310)."""
        import worker.stages.parse as parse
        assert parse.MISTRAL_MAX_BYTES == 50 * 1024 * 1024

    @pytest.mark.skipif(shutil.which("gs") is None, reason="ghostscript not installed")
    def test_oversized_pdf_is_shrunk_for_submission_only(self, monkeypatch):
        """The submitted bytes are smaller than the original AND different from
        it; the caller's bytes are untouched, so S3 keeps full resolution."""
        import worker.stages.parse as parse

        self._mistral_env(monkeypatch)
        captured = self._stub_ocr(monkeypatch)
        original = self._raster_pdf()
        # PIL stamps a CreationDate, so the fixture is not byte-reproducible —
        # snapshot it instead of regenerating for the untouched-bytes check.
        before = bytes(original)
        monkeypatch.setattr(parse, "MISTRAL_MAX_BYTES", len(original) - 1)

        full_text, _ = parse._parse_pdf(original)

        assert full_text == "page one", "the OCR result still comes back normally"
        submitted = captured["submitted"]
        assert len(submitted) < len(original), (
            f"submission should shrink: {len(submitted)} vs {len(original)} bytes"
        )
        assert submitted != original, "the shrunk bytes must be what was submitted"
        assert original == before, "the caller's PDF bytes must be untouched (S3 keeps the original)"

    @pytest.mark.skipif(shutil.which("gs") is None, reason="ghostscript not installed")
    def test_pdf_under_the_cap_is_submitted_verbatim(self, monkeypatch):
        """No shrink, no Ghostscript, for the overwhelming majority of files."""
        import worker.stages.parse as parse

        self._mistral_env(monkeypatch)
        captured = self._stub_ocr(monkeypatch)
        monkeypatch.setattr(parse, "_shrink_pdf",
                            lambda c: pytest.fail("must not shrink a file under the cap"))

        parse._parse_pdf(b"%PDF-small")
        assert captured["submitted"] == b"%PDF-small"

    def test_missing_ghostscript_names_the_size_and_the_binary(self, monkeypatch):
        """Deploy-shaped failure: the image lacks `gs`. The message has to say
        so — it surfaces on the job in the review queue."""
        import worker.stages.parse as parse

        def no_gs(*a, **k):
            raise FileNotFoundError("gs")
        monkeypatch.setattr(parse.subprocess, "run", no_gs)
        monkeypatch.setattr(parse, "MISTRAL_MAX_BYTES", 10)

        with pytest.raises(RuntimeError, match="Ghostscript"):
            parse._shrink_pdf(b"x" * 100)
        try:
            parse._shrink_pdf(b"x" * 100)
        except RuntimeError as exc:
            assert "0.0 MB" in str(exc), f"the message must name the sizes, got: {exc}"

    def test_ghostscript_failure_surfaces_exit_code_and_stderr(self, monkeypatch):
        import worker.stages.parse as parse

        class _Proc:
            returncode = 1
            stdout = ""
            stderr = "**** Unable to open the initial device"

        monkeypatch.setattr(parse.subprocess, "run", lambda *a, **k: _Proc())
        monkeypatch.setattr(parse, "MISTRAL_MAX_BYTES", 10)

        with pytest.raises(RuntimeError, match="Unable to open the initial device"):
            parse._shrink_pdf(b"x" * 100)

    @pytest.mark.skipif(shutil.which("gs") is None, reason="ghostscript not installed")
    def test_still_oversized_after_shrink_raises(self, monkeypatch):
        """300 dpi is not always enough. The job must fail with a message that
        names the sizes rather than submitting a file OCR will reject."""
        import worker.stages.parse as parse

        self._mistral_env(monkeypatch)
        monkeypatch.setattr(parse, "MISTRAL_MAX_BYTES", 1024)

        with pytest.raises(RuntimeError, match="still .* MB after Ghostscript shrink"):
            parse._shrink_pdf(self._raster_pdf())


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
