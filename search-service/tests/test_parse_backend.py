"""Phase 1 parse bake-off (plan §6.1): parse_backend flag + Mistral OCR
branch in worker/stages/parse.py.

Contract: _parse_pdf(content) -> (full_text, page_boundaries) with
boundaries [{"page": N, "end_pos": P}] — identical shape for every
backend. The mistral branch emits PER-PAGE text using the PARSER's page
indices, which is what structurally fixes R4 (zh page labels shifted by
OpenCC length changes under the joined-text arithmetic).

Mistral API is stubbed; no network calls here.
"""
import io
import shutil
from pathlib import Path

import pytest

from app.config import get_settings


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class _StubResp:
    def __init__(self, payload):
        self._payload = payload
        self.status_code = 200

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class FakeMistral:
    """Stubs the upload -> sign -> OCR -> delete flow the mistral backend uses.

    Documents are uploaded and referenced by signed URL rather than inlined as
    base64 (see parse._parse_pdf_mistral), so what a test wants to inspect is
    the bytes that reached /v1/files.
    """

    SIGNED = "https://files.example.invalid/doc?sig=abc"

    def __init__(self, pages):
        self.pages = pages
        self.uploaded = None       # bytes sent to /v1/files
        self.ocr_document = None   # the `document` field sent to /v1/ocr
        self.deleted = []          # file ids cleaned up afterwards

    def install(self, monkeypatch):
        monkeypatch.setattr("requests.post", self.post)
        monkeypatch.setattr("requests.get", self.get)
        monkeypatch.setattr("requests.delete", self.delete)
        return self

    def post(self, url, headers=None, files=None, data=None, json=None, timeout=None):
        if url.endswith("/v1/files"):
            assert data["purpose"] == "ocr"
            self.uploaded = files["file"][1]
            return _StubResp({"id": "file-1"})
        if url.endswith("/v1/ocr"):
            self.ocr_document = json["document"]
            return _StubResp({"pages": self.pages})
        raise AssertionError(f"unexpected POST {url}")

    def get(self, url, headers=None, params=None, timeout=None):
        assert url.endswith("/v1/files/file-1/url"), url
        assert params["expiry"] > 0, "signed URLs need a lifetime"
        return _StubResp({"url": self.SIGNED})

    def delete(self, url, headers=None, timeout=None):
        self.deleted.append(url.rsplit("/", 1)[-1])
        return _StubResp({})


def test_parse_backend_defaults_to_pypdf(monkeypatch):
    monkeypatch.delenv("PARSE_BACKEND", raising=False)
    assert get_settings().parse_backend == "pypdf"


def test_mistral_branch_returns_contract_shape(monkeypatch):
    import worker.stages.parse as parse

    monkeypatch.setenv("PARSE_BACKEND", "mistral")
    monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
    get_settings.cache_clear()

    fake = FakeMistral([
        {"index": 0, "markdown": "# Título\n\nHola mundo"},
        {"index": 1, "markdown": "Segunda página"},
    ]).install(monkeypatch)

    full_text, boundaries = parse._parse_pdf(b"%PDF-fake")

    assert full_text == "# Título\n\nHola mundo\n\nSegunda página"
    assert boundaries == [
        {"page": 1, "end_pos": len("# Título\n\nHola mundo")},
        {"page": 2, "end_pos": len(full_text)},
    ]
    # The document is uploaded and referenced, never inlined as base64: a 50MB
    # PDF would otherwise become a ~68MB request body, against a 50MB limit
    # whose scope (document vs body) was never established.
    assert fake.uploaded == b"%PDF-fake"
    assert fake.ocr_document == {"type": "document_url", "document_url": FakeMistral.SIGNED}
    assert fake.deleted == ["file-1"], "the uploaded copy must be cleaned up"


