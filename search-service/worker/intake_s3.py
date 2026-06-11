"""Bulk intake: register new files from the watched S3 prefix (or a local dir).

Every discovered PDF becomes: content-hash dedup check -> documents row
(status 'draft') -> ingestion_jobs row -> object moved out of intake/ into
documents/. Identical content_hash -> skip (idempotent re-drops), object
removed from intake. Audit rows record every decision.
"""
import hashlib
import logging
import uuid
from pathlib import Path

from psycopg.types.json import Jsonb

from app.config import get_settings
from app.db import get_pool
from worker import queue

logger = logging.getLogger(__name__)


def _register(conn, filename: str, content: bytes) -> str:
    """Returns 'new' | 'duplicate'. Inserts documents+job+audit when new."""
    content_hash = hashlib.sha256(content).hexdigest()
    dup = conn.execute(
        "SELECT external_id FROM documents WHERE content_hash = %s", (content_hash,)
    ).fetchone()
    if dup:
        logger.info(f"intake: {filename} duplicates {dup[0]} — skipping")
        conn.execute(
            """INSERT INTO audit_log (source, action, entity_type, after)
               VALUES ('system', 'import', 'documents', %s)""",
            (Jsonb({"intake": filename, "result": "duplicate_skipped", "of": dup[0]}),),
        )
        return "duplicate"

    external_id = Path(filename).stem
    settings = get_settings()
    doc_id = uuid.uuid4()
    conn.execute(
        """INSERT INTO documents (id, external_id, s3_key, title, status, content_hash)
           VALUES (%s, %s, %s, %s, 'draft', %s)
           ON CONFLICT (external_id) DO UPDATE SET content_hash = EXCLUDED.content_hash""",
        (doc_id, external_id, f"{settings.documents_s3_prefix}{filename}", external_id, content_hash),
    )
    existing = conn.execute(
        "SELECT id FROM documents WHERE external_id = %s", (external_id,)
    ).fetchone()
    doc_id = existing[0]  # ON CONFLICT path: same external_id, new content -> re-ingest existing doc
    queue.enqueue(conn, doc_id)
    conn.execute(
        """INSERT INTO audit_log (source, action, entity_type, entity_id, after)
           VALUES ('system', 'import', 'documents', %s, %s)""",
        (doc_id, Jsonb({"intake": filename, "result": "registered", "content_hash": content_hash})),
    )
    return "new"


def sweep() -> bool:
    """One intake pass. Returns True if anything was processed."""
    settings = get_settings()
    if settings.intake_local_dir:
        return _sweep_local(Path(settings.intake_local_dir))
    if settings.documents_s3_bucket:
        return _sweep_s3()
    return False


def _sweep_local(intake_dir: Path) -> bool:
    if not intake_dir.is_dir():
        return False
    processed = False
    docs_dir = intake_dir.parent / "documents"
    docs_dir.mkdir(exist_ok=True)
    for pdf in sorted(intake_dir.glob("*.pdf")):
        content = pdf.read_bytes()
        with get_pool().connection() as conn:
            _register(conn, pdf.name, content)
        pdf.rename(docs_dir / pdf.name)
        processed = True
    return processed


def _sweep_s3() -> bool:
    import boto3

    settings = get_settings()
    s3 = boto3.client("s3")
    bucket = settings.documents_s3_bucket
    resp = s3.list_objects_v2(Bucket=bucket, Prefix=settings.intake_s3_prefix, MaxKeys=50)
    processed = False
    for obj in resp.get("Contents", []):
        key = obj["Key"]
        if not key.lower().endswith(".pdf"):
            continue
        filename = key.split("/")[-1]
        content = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        with get_pool().connection() as conn:
            _register(conn, filename, content)
        s3.copy_object(Bucket=bucket, Key=f"{settings.documents_s3_prefix}{filename}",
                       CopySource={"Bucket": bucket, "Key": key})
        s3.delete_object(Bucket=bucket, Key=key)
        processed = True
    return processed
