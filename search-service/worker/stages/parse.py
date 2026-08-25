"""Stage: parse the source PDF into full text + page boundaries.

Mirrors the legacy parse exactly (app/indexing.prepare_documents PDF branch):
pages joined with '\n\n', boundaries = [{'page': n, 'end_pos': cumulative}].
Documents with no retrievable file fall back to title+summary text when the
document has a long summary (CSV-imported docs); otherwise -> needs_review.

Parse cache (issue #310 follow-up): document_texts carries three stamps
(parsed_content_hash / parse_backend / parse_model) recording what produced the
stored text. When they all match the document's current content_hash and the
worker's current backend/model, this stage reuses the stored text and skips both
the download and the OCR call — the slowest, costliest stage of a re-ingest.
Everything downstream (metadata extraction, summarize/classify/embed) still
runs, so a prompt-tuning campaign re-runs the cheap stages only. The cache
misses on NULL stamps (pre-existing rows), changed bytes, a backend flip, or an
OCR model upgrade; FORCE_REPARSE=true bypasses it entirely.

Metadata extraction: uses the LLM (one structured-output chat_json call) to
extract title, title_en, authors, DOI, year_published, article_type,
wri_primary_office from the first ~12k chars of the PDF text. DOI is tried via
regex first (more reliable when present). url is NOT extracted from the PDF
(CSV-only field).

title/title_en are extracted TOGETHER in that one call (issue #303). A bilingual
cover page carries the title twice — e.g. a Chinese main title above an English
one — and asking only for "the title" returned both concatenated into `title`,
which summarize then translated into an equally doubled `title_en`. Splitting the
two in the extraction call is what structurally prevents that: `title` is the
native-language title alone, `title_en` the document's own English title when it
has one (a publisher's English title beats a machine translation) and a
translation otherwise. summarize._translate_title survives only as the fallback
for documents that never reach this call (no PDF) or whose call failed.

Author names are transliterated to Latin script in the same call (issue #303):
`authors` is what the admin UI and citations render, and native-script names are
not retained — a re-ingest re-extracts them from the PDF.

Provenance: the parse stage reads documents.metadata_source (jsonb mapping
field→'external'|'llm'|'human') and overwrites a field ONLY when its source is
NULL or 'llm' — never CSV-imported ('external') or human-edited ('human') values.
On re-ingest, a prior LLM extraction is overwritten by a fresh one (self-correcting).
If the LLM call fails, extraction is skipped (best-effort; the stage continues).
"""
import logging
import re
import subprocess
import tempfile
from pathlib import Path

from psycopg.types.json import Jsonb

from app.config import get_settings
from app.db import get_pool
from worker.stages import audit_system_event, fetch_document, stage

logger = logging.getLogger(__name__)

# DOI pattern: matches 10.xxxx/something (the DOI prefix + suffix)
_DOI_RE = re.compile(r'10\.\d{4,}/\S+')

# Mistral OCR rejects documents over 50MB. This is THEIR hard limit, which is
# also why the upload cap in src/app/api/admin/intake/route.ts is pinned to the
# same number (#310): an upload the parser cannot accept should fail at the door.
MISTRAL_MAX_BYTES = 50 * 1024 * 1024

# Appended to the cached parse_model stamp for documents whose OCR submission
# was downsampled by _shrink_pdf. Change it when the shrink POLICY changes
# (e.g. a different dpi), so old shrunk rows stop matching.
SHRINK_POLICY_TAG = "+gs300"

MISTRAL_API = "https://api.mistral.ai"
# Signed-URL lifetime for the SYNC path, which uses the URL within seconds. Kept
# short so a failed cleanup leaves a document fetchable for an hour, not a day.
# scripts/batch_ocr.py passes a longer expiry: its URLs must outlive a queued
# async job.
MISTRAL_SIGNED_URL_EXPIRY_HOURS = 1
MISTRAL_BATCH_SIGNED_URL_EXPIRY_HOURS = 24

# Per-call HTTP timeouts. Their SUM plus the Ghostscript timeout is the parse
# stage's worst case, and it must stay under WORKER_REAP_MINUTES (default 15) or
# a slow document gets reaped mid-parse and re-OCR'd by another worker — paying
# twice. Single-worker deploys are safe today (the poll loop blocks inside
# process_one_job, so the reaper cannot fire against its own in-flight job);
# raising ingestion_worker_desired_count above 1 makes this budget load-bearing.
MISTRAL_UPLOAD_TIMEOUT = 300
MISTRAL_SIGN_TIMEOUT = 60
MISTRAL_OCR_TIMEOUT = 900
MISTRAL_DELETE_TIMEOUT = 15