def test_mistral_branch_preserves_parser_page_numbers(monkeypatch):
    """R4 guard: a page the parser returns EMPTY must not shift later pages'
    labels — boundaries carry the parser's own page indices (zh fixture:
    page 2 is a full-bleed graphic with no text)."""
    import worker.stages.parse as parse

    monkeypatch.setenv("PARSE_BACKEND", "mistral")
    monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
    get_settings.cache_clear()

    FakeMistral([
        {"index": 0, "markdown": "## 执行摘要\n\n纯电动公交车"},
        {"index": 1, "markdown": "   "},
        {"index": 2, "markdown": "## 研究方法\n\n样本城市"},
    ]).install(monkeypatch)

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

    def _stub_ocr(self, monkeypatch) -> FakeMistral:
        """Capture the bytes that reach Mistral (the uploaded file, since the
        document is referenced by signed URL rather than inlined)."""
        return FakeMistral([{"index": 0, "markdown": "page one"}]).install(monkeypatch)

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
        fake = self._stub_ocr(monkeypatch)
        original = self._raster_pdf()
        monkeypatch.setattr(parse, "MISTRAL_MAX_BYTES", len(original) - 1)

        full_text, _ = parse._parse_pdf(original)

        assert full_text == "page one", "the OCR result still comes back normally"
        submitted = fake.uploaded
        assert len(submitted) < len(original), (
            f"submission should shrink: {len(submitted)} vs {len(original)} bytes"
        )
        assert submitted != original, "the shrunk bytes must be what was submitted"
        # The submission must still be a readable PDF with every page intact —
        # a smaller pile of bytes is not the goal, a smaller DOCUMENT is.
        from pypdf import PdfReader
        assert len(PdfReader(io.BytesIO(submitted)).pages) == \
            len(PdfReader(io.BytesIO(original)).pages), "shrink must not drop pages"

    @pytest.mark.skipif(shutil.which("gs") is None, reason="ghostscript not installed")
    def test_shrink_uses_300dpi_and_a_timeout(self, monkeypatch):
        """Pins the two decisions the spec cares about and that no output-shape
        assertion can catch: 300 dpi (NOT the /ebook 150 dpi preset — small
        labels in raster figures have to stay OCR-legible) and a subprocess
        timeout (without it a pathological PDF hangs the single worker forever).
        Both are invisible in the returned bytes, so assert on the argv."""
        import worker.stages.parse as parse

        seen = {}
        real_run = parse.subprocess.run

        def spy(cmd, **kwargs):
            seen["cmd"] = cmd
            seen["kwargs"] = kwargs
            return real_run(cmd, **kwargs)

        monkeypatch.setattr(parse.subprocess, "run", spy)
        parse._shrink_pdf(self._raster_pdf())

        for flag in ("-dColorImageResolution=300", "-dGrayImageResolution=300",
                     "-dMonoImageResolution=300"):
            assert flag in seen["cmd"], f"{flag} missing — is this still 300 dpi?"
        assert "-dPDFSETTINGS=/ebook" not in seen["cmd"], "the 150 dpi preset costs OCR legibility"
        assert seen["kwargs"].get("timeout"), "gs must run under a timeout"

    @pytest.mark.skipif(shutil.which("gs") is None, reason="ghostscript not installed")
    def test_dropped_pages_are_refused(self, monkeypatch):
        """Ghostscript exit 0 is not proof of a faithful conversion — gs 10's
        repair path can drop pages from a damaged source. Truncated text that
        OCRs cleanly would be cached as complete, so the page count is checked."""
        import worker.stages.parse as parse

        original = self._raster_pdf()

        def lossy_gs(cmd, **kwargs):
            # Emulate 'exit 0, fewer pages': a VALID but empty PDF at the output
            # path (pypdf writes one, so this tests page loss, not corruption).
            from pypdf import PdfWriter
            out = Path(cmd[cmd.index("-o") + 1])
            with open(out, "wb") as fh:
                PdfWriter().write(fh)

            class _P:
                returncode = 0
                stdout = ""
                stderr = ""
            return _P()

        monkeypatch.setattr(parse.subprocess, "run", lossy_gs)
        with pytest.raises(RuntimeError, match="dropped pages"):
            parse._shrink_pdf(original)

    @pytest.mark.skipif(shutil.which("gs") is None, reason="ghostscript not installed")
    def test_unreadable_output_is_refused(self, monkeypatch):
        """The other half: exit 0 with output pypdf cannot parse at all. Those
        are the bytes we would submit and then cache, so they must not pass."""
        import worker.stages.parse as parse

        def corrupt_gs(cmd, **kwargs):
            Path(cmd[cmd.index("-o") + 1]).write_bytes(b"%PDF-1.4\nnot really a pdf\n")

            class _P:
                returncode = 0
                stdout = ""
                stderr = ""
            return _P()

        monkeypatch.setattr(parse.subprocess, "run", corrupt_gs)
        with pytest.raises(RuntimeError, match="unreadable PDF"):
            parse._shrink_pdf(self._raster_pdf())

    def test_pdf_under_the_cap_is_submitted_verbatim(self, monkeypatch):
        """No shrink, no Ghostscript, for the overwhelming majority of files."""
        import worker.stages.parse as parse

        self._mistral_env(monkeypatch)
        fake = self._stub_ocr(monkeypatch)
        monkeypatch.setattr(parse, "_shrink_pdf",
                            lambda c: pytest.fail("must not shrink a file under the cap"))

        parse._parse_pdf(b"%PDF-small")
        assert fake.uploaded == b"%PDF-small", "an under-cap file is uploaded verbatim"

    def test_missing_ghostscript_names_the_size_and_the_binary(self, monkeypatch):
        """Deploy-shaped failure: the image lacks `gs`. The message has to say
        so — it surfaces on the job in the review queue."""
        import worker.stages.parse as parse

        def no_gs(*a, **k):
            raise FileNotFoundError("gs")
        monkeypatch.setattr(parse.subprocess, "run", no_gs)
        monkeypatch.setattr(parse, "MISTRAL_MAX_BYTES", 50 * 1024 * 1024)

        # Sizes chosen so the document (60MB) and the limit (50MB) render as
        # DIFFERENT strings — otherwise the message could name the wrong number
        # and still match.
        with pytest.raises(RuntimeError) as exc:
            parse._shrink_pdf(b"x" * (60 * 1024 * 1024))
        msg = str(exc.value)
        assert "Ghostscript" in msg and "not installed" in msg, msg
        assert "60.0 MB" in msg, f"must name the document's size: {msg}"
        assert "50.0 MB" in msg, f"must name the limit: {msg}"

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


