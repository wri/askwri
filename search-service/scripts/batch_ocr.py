"""Bulk OCR via the Mistral Batch API — 50% cheaper than per-document calls.

Fix 3 of docs/plans/2026-08-05-ocr-cache-shrink-batch.md. This is a GATED OPS
SCRIPT, not a worker change: the worker's per-document sequential pipeline is
the wrong shape for batch (one async job, results arrive together).

When this is worth running: a bulk NEW-corpus import, or a re-OCR campaign after
an OCR-model upgrade. It is NOT for ordinary prompt-tuning re-ingests — with the
parse cache (Fix 1) those already make zero OCR calls.

How it works:
  1. Select documents that would MISS the parse cache (NULL or lapsed stamps).
  2. Upload each PDF to Mistral with purpose='ocr' and take a signed URL.
     The batch JSONL references that URL — it never inlines base64, which would
     make one line ~67MB for a 50MB PDF. (Verified against the live API
     2026-08-05: batch jobs accept signed-URL document_url entries.)
  3. Submit one batch job against endpoint=/v1/ocr and poll it to completion.
  4. Write document_texts + the Fix-1 cache stamps, then enqueue each document
     so the normal pipeline runs language→summarize→classify→embed→publish with
     a GUARANTEED parse cache hit — no second OCR bill.

DRY RUN IS THE DEFAULT. It performs no uploads, no job, and no writes; it prints
the selected documents and the exact JSONL/job payload shape. Pass --execute to
actually spend money and write to the database.

Run: cd search-service && ./venv/bin/python -m scripts.batch_ocr
     cd search-service && ./venv/bin/python -m scripts.batch_ocr --execute
     cd search-service && ./venv/bin/python -m scripts.batch_ocr --ids <uuid>,<uuid>
"""
import argparse
import json
import logging
import time

import requests
from psycopg.types.json import Jsonb

from app.config import get_settings
from app.db import get_pool
from worker.queue import enqueue
from worker.stages.parse import (
    MISTRAL_API as API,
    MISTRAL_MAX_BYTES,
    _load_pdf_bytes,
    _mistral_auth_header,
    _parse_model,
    mistral_pages_to_text,
    mistral_upload_and_sign,
)

logger = logging.getLogger(__name__)

BATCH_ENDPOINT = "/v1/ocr"

# Documents whose stored text did not come from this exact parser configuration
# — i.e. exactly the set worker/stages/parse.py::_cached_parse would re-OCR.
_TARGET_SQL = """
    SELECT d.id, d.external_id, d.s3_key, d.content_hash
    FROM documents d
    LEFT JOIN document_texts dt ON dt.document_id = d.id
    WHERE d.status <> 'withdrawn'
      AND d.s3_key IS NOT NULL
      AND d.content_hash IS NOT NULL
      AND (dt.parsed_content_hash IS NULL
           OR dt.parsed_content_hash <> d.content_hash
           OR dt.parse_backend IS DISTINCT FROM %s
           OR dt.parse_model IS DISTINCT FROM %s)
"""


def select_targets(conn, model: str, ids: list[str] | None = None) -> list[dict]:
    """Documents that would miss the parse cache under the current settings."""
    sql, params = _TARGET_SQL, ["mistral", model]
    if ids is not None:
        if not ids:
            return []
        sql += " AND d.id = ANY(%s)"
        params.append(ids)
    sql += " ORDER BY d.created_at, d.external_id"
    rows = conn.execute(sql, params).fetchall()
    keys = ["id", "external_id", "s3_key", "content_hash"]
    return [dict(zip(keys, r)) for r in rows]


def build_entry(custom_id: str, signed_url: str) -> dict:
    """One JSONL line. `body` must match the /v1/ocr request shape."""
    return {"custom_id": custom_id,
            "body": {"document": {"type": "document_url",
                                  "document_url": signed_url}}}