def _mb(n: int) -> str:
    return f"{n / 1024 / 1024:.1f}"

# The fields the LLM extracts, mapped to their DB column names.
_EXTRACT_FIELDS = ["title", "title_en", "authors", "doi", "year_published",
                   "article_type", "wri_primary_office"]

# JSON schema for the LLM structured-output call.
_EXTRACT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "title": {"type": ["string", "null"]},
        "title_en": {"type": ["string", "null"]},
        "authors": {
            "type": ["array", "null"],
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "family_name": {"type": ["string", "null"]},
                    "given_names": {"type": ["string", "null"]},
                    "organization_name": {"type": ["string", "null"]},
                },
                "required": ["family_name", "given_names", "organization_name"],
            },
        },
        "doi": {"type": ["string", "null"]},
        "year_published": {"type": ["integer", "null"]},
        "article_type": {"type": ["string", "null"]},
        "wri_primary_office": {"type": ["string", "null"]},
    },
    "required": ["title", "title_en", "authors", "doi", "year_published",
                 "article_type", "wri_primary_office"],
}


def _extract_doi(text: str) -> str | None:
    """Extract a DOI string from text via regex. Returns '10.xxxx/something' or None."""
    match = _DOI_RE.search(text)
    if match:
        return match.group(0).rstrip('.,;:)') or None
    return None


def _format_authors(authors: object) -> str | None:
    """Convert structured model output to the DMS semicolon-delimited string."""
    if not isinstance(authors, list):
        return None

    formatted = []
    for author in authors:
        if not isinstance(author, dict):
            continue
        family = author.get("family_name")
        given = author.get("given_names")
        organization = author.get("organization_name")
        family = family.strip() if isinstance(family, str) else ""
        given = given.strip() if isinstance(given, str) else ""
        organization = organization.strip() if isinstance(organization, str) else ""

        # A model item must represent either a person or an organization.
        if organization and (family or given):
            continue
        if organization:
            formatted.append(organization)
        elif family and given:
            formatted.append(f"{family}, {given}")
        elif family or given:
            formatted.append(family or given)

    return "; ".join(formatted) or None


def _extract_metadata_llm(full_text: str, model: str) -> dict:
    """Extract bibliographic metadata from PDF text via one LLM call.
    Returns a dict with keys from _EXTRACT_FIELDS; values are None if not determinable.
    Raises RuntimeError if the LLM call fails (caller should catch and continue)."""
    from worker.llm import chat_json

    result = chat_json(
        system=(
            "You extract bibliographic metadata from research publication text. "
            "Return JSON with: title (the document's actual title, NOT a header, "
            "banner, or table-of-contents line), title_en, authors "
            "(an array of structured person or organization authors), doi (the DOI string if present, "
            "e.g. 10.xxxx/yyyy, else null), year_published (integer publication "
            "year if determinable, else null — use the year the document itself "
            "was published, preferring an explicit copyright or publication "
            "date such as '© 2024' or 'Published March 2024' over years of "
            "data, events, or cited works), article_type (e.g. Working Paper, "
            "Report, Article, Technical Note, Practice Note), wri_primary_office "
            "(if mentioned, else null). wri_primary_office is a GEOGRAPHIC "
            "office — e.g. WRI India, WRI Brasil, WRI China, WRI Indonesia, "
            "WRI Africa, WRI Global — never a programmatic unit or center such "
            "as 'WRI Ross Center' or 'WRI Ross Center for Sustainable Cities'; "
            "for a publication by such a unit use the geographic office it was "
            "published from, or WRI Global if unclear. "
            "If a field is not determinable from the text, return null.\n\n"
            "TITLES. Cover pages often print the title in two languages. Never "
            "merge them into one string. Put the title in the document's own "
            "primary language, and that language ONLY, in 'title'. Put the "
            "English title in 'title_en': use the document's own English title "
            "when the cover provides one, otherwise a faithful translation of "
            "'title' preserving proper nouns, place names, and meaning. When the "
            "document is already English, 'title' and 'title_en' are the same "
            "string. A title with a subtitle is ONE title: covers often print "
            "the subtitle on its own smaller line or after a colon — that line "
            "is part of the title, not a banner. Include it, joined as "
            "'Main Title: Subtitle'. Write English titles in Headline Case "
            "(Capitalize Principal Words); keep other languages' own casing "
            "conventions. Do not add quotes, commentary, or a trailing period.\n\n"
            "AUTHORS. Return authors in document order. For a person, put the "
            "family name in 'family_name', all given names in 'given_names', "
            "and null in 'organization_name'. Separate name parts semantically "
            "regardless of the order printed in the source. Prefer a romanized "
            "form printed by the document; otherwise transliterate into the "
            "Latin alphabet. For example, '薛露露' becomes family_name='Xue', "
            "given_names='Lulu', and '陈科' becomes family_name='Chen', "
            "given_names='Ke'. For a group or institution, set only "
            "'organization_name'. Use null rather than guessing an unknown part. "
            "Never put native-script and Latin versions in the same item."
        ),
        user=f"Document text (first ~12000 chars):\n{full_text[:12000]}",
        schema=_EXTRACT_SCHEMA,
        model=model,
        max_tokens=1000,
    )
    # Normalize: ensure all expected keys exist and keep the DB contract stable.
    normalized = {f: result.get(f) for f in _EXTRACT_FIELDS}
    normalized["authors"] = _format_authors(result.get("authors"))
    return normalized


