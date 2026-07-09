"""Pipeline stage registry. STAGE_ORDER is the contract with worker.queue."""
import logging
from typing import Callable, Dict

from psycopg.types.json import Jsonb

logger = logging.getLogger(__name__)

STAGE_ORDER = ["parse", "language", "summarize", "classify", "embed", "publish"]

_REGISTRY: Dict[str, Callable] = {}


def stage(name: str):
    def deco(fn):
        _REGISTRY[name] = fn
        return fn
    return deco


def run_stage(name: str, document_id) -> str | None:
    """Run a stage for a document. Returns 'needs_review' to divert, else None.

    Stages are imported lazily so worker.queue can import STAGE_ORDER without
    pulling LLM/S3 deps (keeps queue unit tests hermetic).
    """
    if name not in _REGISTRY:
        from worker.stages import parse, language, summarize, classify, embed, publish  # noqa: F401
    return _REGISTRY[name](document_id)


def fetch_document(conn, document_id):
    """Common per-stage document fetch: returns dict row or raises."""
    row = conn.execute(
        """SELECT id, external_id, s3_key, title, language, languages, status, source_metadata, metadata_source
           FROM documents WHERE id = %s""",
        (document_id,),
    ).fetchone()
    if row is None:
        raise RuntimeError(f"document {document_id} not found")
    keys = ["id", "external_id", "s3_key", "title", "language", "languages", "status", "source_metadata", "metadata_source"]
    return dict(zip(keys, row))


def audit_system_event(conn, document_id, action, before, after):
    """Best-effort 'system' audit row for a worker-driven document change.

    Mirrors the Node writers (source='system', actor_user_id NULL,
    entity_type='document', entity_id=<doc id>) so the History panel renders
    it with zero UI changes. Wrapped in a SAVEPOINT so a failed insert rolls
    back to the savepoint WITHOUT poisoning the stage's outer transaction, and
    swallowed + logged so auditing is observability, never a pipeline invariant.
    The same-transaction guarantee assumes the pooled connection is not
    autocommit (a stage statement has already opened the outer transaction).
    """
    try:
        with conn.transaction():
            conn.execute(
                """INSERT INTO audit_log (source, action, entity_type, entity_id, before, after)
                   VALUES ('system', %s, 'document', %s, %s, %s)""",
                (action, document_id, Jsonb(before), Jsonb(after)),
            )
    except Exception:  # noqa: BLE001 — auditing is observability, not a pipeline invariant
        logger.warning(
            "audit_system_event(%s, %s) failed (non-fatal)", action, document_id, exc_info=True
        )
