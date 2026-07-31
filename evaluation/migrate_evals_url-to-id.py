#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# STALE OUTPUT FORMAT — this script's output was hand-edited after generation
# ---------------------------------------------------------------------------
# `evaluation/golden-dataset.doc-ids.json` (produced by this script, then
# manually cleaned up on 2026-07-31) no longer matches what this script
# actually emits. If you re-run this script as-is, it will regenerate the
# OLD shape below and someone will have to redo the manual edits by hand.
#
# Before relying on this script again, update it to emit the FINAL/DESIRED
# shape directly:
#
#   Per test case (test_cases[i]):
#     - `expected_document_ids` only. NO `expected_urls` (drop the source
#       URLs instead of keeping them alongside for audit), and NO
#       `expected_count` / `expected_document_ids_count` companion fields.
#     - Field order: id, question, task_description, expected_document_ids,
#       difficulty, query_type, note? (note is optional, only present on
#       some test cases).
#     - Ambiguous urls (matching >1 document, see AMBIGUOUS handling below)
#       still get ALL candidate ids folded into expected_document_ids -- that
#       part of the current behavior is correct and should stay. What needs
#       to change is simply that expected_urls / *_count must never be
#       written in the first place.
#
#   Top-level `metadata`:
#     - No `migration_report` block (the missing/ambiguous/normalized/
#       non_searchable breakdown this script currently writes there).
#       Anomalies should instead be printed to the console only (as this
#       script already does) -- don't persist them into the golden dataset.
#     - `total_expected_documents` / `unique_documents` should be
#       RECOMPUTED from the final `expected_document_ids` arrays (sum of
#       lengths / size of the union across all test cases) rather than left
#       as whatever was already in the source file's metadata.
#     - Add a `changes_from_v2` array under metadata: a flat list of plain
#       strings summarizing this migration (e.g. "Converted expected_urls to
#       expected_document_ids", "Ambiguous matches were all added, for human
#       review, increasing the expected number of documents at least
#       temporarily", "Removed expected_count field"). Every element MUST be
#       a plain string -- do not emit `"key": "value"` pairs as array
#       elements (that produces invalid JSON; this bit the manual edit last
#       time).
#
# See `evaluation/golden-dataset.doc-ids.json` as the reference for the
# exact desired shape once this script is fixed.
# ---------------------------------------------------------------------------
"""
Migrate evaluation/golden-dataset.json (Cite mode golden set) from
URL-based matching to document-ID-based matching.

Background
----------
`run-cite-eval.ts` currently matches retrieved documents against
`expected_urls` using fuzzy slug extraction (see
`evaluation/lib/metrics.ts::extractUrlSlug`). The search service actually
identifies documents by `doc_id` in its response, and `doc_id` is populated
verbatim from the Postgres `documents.external_id` column at ingest time
(confirmed via `search-service/app/pg_store.py`: chunk `node_metadata.doc_id`
== `documents.external_id`). Matching on `external_id` directly is exact and
avoids slug-matching fragility (protocol/www/trailing-slash/file-extension
edge cases).

What this script does
----------------------
1. Connects to the AskWRI Postgres database (same env vars as the app:
   DATABASE_URL, or DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME).
2. Builds an index of `url -> [external_id, ...]` from the `documents` table.
3. For every `expected_urls` entry in the golden dataset, resolves it to a
   `documents.external_id`.
4. Writes a NEW file (does NOT touch the input file) with an added
   `expected_document_ids` array per test case, alongside the original
   `expected_urls` (kept for audit/rollback), plus a `migration_report` in
   the output's metadata documenting anomalies.

Anomaly handling (by design, not silent)
-----------------------------------------
- MISSING: a url with zero matching documents. Left out of
  `expected_document_ids`, reported under `metadata.migration_report.missing`,
  and printed to the console. (These are usually already-known "not in
  catalog" removals per the existing golden-dataset.json notes.)
- AMBIGUOUS: a url matching MULTIPLE documents. This is a known, confirmed
  data-quality issue: 10 urls in the current corpus are each backed by 2+
  `documents` rows with identical url/date/title (duplicate ingests with
  different `external_id` suffixes). Rather than silently guessing which one
  is "canonical", ALL candidate external_ids are included in
  `expected_document_ids` (so recall isn't undercounted if only one of the
  duplicates is returned by retrieval), and the full set of candidates is
  reported under `metadata.migration_report.ambiguous` for manual review /
  pruning.
- NON-SEARCHABLE: a matched document whose `status != 'searchable'` (would
  never be returned by the live search index regardless of URL matching).
  Reported under `metadata.migration_report.non_searchable`.

Usage
-----
    search-service/venv/bin/python evaluation/migrate-golden-dataset-doc-ids.py
    search-service/venv/bin/python evaluation/migrate-golden-dataset-doc-ids.py \
        --input evaluation/golden-dataset.json \
        --output evaluation/golden-dataset.doc-ids.json

Does not require any Node dependencies. Requires `psycopg` and
`python-dotenv`, both already present in `search-service/venv`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import psycopg
from dotenv import dotenv_values

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_env() -> None:
    """Load .env then .env.local into os.environ, without clobbering
    variables already set in the real process environment.

    Precedence (per repo convention, see CLAUDE.md): real env > .env.local >
    .env. dotenv_values() parses files without mutating os.environ, so we
    can merge them ourselves and only fill in gaps.
    """
    merged: dict[str, str] = {}
    for fname in (".env", ".env.local"):
        path = REPO_ROOT / fname
        if path.exists():
            merged.update({k: v for k, v in dotenv_values(path).items() if v is not None})
    for key, value in merged.items():
        os.environ.setdefault(key, value)


def get_connection() -> psycopg.Connection:
    load_env()
    database_url = os.environ.get("DATABASE_URL")
    if database_url:
        return psycopg.connect(database_url)
    return psycopg.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=os.environ.get("DB_PORT", "5432"),
        user=os.environ.get("DB_USER"),
        password=os.environ.get("DB_PASSWORD"),
        dbname=os.environ.get("DB_NAME"),
    )


def normalize_url(url: str) -> str:
    """Loose fallback normalization (mirrors evaluation/lib/metrics.ts
    normalizeUrl): strips protocol, leading www., and trailing slash."""
    if not url:
        return ""
    u = url.strip().lower()
    u = u.split("://", 1)[-1]
    if u.startswith("www."):
        u = u[4:]
    return u.rstrip("/")


def build_url_index(
    conn: psycopg.Connection,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]]]:
    """Returns (exact_index, normalized_index), each mapping a url string to
    the list of matching document records (external_id/status/date/etc)."""
    exact_index: dict[str, list[dict[str, Any]]] = defaultdict(list)
    normalized_index: dict[str, list[dict[str, Any]]] = defaultdict(list)

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT external_id, url, status, date_published, language, title
            FROM documents
            WHERE url IS NOT NULL
            """
        )
        for external_id, url, status, date_published, language, title in cur.fetchall():
            record = {
                "external_id": external_id,
                "url": url,
                "status": status,
                "date_published": str(date_published) if date_published else None,
                "language": language,
                "title": title,
            }
            exact_index[url].append(record)
            normalized_index[normalize_url(url)].append(record)

    return exact_index, normalized_index


