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
import tempfile
from pathlib import Path

from psycopg.types.json import Jsonb

from app.config import get_settings
from app.db import get_pool
from worker.stages import audit_system_event, fetch_document, stage

logger = logging.getLogger(__name__)

# DOI pattern: matches 10.xxxx/something (the DOI prefix + suffix)
_DOI_RE = re.compile(r'10\.\d{4,}/\S+')

# The fields the LLM extracts, mapped to their DB column names.
_EXTRACT_FIELDS = ["title", "title_en", "authors", "doi", "year_published",
                   "article_type", "wri_primary_office"]

# JSON schema for the LLM structured-output call.
_EXTRACT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "title": {"type": ["string", "null"]},
        "title_en": {"type": ["string", "null"]},
        "authors": {"type": ["string", "null"]},
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
            "(semicolon-separated full names), doi (the DOI string if present, "
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
            "AUTHORS. Transliterate every author name into the Latin alphabet, "
            "e.g. '薛露露' -> 'Xue, Lulu'. When the document itself prints a "
            "romanized form of a name, use that spelling rather than your own. "
            "Return only the transliterated names — never the native script."
        ),
        user=f"Document text (first ~12000 chars):\n{full_text[:12000]}",
        schema=_EXTRACT_SCHEMA,
        model=model,
        max_tokens=1000,
    )
    # Normalize: ensure all expected keys exist
    return {f: result.get(f) for f in _EXTRACT_FIELDS}


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


def _parse_pdf_mistral(content: bytes) -> tuple[str, list]:
    """Mistral OCR (spec §7 as amended 2026-07-22): per-page markdown.
    Boundaries carry the PARSER's page indices, so a page that comes back
    empty (full-bleed graphic) doesn't shift later pages' labels — this is
    what structurally fixes R4 (zh boundaries vs OpenCC length changes)."""
    import base64

    import requests

    settings = get_settings()
    if not settings.mistral_api_key:
        raise RuntimeError("PARSE_BACKEND=mistral requires MISTRAL_API_KEY")
    data_uri = ("data:application/pdf;base64,"
                + base64.b64encode(content).decode())
    r = requests.post(
        "https://api.mistral.ai/v1/ocr",
        headers={"Authorization": _mistral_auth_header(settings)},
        json={"model": settings.mistral_ocr_model,
              "document": {"type": "document_url", "document_url": data_uri}},
        timeout=900,
    )
    r.raise_for_status()
    pages = r.json().get("pages", [])
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
             _parse_model(settings) if stamp_hash else None),
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
