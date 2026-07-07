"""Stage: parse the source PDF into full text + page boundaries.

Mirrors the legacy parse exactly (app/indexing.prepare_documents PDF branch):
pages joined with '\n\n', boundaries = [{'page': n, 'end_pos': cumulative}].
Documents with no retrievable file fall back to title+summary text when the
document has a long summary (CSV-imported docs); otherwise -> needs_review.

J1: After parsing, extracts metadata (title, authors, DOI, year_published)
from the PDF's embedded metadata and first-page front-matter. Fill-only-empty:
never overwrites a non-NULL column (precedence: human > external > llm).
"""
import logging
import re
import tempfile
from pathlib import Path

from psycopg.types.json import Jsonb

from app.config import get_settings
from app.db import get_pool
from worker.stages import fetch_document, stage

logger = logging.getLogger(__name__)

# DOI pattern: matches 10.xxxx/something (the DOI prefix + suffix)
_DOI_RE = re.compile(r'10\.\d{4,}/\S+')
# Year pattern: a 4-digit year 19xx-20xx
_YEAR_RE = re.compile(r'\b(19\d{2}|20\d{2})\b')
# Author patterns: "Author(s):" or "By:" prefix, or a line that looks like names
_AUTHOR_PREFIX_RE = re.compile(r'^(?:Authors?|By|Autore?s)\s*[:\u00a0]\s*(.+)', re.IGNORECASE)


def _extract_doi(text: str) -> str | None:
    """Extract a DOI string from text. Returns '10.xxxx/something' or None."""
    match = _DOI_RE.search(text)
    if match:
        # Clean trailing punctuation that often follows a DOI in citation text
        return match.group(0).rstrip('.,;:)')
    return None


def _extract_year(text: str) -> int | None:
    """Extract a 4-digit year (19xx-20xx) from text. Returns the first match or None."""
    match = _YEAR_RE.search(text)
    return int(match.group(1)) if match else None


def _extract_title_from_text(page_texts: list[str]) -> str | None:
    """Heuristic: the first non-empty line of page 1 that looks like a title.
    A title is typically short (< 200 chars), not a page number/header,
    and is the first substantial line. Returns None if nothing looks like a title."""
    if not page_texts:
        return None
    first_page = page_texts[0]
    lines = [l.strip() for l in first_page.split('\n') if l.strip()]
    for line in lines[:5]:  # only look at the first 5 lines
        # Skip page numbers, URLs, very short fragments
        if len(line) < 10:
            continue
        if line.isdigit():
            continue
        if line.startswith('http'):
            continue
        # This looks like a title — return it (cap at 300 chars)
        return line[:300]
    return None


def _extract_authors_from_text(page_texts: list[str]) -> str | None:
    """Heuristic: look for 'Author(s):' or 'By:' prefix in the first 2 pages.
    Returns the text after the colon, or None."""
    for page_text in page_texts[:2]:
        for line in page_text.split('\n'):
            line = line.strip()
            match = _AUTHOR_PREFIX_RE.match(line)
            if match:
                authors = match.group(1).strip()
                if authors:
                    return authors[:500]  # cap length
    return None


def _extract_pdf_metadata(content: bytes) -> dict:
    """Extract title, author, DOI, year from the PDF's embedded metadata.
    Uses pypdf (available in the venv). Returns a dict with keys
    'title', 'authors', 'doi', 'year_published' — values are None if not found.
    Best-effort: wrapped in try/except so a failed extraction never breaks the stage."""
    result = {"title": None, "authors": None, "doi": None, "year_published": None}
    try:
        from pypdf import PdfReader
        import tempfile as _tempfile
        with _tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
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