def build_job_payload(input_file_id: str, model: str) -> dict:
    return {"input_files": [input_file_id], "model": model,
            "endpoint": BATCH_ENDPOINT, "metadata": {"source": "askwri-batch-ocr"}}


def _submit(settings, entries: list[dict], model: str) -> str:
    headers = {"Authorization": _mistral_auth_header(settings)}
    jsonl = "".join(json.dumps(e) + "\n" for e in entries).encode()
    logger.info("uploading batch JSONL: %d entries, %d bytes", len(entries), len(jsonl))
    r = requests.post(f"{API}/v1/files", headers=headers,
                      files={"file": ("batch.jsonl", jsonl, "application/jsonl")},
                      data={"purpose": "batch"}, timeout=600)
    r.raise_for_status()
    r = requests.post(f"{API}/v1/batch/jobs", headers=headers,
                      json=build_job_payload(r.json()["id"], model), timeout=120)
    r.raise_for_status()
    return r.json()["id"]


def _poll(settings, job_id: str, interval: int, timeout_s: int) -> dict:
    headers = {"Authorization": _mistral_auth_header(settings)}
    deadline = time.monotonic() + timeout_s
    while True:
        r = requests.get(f"{API}/v1/batch/jobs/{job_id}", headers=headers, timeout=120)
        r.raise_for_status()
        job = r.json()
        status = job.get("status")
        logger.info("job %s: %s (succeeded=%s failed=%s)", job_id, status,
                    job.get("succeeded_requests"), job.get("failed_requests"))
        if status in ("SUCCESS", "FAILED", "TIMEOUT_EXCEEDED", "CANCELLED"):
            return job
        if time.monotonic() > deadline:
            raise RuntimeError(
                f"batch job {job_id} still {status} after {timeout_s}s — it is not "
                "lost; re-run with --resume-job to collect results later"
            )
        time.sleep(interval)


def _fetch_results(settings, output_file_id: str) -> dict[str, list]:
    """custom_id -> the OCR `pages` array."""
    r = requests.get(f"{API}/v1/files/{output_file_id}/content",
                     headers={"Authorization": _mistral_auth_header(settings)},
                     timeout=900)
    r.raise_for_status()
    results = {}
    for line in r.text.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        resp = row.get("response") or {}
        if row.get("error") or resp.get("status_code") != 200:
            logger.warning("entry %s failed: %s", row.get("custom_id"),
                           json.dumps(row.get("error"))[:300])
            continue
        results[row["custom_id"]] = (resp.get("body") or {}).get("pages", [])
    return results


def write_results(conn, targets_by_id: dict[str, dict], results: dict[str, list],
                  model: str) -> int:
    """Store OCR text with Fix-1 cache stamps, then enqueue the pipeline.

    The stamps are the point: the enqueued run re-parses with a guaranteed cache
    hit, so summarize/classify/embed/publish happen without a second OCR bill.
    """
    written = 0
    for custom_id, pages in results.items():
        doc = targets_by_id.get(custom_id)
        if doc is None:
            logger.warning("result for unknown custom_id %s — skipped", custom_id)
            continue
        full_text, boundaries = mistral_pages_to_text(pages)
        if not full_text.strip():
            logger.warning("%s: batch OCR returned no text — left for the worker",
                           doc["external_id"])
            continue
        conn.execute(
            """INSERT INTO document_texts
                   (document_id, full_text, page_boundaries, char_count,
                    parsed_content_hash, parse_backend, parse_model)
               VALUES (%s, %s, %s, %s, %s, 'mistral', %s)
               ON CONFLICT (document_id) DO UPDATE
               SET full_text = EXCLUDED.full_text,
                   page_boundaries = EXCLUDED.page_boundaries,
                   char_count = EXCLUDED.char_count,
                   parsed_content_hash = EXCLUDED.parsed_content_hash,
                   parse_backend = EXCLUDED.parse_backend,
                   parse_model = EXCLUDED.parse_model""",
            (doc["id"], full_text, Jsonb(boundaries), len(full_text),
             doc["content_hash"], model),
        )
        enqueue(conn, doc["id"])
        written += 1
    return written


