# Phase 1 — Durable Ingestion + Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New documents become searchable without engineers: drop PDFs in S3 (or POST a metadata CSV), and a queue-driven Python worker parses, language-detects, summarizes, auto-tags, embeds, quality-gates, and publishes them incrementally into the Phase 0 Postgres store.

**Architecture:** A new `worker/` package inside the search-service codebase (same Docker image, different entrypoint, own ECS service) polls `ingestion_jobs` with `FOR UPDATE SKIP LOCKED` and runs each document through a resumable stage machine. Intake is bulk-first: an S3 watched prefix (worker-side) and a canonical-CSV import API (app-side). Retrieval lanes are **unchanged** — dense picks up new chunks instantly; BM25 refreshes via `/reindex` after publishes.

**Tech Stack:** Python 3.12 (worker: psycopg3, boto3, langdetect, OpenCC, openai, LlamaIndex PDFReader/SimpleNodeParser); Next.js + TypeORM (import API); Terraform/ECS (worker service); existing pytest/Jest harnesses.

**Spec:** design doc §7–§8, §17 Phase 1 (`docs/plans/2026-06-09-askwri-document-management-design.md`); handoff doc §2 (job contract); as-built reference `docs/document-management.md`. Codebase recon (verbatim terraform/S3/LLM patterns): `docs/research/2026-06-10-phase1-recon-notes.md` — referenced below as **RECON**.

---

## Scope decisions (read first)

1. **Sparse swap is OUT.** Per the 2026-06-10 decision, BGE-M3/sparse-model selection is a separate eval-gated track (`docs/research/2026-06-10-sparse-model-bakeoff-brief.md`). Phase 1 ships against the existing BM25 lane: new chunks enter dense retrieval immediately (SQL filter), and the worker POSTs `/reindex` to refresh BM25 after publishing.
2. **Parser default = existing `PDFReader`** (lean-core: "start with one parser"). GROBID/LlamaParse/Docling remain provider swaps later; the parse stage is isolated in one module to keep that swap cheap.
3. **Chunking/embedding identical to Phase 0** (SimpleNodeParser 400/80, summary node, `text-embedding-3-small`, legacy chunk-id format, `node_metadata` jsonb, `corpus_order` appended monotonically). New docs are corpus-order-appended, which matches legacy BM25 semantics (new docs were always appended at rebuild).
4. **Write-ownership amendment** (update `docs/document-management.md` in Task 12): the *ingestion domain* is worker-owned — for documents it ingests, the worker may INSERT `documents` (status `draft`) and write `document_texts`, `document_summaries`, `document_chunks`, LLM `document_tags`, `ingestion_jobs`, and `audit_log` rows. The app tier owns admin-driven CRUD (the CSV import API creates `documents` rows app-side) and ALL DDL. Human/external tag rows are never modified by the worker.
5. **LLM defaults (assumption — flag to owner):** summaries + tagging use `WORKER_LLM_MODEL` (default `gpt-5-mini`, override via env). Estimated marginal cost ≈ $0.02–0.05/document (2 summary calls + 1 tagging call + embeddings); the worker logs a cost estimate per batch before LLM stages run (Task 8).
6. **Multilingual v1:** doc-level language detection (`langdetect`), `id` (Indonesian) added to the language map (fixes the 2 mislabeled "Bahasa" docs on future re-ingest), zh chunk text normalized Traditional→Simplified via OpenCC at chunk time (original preserved in `document_texts`). Per-chunk language detection deferred.

## Human gates (proceed with defaults, flag in PR)

- **Taxonomy v1 curation** — auto-tagging classifies against whatever is in `tags`. Today that's 18 raw CSV values. The mechanism (Task 7) is taxonomy-agnostic; a domain owner should curate facets/values before auto-tags are trusted. Until then, all LLM tags land as `suggested` unless confidence ≥ 0.7.
- **NFR defaults assumed:** time-to-searchable ≤ 10 min/doc at queue depth ≤ 200; single worker instance; max 3 attempts/job.
- **RDS extension check:** none needed beyond Phase 0 (no new extensions).

## Key facts (verified — do not re-derive)

| Fact | Value |
|---|---|
| `ingestion_jobs` schema (exists, empty) | `id uuid, document_id uuid FK SET NULL, stage text, status text default 'queued', error text, attempts int default 0, model_versions jsonb, created_at/updated_at` + `idx_ingestion_jobs_status` |
| Legacy chunk-id format | `{external_id}_chunk_{n}` / `{external_id}_summary`; `chunk_index` -1 for summary; `unit_type` `text\|summary` |
| Chunk node metadata keys | doc_id, title(≤100), authors, year, subtag(≤50), program_series, chunk_id, chunk_index, total_chunks, page, chunk_start_pos, url, file_path, prev/next_chunk_id (+ is_summary_node on summaries) — see `app/indexing.py` |
| Embedding input | `node.get_content(metadata_mode=MetadataMode.EMBED)` (metadata + text), `text-embedding-3-small`, dim 1536 |
| `corpus_order` | global monotonic int; BM25 tie-break parity. New chunks append after current max. |
| DB access | `app/db.py` `get_pool()` (psycopg3 + pgvector adapters), `DATABASE_URL` |
| S3 | bucket `DOCUMENTS_S3_BUCKET`, docs under `DOCUMENTS_S3_PREFIX` (default `documents/`); task role already has Get/List on those prefixes (RECON §1) — **Put on `documents/*` + Get/Delete on `intake/*` must be added** (Task 11) |
| App-tier S3 pattern | `src/lib/eval-storage.ts` — `new S3Client({})`, ambient credentials (RECON §2) |
| App-tier LLM pattern | raw `fetch` to `${OPENAI_BASE_URL}/chat/completions`, json_schema → tool-call → json_object fallback waterfall (RECON §3) |
| Worker deploy pattern | mirror search-service ECS service minus ALB/port/service-discovery; same image, command override; same IAM roles; files to touch listed in RECON §1 |
| CI | `.github/workflows/pr-check.yml` + deploy workflows run `npm run test:ci`; Python suite not wired in |
| Existing tests | 45 pytest (incl. hermetic scratch-DB pattern in `tests/test_migration_script.py` — REUSE its fixtures), 26 Jest |

