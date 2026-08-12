# Issue 324 Final Fix Report

## Changes

- Added an integration regression case proving an `authors` value with `metadata_source.authors='human'` remains unchanged during parse-stage re-ingestion.
- Retained the existing direct external-author preservation case and extended the prior-LLM re-ingest case to seed `authors='Old LLM Author'` with `metadata_source.authors='llm'`. It asserts the normalized `Doe, Jane; Smith, John` value, retained `llm` provenance, and author-specific before/after audit payload.
- Merged author normalization documentation into the `parse` table cell with `<br><br>`, removed the separate empty-label row, and removed duplicated prose. The explicitly retained plan artifact was not changed.

## Covering Test Files

- `search-service/tests/test_worker_stages.py` — database-backed provenance and audit integration cases.
- `search-service/tests/test_worker_parse_metadata.py` — focused formatter/schema coverage run as the executable non-database companion.

## Verification

Command: `cd search-service && ./venv/bin/python -m pytest tests/test_worker_stages.py::TestParseLLMExtraction -rs -v`

Output: `9 skipped in 0.16s`. Exact skip reason for every collected integration case: `DATABASE_URL not set — skipping worker stages integration tests`.

Command: `cd search-service && ./venv/bin/python -m pytest tests/test_worker_parse_metadata.py -v`

Output: `5 passed in 0.06s`.

Commands: `cd search-service && ./venv/bin/python -m py_compile tests/test_worker_stages.py`; `npx prettier --check docs/document-management.md`; `git diff --check`.

Outputs: `py_compile` and `git diff --check` produced no output and exited 0; Prettier reported `All matched files use Prettier code style!`.

## Self-Review

- Tests assert observable database values, persisted provenance, and audit data instead of mock calls.
- The new human case and existing external case independently exercise protected branches; the LLM case exercises the permitted refresh branch and normalized structured-author result.
- No production behavior changed. Documentation remains one valid two-column `parse` table row with one authoritative author-formatting description.
- The final diff contains only the requested test, documentation, and this report; no plan artifact was removed.

## Concerns

- `DATABASE_URL` is unavailable, so amended integration tests could only be collected and skipped, not executed against PostgreSQL. The exact skip is recorded above.
- No Python formatter is configured in `search-service/venv`; syntax compilation, focused unit tests, Prettier for Markdown, and `git diff --check` were run.