def run(ids=None, execute=False, limit=None, poll_interval=30, poll_timeout=86400) -> int:
    settings = get_settings()
    model = _parse_model(settings) or settings.mistral_ocr_model

    with get_pool().connection() as conn:
        targets = select_targets(conn, model, ids)
    if limit:
        targets = targets[:limit]
    if not targets:
        logger.info("no documents need OCR — every candidate already has current cache stamps")
        return 0

    logger.info("%d document(s) would miss the parse cache", len(targets))

    if not execute:
        # Dry run: no uploads, no job, no writes. Show the exact payload shape.
        sample = build_entry(targets[0]["external_id"], "<signed-url>")
        print(f"\n--- DRY RUN ({len(targets)} documents) ---")
        for t in targets[:20]:
            print(f"  {t['external_id']}  {t['s3_key']}")
        if len(targets) > 20:
            print(f"  ... and {len(targets) - 20} more")
        print(f"\nJSONL entry shape:\n  {json.dumps(sample)}")
        print(f"\nJob payload:\n  {json.dumps(build_job_payload('<file-id>', model))}")
        print("\nRe-run with --execute to upload, submit, and write results.\n")
        return 0

    if not settings.mistral_api_key:
        raise RuntimeError("batch OCR requires MISTRAL_API_KEY")

    entries, kept = [], {}
    for doc in targets:
        content = _load_pdf_bytes(doc)
        if content is None:
            logger.warning("%s: no retrievable file — skipped", doc["external_id"])
            continue
        if len(content) > MISTRAL_MAX_BYTES:
            # The sync path shrinks these with Ghostscript and tags the stamp so
            # the row never cache-hits. Batching them would spend money on text
            # the follow-up pipeline pass would re-OCR anyway.
            logger.warning("%s: %.1f MB exceeds the OCR limit — leave it to the "
                           "worker's shrink path", doc["external_id"],
                           len(content) / 1024 / 1024)
            continue
        _, signed_url = mistral_upload_and_sign(
            settings, f"{doc['external_id']}.pdf", content)
        entries.append(build_entry(doc["external_id"], signed_url))
        kept[doc["external_id"]] = doc
        logger.info("uploaded %s (%d entries ready)", doc["external_id"], len(entries))

    if not entries:
        logger.info("nothing uploadable — no batch submitted")
        return 0

    job_id = _submit(settings, entries, model)
    logger.info("submitted batch job %s", job_id)
    job = _poll(settings, job_id, poll_interval, poll_timeout)
    if job.get("status") != "SUCCESS":
        raise RuntimeError(f"batch job {job_id} ended {job.get('status')}: "
                           f"{json.dumps(job.get('errors'))[:500]}")

    results = _fetch_results(settings, job["output_file"])
    with get_pool().connection() as conn:
        written = write_results(conn, kept, results, model)
    logger.info("wrote %d document_texts rows and enqueued them (job %s)", written, job_id)
    return written


def _parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--ids", type=lambda v: [s.strip() for s in v.split(",") if s.strip()],
                   default=None, help="comma-separated document ids (default: all cache misses)")
    p.add_argument("--limit", type=int, default=None, help="cap the number of documents")
    p.add_argument("--execute", action="store_true",
                   help="actually upload, submit, and write (default is a dry run)")
    p.add_argument("--poll-interval", type=int, default=30, help="seconds between status polls")
    p.add_argument("--poll-timeout", type=int, default=86400, help="seconds to wait for the job")
    return p.parse_args(argv)


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    args = _parse_args(argv)
    try:
        run(ids=args.ids, execute=args.execute, limit=args.limit,
            poll_interval=args.poll_interval, poll_timeout=args.poll_timeout)
    finally:
        get_pool().close()
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