class TestOversizedPdfPageSplit:
    """Issue #310 follow-up: the lossless fallback for files downsampling cannot
    fix. Measured on the real 304-page wri-india-nup-report (59.2MB of already
    ~72dpi imagery): Ghostscript recovered 2.1MB at 300 dpi and 2.8MB at 150 dpi,
    and /ebook and /screen crashed outright. Nothing to downsample — the size is
    page count, so the document is split on page ranges instead.
    """

    def _multipage_pdf(self, pages: int) -> bytes:
        import io

        from pypdf import PdfWriter
        w = PdfWriter()
        for _ in range(pages):
            w.add_blank_page(width=612, height=792)
        buf = io.BytesIO()
        w.write(buf)
        return buf.getvalue()

    def test_split_covers_every_page_exactly_once(self):
        import worker.stages.parse as parse

        pieces = parse._split_pdf(self._multipage_pdf(10), 3)

        assert sum(count for _, count in pieces) == 10, "no page may be lost or duplicated"
        assert len(pieces) == 3

    def test_page_numbers_are_rebased_onto_the_whole_document(self, monkeypatch):
        """The correctness property citations depend on: a part's page 1 is NOT
        the document's page 1. Without rebasing, every part after the first
        would report pages 1..n and silently overwrite the earlier parts'
        numbering."""
        import worker.stages.parse as parse

        # Cap large enough that the stubbed parts are accepted at parts=2.
        monkeypatch.setattr(parse, "MISTRAL_MAX_BYTES", 100)
        monkeypatch.setattr(parse, "_split_pdf",
                            lambda content, parts: [(b"part1", 2), (b"part2", 2)])

        calls = []

        def fake_ocr(settings, content):
            calls.append(content)
            # Each part reports its OWN page indices, starting at 0.
            return [{"index": 0, "markdown": f"{content.decode()} page A"},
                    {"index": 1, "markdown": f"{content.decode()} page B"}]

        monkeypatch.setattr(parse, "_mistral_ocr_bytes", fake_ocr)

        pages = parse._ocr_by_parts(object(), b"x" * 10)

        assert calls == [b"part1", b"part2"], "each part is OCR'd once, in order"
        assert [p["index"] for p in pages] == [0, 1, 2, 3], (
            "part 2's pages must continue the document's numbering, not restart"
        )
        full_text, boundaries = parse.mistral_pages_to_text(pages)
        assert [b["page"] for b in boundaries] == [1, 2, 3, 4]
        assert full_text.endswith("part2 page B")

    def test_split_is_only_reached_after_shrink_fails(self, monkeypatch):
        """Downsampling is one API call and genuinely fixes high-dpi files, so it
        stays the first attempt; splitting is the fallback."""
        import worker.stages.parse as parse

        monkeypatch.setenv("PARSE_BACKEND", "mistral")
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        get_settings.cache_clear()
        monkeypatch.setattr(parse, "MISTRAL_MAX_BYTES", 10)

        order = []
        monkeypatch.setattr(parse, "_shrink_pdf",
                            lambda c: order.append("shrink") or b"tiny")
        monkeypatch.setattr(parse, "_ocr_by_parts",
                            lambda s, c: pytest.fail("must not split when shrink succeeds"))
        monkeypatch.setattr(parse, "_mistral_ocr_bytes",
                            lambda s, c: [{"index": 0, "markdown": "shrunk text"}])

        text, _ = parse._parse_pdf(b"x" * 100)

        assert order == ["shrink"]
        assert text == "shrunk text"

    def test_falls_back_to_splitting_when_shrink_cannot_clear_the_limit(self, monkeypatch):
        import worker.stages.parse as parse

        monkeypatch.setenv("PARSE_BACKEND", "mistral")
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        get_settings.cache_clear()
        monkeypatch.setattr(parse, "MISTRAL_MAX_BYTES", 10)

        def shrink_fails(content):
            raise RuntimeError("PDF is still 57.1 MB after Ghostscript shrink")

        monkeypatch.setattr(parse, "_shrink_pdf", shrink_fails)
        monkeypatch.setattr(parse, "_ocr_by_parts",
                            lambda s, c: [{"index": 0, "markdown": "split text"}])

        text, _ = parse._parse_pdf(b"x" * 100)

        assert text == "split text", "a file shrink cannot fix must still be parsed"

    def test_gives_up_with_a_clear_error_when_even_ten_parts_are_too_big(self, monkeypatch):
        import worker.stages.parse as parse

        monkeypatch.setattr(parse, "MISTRAL_MAX_BYTES", 10)
        monkeypatch.setattr(parse, "_split_pdf",
                            lambda content, parts: [(b"x" * 100, 1)] * parts)

        with pytest.raises(RuntimeError, match="even at 10 parts"):
            parse._ocr_by_parts(object(), b"x" * 1000)


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