## File map

**Create (search-service):** `worker/__init__.py`, `worker/main.py`, `worker/queue.py`, `worker/intake_s3.py`, `worker/stages/__init__.py`, `worker/stages/parse.py`, `worker/stages/language.py`, `worker/stages/summarize.py`, `worker/stages/classify.py`, `worker/stages/embed.py`, `worker/stages/publish.py`, `worker/llm.py`, `tests/test_worker_queue.py`, `tests/test_worker_stages.py`, `tests/test_worker_pipeline.py`, `tests/fixtures/sample.pdf` (tiny 1-page PDF, committed)
**Create (app tier):** `src/app/api/import-documents/route.ts`, `src/db/queries/importDocuments.ts`, `src/db/entities/IngestionJob.entity.ts`, `src/__tests__/import-documents.test.ts`
**Modify:** `search-service/app/config.py`, `search-service/requirements.txt`, `search-service/Dockerfile` (worker entrypoint support — none needed if command override; verify), `terraform/infrastructure/{ecr,ecs,variables,security_groups}.tf`, `.github/workflows/{pr-check,deploy-qa,deploy-production}.yml`, `docs/document-management.md`, `docs/runbooks/phase0-cutover.md` (or new worker runbook section), `.env.example`, `src/db/data-source.ts` + `migration-data-source.ts` (register IngestionJob)

---

### Task 1: Worker settings, package skeleton, and main loop

**Files:** Create `search-service/worker/__init__.py` (empty), `search-service/worker/main.py`; modify `search-service/app/config.py`, `search-service/requirements.txt`, `.env.example`.

- [ ] **Step 1:** Append to `app/config.py` `Settings` (after `retrieval_backend`):

```python
    # Phase 1 ingestion worker
    worker_poll_seconds: int = 10
    worker_max_attempts: int = 3
    worker_llm_model: str = "gpt-5-mini"      # summaries + tagging; override in env
    intake_s3_prefix: str = "intake/"          # watched S3 prefix (bulk drop)
    intake_local_dir: str = ""                 # local-dev alternative to S3 intake
    documents_s3_bucket: str = ""              # reuse the existing env var name
    documents_s3_prefix: str = "documents/"
    tag_confidence_accept: float = 0.7         # >= -> accepted, else suggested
    quality_min_chars_per_page: int = 200      # extraction_confidence gate input
```

(pydantic-settings is case-insensitive: `DOCUMENTS_S3_BUCKET` etc. resolve from the existing env vars.)

- [ ] **Step 2:** Append to `requirements.txt`:

```
# Phase 1 ingestion worker
boto3>=1.34
langdetect>=1.0.9
opencc-python-reimplemented>=0.1.7
```

`./venv/bin/pip install -r requirements.txt`.

- [ ] **Step 3:** Write `worker/main.py`:

```python
"""Ingestion worker entrypoint: poll the queue, run pipeline stages.

Run:  cd search-service && ./venv/bin/python -m worker.main [--once]
The --once flag processes at most one intake sweep + one job, then exits
(used by tests and smoke checks).
"""
import argparse
import logging
import time

from app.config import get_settings
from worker import intake_s3, queue
from worker.stages import STAGE_ORDER, run_stage

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("worker")


def process_one_job() -> bool:
    """Claim and advance one job by one stage. Returns True if work was done."""
    settings = get_settings()
    claimed = queue.claim_job()
    if claimed is None:
        return False
    job_id, document_id, stage, attempts = claimed
    next_stage = queue.next_stage(stage)
    logger.info(f"job {job_id} doc {document_id}: running stage '{next_stage}' (attempt {attempts + 1})")
    try:
        outcome = run_stage(next_stage, document_id)
        if outcome == "needs_review":
            queue.mark_needs_review(job_id, next_stage)
        elif next_stage == STAGE_ORDER[-1]:
            queue.mark_done(job_id, next_stage)
        else:
            queue.advance(job_id, next_stage)
    except Exception as exc:  # noqa: BLE001 — every stage failure routes to retry/error
        logger.exception(f"job {job_id} stage '{next_stage}' failed")
        queue.mark_failed(job_id, next_stage, str(exc), attempts, settings.worker_max_attempts)
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    settings = get_settings()
    logger.info("Ingestion worker started")
    while True:
        swept = intake_s3.sweep()
        worked = process_one_job()
        if args.once:
            break
        if not swept and not worked:
            time.sleep(settings.worker_poll_seconds)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4:** Add to `.env.example` under a new `# Ingestion worker (Phase 1)` header: `WORKER_LLM_MODEL=gpt-5-mini`, `INTAKE_S3_PREFIX=intake/`, `# INTAKE_LOCAL_DIR=./intake` with one-line comments.
- [ ] **Step 5:** Commit: `feat: ingestion worker skeleton, settings, and main loop`

---

### Task 2: Job queue — claim, advance, retry (TDD against scratch DB)

**Files:** Create `search-service/worker/queue.py`, `search-service/tests/test_worker_queue.py`.