def _extract_pdf_metadata(content: bytes) -> dict:
    """Extract title, author from the PDF's embedded metadata (pypdf).
    Used only as a last-resort fallback when text extraction yields nothing.
    Returns a dict with 'title'/'authors' (None if not found)."""
    result = {"title": None, "authors": None}
    try:
        from pypdf import PdfReader
        with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        try:
            reader = PdfReader(tmp_path)
            meta = reader.metadata
            if meta:
                if meta.title:
                    result["title"] = str(meta.title).strip()[:300] or None
                if meta.author:
                    result["authors"] = str(meta.author).strip()[:500] or None
        finally:
            Path(tmp_path).unlink(missing_ok=True)
    except Exception:
        logger.debug("_extract_pdf_metadata: pypdf extraction failed", exc_info=True)
    return result


def _load_pdf_bytes(doc) -> bytes | None:
    settings = get_settings()
    # local-dev: intake moved files next to the intake dir
    if settings.intake_local_dir:
        local = Path(settings.intake_local_dir).parent / "documents" / Path(doc["s3_key"]).name
        if local.exists():
            return local.read_bytes()
    if settings.documents_s3_bucket:
        import boto3
        s3 = boto3.client("s3")
        try:
            return s3.get_object(Bucket=settings.documents_s3_bucket, Key=doc["s3_key"])["Body"].read()
        except s3.exceptions.NoSuchKey:
            return None
    # legacy local layout (DOCUMENTS_LOCAL_DIR)
    local = Path(settings.documents_local_dir) / Path(doc["s3_key"]).name
    return local.read_bytes() if local.exists() else None


def _parse_pdf_pypdf(content: bytes) -> tuple[str, list]:
    from llama_index.readers.file import PDFReader

    with tempfile.NamedTemporaryFile(suffix=".pdf") as tmp:
        tmp.write(content)
        tmp.flush()
        pages = PDFReader().load_data(tmp.name)
    page_texts, boundaries, pos = [], [], 0
    for i, page in enumerate(pages):
        text = page.text.strip()
        if text:
            page_texts.append(text)
            pos += len(text) + 2
            boundaries.append({"page": i + 1, "end_pos": pos - 2})
    return "\n\n".join(page_texts), boundaries


def _mistral_auth_header(settings) -> str:
    """Build the Mistral bearer header from the SecretStr setting.

    Deliberately NOT an f-string on the setting itself: str(SecretStr) renders
    '**********', so interpolating it would send `Bearer **********` and fail
    with a 401 rather than anything that names the real problem.
    """
    return f"Bearer {settings.mistral_api_key.get_secret_value()}"