def _extract_metadata(content: bytes, page_texts: list[str]) -> dict:
    """Full metadata extraction: PDF embedded metadata first, then first-page
    heuristics for what's missing. Returns a dict with keys
    'title', 'authors', 'doi', 'year_published' — values are None if not found.
    Best-effort: each source is independent and wrapped in try/except."""
    # Start with PDF embedded metadata
    meta = _extract_pdf_metadata(content)

    # Fall back to first-page heuristics for missing fields
    first_two_pages_text = '\n'.join(page_texts[:2]) if page_texts else ''

    if meta["title"] is None:
        try:
            meta["title"] = _extract_title_from_text(page_texts)
        except Exception:
            logger.debug("_extract_metadata: title heuristic failed", exc_info=True)

    if meta["authors"] is None:
        try:
            meta["authors"] = _extract_authors_from_text(page_texts)
        except Exception:
            logger.debug("_extract_metadata: authors heuristic failed", exc_info=True)

    try:
        meta["doi"] = _extract_doi(first_two_pages_text)
    except Exception:
        logger.debug("_extract_metadata: DOI extraction failed", exc_info=True)

    try:
        meta["year_published"] = _extract_year(first_two_pages_text)
    except Exception:
        logger.debug("_extract_metadata: year extraction failed", exc_info=True)

    return meta


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


def _parse_pdf(content: bytes) -> tuple[str, list]:
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


def _parse_pdf_pages(content: bytes) -> list[str]:
    """Return the list of page text strings (for metadata extraction heuristics).
    Separate from _parse_pdf to avoid double-parsing: call this only when
    metadata extraction is needed (content is not None)."""
    from llama_index.readers.file import PDFReader

    with tempfile.NamedTemporaryFile(suffix=".pdf") as tmp:
        tmp.write(content)
        tmp.flush()
        pages = PDFReader().load_data(tmp.name)
    return [page.text.strip() for page in pages if page.text.strip()]


@stage("parse")
def run(document_id):
    with get_pool().connection() as conn:
        doc = fetch_document(conn, document_id)
        content = _load_pdf_bytes(doc)
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
            # Even with no extractable text, try metadata extraction (the PDF
            # may have /Title and /Author even if text extraction failed).
            if content is not None:
                try:
                    meta = _extract_pdf_metadata(content)
                    if meta["title"]:
                        conn.execute(
                            """UPDATE documents SET title = %s
                               WHERE id = %s AND (title IS NULL OR title = external_id)""",
                            (meta["title"], document_id),
                        )
                    if meta["authors"]:
                        conn.execute(
                            "UPDATE documents SET authors = COALESCE(authors, %s) WHERE id = %s",
                            (meta["authors"], document_id),
                        )
                except Exception:
                    pass
            conn.execute("UPDATE documents SET status='needs_review', updated_at=now() WHERE id=%s AND status <> 'withdrawn'",
                         (document_id,))
            return "needs_review"

        # J1: Extract metadata from the PDF (best-effort, fill-only-empty).
        # Precedence: human > external > llm — never overwrite a non-NULL column.
        # Exception: intake_s3._register sets title=external_id (the filename slug)
        # as a placeholder. That placeholder is overwritten by a real extraction,
        # because it's not a real title — just a filename stem.
        if content is not None:
            try:
                page_text_list = _parse_pdf_pages(content)
                meta = _extract_metadata(content, page_text_list)
                # Title: overwrite only if the current title is NULL or the intake slug (= external_id)
                if meta["title"]:
                    conn.execute(
                        """UPDATE documents SET title = %s
                           WHERE id = %s AND (title IS NULL OR title = external_id)""",
                        (meta["title"], document_id),
                    )
                # Other columns: strict fill-only-empty (COALESCE)
                conn.execute(
                    """UPDATE documents SET
                           authors = COALESCE(authors, %s),
                           doi = COALESCE(doi, %s),
                           year_published = COALESCE(year_published, %s)
                       WHERE id = %s""",
                    (meta["authors"], meta["doi"], meta["year_published"],
                     document_id),
                )
                if meta["title"]:
                    logger.info(f"{doc['external_id']}: extracted title='{meta['title'][:80]}'")
            except Exception:
                logger.warning(f"{doc['external_id']}: metadata extraction failed (non-fatal)", exc_info=True)

        conn.execute(
            """INSERT INTO document_texts (document_id, full_text, page_boundaries, char_count)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (document_id) DO UPDATE
               SET full_text = EXCLUDED.full_text, page_boundaries = EXCLUDED.page_boundaries,
                   char_count = EXCLUDED.char_count""",
            (document_id, full_text, Jsonb(boundaries), len(full_text)),
        )
        conn.execute(
            "UPDATE documents SET status='processing', updated_at=now() WHERE id=%s AND status <> 'withdrawn'",
            (document_id,))
    return None