- [ ] **Step 1:** Write `worker/queue.py`:

```python
"""ingestion_jobs queue operations. One job = one document through all stages.

Claim model: status='queued' rows are claimable; FOR UPDATE SKIP LOCKED makes
concurrent workers safe. `stage` records the last COMPLETED stage (NULL at
enqueue); status transitions: queued -> running -> queued (next stage) ...
-> done | needs_review | error.
"""
import logging
import uuid
from typing import Optional, Tuple

from psycopg.types.json import Jsonb

from app.db import get_pool
from worker.stages import STAGE_ORDER

logger = logging.getLogger(__name__)

_CLAIM_SQL = """
    UPDATE ingestion_jobs
    SET status = 'running', updated_at = now()
    WHERE id = (
        SELECT id FROM ingestion_jobs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    RETURNING id, document_id, stage, attempts
"""


def enqueue(conn, document_id, model_versions: dict | None = None) -> uuid.UUID:
    """Insert a queued job for a document (idempotent: skips if an open job exists)."""
    row = conn.execute(
        """SELECT id FROM ingestion_jobs
           WHERE document_id = %s AND status IN ('queued', 'running', 'needs_review')""",
        (document_id,),
    ).fetchone()
    if row:
        return row[0]
    job_id = uuid.uuid4()
    conn.execute(
        """INSERT INTO ingestion_jobs (id, document_id, stage, status, model_versions)
           VALUES (%s, %s, NULL, 'queued', %s)""",
        (job_id, document_id, Jsonb(model_versions or {})),
    )
    return job_id


def claim_job() -> Optional[Tuple]:
    with get_pool().connection() as conn:
        return conn.execute(_CLAIM_SQL).fetchone()


def next_stage(completed_stage: Optional[str]) -> str:
    if completed_stage is None:
        return STAGE_ORDER[0]
    return STAGE_ORDER[STAGE_ORDER.index(completed_stage) + 1]


def advance(job_id, completed_stage: str) -> None:
    """Stage done; requeue for the next stage."""
    with get_pool().connection() as conn:
        conn.execute(
            """UPDATE ingestion_jobs
               SET status = 'queued', stage = %s, attempts = 0, error = NULL, updated_at = now()
               WHERE id = %s""",
            (completed_stage, job_id),
        )


def mark_done(job_id, completed_stage: str) -> None:
    with get_pool().connection() as conn:
        conn.execute(
            "UPDATE ingestion_jobs SET status='done', stage=%s, error=NULL, updated_at=now() WHERE id=%s",
            (completed_stage, job_id),
        )


def mark_needs_review(job_id, at_stage: str) -> None:
    with get_pool().connection() as conn:
        conn.execute(
            "UPDATE ingestion_jobs SET status='needs_review', stage=%s, updated_at=now() WHERE id=%s",
            (at_stage, job_id),
        )


def mark_failed(job_id, at_stage: str, error: str, attempts: int, max_attempts: int) -> None:
    """Retry (requeue, attempts+1) until max_attempts, then status='error'."""
    new_attempts = attempts + 1
    status = "error" if new_attempts >= max_attempts else "queued"
    with get_pool().connection() as conn:
        conn.execute(
            """UPDATE ingestion_jobs
               SET status=%s, attempts=%s, error=%s, updated_at=now()
               WHERE id=%s""",
            (status, new_attempts, error[:2000], job_id),
        )
    logger.warning(f"job {job_id} stage '{at_stage}' -> {status} (attempt {new_attempts}): {error[:200]}")
```

Note: a stage failure retries the SAME stage because `stage` (last completed) is unchanged and status returns to `queued`.

- [ ] **Step 2:** Write `tests/test_worker_queue.py` reusing the scratch-DB session fixture pattern from `tests/test_migration_script.py` (create `askwri_test`, apply migrations via subprocess, point `DATABASE_URL` at it, reset `app.db._pool`). Tests (all against the scratch DB; insert a minimal `documents` row first since `document_id` FK is nullable but we want realistic rows):
  - `test_enqueue_is_idempotent_while_open` — enqueue twice → one row; after `mark_done`, enqueue → second row.
  - `test_claim_sets_running_and_skips_locked` — enqueue 2 jobs using SEPARATE connections (same-transaction inserts share one `now()`, making created_at ordering ambiguous); claim → first by created_at, status running; claim again → second.
  - `test_full_stage_walk` — claim/advance through every stage in `STAGE_ORDER`; last advance via `mark_done` → status done.
  - `test_retry_then_error` — `mark_failed` twice with max_attempts=3 → status queued, attempts 2; third → status error.
  - `test_needs_review_not_claimable` — mark_needs_review → claim returns None.
