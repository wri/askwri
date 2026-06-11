"""Stage: parse the source PDF into full text + page boundaries.

Mirrors the legacy parse exactly (app/indexing.prepare_documents PDF branch):
pages joined with '\n\n', boundaries = [{'page': n, 'end_pos': cumulative}].
Documents with no retrievable file fall back to title+summary text when the
document has a long summary (CSV-imported docs); otherwise -> needs_review.
"""
import logging
import tempfile
from pathlib import Path

from psycopg.types.json import Jsonb

from app.config import get_settings
from app.db import get_pool
from worker.stages import fetch_document, stage

logger = logging.getLogger(__name__)


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
                conn.execute("UPDATE documents SET status='needs_review', updated_at=now() WHERE id=%s",
                             (document_id,))
                return "needs_review"
            full_text, boundaries = f"{doc['title']}\n\n{summary}", []
        if not full_text.strip():
            conn.execute("UPDATE documents SET status='needs_review', updated_at=now() WHERE id=%s",
                         (document_id,))
            return "needs_review"
        conn.execute(
            """INSERT INTO document_texts (document_id, full_text, page_boundaries, char_count)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (document_id) DO UPDATE
               SET full_text = EXCLUDED.full_text, page_boundaries = EXCLUDED.page_boundaries,
                   char_count = EXCLUDED.char_count""",
            (document_id, full_text, Jsonb(boundaries), len(full_text)),
        )
        conn.execute("UPDATE documents SET status='processing', updated_at=now() WHERE id=%s", (document_id,))
    return None
