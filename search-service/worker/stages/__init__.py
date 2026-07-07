"""Pipeline stage registry. STAGE_ORDER is the contract with worker.queue."""
from typing import Callable, Dict

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