def _assert_pages_preserved(src: Path, dst: Path, orig_bytes: int) -> None:
    """Raise unless the shrunk PDF still has every page the original had.

    Ghostscript exit 0 does not mean a faithful conversion: it always creates
    the output file, and gs 10's repair path can drop pages from a damaged
    source without failing. A silently short document would OCR cleanly, store
    truncated text, and (with the parse cache) keep it — so the page count is
    checked before those bytes go anywhere.
    """
    if dst.stat().st_size == 0:
        raise RuntimeError(
            f"Ghostscript produced an empty file from a {_mb(orig_bytes)} MB PDF"
        )
    from pypdf import PdfReader
    try:
        before = len(PdfReader(str(src)).pages)
    except Exception:
        # Lenient about the SOURCE: a PDF pypdf cannot read is exactly the kind
        # of damaged file we still want to hand to OCR. Nothing to compare, so
        # skip the check rather than block the document.
        logger.warning("could not read source page count before shrink", exc_info=True)
        return
    try:
        after = len(PdfReader(str(dst)).pages)
    except Exception as exc:
        # Strict about the OUTPUT: these are the bytes we are about to submit
        # and cache. Unreadable means Ghostscript failed while reporting success.
        raise RuntimeError(
            f"Ghostscript produced an unreadable PDF from a {_mb(orig_bytes)} MB "
            f"source ({type(exc).__name__}: {exc})"
        ) from None
    if after < before:
        raise RuntimeError(
            f"Ghostscript dropped pages shrinking a {_mb(orig_bytes)} MB PDF "
            f"({before} pages in, {after} out) — refusing to OCR a truncated document"
        )