- [ ] **Step 3:** Run: `./venv/bin/python -m pytest tests/test_worker_queue.py -v` → 5 passed. (STAGE_ORDER comes from Task 3's stages package — implement Tasks 2+3 Step 1 together if the import bites.)
- [ ] **Step 4:** Commit: `feat: ingestion job queue with skip-locked claiming and retries`

---

### Task 3: Stage registry and shared helpers

**Files:** Create `search-service/worker/stages/__init__.py`.

- [ ] **Step 1:**

```python
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
        """SELECT id, external_id, s3_key, title, language, languages, status, source_metadata
           FROM documents WHERE id = %s""",
        (document_id,),
    ).fetchone()
    if row is None:
        raise RuntimeError(f"document {document_id} not found")
    keys = ["id", "external_id", "s3_key", "title", "language", "languages", "status", "source_metadata"]
    return dict(zip(keys, row))
```

- [ ] **Step 2:** Commit with Task 2 or separately: `feat: pipeline stage registry`

---

### Task 4: Intake A — S3 watched prefix (+ local-dir mode)

**Files:** Create `search-service/worker/intake_s3.py`, tests in `tests/test_worker_stages.py` (intake section).

- [ ] **Step 1:** Write `worker/intake_s3.py`:

```python
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
           ON CONFLICT (external_id) DO NOTHING""",
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
```

- [ ] **Step 2:** Tests (scratch DB; local-dir mode only — S3 path is covered by the integration smoke in staging): register new file → documents row draft + job queued + audit row; same bytes again → 'duplicate', no second job; same filename different bytes → re-enqueues the existing external_id doc. Run → pass.
- [ ] **Step 3:** Commit: `feat: S3/local intake sweep with content-hash dedup`

---

### Task 5: Stage `parse` — PDF → document_texts

**Files:** Create `search-service/worker/stages/parse.py`; fixture `tests/fixtures/sample.pdf` (generate once with any 1-page PDF ≤ 50 KB; commit it).

- [ ] **Step 1:**

```python
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
```

- [ ] **Step 2:** Tests (scratch DB + fixture PDF via `INTAKE_LOCAL_DIR` layout): parse writes document_texts with char_count>0 and boundaries; re-run upserts (no duplicate-key error); empty/missing file with no summary → needs_review and document status flips. Run → pass.
- [ ] **Step 3:** Commit: `feat: parse stage (PDF -> document_texts, summary fallback)`

---

### Task 6: Stage `language` — detection + zh normalization prep

**Files:** Create `search-service/worker/stages/language.py`; tests in `tests/test_worker_stages.py`.

- [ ] **Step 1:**

```python
"""Stage: detect document language; record on documents.

LANGUAGE_MAP extends Phase 0's with Indonesian ('id') — the 2 'Bahasa' docs
mislabeled as 'en' get corrected on re-ingest. zh text is NOT mutated here;
Traditional->Simplified normalization happens at chunk time (embed stage) so
document_texts keeps the original for display (capture-rich principle).
"""
import logging

from app.db import get_pool
from worker.stages import fetch_document, stage

logger = logging.getLogger(__name__)

SUPPORTED = {"en", "es", "zh", "pt", "id"}


def detect(text: str) -> str:
    from langdetect import DetectorFactory, detect as _detect

    DetectorFactory.seed = 0  # deterministic
    sample = text[:5000]
    code = _detect(sample)
    if code.startswith("zh"):
        return "zh"
    return code if code in SUPPORTED else "en"


@stage("language")
def run(document_id):
    with get_pool().connection() as conn:
        fetch_document(conn, document_id)
        row = conn.execute(
            "SELECT full_text FROM document_texts WHERE document_id = %s", (document_id,)
        ).fetchone()
        lang = detect(row[0])
        conn.execute(
            "UPDATE documents SET language=%s, languages=%s, updated_at=now() WHERE id=%s",
            (lang, [lang], document_id),
        )
        logger.info(f"doc {document_id}: language={lang}")
    return None
```

- [ ] **Step 2:** Unit tests (no DB for `detect`): English/Spanish/Chinese/Portuguese sample paragraphs → expected codes; `zh-cn`/`zh-tw` both → `zh`; deterministic across runs. One scratch-DB test for the stage write. Run → pass.
- [ ] **Step 3:** Commit: `feat: language detection stage (incl. Indonesian)`

---

### Task 7: LLM helper + stage `summarize`

**Files:** Create `search-service/worker/llm.py`, `search-service/worker/stages/summarize.py`; tests with mocked LLM.

- [ ] **Step 1:** `worker/llm.py` — one thin helper (mirrors the app tier's raw-fetch pattern, python-side via `openai` client already in requirements):

```python
"""Shared LLM access for worker stages. JSON-schema structured output."""
import json
import logging
import os

logger = logging.getLogger(__name__)


def chat_json(system: str, user: str, schema: dict, model: str, max_tokens: int = 1500) -> dict:
    """One chat call with json_schema structured output; raises on failure."""
    from openai import OpenAI

    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    resp = client.chat.completions.create(
        model=model,
        max_completion_tokens=max_tokens,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        response_format={"type": "json_schema",
                         "json_schema": {"name": "result", "strict": True, "schema": schema}},
    )
    return json.loads(resp.choices[0].message.content)
```

- [ ] **Step 2:** `worker/stages/summarize.py`:

```python
"""Stage: generate native + English summaries (long + short).

Summarize-from-source in the target language (design §7.5) — never
translate-the-summary. Skips languages/kinds that already exist (idempotent;
also preserves CSV-imported 'external' summaries: they satisfy the existence
check, and the worker never overwrites rows it didn't write).
"""
import logging

from app.config import get_settings
from app.db import get_pool
from worker.llm import chat_json
from worker.stages import fetch_document, stage

logger = logging.getLogger(__name__)

_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {"long": {"type": "string"}, "short": {"type": "string"}},
    "required": ["long", "short"],
}
_LANG_NAMES = {"en": "English", "es": "Spanish", "zh": "Simplified Chinese", "pt": "Portuguese", "id": "Indonesian"}


def _summarize(text: str, title: str, lang: str, model: str) -> dict:
    return chat_json(
        system=(f"You summarize research publications in {_LANG_NAMES.get(lang, 'English')}. "
                "Return JSON with 'long' (120-180 words) and 'short' (max 40 words) summaries "
                "written in that language, faithful to the source."),
        user=f"Title: {title}\n\nDocument text (truncated):\n{text[:24000]}",
        schema=_SCHEMA, model=model,
    )


@stage("summarize")
def run(document_id):
    settings = get_settings()
    with get_pool().connection() as conn:
        doc = fetch_document(conn, document_id)
        text = conn.execute(
            "SELECT full_text FROM document_texts WHERE document_id=%s", (document_id,)
        ).fetchone()[0]
        existing = {(r[0], r[1]) for r in conn.execute(
            "SELECT language, kind FROM document_summaries WHERE document_id=%s", (document_id,)
        ).fetchall()}
        targets = {doc["language"], "en"}
        for lang in sorted(targets):
            if {(lang, "long"), (lang, "short")} <= existing:
                continue
            result = _summarize(text, doc["title"] or doc["external_id"], lang, settings.worker_llm_model)
            for kind in ("long", "short"):
                if (lang, kind) in existing:
                    continue
                conn.execute(
                    """INSERT INTO document_summaries (document_id, language, kind, text, source, model_version)
                       VALUES (%s,%s,%s,%s,'generated',%s)""",
                    (document_id, lang, kind, result[kind], settings.worker_llm_model),
                )
        # title_en convenience (design §7.5) when missing and doc is non-English
        if doc["language"] != "en":
            conn.execute(
                """UPDATE documents SET title_en = COALESCE(title_en, title), updated_at=now()
                   WHERE id=%s""", (document_id,))
    return None
```

(`title_en` proper translation is deliberately COALESCE-to-title in v1 — flagged as a known simplification; a translation call can replace it without schema change.)

- [ ] **Step 3:** Tests: monkeypatch `worker.llm.chat_json` to return canned summaries; assert native+en rows (4 for a zh doc, 2 for an en doc), idempotent re-run adds nothing, pre-existing `external` rows are not overwritten. Run → pass.
- [ ] **Step 4:** Commit: `feat: summarize stage (native + English, idempotent)`

---

### Task 8: Stage `classify` — auto-tagging against taxonomy v1

**Files:** Create `search-service/worker/stages/classify.py`; tests with mocked LLM.

- [ ] **Step 1:**

```python
"""Stage: LLM classification constrained to the controlled vocabulary.

Reads the live taxonomy from `tags`; emits per-facet selections with
confidence. Writes document_tags with source='llm' and status
'accepted' (confidence >= settings.tag_confidence_accept) or 'suggested'.
NEVER touches rows with source 'human' or 'external' (precedence, design §8).
Logs a cost estimate before calling the LLM.
"""
import logging

from psycopg.types.json import Jsonb  # noqa: F401  (audit use below)
from app.config import get_settings
from app.db import get_pool
from worker.llm import chat_json
from worker.stages import fetch_document, stage

logger = logging.getLogger(__name__)


def _schema(vocab: dict) -> dict:
    props = {
        facet: {
            "type": "array",
            "items": {"type": "object", "additionalProperties": False,
                      "properties": {"value": {"type": "string", "enum": values},
                                     "confidence": {"type": "number"}},
                      "required": ["value", "confidence"]},
        }
        for facet, values in vocab.items()
    }
    return {"type": "object", "additionalProperties": False,
            "properties": props, "required": list(props)}


@stage("classify")
def run(document_id):
    settings = get_settings()
    with get_pool().connection() as conn:
        doc = fetch_document(conn, document_id)
        vocab: dict[str, list] = {}
        tag_ids: dict[tuple, object] = {}
        for tag_id, facet, value in conn.execute(
            "SELECT id, facet, value_id FROM tags WHERE taxonomy_version='v1' ORDER BY facet, value_id"
        ).fetchall():
            vocab.setdefault(facet, []).append(value)
            tag_ids[(facet, value)] = tag_id
        if not vocab:
            logger.warning("classify: empty taxonomy — skipping")
            return None
        summary = conn.execute(
            """SELECT text FROM document_summaries
               WHERE document_id=%s AND language='en' AND kind='long'""", (document_id,)
        ).fetchone()
        basis = summary[0] if summary else conn.execute(
            "SELECT left(full_text, 8000) FROM document_texts WHERE document_id=%s", (document_id,)
        ).fetchone()[0]
        logger.info(f"classify {doc['external_id']}: 1 LLM call, model={settings.worker_llm_model}")
        result = chat_json(
            system=("Classify the document against the controlled vocabulary. For each facet pick zero or "
                    "more values that clearly apply, each with a confidence in [0,1]. Be conservative."),
            user=f"Title: {doc['title']}\n\nSummary/content:\n{basis}",
            schema=_schema(vocab), model=settings.worker_llm_model,
        )
        protected = {r[0] for r in conn.execute(
            """SELECT tag_id FROM document_tags
               WHERE document_id=%s AND source IN ('human','external')""", (document_id,)
        ).fetchall()}
        for facet, picks in result.items():
            for pick in picks:
                tag_id = tag_ids.get((facet, pick["value"]))
                if tag_id is None or tag_id in protected:
                    continue
                conf = max(0.0, min(1.0, float(pick["confidence"])))
                status = "accepted" if conf >= settings.tag_confidence_accept else "suggested"
                conn.execute(
                    """INSERT INTO document_tags (document_id, tag_id, source, confidence, model_version, status)
                       VALUES (%s,%s,'llm',%s,%s,%s)
                       ON CONFLICT (document_id, tag_id) DO NOTHING""",
                    (document_id, tag_id, conf, settings.worker_llm_model, status),
                )
    return None
```

- [ ] **Step 2:** Tests (mocked `chat_json`): accepted vs suggested by confidence threshold; human/external rows untouched (insert one `source='human'` row first, mock returns the same facet/value, assert row unchanged); empty taxonomy skips cleanly; out-of-vocab value from mock is ignored. Run → pass.
- [ ] **Step 3:** Commit: `feat: classify stage — vocabulary-constrained LLM tagging with provenance`

---

### Task 9: Stage `embed` — chunk + embed + corpus_order append

**Files:** Create `search-service/worker/stages/embed.py`; tests with fake embedder.

- [ ] **Step 1:**

```python
"""Stage: chunk the document and write embedded document_chunks rows.

Chunking is IDENTICAL to Phase 0 (SimpleNodeParser 400/80 + one summary node;
legacy chunk-id format; node_metadata verbatim) so retrieval semantics and
golden-set chunk references stay coherent. corpus_order appends after the
global max under an advisory lock (BM25 tie parity: append == legacy rebuild
behavior for new docs). Re-ingest deletes the doc's prior chunks first.
zh text is OpenCC-normalized (t2s) in chunk/summary TEXT (indexed form);
document_texts keeps the original.
"""
import logging

from psycopg.types.json import Jsonb

from app.config import get_settings
from app.db import get_pool
from worker.stages import fetch_document, stage

logger = logging.getLogger(__name__)
EMBEDDING_MODEL = "text-embedding-3-small"
DIMENSION = 1536
_LOCK_KEY = 0x636F7270  # 'corp' — corpus_order allocation lock


def _build_nodes_for_doc(doc, full_text: str, boundaries: list, summary: str):
    """Single-document version of app.indexing.build_nodes (same params/metadata)."""
    from llama_index.core.node_parser import SimpleNodeParser
    from llama_index.core.schema import Document, TextNode

    from app.indexing import get_page_number_for_position

    src = (doc["source_metadata"] or {}).get("metadata", {}) or {}
    base = {
        "doc_id": doc["external_id"],
        "title": (doc["title"] or "")[:100],
        "authors": (src.get("All authors") or "")[:100],
        "year": str(src.get("YEAR published") or ""),
        "subtag": (src.get("Sub-tag") or "")[:50] if isinstance(src.get("Sub-tag"), str) else "",
        "program_series": src.get("program_series", ""),
    }
    parser = SimpleNodeParser.from_defaults(chunk_size=400, chunk_overlap=80)
    nodes = parser.get_nodes_from_documents([Document(text=full_text, metadata=dict(base))])
    for idx, node in enumerate(nodes):
        start = full_text.find(node.text[:100])
        if start == -1:
            start = idx * (len(full_text) // max(len(nodes), 1))
        node.metadata.update({
            "chunk_id": f"{doc['external_id']}_chunk_{idx}",
            "chunk_index": idx, "total_chunks": len(nodes),
            "page": get_page_number_for_position(start, boundaries),
            "chunk_start_pos": start,
            "authors": base["authors"], "year": base["year"],
            "url": src.get("URL", ""), "file_path": doc["s3_key"],
            "program_series": base["program_series"],
            "prev_chunk_id": f"{doc['external_id']}_chunk_{idx-1}" if idx else None,
            "next_chunk_id": f"{doc['external_id']}_chunk_{idx+1}" if idx < len(nodes) - 1 else None,
        })
    if summary:
        nodes.append(TextNode(
            text=f"{doc['title']}\n\n{summary}" if doc["title"] else summary,
            metadata={**base, "chunk_id": f"{doc['external_id']}_summary", "chunk_index": -1,
                      "total_chunks": -1, "page": 1, "chunk_start_pos": 0,
                      "url": src.get("URL", ""), "file_path": doc["s3_key"],
                      "is_summary_node": True, "prev_chunk_id": None,
                      "next_chunk_id": f"{doc['external_id']}_chunk_0"},
        ))
    return nodes


def _embed_texts(texts: list) -> list:
    import os
    from llama_index.embeddings.openai import OpenAIEmbedding

    return OpenAIEmbedding(model=EMBEDDING_MODEL, api_key=os.getenv("OPENAI_API_KEY")) \
        .get_text_embedding_batch(texts)


@stage("embed")
def run(document_id):
    import numpy as np
    from llama_index.core.schema import MetadataMode

    with get_pool().connection() as conn:
        doc = fetch_document(conn, document_id)
        full_text, boundaries = conn.execute(
            "SELECT full_text, page_boundaries FROM document_texts WHERE document_id=%s",
            (document_id,),
        ).fetchone()
        summary_row = conn.execute(
            """SELECT text FROM document_summaries WHERE document_id=%s
               AND language=%s AND kind='long'""", (document_id, doc["language"]),
        ).fetchone()
        index_text = full_text
        if doc["language"] == "zh":
            from opencc import OpenCC
            index_text = OpenCC("t2s").convert(full_text)
        nodes = _build_nodes_for_doc(doc, index_text, boundaries, summary_row[0] if summary_row else "")
        logger.info(f"embed {doc['external_id']}: {len(nodes)} chunks, "
                    f"~{sum(len(n.text) for n in nodes)//4} tokens to {EMBEDDING_MODEL}")
        vectors = _embed_texts([n.get_content(metadata_mode=MetadataMode.EMBED) for n in nodes])

        conn.execute("SELECT pg_advisory_xact_lock(%s)", (_LOCK_KEY,))
        conn.execute("DELETE FROM document_chunks WHERE document_id=%s", (document_id,))
        next_order = conn.execute(
            "SELECT COALESCE(MAX(corpus_order), -1) + 1 FROM document_chunks"
        ).fetchone()[0]
        for offset, (node, vec) in enumerate(zip(nodes, vectors)):
            is_summary = bool(node.metadata.get("is_summary_node"))
            conn.execute(
                """INSERT INTO document_chunks
                   (document_id, legacy_chunk_id, chunk_index, unit_type, page, text,
                    language, node_metadata, embedding, embedding_model, dimension, corpus_order)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (document_id, node.metadata["chunk_id"], node.metadata.get("chunk_index", 0),
                 "summary" if is_summary else "text", node.metadata.get("page"),
                 node.text, doc["language"], Jsonb(dict(node.metadata)),
                 np.array(vec, dtype=np.float32), EMBEDDING_MODEL, DIMENSION, next_order + offset),
            )
    return None
```

- [ ] **Step 2:** Tests (scratch DB, monkeypatch `_embed_texts` → fake 1536-dim vectors): chunk rows with legacy ids + contiguous appended corpus_order above pre-existing max; summary chunk present when a native long summary exists; re-run replaces (no orphans, count stable); zh doc text normalized (feed Traditional sample, assert Simplified in chunk text while document_texts unchanged). Run → pass.
- [ ] **Step 3:** Commit: `feat: embed stage — phase0-identical chunking with corpus_order append`

---

### Task 10: Stage `publish` — quality gate + searchable + BM25 refresh

**Files:** Create `search-service/worker/stages/publish.py`; tests.

- [ ] **Step 1:**

```python
"""Stage: quality gate, then flip to searchable and refresh BM25.

extraction_confidence heuristic (cheap signals, design §7.9):
  0.4 * (chars/page >= settings.quality_min_chars_per_page, capped at 1)
+ 0.3 * (language detected in supported set)
+ 0.3 * (chunk count > 0)
< 0.7 -> needs_review (document + job), else searchable + best-effort
POST {SEARCH_SERVICE_URL}/reindex so the BM25 lane picks the doc up.
"""
import logging
import os

from app.config import get_settings
from app.db import get_pool
from worker.stages import fetch_document, stage
from worker.stages.language import SUPPORTED

logger = logging.getLogger(__name__)


def _confidence(conn, document_id, language) -> float:
    settings = get_settings()
    chars, pages = conn.execute(
        """SELECT char_count, GREATEST(jsonb_array_length(page_boundaries), 1)
           FROM document_texts WHERE document_id=%s""", (document_id,),
    ).fetchone()
    chunks = conn.execute(
        "SELECT count(*) FROM document_chunks WHERE document_id=%s", (document_id,)
    ).fetchone()[0]
    density = min((chars / pages) / settings.quality_min_chars_per_page, 1.0)
    return 0.4 * density + 0.3 * (1.0 if language in SUPPORTED else 0.0) + 0.3 * (1.0 if chunks else 0.0)


@stage("publish")
def run(document_id):
    with get_pool().connection() as conn:
        doc = fetch_document(conn, document_id)
        score = round(_confidence(conn, document_id, doc["language"]), 3)
        if score < 0.7:
            conn.execute(
                """UPDATE documents SET status='needs_review', extraction_confidence=%s,
                   updated_at=now() WHERE id=%s""", (score, document_id))
            logger.warning(f"{doc['external_id']}: confidence {score} -> needs_review")
            return "needs_review"
        conn.execute(
            """UPDATE documents SET status='searchable', extraction_confidence=%s,
               updated_at=now() WHERE id=%s""", (score, document_id))
        logger.info(f"{doc['external_id']}: searchable (confidence {score})")
    url = os.getenv("SEARCH_SERVICE_URL", "")
    if url:
        try:
            import httpx
            httpx.post(f"{url}/reindex", timeout=10)
        except Exception as exc:  # noqa: BLE001 — refresh is best-effort; dense lane is already live
            logger.warning(f"/reindex refresh failed (BM25 stale until restart): {exc}")
    return None
```

- [ ] **Step 2:** Tests: high-density doc → searchable + confidence recorded; sparse doc (chars/page below threshold, e.g. 50) → needs_review; `/reindex` failure does not fail the stage (monkeypatch httpx.post to raise). Run → pass.
- [ ] **Step 3:** Commit: `feat: publish stage — quality gate and BM25 refresh`

---

### Task 11: End-to-end worker pipeline test + intake-to-searchable smoke

**Files:** Create `search-service/tests/test_worker_pipeline.py`.

- [ ] **Step 1:** Test (scratch DB; `INTAKE_LOCAL_DIR` tmp layout with `tests/fixtures/sample.pdf`; monkeypatch `worker.llm.chat_json` (canned summaries + tags) and `worker.stages.embed._embed_texts` (fake vectors); seed two `tags` rows so classify has a vocabulary): call `intake_s3.sweep()` then loop `process_one_job()` until it returns False. Assert the full ledger: document searchable with extraction_confidence ≥ 0.7; document_texts row; ≥2 summaries; ≥1 llm document_tag; chunks with contiguous corpus_order and legacy ids; job status done with stage='publish'; audit rows for intake. Second sweep of the same file → duplicate-skipped, no new job.
- [ ] **Step 2:** Run the FULL python suite — all green, `qa` DB untouched.
- [ ] **Step 3:** Commit: `test: end-to-end ingestion pipeline (intake -> searchable)`

---

### Task 12: Intake B — canonical CSV import API (app tier)

**Files:** Create `src/app/api/import-documents/route.ts`, `src/db/queries/importDocuments.ts`, `src/db/entities/IngestionJob.entity.ts`, `src/__tests__/import-documents.test.ts`; modify both data-sources (register entity).

- [ ] **Step 1:** `IngestionJob.entity.ts` — map `ingestion_jobs` exactly (mirror the DDL: uuid PK default uuid_generate_v4(), `document_id` uuid nullable, `stage` text nullable, `status` text default 'queued', `error` text nullable, `attempts` int default 0, `model_versions` jsonb nullable, Create/UpdateDateColumn timestamptz; `@Index('idx_ingestion_jobs_status')` on status). Register in both data sources; run `npm run migration:generate` → expect "No changes" (drift check, as in Phase 0 Task 4).
- [ ] **Step 2:** `importDocuments.ts` — seed-mode import: input rows `{file_path, metadata (object), summary}` (the canonical/documents.csv shape). For each row: derive `external_id` (file_path minus `.pdf`), map fields exactly as the Python migration script does (title from `Article Title`→`Publication Title` fallback; languages via the same map INCLUDING `bahasa→id`; year parse; source_metadata = verbatim row). Upsert by `external_id` (`INSERT ... ON CONFLICT (external_id) DO UPDATE SET` only for NULL columns — seed semantics: never clobber non-null values). Status stays `draft`; create an `ingestion_jobs` row (status `queued`) per new/changed doc via the repository; write one `audit_log` row (`source='external'`, `action='import'`, counts). Return `{created, updated, skipped, jobs}`. Full code in the module; pure mapping helpers exported for tests.
- [ ] **Step 3:** Route: `POST /api/import-documents` — `initializeDatabase()`, body `{rows: [...], dryRun?: boolean}`; dryRun returns the per-row decision list without writing (run the mapping + upsert classification only). Follow the repo's route/error pattern.
- [ ] **Step 4:** Jest tests for the pure mappers (language map incl. bahasa→id, year parse, seed-upsert decision logic) + one `@jest-environment node` DB test gated on `DATABASE_URL` (import 2 synthetic rows into the LOCAL dev DB inside a transaction-like cleanup: delete the created rows in `afterAll` by external_id prefix `test-import-`).
- [ ] **Step 5:** `npm test` + `npm run lint` green. Commit: `feat: canonical CSV import API (seed mode) with dry-run`

---

### Task 13: Infra — worker ECS service, CI wiring, docs

**Files:** Modify `terraform/infrastructure/{ecr,ecs,variables,security_groups}.tf`, `.github/workflows/{pr-check,deploy-qa,deploy-production}.yml`, `docs/document-management.md`, `docs/runbooks/phase0-cutover.md`, `.env.example`.

- [ ] **Step 1:** Terraform — follow RECON §1 verbatim patterns ("Files that must be touched" table). Worker specifics: REUSE the search-service image/ECR repo (no new repo); task definition `ingestion-worker` with `command = ["python", "-m", "worker.main"]`, no portMappings, no init container, env: `RETRIEVAL_BACKEND` unset, `DATABASE_URL` via `ingestion_worker_secret_env`, `DOCUMENTS_S3_BUCKET/PREFIX`, `INTAKE_S3_PREFIX`, `SEARCH_SERVICE_URL=http://search-service.<namespace>.local:8000`, `OPENAI_API_KEY` secret, `WORKER_LLM_MODEL`; ECS service desired_count 1, no load_balancer, no service_registries; new SG egress-only + `rds_from_worker` rule. IAM: extend the existing task-role S3 policy with `s3:GetObject/DeleteObject` on `${intake_s3_prefix}*` and `s3:PutObject` on `${documents_s3_prefix}*`. `terraform validate` + `terraform plan` (qa var-file) must succeed; do NOT apply in this plan.
- [ ] **Step 2:** CI — `pr-check.yml`: add a `python-tests` job (setup-python 3.12, `pip install -r requirements.txt -r requirements-dev.txt`, run `pytest tests/test_indexing.py tests/test_worker_queue.py tests/test_worker_stages.py -v` — the hermetic + unit subset; DB-full subset needs a pgvector service container, add it with `REQUIRE_DB_TESTS=1` if runner minutes allow). Deploy workflows: include the worker service in `deploy-service` (`aws ecs update-service --force-new-deployment` + `wait services-stable`).
- [ ] **Step 3:** Docs — `docs/document-management.md`: ownership-amendment paragraph (Scope decision #4 above), intake section (S3 prefix flow + CSV import API), lifecycle update (`draft → processing → searchable/needs_review`, re-ingest semantics), worker ops (env vars, `--once`, retry semantics). Runbook: worker local-dev section (`INTAKE_LOCAL_DIR` + `--once` walkthrough) and deploy notes.
- [ ] **Step 4:** Full sweeps (`npm test`, `npm run lint`, python suite) green. Commit: `feat: ingestion worker infra, CI wiring, and docs`

---

## Definition of done (Phase 1)

1. All 13 tasks committed; Jest + Python suites green; `terraform plan` clean (apply is an ops action).
2. Local proof: drop `tests/fixtures/sample.pdf` into `INTAKE_LOCAL_DIR` → run `python -m worker.main --once` repeatedly → document reaches `searchable` with texts/summaries/tags/chunks; `/query` (postgres mode) returns its chunks after `/reindex`.
3. Golden-set evals against the unchanged 169-doc corpus show no drift (the pipeline only APPENDS; run `eval:cite` once after the e2e test corpus is cleaned from the local DB to confirm).
4. The two human gates (taxonomy curation, NFR sign-off) explicitly acknowledged in the PR description.

## Explicitly deferred

Sparse-model swap (bake-off brief governs), GROBID/layout-parser upgrade, authoritative-import precedence + dry-run field diff (only seed mode ships), per-chunk language detection, admin UI/review-queue UI (Phase 2 — `needs_review` rows are queryable via SQL until then), Zotero sync connector, SQS, typed attributes, works/versioning, title_en true translation, legacy-mode code removal.
