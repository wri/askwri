# Issue 324 AI Author Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every AI-extracted personal author land in the DMS `Family name, Given names` convention without changing imported, human-edited, date, or publication metadata.

**Architecture:** Change the existing parse-stage structured output from a free-form author string to an array of semantic name-part objects. Normalize those objects through a pure formatter immediately after the single metadata model call, then feed the resulting `str | None` into the existing provenance and audit loop unchanged.

**Tech Stack:** Python 3.13, pytest, OpenAI Chat Completions structured outputs, psycopg/PostgreSQL integration tests

**Spec:** `docs/superpowers/specs/2026-08-12-issue-324-author-normalization-design.md`

## Global Constraints

- Do not add a model call or change `WORKER_LLM_MODEL`.
- Do not change `date_published`, `publication_title`, their import behavior, or their provenance.
- Keep the database and admin contracts for `documents.authors` as `str | null`, with entries separated by `; `.
- Preserve `human` and `external` metadata; only absent or `llm` author provenance may be written by parse.
- Prefer a document-provided Latin spelling; otherwise transliterate into Latin script.
- Format personal authors as `Family name, Given names`; do not add a comma to single-name or organizational authors.

---

### Task 1: Structure and deterministically format AI-extracted authors

**Files:**
- Create: `search-service/tests/test_worker_parse_metadata.py`
- Modify: `search-service/worker/stages/parse.py:93-173`
- Modify: `search-service/tests/test_worker_stages.py:1292-1368,3441-3700`
- Modify: `docs/document-management.md:249`

**Interfaces:**
- Consumes: `worker.llm.chat_json(system: str, user: str, schema: dict, model: str, max_tokens: int) -> dict`
- Produces: `_format_authors(authors: object) -> str | None`
- Preserves: `_extract_metadata_llm(full_text: str, model: str) -> dict`, whose returned `authors` value remains `str | None` for the existing database writer

- [ ] **Step 1: Write focused failing tests for the structured schema and formatter**

Create `search-service/tests/test_worker_parse_metadata.py`:

```python
"""Unit tests for parse-stage bibliographic metadata normalization."""
from unittest.mock import patch

from worker.stages.parse import (
    _EXTRACT_SCHEMA,
    _extract_metadata_llm,
    _format_authors,
)


def _empty_metadata(**overrides):
    result = {name: None for name in _EXTRACT_SCHEMA["properties"]}
    result.update(overrides)
    return result


def test_authors_schema_requires_semantic_name_parts():
    authors = _EXTRACT_SCHEMA["properties"]["authors"]
    assert authors["type"] == ["array", "null"]
    item = authors["items"]
    assert item["additionalProperties"] is False
    assert set(item["properties"]) == {
        "family_name",
        "given_names",
        "organization_name",
    }
    assert set(item["required"]) == set(item["properties"])


def test_formats_chinese_personal_names_family_first():
    assert _format_authors([
        {"family_name": "Xue", "given_names": "Lulu", "organization_name": None},
        {"family_name": "Chen", "given_names": "Ke", "organization_name": None},
    ]) == "Xue, Lulu; Chen, Ke"


def test_preserves_single_names_and_organizations_without_inventing_commas():
    assert _format_authors([
        {"family_name": "Sukarno", "given_names": None, "organization_name": None},
        {"family_name": None, "given_names": None, "organization_name": "World Resources Institute"},
    ]) == "Sukarno; World Resources Institute"


def test_discards_blank_malformed_and_conflicting_author_items():
    assert _format_authors([
        None,
        "Xue, Lulu",
        {"family_name": " ", "given_names": "", "organization_name": None},
        {"family_name": "Xue", "given_names": "Lulu", "organization_name": "WRI"},
        {"family_name": " Li ", "given_names": " Xiang ", "organization_name": None},
    ]) == "Li, Xiang"
    assert _format_authors(None) is None
    assert _format_authors("Xue, Lulu") is None


def test_metadata_extraction_formats_authors_and_keeps_one_model_call():
    captured = {}

    def fake_chat_json(**kwargs):
        captured.update(kwargs)
        return _empty_metadata(authors=[
            {"family_name": "Xue", "given_names": "Lulu", "organization_name": None},
            {"family_name": "Chen", "given_names": "Ke", "organization_name": None},
        ])

    with patch("worker.llm.chat_json", side_effect=fake_chat_json) as chat:
        result = _extract_metadata_llm("薛露露 陈科", "test-model")

    assert chat.call_count == 1
    assert result["authors"] == "Xue, Lulu; Chen, Ke"
    system = captured["system"]
    assert "family_name" in system and "given_names" in system
    assert "romanized form" in system
    assert "Latin alphabet" in system
```

- [ ] **Step 2: Run the focused tests and verify the RED state**

Run:

```bash
cd search-service && ./venv/bin/python -m pytest tests/test_worker_parse_metadata.py -v
```

Expected: collection fails because `_format_authors` does not exist, proving the new normalization contract is not implemented.

- [ ] **Step 3: Add the structured author schema and pure formatter**

In `search-service/worker/stages/parse.py`, replace the current `authors` property in `_EXTRACT_SCHEMA` with:

```python
        "authors": {
            "type": ["array", "null"],
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "family_name": {"type": ["string", "null"]},
                    "given_names": {"type": ["string", "null"]},
                    "organization_name": {"type": ["string", "null"]},
                },
                "required": ["family_name", "given_names", "organization_name"],
            },
        },
```

Add this pure helper after `_extract_doi`:

```python
def _format_authors(authors: object) -> str | None:
    """Convert structured model output to the DMS semicolon-delimited string."""
    if not isinstance(authors, list):
        return None

    formatted = []
    for author in authors:
        if not isinstance(author, dict):
            continue
        family = author.get("family_name")
        given = author.get("given_names")
        organization = author.get("organization_name")
        family = family.strip() if isinstance(family, str) else ""
        given = given.strip() if isinstance(given, str) else ""
        organization = organization.strip() if isinstance(organization, str) else ""

        # A model item must represent either a person or an organization.
        if organization and (family or given):
            continue
        if organization:
            formatted.append(organization)
        elif family and given:
            formatted.append(f"{family}, {given}")
        elif family or given:
            formatted.append(family or given)

    return "; ".join(formatted) or None
```

- [ ] **Step 4: Strengthen the prompt and normalize the model response**

In `_extract_metadata_llm`, replace the free-form authors description with `authors (an array of structured person or organization authors)`.

Replace the `AUTHORS.` paragraph with:

```python
            "AUTHORS. Return authors in document order. For a person, put the "
            "family name in 'family_name', all given names in 'given_names', "
            "and null in 'organization_name'. Separate name parts semantically "
            "regardless of the order printed in the source. Prefer a romanized "
            "form printed by the document; otherwise transliterate into the "
            "Latin alphabet. For example, '薛露露' becomes family_name='Xue', "
            "given_names='Lulu', and '陈科' becomes family_name='Chen', "
            "given_names='Ke'. For a group or institution, set only "
            "'organization_name'. Use null rather than guessing an unknown part. "
            "Never put native-script and Latin versions in the same item."
```

Replace the return normalization with:

```python
    normalized = {f: result.get(f) for f in _EXTRACT_FIELDS}
    normalized["authors"] = _format_authors(result.get("authors"))
    return normalized
```

- [ ] **Step 5: Run the focused tests and verify the GREEN state**

Run:

```bash
cd search-service && ./venv/bin/python -m pytest tests/test_worker_parse_metadata.py -v
```

Expected: 5 tests pass with no warnings or errors.

- [ ] **Step 6: Update DB-integration fixtures to model the new API response while retaining stored-string assertions**

In `TestParseTitleAndAuthors._fake_llm`, keep the payload helper but pass author objects in the bilingual-cover test:

```python
            authors=[
                {"family_name": "Xue", "given_names": "Lulu", "organization_name": None},
                {"family_name": "Liu", "given_names": "Daizong", "organization_name": None},
            ],
```

Update the prompt-contract assertion to check semantic splitting as well as transliteration:

```python
        assert "family_name" in system and "given_names" in system
```

In `TestParseLLMExtraction`, preserve `_FAKE_EXTRACTION` as the expected database/audit dictionary and add:

```python
    _FAKE_AUTHOR_PARTS = [
        {"family_name": "Doe", "given_names": "Jane", "organization_name": None},
        {"family_name": "Smith", "given_names": "John", "organization_name": None},
    ]

    def _fake_llm_response(self):
        return {**self._FAKE_EXTRACTION, "authors": list(self._FAKE_AUTHOR_PARTS)}
```

Replace each metadata-extraction mock in that class:

```python
monkeypatch.setattr(_llm, "chat_json", lambda **kw: self._fake_llm_response())
```

Do not change assertions against `_FAKE_EXTRACTION`: they verify that the database and audit log still receive `"Doe, Jane; Smith, John"`, not the internal object array.

- [ ] **Step 7: Run the parse metadata unit tests and the worker-stage integration module**

Run:

```bash
cd search-service && ./venv/bin/python -m pytest tests/test_worker_parse_metadata.py tests/test_worker_stages.py -v
```

Expected: the five unit tests pass. Worker-stage integration tests pass when `DATABASE_URL` is configured, or report their existing explicit skip when it is not.

- [ ] **Step 8: Update the as-built DMS documentation**

In `docs/document-management.md`, amend the parse-stage author sentence to state:

```markdown
Author names are returned as structured family/given-name parts, transliterated to Latin script, and deterministically stored as `Family, Given` entries separated by semicolons; organization and single-name authors are preserved without an invented comma. Native-script forms are not retained (a re-ingest re-extracts them).
```

Keep the same paragraph explicit that `date_published` and `publication_title` are not parse-stage model fields.

- [ ] **Step 9: Run full verification**

Run:

```bash
npm run test:python
npm test -- --runInBand
npm run lint
git diff --check
```

Expected:

- Python: all available tests pass; only documented service-dependent tests skip.
- Jest: all available tests pass; only documented database-dependent tests skip.
- ESLint exits 0.
- `git diff --check` prints nothing.

- [ ] **Step 10: Commit the implementation**

```bash
git add search-service/worker/stages/parse.py \
  search-service/tests/test_worker_parse_metadata.py \
  search-service/tests/test_worker_stages.py \
  docs/document-management.md \
  docs/superpowers/plans/2026-08-12-issue-324-author-normalization.md
git commit -m "fix(worker): normalize AI authors as family, given"
```