def _shrink_pdf(content: bytes) -> bytes:
    """Downsample a PDF's raster images with Ghostscript so it fits the OCR cap.

    300 dpi, NOT the /ebook preset (150 dpi). Vector charts pass through
    untouched either way, but 300 dpi is what keeps small labels inside raster
    figures legible to OCR — the whole point of sending the file at all.
    Typical oversized WRI reports carry 400-600 dpi imagery, so 2x+ shrink is
    the expected outcome. Note it is not guaranteed: Ghostscript re-encodes, and
    an already-well-compressed file can come back LARGER, which is why the
    result is re-checked against the cap below.

    Only the OCR submission shrinks: the caller's bytes are untouched, and S3
    and the app keep the original file. Raises RuntimeError (naming the sizes)
    when Ghostscript is missing, fails, or cannot get the file under the cap —
    the job then lands in the review queue with a message an admin can act on.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        src = Path(tmpdir) / "in.pdf"
        dst = Path(tmpdir) / "out.pdf"
        src.write_bytes(content)
        cmd = [
            "gs", "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5",
            "-dNOPAUSE", "-dBATCH", "-dQUIET",
            "-dDownsampleColorImages=true", "-dColorImageResolution=300",
            "-dDownsampleGrayImages=true", "-dGrayImageResolution=300",
            "-dDownsampleMonoImages=true", "-dMonoImageResolution=300",
            "-o", str(dst), str(src),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        except FileNotFoundError:
            raise RuntimeError(
                f"PDF is {_mb(len(content))} MB, over the {_mb(MISTRAL_MAX_BYTES)} MB "
                "Mistral OCR limit, and Ghostscript ('gs') is not installed — cannot shrink it"
            ) from None
        except subprocess.TimeoutExpired:
            raise RuntimeError(
                f"Ghostscript timed out shrinking a {_mb(len(content))} MB PDF"
            ) from None
        if proc.returncode != 0 or not dst.exists():
            raise RuntimeError(
                f"Ghostscript failed to shrink a {_mb(len(content))} MB PDF "
                f"(exit {proc.returncode}): {(proc.stderr or '').strip()[-500:]}"
            )
        shrunk = dst.read_bytes()
        # Exit 0 is NOT proof of a good conversion. Ghostscript writes out.pdf
        # even on hard failure, and gs 10's permissive repair path can "recover"
        # a damaged file by silently dropping pages — which would OCR clean,
        # store short text, and cache it as if complete. Compare page counts.
        _assert_pages_preserved(src, dst, len(content))

    if len(shrunk) > MISTRAL_MAX_BYTES:
        raise RuntimeError(
            f"PDF is still {_mb(len(shrunk))} MB after Ghostscript shrink "
            f"(was {_mb(len(content))} MB), over the {_mb(MISTRAL_MAX_BYTES)} MB "
            "Mistral OCR limit — split the document or reduce its imagery"
        )
    logger.info("shrank oversized PDF for OCR: %s MB -> %s MB",
                _mb(len(content)), _mb(len(shrunk)))
    return shrunk


def mistral_upload_and_sign(settings, name: str, content: bytes,
                            expiry_hours: int = MISTRAL_SIGNED_URL_EXPIRY_HOURS
                            ) -> tuple[str, str]:
    """Upload a PDF to Mistral file storage; return (file_id, signed_url).

    Shared by the sync parse path and scripts/batch_ocr.py so both transports
    submit documents the same way.

    If signing fails the upload is deleted before raising: the caller never
    receives the file_id on that path, so it could not clean up itself, and a
    retried parse would orphan another copy on every attempt.
    """
    import requests

    headers = {"Authorization": _mistral_auth_header(settings)}
    r = requests.post(f"{MISTRAL_API}/v1/files", headers=headers,
                      files={"file": (name, content, "application/pdf")},
                      data={"purpose": "ocr"}, timeout=MISTRAL_UPLOAD_TIMEOUT)
    r.raise_for_status()
    file_id = r.json()["id"]
    try:
        r = requests.get(f"{MISTRAL_API}/v1/files/{file_id}/url", headers=headers,
                         params={"expiry": expiry_hours}, timeout=MISTRAL_SIGN_TIMEOUT)
        r.raise_for_status()
        return file_id, r.json()["url"]
    except Exception:
        _mistral_delete_file(settings, file_id)
        raise


def _mistral_delete_file(settings, file_id: str) -> None:
    """Best-effort cleanup so parsing does not accumulate copies of the corpus
    in Mistral's file storage. Never fails the parse — but never silent either:
    requests does not raise on 4xx/5xx, so the status is checked explicitly or a
    failed delete would leave a document fetchable by signed URL with no trace."""
    import requests

    try:
        r = requests.delete(f"{MISTRAL_API}/v1/files/{file_id}",
                            headers={"Authorization": _mistral_auth_header(settings)},
                            timeout=MISTRAL_DELETE_TIMEOUT)
        if r.status_code >= 400:
            logger.warning("deleting Mistral file %s returned HTTP %s: %s",
                           file_id, r.status_code, (r.text or "")[:200])
    except Exception:  # noqa: BLE001 — cleanup is hygiene, not a parse invariant
        logger.warning("could not delete Mistral file %s (non-fatal)", file_id, exc_info=True)


def _parse_pdf_mistral(content: bytes) -> tuple[str, list]:
    """Mistral OCR (spec §7 as amended 2026-07-22): per-page markdown.
    Boundaries carry the PARSER's page indices, so a page that comes back
    empty (full-bleed graphic) doesn't shift later pages' labels — this is
    what structurally fixes R4 (zh boundaries vs OpenCC length changes).

    The document is uploaded and referenced by signed URL rather than inlined as
    a base64 data URI. Base64 is 1.37x, so a 50MB PDF became a ~68MB request
    body, and it was never established whether Mistral's 50MB limit applies to
    the document or to the body — meaning a file shrunk to just under the cap
    might still have been rejected. Uploading removes the question (verified
    against the live API 2026-08-05) and drops peak memory per parse by ~2
    copies of the file.
    """
    settings = get_settings()
    if not settings.mistral_api_key:
        raise RuntimeError("PARSE_BACKEND=mistral requires MISTRAL_API_KEY")
    if len(content) <= MISTRAL_MAX_BYTES:
        return mistral_pages_to_text(_mistral_ocr_bytes(settings, content))

    # Oversized. Downsampling first, because it is one API call and it genuinely
    # works for the high-dpi-imagery case. (The parse cache does NOT let either
    # path coast — the stamp is tagged SHRINK_POLICY_TAG and never matches, so
    # raising the cap and re-ingesting really does re-parse at full resolution.)
    try:
        shrunk = _shrink_pdf(content)
        return mistral_pages_to_text(_mistral_ocr_bytes(settings, shrunk))
    except RuntimeError as exc:
        logger.info("shrink did not clear the OCR limit (%s) — splitting by pages", exc)

    return mistral_pages_to_text(_ocr_by_parts(settings, content))


def _split_pdf(content: bytes, parts: int) -> list[tuple[bytes, int]]:
    """Split into `parts` contiguous page ranges: [(bytes, page_count), ...]."""
    import io

    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(io.BytesIO(content))
    total = len(reader.pages)
    step = (total + parts - 1) // parts
    out = []
    for start in range(0, total, step):
        writer = PdfWriter()
        chunk = reader.pages[start:start + step]
        for page in chunk:
            writer.add_page(page)
        buf = io.BytesIO()
        writer.write(buf)
        out.append((buf.getvalue(), len(chunk)))
    return out


def _ocr_by_parts(settings, content: bytes) -> list:
    """OCR a document too large for one request by splitting it on page ranges.

    The lossless fallback for files downsampling cannot fix: the 304-page
    wri-india-nup-report is 59MB of already-~72dpi imagery, so Ghostscript
    recovered 2MB at 300 dpi and 3MB at 150 dpi, while /ebook and /screen crashed
    outright. Nothing is left to downsample; the size is simply page count.

    Page INDICES are rebased onto the whole document as parts are stitched, so
    citations keep pointing at the right page — a part's page 1 is not the
    document's page 1.
    """
    size = len(content)
    # Aim comfortably under the cap: parts are uneven (the same file split in two
    # gave 49.6MB + 9.5MB — technically passing, with 0.4MB of headroom).
    target = int(MISTRAL_MAX_BYTES * 0.9)
    for parts in range(2, 11):
        pieces = _split_pdf(content, parts)
        largest = max(len(b) for b, _ in pieces)
        if largest <= target:
            logger.info("split %s MB document into %d parts (largest %s MB)",
                        _mb(size), len(pieces), _mb(largest))
            break
    else:
        raise RuntimeError(
            f"could not split a {_mb(size)} MB PDF into parts under the "
            f"{_mb(MISTRAL_MAX_BYTES)} MB OCR limit even at 10 parts — a single "
            "page may exceed the limit"
        )

    pages, page_offset = [], 0
    for i, (part_bytes, page_count) in enumerate(pieces, start=1):
        logger.info("OCR part %d/%d (%s MB, %d pages)",
                    i, len(pieces), _mb(len(part_bytes)), page_count)
        for page in _mistral_ocr_bytes(settings, part_bytes):
            page = dict(page)
            page["index"] = int(page.get("index", 0)) + page_offset
            pages.append(page)
        page_offset += page_count
    return pages


def _mistral_ocr_bytes(settings, content: bytes) -> list:
    """Upload one PDF, OCR it, delete the upload; return the raw `pages` array."""
    import requests

    file_id, signed_url = mistral_upload_and_sign(settings, "document.pdf", content)
    try:
        r = requests.post(
            f"{MISTRAL_API}/v1/ocr",
            headers={"Authorization": _mistral_auth_header(settings)},
            json={"model": settings.mistral_ocr_model,
                  "document": {"type": "document_url", "document_url": signed_url}},
            timeout=MISTRAL_OCR_TIMEOUT,
        )
        r.raise_for_status()
        return r.json().get("pages", [])
    finally:
        _mistral_delete_file(settings, file_id)


def mistral_pages_to_text(pages: list) -> tuple[str, list]:
    """Convert a Mistral OCR `pages` array to (full_text, page_boundaries).

    Public because scripts/batch_ocr.py submits the SAME documents through the
    Batch API and must produce byte-identical text and boundaries — text that
    differs by transport would make the parse cache serve one shape where the
    pipeline expects another.
    """
    page_texts, boundaries, pos = [], [], 0
    for i, page in enumerate(pages):
        text = (page.get("markdown") or "").strip()
        if text:
            page_texts.append(text)
            pos += len(text) + 2
            boundaries.append({"page": int(page.get("index", i)) + 1,
                               "end_pos": pos - 2})
    return "\n\n".join(page_texts), boundaries


def _parse_pdf(content: bytes) -> tuple[str, list]:
    if get_settings().parse_backend == "mistral":
        return _parse_pdf_mistral(content)
    return _parse_pdf_pypdf(content)


def _parse_model(settings) -> str:
    """The parser identity stamped alongside cached text. Empty for pypdf,
    which has no model — only the backend name distinguishes it.

    The stamp names the backend and the model, NOT this module's code version.
    Two consequences a future author must act on deliberately:
      - Changing what _parse_pdf_pypdf/_parse_pdf_mistral EMIT (the 2026-07-22
        per-page boundary fix is the precedent) does not invalidate anything: a
        re-ingest would cache-hit and quietly keep the old-format text. Re-run
        the campaign with FORCE_REPARSE=true, or bump this string.
      - MISTRAL_OCR_MODEL defaults to the 'mistral-ocr-latest' ALIAS, whose
        target Mistral can repoint under a stable name. Pin a dated model id
        per environment if you want an OCR upgrade to invalidate the cache
        on its own.
    """
    return settings.mistral_ocr_model if settings.parse_backend == "mistral" else ""


def _cached_parse(conn, doc) -> tuple[str, list] | None:
    """Reusable stored text for this document, or None (cache miss).

    Cache validity = same bytes + same parser: the stored stamps must match the
    document's current content_hash AND the worker's current backend/model.
    Misses on NULL stamps (every pre-Fix-1 row, and CSV-era rows with no
    content_hash), on changed bytes (a version replacement re-stamps
    documents.content_hash at intake), on a backend flip, and on an OCR model
    upgrade. FORCE_REPARSE=true skips the read path entirely.
    """
    settings = get_settings()
    if settings.force_reparse:
        return None
    if not doc.get("content_hash"):
        return None
    row = conn.execute(
        """SELECT full_text, page_boundaries, parsed_content_hash, parse_backend, parse_model
           FROM document_texts WHERE document_id = %s""",
        (doc["id"],),
    ).fetchone()
    if row is None:
        return None
    full_text, boundaries, parsed_hash, backend, model = row
    if parsed_hash is None or parsed_hash != doc["content_hash"]:
        return None
    if backend != settings.parse_backend or (model or "") != _parse_model(settings):
        return None
    if not (full_text or "").strip():
        return None
    return full_text, list(boundaries or [])


@stage("parse")
def run(document_id):
    with get_pool().connection() as conn:
        doc = fetch_document(conn, document_id)
        cached = _cached_parse(conn, doc)
        content = None
        if cached is not None:
            # Unchanged bytes, unchanged parser: reuse the stored text and skip
            # the download AND the OCR call. Everything downstream still runs —
            # metadata extraction below, then summarize/classify/embed under
            # whatever prompts are current. That is the point: a prompt-tuning
            # re-ingest campaign re-runs the cheap stages, not the OCR.
            logger.info(f"{doc['external_id']}: parse cache hit, skipping OCR")
            full_text, boundaries = cached
            # PDF-derived text, so the LLM metadata extraction below still applies.
            from_pdf = True
        else:
            content = _load_pdf_bytes(doc)
            from_pdf = content is not None
            if content is not None:
                full_text, boundaries = _parse_pdf(content)
            else:
                src = doc["source_metadata"] or {}
                summary = (src.get("metadata") or {}).get("summary") or src.get("summary") or ""
                if not summary:
                    logger.warning(f"{doc['external_id']}: no file and no summary -> needs_review")
                    conn.execute("UPDATE documents SET status='needs_review', updated_at=now() WHERE id=%s AND status <> 'withdrawn'",
                                 (document_id,))
                    return "needs_review"
                full_text, boundaries = f"{doc['title']}\n\n{summary}", []
        if not full_text.strip():
            # Even with no extractable text, try PDF embedded metadata (pypdf).
            if content is not None:
                try:
                    meta = _extract_pdf_metadata(content)
                    if meta["title"]:
                        conn.execute(
                            """UPDATE documents SET title = %s
                               WHERE id = %s AND (metadata_source->>'title' IS NULL OR metadata_source->>'title' = 'llm')""",
                            (meta["title"], document_id),
                        )
                        conn.execute(
                            """UPDATE documents SET metadata_source = metadata_source || jsonb_build_object('title', 'llm')
                               WHERE id = %s AND (metadata_source->>'title' IS NULL OR metadata_source->>'title' = 'llm')""",
                            (document_id,),
                        )
                    if meta["authors"]:
                        conn.execute(
                            """UPDATE documents SET authors = %s
                               WHERE id = %s AND (metadata_source->>'authors' IS NULL OR metadata_source->>'authors' = 'llm')""",
                            (meta["authors"], document_id),
                        )
                        conn.execute(
                            """UPDATE documents SET metadata_source = metadata_source || jsonb_build_object('authors', 'llm')
                               WHERE id = %s AND (metadata_source->>'authors' IS NULL OR metadata_source->>'authors' = 'llm')""",
                            (document_id,),
                        )
                except Exception:
                    pass
            conn.execute("UPDATE documents SET status='needs_review', updated_at=now() WHERE id=%s AND status <> 'withdrawn'",
                         (document_id,))
            return "needs_review"

        # LLM metadata extraction (best-effort). Overwrites a field only when its
        # provenance is NULL or 'llm' — never CSV ('external') or human ('human').
        # On re-ingest, a prior LLM extraction is overwritten (self-correcting).
        if from_pdf and full_text.strip():
            try:
                settings = get_settings()
                meta = _extract_metadata_llm(full_text, settings.worker_llm_model)

                # DOI: prefer the regex hit (more reliable when present) over the LLM.
                regex_doi = _extract_doi(full_text[:12000])
                if regex_doi:
                    meta["doi"] = regex_doi

                # Capture current values BEFORE overwriting so the audit records a
                # genuine before/after (advisory 2: filter no-op re-ingests).
                old_row = conn.execute(
                    f"SELECT {', '.join(_EXTRACT_FIELDS)} FROM documents WHERE id=%s",
                    (document_id,),
                ).fetchone()
                old_values = dict(zip(_EXTRACT_FIELDS, old_row))

                changes = []  # (field, old, new) — fields the guard actually overwrote AND changed
                for field in _EXTRACT_FIELDS:
                    value = meta.get(field)
                    if value is None:
                        continue
                    # Overwrite the column value only if provenance is NULL or 'llm'.
                    # Advisory 1: the collect decision keys off THIS statement's rowcount.
                    cur = conn.execute(
                        f"""UPDATE documents SET {field} = %s
                            WHERE id = %s AND (metadata_source->>'{field}' IS NULL OR metadata_source->>'{field}' = 'llm')""",
                        (value, document_id),
                    )
                    # Record provenance as 'llm' ONLY for fields we actually overwrote
                    # (same guard — don't clobber 'external'/'human' provenance).
                    conn.execute(
                        f"""UPDATE documents SET metadata_source = metadata_source || jsonb_build_object('{field}', 'llm')
                            WHERE id = %s AND (metadata_source->>'{field}' IS NULL OR metadata_source->>'{field}' = 'llm')""",
                        (document_id,),
                    )
                    # Audit only genuinely-overwritten fields: rowcount==1 (guard passed)
                    # AND old != new (advisory 2: drop before==after no-op re-ingests).
                    if cur.rowcount == 1 and old_values[field] != value:
                        changes.append((field, old_values[field], value))

                if changes:
                    audit_system_event(
                        conn, document_id, "update",
                        {field: old for field, old, _ in changes},
                        {field: new for field, _, new in changes},
                    )

                if meta.get("title"):
                    logger.info(f"{doc['external_id']}: LLM extracted title='{str(meta['title'])[:80]}'")
            except Exception:
                logger.warning(f"{doc['external_id']}: LLM metadata extraction failed (non-fatal)", exc_info=True)

        # Stamp what produced this text (bytes + parser identity) so an
        # unchanged re-ingest can skip the OCR call. Stamps are NULL when the
        # text did not come from a hashed PDF (CSV-era summary fallback), which
        # is exactly the miss the read path wants.
        settings = get_settings()
        stamp_hash = doc["content_hash"] if from_pdf else None
        # A shrunk parse is NOT the same product as a full-resolution one, but
        # content_hash (the ORIGINAL bytes) and the model id are identical for
        # both. Tag the stamp so the two are distinguishable. The read path
        # compares against the untagged identity, so a shrunk row never hits the
        # cache — it re-OCRs instead of silently serving downsampled text
        # forever once the cap is raised. `WHERE parse_model LIKE '%+gs%'`
        # finds every document that went through the shrink.
        was_shrunk = (stamp_hash and content is not None
                      and settings.parse_backend == "mistral"
                      and len(content) > MISTRAL_MAX_BYTES)
        stamp_model = _parse_model(settings) + (SHRINK_POLICY_TAG if was_shrunk else "")
        conn.execute(
            """INSERT INTO document_texts
                   (document_id, full_text, page_boundaries, char_count,
                    parsed_content_hash, parse_backend, parse_model)
               VALUES (%s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (document_id) DO UPDATE
               SET full_text = EXCLUDED.full_text, page_boundaries = EXCLUDED.page_boundaries,
                   char_count = EXCLUDED.char_count,
                   parsed_content_hash = EXCLUDED.parsed_content_hash,
                   parse_backend = EXCLUDED.parse_backend, parse_model = EXCLUDED.parse_model""",
            (document_id, full_text, Jsonb(boundaries), len(full_text),
             stamp_hash,
             settings.parse_backend if stamp_hash else None,
             stamp_model if stamp_hash else None),
        )
        # Record the pre-ingest status on the open job BEFORE flipping to
        # 'processing', so publish can restore a previously-searchable doc
        # instead of unpublishing it (issue #310). First write per job wins:
        # a reaped/retried parse re-runs with the doc already 'processing',
        # and overwriting would lose the real prior status.
        conn.execute(
            """UPDATE ingestion_jobs SET prior_status = d.status
               FROM documents d
               WHERE d.id = %s AND ingestion_jobs.document_id = d.id
                 AND ingestion_jobs.status = 'running'
                 AND ingestion_jobs.prior_status IS NULL""",
            (document_id,))
        conn.execute(
            "UPDATE documents SET status='processing', updated_at=now() WHERE id=%s AND status <> 'withdrawn'",
            (document_id,))
    return None