def resolve_url(
    url: str,
    exact_index: dict[str, list[dict[str, Any]]],
    normalized_index: dict[str, list[dict[str, Any]]],
) -> tuple[list[dict[str, Any]], str]:
    """Resolve a single expected_url to candidate document records.

    Returns (matches, match_kind) where match_kind is "exact", "normalized",
    or "missing".
    """
    matches = exact_index.get(url)
    if matches:
        return matches, "exact"
    matches = normalized_index.get(normalize_url(url))
    if matches:
        return matches, "normalized"
    return [], "missing"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migrate golden-dataset.json expected_urls -> expected_document_ids",
    )
    parser.add_argument(
        "--input",
        default=str(REPO_ROOT / "evaluation" / "golden-dataset.json"),
        help="Path to the source golden dataset (URL-based). Never modified.",
    )
    parser.add_argument(
        "--output",
        default=str(REPO_ROOT / "evaluation" / "golden-dataset.doc-ids.json"),
        help="Path to write the new document-ID-based golden dataset.",
    )
    parser.add_argument(
        "--fail-on-missing",
        action="store_true",
        help="Exit non-zero if any expected_url has no matching document.",
    )
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()

    if output_path == input_path:
        print(
            "ERROR: --output must differ from --input "
            "(refusing to overwrite the source file)",
            file=sys.stderr,
        )
        sys.exit(1)

    with input_path.open() as f:
        golden = json.load(f)

    conn = get_connection()
    try:
        exact_index, normalized_index = build_url_index(conn)
    finally:
        conn.close()

    missing_report: list[dict[str, Any]] = []
    ambiguous_report: list[dict[str, Any]] = []
    normalized_report: list[dict[str, Any]] = []
    non_searchable_report: list[dict[str, Any]] = []

    total_urls = 0
    for tc in golden["test_cases"]:
        expected_urls = tc["expected_urls"]
        expected_document_ids: list[str] = []
        seen_ids: set[str] = set()

        for url in expected_urls:
            total_urls += 1
            matches, kind = resolve_url(url, exact_index, normalized_index)

            if kind == "missing":
                missing_report.append({"test_case_id": tc["id"], "url": url})
                continue

            if kind == "normalized":
                normalized_report.append(
                    {
                        "test_case_id": tc["id"],
                        "url": url,
                        "matched_external_ids": [m["external_id"] for m in matches],
                    }
                )

            if len(matches) > 1:
                ambiguous_report.append(
                    {
                        "test_case_id": tc["id"],
                        "url": url,
                        "candidates": matches,
                    }
                )

            for m in matches:
                if m["status"] != "searchable":
                    non_searchable_report.append(
                        {
                            "test_case_id": tc["id"],
                            "url": url,
                            "external_id": m["external_id"],
                            "status": m["status"],
                        }
                    )
                if m["external_id"] not in seen_ids:
                    seen_ids.add(m["external_id"])
                    expected_document_ids.append(m["external_id"])

        tc["expected_document_ids"] = expected_document_ids
        tc["expected_document_ids_count"] = len(expected_document_ids)
        # expected_urls / expected_count are intentionally left in place for
        # audit / rollback — this script only adds fields, never removes.

    golden.setdefault("metadata", {})
    golden["metadata"]["migration_report"] = {
        "source_file": input_path.name,
        "total_expected_urls_processed": total_urls,
        "missing_count": len(missing_report),
        "ambiguous_count": len(ambiguous_report),
        "normalized_match_count": len(normalized_report),
        "non_searchable_count": len(non_searchable_report),
        "missing": missing_report,
        "ambiguous": ambiguous_report,
        "normalized_matches": normalized_report,
        "non_searchable": non_searchable_report,
        "note": (
            "expected_document_ids uses documents.external_id, the same "
            "identifier the search service returns as doc_id (see "
            "search-service/app/pg_store.py — document_chunks.node_metadata"
            ".doc_id is populated from documents.external_id at ingest). "
            "Ambiguous urls (matching >1 document — confirmed duplicate "
            "ingests with identical url/date/title, different external_id "
            "suffix) include ALL candidate external_ids so recall isn't "
            "undercounted; see `ambiguous` below and prune manually once "
            "the canonical duplicate is confirmed with the corpus owner."
        ),
    }

    with output_path.open("w") as f:
        json.dump(golden, f, indent=2)
        f.write("\n")

    # --- Console summary ---
    print(
        f"Read {total_urls} expected_urls across "
        f"{len(golden['test_cases'])} test cases"
    )
    print(f"Wrote: {output_path}")
    print()

    if missing_report:
        print(
            f"[MISSING] {len(missing_report)} url(s) had NO matching document "
            "(excluded from expected_document_ids):"
        )
        for m in missing_report:
            print(f"   [{m['test_case_id']}] {m['url']}")
        print()

    if normalized_report:
        print(
            f"[NORMALIZED] {len(normalized_report)} url(s) matched only after "
            "normalization (protocol/www/trailing-slash differences) — "
            "verify these are correct:"
        )
        for m in normalized_report:
            print(f"   [{m['test_case_id']}] {m['url']} -> {m['matched_external_ids']}")
        print()

    if non_searchable_report:
        print(
            f"[NON-SEARCHABLE] {len(non_searchable_report)} matched document(s) "
            "are not status='searchable' (will never be retrievable regardless "
            "of the golden set):"
        )
        for n in non_searchable_report:
            print(f"   [{n['test_case_id']}] {n['external_id']} (status={n['status']}) <- {n['url']}")
        print()

    if ambiguous_report:
        print(
            f"[AMBIGUOUS] {len(ambiguous_report)} url(s) matched MULTIPLE "
            "documents — needs manual review:"
        )
        for a in ambiguous_report:
            print(f"   [{a['test_case_id']}] {a['url']}")
            for c in a["candidates"]:
                print(
                    f"       - {c['external_id']}  "
                    f"(status={c['status']}, date={c['date_published']}, "
                    f"lang={c['language']}, title={c['title']!r})"
                )
        print()
        print(
            "   All candidate ids were included in expected_document_ids for these\n"
            "   entries so recall isn't undercounted. These are confirmed duplicate\n"
            "   ingests (identical url/date/title, different external_id suffix) —\n"
            "   confirm the canonical one with the corpus owner, then manually\n"
            "   prune the other from the output file."
        )
        print()

    if args.fail_on_missing and missing_report:
        sys.exit(1)


if __name__ == "__main__":
    main()
